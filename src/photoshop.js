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
    var n = U.parseBitsPerChannel(doc.bitsPerChannel);
    if (n) bits = '，色深 ' + n + ' 位/通道';
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
// 最近一次读到的像素实况。成功时跟着结果一起返回，失败时拼进报错——
// 这样无论哪条路，日志里都能看到"当时拿到的像素到底是什么形状"。
var lastPixelInfo = '';

async function captureSelection(maxEdge) {
  var out = null;
  lastPixelInfo = '';
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

        // 交给 JPEG 编码器之前，把像素整理成「8 位、无 alpha 的 RGB」。
        // 有的 Photoshop 版本即使写了 applyAlpha:false 也照样返回四通道数据，
        // 直接编码会被顶回来：Image data with alpha cannot be encoded as jpeg。
        var norm = await ensureEncodableImageData(imageData);
        imageData = norm.imageData;

        lastPixelInfo =
          '像素 ' + norm.width + '×' + norm.height + '，通道 ' + norm.components + '，字节数 ' + norm.rawLength +
          (norm.changed ? '（已转成 8 位 RGB）' : '') +
          (norm.error ? '｜整理像素时出过错：' + norm.error : '');

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
          jpegBase64: b64,
          pixelInfo: lastPixelInfo
        };
      },
      { commandName: '读取选区内容' }
    );
  } catch (e) {
    // executeAsModal 会把里面抛的错换成一个没有 message 的对象，
    // 不翻译的话日志上屏就只有「undefined」。
    throw new Error(
      (U.describeError(e) || 'Photoshop 拒绝了这次读取，但没给出原因') +
        (lastPixelInfo ? '｜' + lastPixelInfo : '')
    );
  }
  if (!out) throw new Error('读选区没有返回内容，请重新拉一个选区再试');
  return out;
}

/**
 * 把 imaging.getPixels 拿到的像素整理成"能直接交给编码器 / putPixels"的形状。
 *
 * 具体拆 alpha、统一位深这件事在 util.toRgb8 里做，这里负责三件事：
 *   1) 把像素从 PhotoshopImageData 里读出来（getData 和 .data 两种形态都认）
 *   2) 需要动的时候重建一个 PhotoshopImageData，并把旧的释放掉
 *   3) 把"这次拿到的像素长什么样"记下来，方便日志里排查
 *
 * @param {Object} imageData
 * @param {boolean} [keepAlpha] 贴回图层时传 true，送 JPEG 编码时必须留空
 * @returns {Promise<{imageData, width, height, components, rawLength, changed, error}>}
 */
async function ensureEncodableImageData(imageData, keepAlpha) {
  var out = {
    imageData: imageData,
    width: 0,
    height: 0,
    components: 0,
    rawLength: 0,
    changed: false,
    error: ''
  };
  if (!imageData) {
    out.error = '拿不到像素对象';
    return out;
  }

  out.width = imageData.width || 0;
  out.height = imageData.height || 0;
  out.components = imageData.components || 3;

  var raw = null;
  try {
    raw = typeof imageData.getData === 'function' ? await imageData.getData({}) : imageData.data;
  } catch (eRead) {
    // 读不出来就别硬撑，原样交出去让上层报错，比在这里吞掉更好查
    out.error = U.describeError(eRead) || '读不出像素';
    return out;
  }
  if (!raw) {
    out.error = '像素是空的';
    return out;
  }
  out.rawLength = raw.length !== undefined ? raw.length : raw.byteLength || 0;

  var fixed = U.toRgb8(raw, out.width, out.height, out.components, keepAlpha === true);
  if (!fixed.changed) return out;

  out.imageData = await imaging.createImageDataFromBuffer(fixed.data, {
    width: out.width,
    height: out.height,
    components: fixed.components,
    chunky: true,
    colorSpace: 'RGB'
  });
  out.components = fixed.components;
  out.changed = true;

  try {
    if (typeof imageData.dispose === 'function') imageData.dispose();
  } catch (eDispose) {
    // 交给 GC
  }
  return out;
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
        var tempNorm = null;
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

          // 像素必须在临时文档还开着的时候读出来——文档一关，这份句柄就可能失效。
          // 贴回走的是 putPixels 不是编码器，所以这里保留 alpha（生图可能带透明），
          // 但位深还是要统一，免得拿到 16 位字节流直接铺进 8 位文档。
          tempNorm = await ensureEncodableImageData(tempPixels.imageData || tempPixels, true);
        } finally {
          await tempDoc.closeWithoutSaving();
        }
        tempPixels = { imageData: tempNorm.imageData };

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
    // DOM 上读到的色深各版本形状不一（8 / 'bitDepth8' / { _value: ... }），
    // 统一成数字再往外传，不然调用方拿它跟 8 比会把 8 位文档也判成"不是 8 位"。
    var bits = U.parseBitsPerChannel(doc.bitsPerChannel);
    if (!bits) {
      // DOM 上读不到时退到 batchPlay 问一次
      try {
        var res = await app.batchPlay(
          [
            {
              _obj: 'get',
              _target: [{ _property: 'depth' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
            }
          ],
          {}
        );
        if (res && res[0] && res[0].depth) bits = U.parseBitsPerChannel(res[0].depth);
      } catch (eDepth) {
        // 读不到就按未知处理
      }
    }
    return {
      id: doc.id,
      name: doc.name,
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      bitsPerChannel: bits
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
