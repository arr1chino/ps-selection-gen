/**
 * pipeline.js — 一次批量生成的全流程
 *
 *   抓选区（一次，整批共用）
 *     → 每个提示词一个任务，进并发池
 *         → 调接口生成
 *         → 走 PS 锁，贴回选区位置的新图层
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
  var shot = await ps.captureSelection(maxEdge);
  log(
    '选区 ' + shot.rect.width + '×' + shot.rect.height + ' @ (' + shot.rect.left + ',' + shot.rect.top + ')' +
      ' → 发给模型 ' + shot.captureWidth + '×' + shot.captureHeight,
    'ok'
  );

  deps.pool.setMax(cfg.concurrency);

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
  return { okCount: okCount, failCount: failCount, total: results.length };
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
      deps.tasks.update(task.id, { state: 'failed', message: e.message, finishedAt: Date.now() });
      log('失败：' + shorten(task.prompt) + ' — ' + e.message, 'err');
    }
    throw e;
  }
  clearTimeout(timeoutId);

  if (task.state === 'cancelled') throw new Error('已取消');

  deps.tasks.update(task.id, { state: 'pasting', message: '等待贴回' });
  try {
    await deps.psLock.acquire(function () {
      return ps.pasteToSelection({
        base64: result.base64,
        docId: shot.docId,
        target: shot.rect,
        layerName: '生成 ' + shorten(task.prompt)
      });
    });
  } catch (e2) {
    deps.tasks.update(task.id, { state: 'failed', message: '贴回失败：' + e2.message, finishedAt: Date.now() });
    log('贴回失败：' + e2.message, 'err');
    throw e2;
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
