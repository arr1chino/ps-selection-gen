/**
 * photoshop.js — 跟 Photoshop 打交道的那一层
 *
 * 只用官方公开 API：
 *   - 选区边界：DOM doc.selection.bounds，失败退到 batchPlay
 *   - 取像素：  imaging.getPixels
 *   - 转图片：  imaging.encodeImageData（UXP 自带，省掉手写编码器）
 *   - 贴回去：  写临时文件 → app.open 让 PS 解码 → imaging.getPixels(带 targetSize 缩放)
 *              → 关掉临时文档 → 在新图层上 imaging.putPixels 定位到选区左上角
 *
 * 这套流程的好处：缩放和编解码都交给 Photoshop 自己干，插件里不出现任何解码器。
 */

var photoshop = require('photoshop');
var uxp = require('uxp');
var U = require('./util.js');

var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var lfs = uxp.storage.localFileSystem;
var formats = uxp.storage.formats;

/**
 * 读当前文档的选区边界。
 * 必须在 executeAsModal 里调用。
 */
async function readSelectionBoundsInModal() {
  var doc = app.activeDocument;
  if (!doc) throw new Error('Photoshop 里没有打开的文档');

  // 三种读法都会失败时，把每一路的原因留下来，一起写进最后的报错里。
  // 之前这里是静默 catch，三个都不行也只看到一句「没读到选区」，没法查。
  var reasons = [];

  // 方法 1：UXP DOM
  try {
    var sel = doc.selection;
    if (sel && sel.bounds) {
      var b = sel.bounds;
      if (isFinite(b.left) && isFinite(b.right) && b.right - b.left > 0) {
        return {
          left: Math.round(b.left),
          top: Math.round(b.top),
          right: Math.round(b.right),
          bottom: Math.round(b.bottom)
        };
      }
      reasons.push('DOM 选区：边界是空的');
    } else {
      reasons.push('DOM 选区：读不到 selection');
    }
  } catch (e1) {
    reasons.push('DOM 选区：' + (U.describeError(e1) || '没给出原因'));
  }

  // 方法 2：batchPlay 读 selection 属性（DOM 在部分版本/通道状态下会返回空）
  try {
    var res = await app.batchPlay(
      [
        {
          _obj: 'get',
          _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
        }
      ],
      {}
    );
    if (res && res[0] && res[0].selection) {
      var s = res[0].selection;
      var pick = function (v) {
        if (v === undefined || v === null) return NaN;
        return typeof v === 'number' ? v : v._value;
      };
      var left = pick(s.left);
      var top = pick(s.top);
      var right = pick(s.right);
      var bottom = pick(s.bottom);
      if (isFinite(left) && isFinite(right) && right - left > 0) {
        return {
          left: Math.round(left),
          top: Math.round(top),
          right: Math.round(right),
          bottom: Math.round(bottom)
        };
      }
      reasons.push('batchPlay 选区属性：拿到了但边界无效');
    } else {
      reasons.push('batchPlay 选区属性：返回里没有 selection');
    }
  } catch (e2) {
    reasons.push('batchPlay 选区属性：' + (U.describeError(e2) || '没给出原因'));
  }

  // 方法 3：读选区通道的 bounds
  try {
    var chRes = await app.batchPlay(
      [
        {
          _obj: 'get',
          _target: [{ _property: 'bounds' }, { _ref: 'channel', _enum: 'channel', _value: 'selection' }]
        }
      ],
      {}
    );
    if (chRes && chRes[0] && chRes[0].bounds) {
      var cb = chRes[0].bounds;
      var p2 = function (v) {
        return typeof v === 'number' ? v : v && v._value;
      };
      var l2 = p2(cb.left);
      var r2 = p2(cb.right);
      if (isFinite(l2) && isFinite(r2) && r2 - l2 > 0) {
        return {
          left: Math.round(l2),
          top: Math.round(p2(cb.top)),
          right: Math.round(r2),
          bottom: Math.round(p2(cb.bottom))
        };
      }
      reasons.push('选区通道 bounds：拿到了但边界无效');
    } else {
      reasons.push('选区通道 bounds：返回里没有 bounds');
    }
  } catch (e3) {
    reasons.push('选区通道 bounds：' + (U.describeError(e3) || '没给出原因'));
  }

  throw new Error(
    '没读到选区。请先用矩形选框工具(M)拉一个选区；' +
      '如果确实拉好了还是读不到，多半是文档处于 16/32 位模式，试试转成 8 位/通道。' +
      (reasons.length ? ' | 细节：' + reasons.join('；') : '') +
      describeDoc(doc)
  );
}

/** 报错时捎上"当时是哪张图、多少位"，这两个信息往往直接指向原因 */
function describeDoc(doc) {
  if (!doc) return '';
  var bits = '';
  try {
    if (doc.bitsPerChannel) bits = '，色深 ' + doc.bitsPerChannel + ' 位/通道';
  } catch (eBits) {
    // 读不到就不写
  }
  return ' | 当前文档：' + (doc.name || '(无名)') + bits;
}

function boundsToRect(b) {
  return {
    left: b.left,
    top: b.top,
    right: b.right,
    bottom: b.bottom,
    width: b.right - b.left,
    height: b.bottom - b.top
  };
}

/**
 * 抓取当前选区的内容。
 * 返回 { docId, rect, captureWidth, captureHeight, jpegBase64 }
 *
 * captureWidth/Height 可能小于 rect 宽高（受 maxEdge 限制），这是发给模型的尺寸。
 */
async function captureSelection(maxEdge) {
  var out = null;
  try {
    await core.executeAsModal(
      async function () {
        var doc = app.activeDocument;
        if (!doc) throw new Error('Photoshop 里没有打开的文档');

        var raw = await readSelectionBoundsInModal();
        var rect = boundsToRect(raw);

        // 限制发给模型的最大边，避免大图直接把内存和带宽打爆
        var cw = rect.width;
        var ch = rect.height;
        var limit = maxEdge || 2048;
        if (cw > limit || ch > limit) {
          if (cw >= ch) {
            ch = Math.max(1, Math.round((ch * limit) / cw));
            cw = limit;
          } else {
            cw = Math.max(1, Math.round((cw * limit) / ch));
            ch = limit;
          }
        }

        var pixelObj = null;
        try {
          pixelObj = await imaging.getPixels({
            documentID: doc.id,
            sourceBounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            targetSize: { width: cw, height: ch },
            componentSize: 8,
            colorSpace: 'RGB',
            applyAlpha: false
          });
        } catch (e8) {
          // 16/32 位文档下指定 componentSize:8 可能不被支持，去掉让它按原深度返回再自行降位
          pixelObj = await imaging.getPixels({
            documentID: doc.id,
            sourceBounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            targetSize: { width: cw, height: ch },
            colorSpace: 'RGB',
            applyAlpha: false
          });
        }

        var imageData = pixelObj.imageData || pixelObj;

        // 如果是 16/32 位返回，先转成 8 位再交给编码器
        try {
          if (imageData.componentSize && imageData.componentSize !== 8) {
            imageData = await convertTo8Bit(imageData);
          }
        } catch (eConv) {
          // 转不动就按原样试编码，失败会在下面暴露出来
        }

        var b64 = await imaging.encodeImageData({ imageData: imageData, base64: true });

        try {
          if (imageData && typeof imageData.dispose === 'function') imageData.dispose();
        } catch (eDispose) {
          // 交给 GC
        }

        out = {
          docId: doc.id,
          docName: doc.name,
          rect: rect,
          captureWidth: cw,
          captureHeight: ch,
          jpegBase64: b64
        };
      },
      { commandName: '读取选区内容' }
    );
  } catch (e) {
    // executeAsModal 会把里面抛的错换成一个没有 message 的对象，
    // 不翻译的话日志上屏就只有「undefined」。
    throw new Error(U.describeError(e) || 'Photoshop 拒绝了这次读取，但没给出原因');
  }
  if (!out) throw new Error('读选区没有返回内容，请重新拉一个选区再试');
  return out;
}

/** 16/32 位像素 → 8 位 PhotoshopImageData */
async function convertTo8Bit(imageData) {
  var raw = typeof imageData.getData === 'function' ? await imageData.getData({}) : imageData.data;
  var w = imageData.width;
  var h = imageData.height;
  var comps = imageData.components || 3;
  var total = w * h * comps;
  var out8 = new Uint8Array(total);

  if (raw instanceof Uint16Array) {
    // Photoshop 的 16 位是 0..32768（不是 0..65535）
    var maxVal = 0;
    var probe = Math.min(raw.length, 4096);
    for (var i = 0; i < probe; i++) if (raw[i] > maxVal) maxVal = raw[i];
    var psRange = maxVal > 0 && maxVal <= 32769;
    for (var j = 0; j < total && j < raw.length; j++) {
      out8[j] = psRange ? Math.min(255, Math.round((raw[j] * 255) / 32768)) : Math.min(255, raw[j] >> 8);
    }
  } else if (raw instanceof Float32Array) {
    for (var k = 0; k < total && k < raw.length; k++) {
      var f = raw[k];
      out8[k] = Math.round(Math.min(1, Math.max(0, f)) * 255);
    }
  } else if (raw instanceof Uint8Array) {
    return imageData;
  } else {
    return imageData;
  }

  return await imaging.createImageDataFromBuffer(out8, {
    width: w,
    height: h,
    components: comps,
    chunky: true,
    colorSpace: 'RGB'
  });
}

/**
 * 把生成的图片贴回到指定文档的指定位置。
 * target: { left, top, width, height }
 */
async function pasteToSelection(opts) {
  var bytes = U.base64ToBytes(opts.base64);
  var fmt = U.sniffImageFormat(bytes);
  var tempFolder = await lfs.getTemporaryFolder();
  var tempName = 'selgen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + fmt.ext;
  var tempFile = await tempFolder.createFile(tempName, { overwrite: true });
  await tempFile.write(bytes, { format: formats.binary });

  var layerId = null;
  try {
    await core.executeAsModal(
      async function () {
        // 1) 打开临时图，让 Photoshop 帮我们把 png/jpeg 解成像素
        var tempDoc = await app.open(tempFile);
        if (!tempDoc) throw new Error('打不开生成的图片（格式可能不被支持）');

        var tempPixels = null;
        try {
          // 2) 顺手让 PS 缩放到选区的尺寸，省掉 JS 里写缩放
          tempPixels = await imaging.getPixels({
            documentID: tempDoc.id,
            sourceBounds: { left: 0, top: 0, right: tempDoc.width, bottom: tempDoc.height },
            targetSize: { width: opts.target.width, height: opts.target.height },
            componentSize: 8,
            colorSpace: 'RGB',
            applyAlpha: false
          });
        } finally {
          await tempDoc.closeWithoutSaving();
        }

        // 3) 回到目标文档，新建一个空像素图层
        var targetDoc = null;
        for (var i = 0; i < app.documents.length; i++) {
          if (app.documents[i].id === opts.docId) targetDoc = app.documents[i];
        }
        if (!targetDoc) throw new Error('目标文档已经关闭了');

        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: opts.docId }] }], {});
        await app.batchPlay(
          [
            {
              _obj: 'make',
              _target: [{ _ref: 'layer' }],
              name: opts.layerName || '生成结果',
              _options: { dialogOptions: 'dontDisplay' }
            }
          ],
          {}
        );

        var active = app.activeDocument.activeLayers;
        if (!active || active.length === 0) throw new Error('新建图层失败');
        layerId = active[0].id;

        // 4) 把像素写到选区左上角
        await imaging.putPixels({
          documentID: opts.docId,
          layerID: layerId,
          imageData: tempPixels.imageData || tempPixels,
          targetBounds: { left: opts.target.left, top: opts.target.top },
          replace: true,
          commandName: '贴回生成结果'
        });

        try {
          var imgData = tempPixels.imageData || tempPixels;
          if (imgData && typeof imgData.dispose === 'function') imgData.dispose();
        } catch (eDispose) {
          // 交给 GC
        }
      },
      { commandName: '贴回生成结果' }
    );
  } catch (e) {
    // 同 captureSelection：executeAsModal 会把异常换壳，先翻成人话再往上抛
    throw new Error(U.describeError(e) || 'Photoshop 拒绝了这次贴回，但没给出原因');
  } finally {
    try {
      await tempFile.delete();
    } catch (eClean) {
      // 临时目录会被系统清理，删不掉不影响使用
    }
  }

  if (!layerId) throw new Error('贴回步骤走完了，但没有拿到新图层');
  return layerId;
}

/** 给 UI 用的当前文档信息 */
async function getActiveDocInfo() {
  try {
    var doc = app.activeDocument;
    if (!doc) return null;
    return {
      id: doc.id,
      name: doc.name,
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      bitsPerChannel: doc.bitsPerChannel
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  captureSelection: captureSelection,
  pasteToSelection: pasteToSelection,
  getActiveDocInfo: getActiveDocInfo
};
