/**
 * pipeline.js — 一次批量生成的全流程
 *
 *   抓选区（一次，整批共用）
 *     → 每个提示词一个任务，进并发池
 *         → 调接口生成
 *         → 走 PS 锁，贴回选区位置的新图层
 *     → 整批跑完：把这些新图层收进一个组，再给组加一个白色蒙版
 */

var api = require('./api.js');
var ps = require('./photoshop.js');
var U = require('./util.js');

/**
 * @param {Object} deps  { cfg, tasks, pool, psLock, log }
 * @param {string[]} prompts
 */
async function runBatch(deps, prompts) {
  var log = deps.log || function () {};
  var cfg = deps.cfg;

  var lines = prompts
    .map(function (s) {
      return String(s || '').trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
  if (lines.length === 0) throw new Error('提示词是空的');
  if (!cfg.baseUrl) throw new Error('先去上面填接口地址');
  if (!cfg.model) throw new Error('先去上面选一个模型');

  log('正在读取选区…', 'info');
  var maxEdge = parseInt(cfg.sizeTier, 10) || 2048;
  var shot;
  try {
    // 先把"现在对着哪张图、多少位"写进日志。
    // 万一后面的报错被宿主吞掉，这一行也足够看出问题出在哪。
    var docInfo = await ps.getActiveDocInfo();
    if (docInfo) {
      log(
        '当前文档：' + docInfo.name + '（' + docInfo.width + '×' + docInfo.height +
          '，' + (docInfo.bitsPerChannel || '?') + ' 位/通道）',
        docInfo.bitsPerChannel && docInfo.bitsPerChannel !== 8 ? 'warn' : 'info'
      );
      if (docInfo.bitsPerChannel && docInfo.bitsPerChannel !== 8) {
        log('提示：' + docInfo.bitsPerChannel + ' 位/通道的文档读选区容易失败，建议先转成 8 位（图像 → 模式 → 8 位/通道）。', 'warn');
      }
    } else {
      log('当前读不到活动文档——请确认 Photoshop 里已经打开了图片。', 'warn');
    }
    shot = await ps.captureSelection(maxEdge);
  } catch (eSel) {
    // Photoshop 抛出来的东西经常不带 message，直接上屏就是一个 undefined。
    // 在这里统一翻成人话，保证「这一批没能启动：xxx」永远是能读的句子。
    throw new Error(U.describeError(eSel) || '读选区这一步被 Photoshop 挡下了，但没给出原因');
  }
  log(
    '选区 ' + shot.rect.width + '×' + shot.rect.height + ' @ (' + shot.rect.left + ',' + shot.rect.top + ')' +
      ' → 发给模型 ' + shot.captureWidth + '×' + shot.captureHeight,
    'ok'
  );
  // 抓到的像素究竟几个通道、几个字节，这一行是关键排查信息，直接留痕
  if (shot.pixelInfo) log(shot.pixelInfo, 'info');

  deps.pool.setMax(cfg.concurrency);

  // 贴回成功的图层都记在这里，等整批跑完一次性编组。
  // 走 PS 锁的顺序就是它们堆在图层面板里的顺序（从下到上）。
  deps.successLayerIds = [];

  var created = lines.map(function (line) {
    return deps.tasks.add(line);
  });

  var jobs = created.map(function (task) {
    return deps.pool.add(function () {
      return runOne(deps, task, shot);
    });
  });

  // 单个任务失败不拖垮整批，最后统一汇报
  var results = await Promise.all(
    jobs.map(function (p) {
      return p.then(
        function (v) {
          return { ok: true, value: v };
        },
        function (e) {
          return { ok: false, error: e };
        }
      );
    })
  );

  var okCount = 0;
  var failCount = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i].ok) okCount++;
    else failCount++;
  }

  // 收尾：把这一批生成出来的图层收进一个组，再给组加一个白色蒙版。
  // 单张也编组——用户要的就是"生成完结果都躺在一个组里"。
  // 这一步走 psLock：前面每个贴回都在这条链上排过队，所以它会等最后一张贴完才动手。
  var groupName = '生图结果';
  var grouped = false;
  if (deps.successLayerIds.length > 0) {
    log('正在把 ' + deps.successLayerIds.length + ' 张结果收进组「' + groupName + '」…', 'info');
    try {
      await deps.psLock.acquire(function () {
        return ps.groupLayersIntoOne({
          docId: shot.docId,
          layerIds: deps.successLayerIds.slice(),
          groupName: groupName
        });
      });
      grouped = true;
      log('已编组并给组加上白色蒙版：' + groupName, 'ok');
    } catch (eGroup) {
      // 编组只是收尾，没做成也不影响已经贴回的那几张，所以只报一句别把整批判失败
      log(
        '编组没做成：' + (U.describeError(eGroup) || '没有给出原因') +
          '（已生成的结果不受影响，图层还在画面上）',
        'warn'
      );
    }
  } else {
    log('这一批没有贴回成功的结果，跳过编组', 'warn');
  }

  return { okCount: okCount, failCount: failCount, total: results.length, grouped: grouped };
}

async function runOne(deps, task, shot) {
  var log = deps.log || function () {};
  var cfg = deps.cfg;

  if (task.state === 'cancelled') throw new Error('已取消');

  var controller = new AbortController();
  task.controller = controller;
  var timeoutId = setTimeout(function () {
    try {
      controller.abort();
    } catch (e) {
      // 忽略
    }
  }, Math.max(10, cfg.timeout) * 1000);

  deps.tasks.update(task.id, { state: 'running', startedAt: Date.now() });
  log('开始生成：' + shorten(task.prompt), 'info');

  var result;
  try {
    result = await api.generate(cfg, {
      prompt: task.prompt,
      imageBase64: shot.jpegBase64,
      selW: shot.rect.width,
      selH: shot.rect.height,
      tier: cfg.sizeTier,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (task.state === 'cancelled') {
      log('已中断：' + shorten(task.prompt), 'warn');
    } else {
      var why = U.describeError(e) || '接口没返回原因';
      deps.tasks.update(task.id, { state: 'failed', message: why, finishedAt: Date.now() });
      log('失败：' + shorten(task.prompt) + ' — ' + why, 'err');
    }
    throw e;
  }
  clearTimeout(timeoutId);

  if (task.state === 'cancelled') throw new Error('已取消');

  deps.tasks.update(task.id, { state: 'pasting', message: '等待贴回' });
  var pastedLayerId = null;
  try {
    pastedLayerId = await deps.psLock.acquire(function () {
      return ps.pasteToSelection({
        base64: result.base64,
        docId: shot.docId,
        target: shot.rect,
        layerName: '生成 ' + shorten(task.prompt)
      });
    });
  } catch (e2) {
    var why2 = U.describeError(e2) || 'Photoshop 拒绝了这次贴回，但没给出原因';
    deps.tasks.update(task.id, { state: 'failed', message: '贴回失败：' + why2, finishedAt: Date.now() });
    log('贴回失败：' + why2, 'err');
    throw e2;
  }

  // 记住这个图层，整批结束后一起编组
  if (pastedLayerId !== null && pastedLayerId !== undefined && deps.successLayerIds) {
    deps.successLayerIds.push(pastedLayerId);
  }

  // 返回的图可能是 png 也可能是 jpeg，用字节头判断，别写死 mime
  var fmt = U.sniffImageFormat(U.base64ToBytes(result.base64));
  deps.tasks.update(task.id, {
    state: 'done',
    message: '',
    finishedAt: Date.now(),
    preview: 'data:' + fmt.mime + ';base64,' + result.base64
  });
  log('完成并贴回：' + shorten(task.prompt), 'ok');
  return true;
}

function shorten(s, n) {
  var t = String(s || '').replace(/\s+/g, ' ');
  var limit = n || 24;
  return t.length > limit ? t.slice(0, limit) + '…' : t;
}

module.exports = {
  runBatch: runBatch
};
