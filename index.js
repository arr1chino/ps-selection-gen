/**
 * index.js — 面板入口：把 UI 和上面几个模块接起来
 */

var store = require('./src/store.js');
var api = require('./src/api.js');
var queueLib = require('./src/queue.js');
var pipeline = require('./src/pipeline.js');

function $(id) {
  return document.getElementById(id);
}

var cfg = store.loadConfig();
var tasks = queueLib.createTaskManager(renderTasks);
var pool = queueLib.createPool(cfg.concurrency);
var psLock = queueLib.createPSLock();
var running = false;
var modelsAll = [];

/* ------------------------------------------------------------------ */
/*  日志                                                              */
/* ------------------------------------------------------------------ */

function log(message, type) {
  var box = $('log');
  if (!box) return;
  var line = document.createElement('div');
  var cls = type === 'ok' ? 'lg-ok' : type === 'warn' ? 'lg-warn' : type === 'err' ? 'lg-err' : 'lg-info';
  line.className = cls;
  var t = new Date();
  var hh = ('0' + t.getHours()).slice(-2);
  var mm = ('0' + t.getMinutes()).slice(-2);
  var ss = ('0' + t.getSeconds()).slice(-2);
  line.textContent = '[' + hh + ':' + mm + ':' + ss + '] ' + message;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ */
/*  任务列表渲染                                                       */
/* ------------------------------------------------------------------ */

var STATE_TEXT = {
  queued: '排队中',
  running: '生成中',
  pasting: '贴回中',
  done: '已完成',
  failed: '失败',
  cancelled: '已中断'
};

function renderTasks(list) {
  var box = $('taskList');
  var wrap = $('preview');
  if (!box) return;
  box.innerHTML = '';
  if (wrap) wrap.innerHTML = '';

  if (!list.length) {
    var empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '还没有任务。';
    box.appendChild(empty);
  }

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var row = document.createElement('div');
    row.className = 'task';

    var name = document.createElement('div');
    name.className = 'tname';
    name.textContent = (i + 1) + '. ' + t.prompt;
    row.appendChild(name);

    var state = document.createElement('div');
    state.className = 'tstate';
    state.textContent = STATE_TEXT[t.state] || t.state;
    row.appendChild(state);

    if (t.state === 'queued' || t.state === 'running' || t.state === 'pasting') {
      var kill = document.createElement('button');
      kill.className = 'tkill';
      kill.textContent = '中断';
      kill.setAttribute('data-task', t.id);
      kill.addEventListener('click', function (ev) {
        var id = ev.target.getAttribute('data-task');
        tasks.cancel(id);
        log('已请求中断该任务', 'warn');
      });
      row.appendChild(kill);
    }

    if (t.state === 'done' && t.preview && wrap) {
      var img = document.createElement('img');
      img.src = t.preview;
      img.title = t.prompt;
      wrap.appendChild(img);
    }

    box.appendChild(row);
  }

  var c = tasks.counts();
  var stat = $('queueStat');
  if (stat) {
    stat.textContent = c.total === 0
      ? '空闲'
      : '共 ' + c.total + '｜排队 ' + c.queued + '｜进行 ' + (c.running + c.pasting) + '｜完成 ' + c.done +
        (c.failed ? '｜失败 ' + c.failed : '') + (c.cancelled ? '｜中断 ' + c.cancelled : '');
  }
}

/* ------------------------------------------------------------------ */
/*  配置读写                                                           */
/* ------------------------------------------------------------------ */

function readForm() {
  cfg.baseUrl = $('baseUrl').value.trim();
  cfg.protocol = $('protocol').value;
  cfg.model = $('model').value.trim();
  cfg.sizeTier = $('sizeTier').value;
  cfg.concurrency = Math.max(1, Math.min(8, parseInt($('concurrency').value, 10) || 1));
  cfg.timeout = Math.max(10, Math.min(900, parseInt($('timeout').value, 10) || 180));
  return cfg;
}

function fillForm() {
  $('baseUrl').value = cfg.baseUrl || '';
  $('protocol').value = cfg.protocol || 'openai';
  $('model').value = cfg.model || '';
  $('sizeTier').value = cfg.sizeTier || '2048';
  $('concurrency').value = cfg.concurrency || 2;
  $('timeout').value = cfg.timeout || 180;
}

/* 顶部状态条：让用户一眼看出 API 配好没有，不用点进设置 */
function updateApiState() {
  var ready = !!(cfg.baseUrl && cfg.model);
  var text = ready
    ? '模型：' + cfg.model
    : cfg.baseUrl
      ? '已填地址，未选模型'
      : '未配置 API（点右上角「设置」）';

  var bar = $('apiState');
  if (bar) {
    bar.textContent = text;
    bar.className = ready ? 'ok' : '';
  }
  var box = $('settingsState');
  if (box) {
    box.textContent = ready
      ? '已配置：' + cfg.baseUrl + ' ｜ 模型 ' + cfg.model + ' ｜ 协议 ' + (cfg.protocol || 'openai')
      : '还没配好。至少要填「接口地址」并选定「模型」，才能生成。';
  }
}

/* ------------------------------------------------------------------ */
/*  按钮                                                              */
/* ------------------------------------------------------------------ */

async function onSaveConfig() {
  readForm();
  var stored = store.saveConfig(cfg);
  var where = await store.saveApiKey($('apiKey').value);
  if (!stored) log('配置写入本地失败', 'err');
  else log('配置已保存（Key 存储位置：' + where + '）', 'ok');
  updateApiState();
}

async function onPullModels() {
  readForm();
  if (!cfg.baseUrl) {
    log('先填接口地址', 'err');
    return;
  }
  var btn = $('btnPullModels');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    var key = $('apiKey').value;
    var res = await api.listModels({ baseUrl: cfg.baseUrl, apiKey: key });
    modelsAll = res.ids;
    var likely = api.prioritizeImageModels(modelsAll);
    var picker = $('modelPicker');
    picker.innerHTML = '';

    var optAll = document.createElement('option');
    optAll.value = '__ALL__';
    optAll.textContent = '—— 下面是 ' + likely.length + ' 个疑似生图模型（共拉到 ' + modelsAll.length + ' 个）——';
    picker.appendChild(optAll);

    for (var i = 0; i < likely.length; i++) {
      var o = document.createElement('option');
      o.value = likely[i];
      o.textContent = likely[i];
      picker.appendChild(o);
    }
    if (likely.length !== modelsAll.length) {
      var sep = document.createElement('option');
      sep.value = '__ALL2__';
      sep.textContent = '—— 全部模型 ——';
      picker.appendChild(sep);
      for (var j = 0; j < modelsAll.length; j++) {
        if (likely.indexOf(modelsAll[j]) !== -1) continue;
        var o2 = document.createElement('option');
        o2.value = modelsAll[j];
        o2.textContent = modelsAll[j];
        picker.appendChild(o2);
      }
    }
    log('拉取成功（' + res.source + '），共 ' + modelsAll.length + ' 个模型', 'ok');
  } catch (e) {
    log('拉取失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型列表';
    updateApiState();
  }
}

async function onGenerate() {
  if (running) {
    log('已经有一批在跑了', 'warn');
    return;
  }
  readForm();
  if (!cfg.baseUrl || !cfg.model) {
    log('还没配好 API：先在「设置」里填接口地址并选定模型', 'err');
    openSettings();
    return;
  }
  store.saveConfig(cfg);
  await store.saveApiKey($('apiKey').value);

  var prompts = $('prompt').value.split('\n');
  running = true;
  setBusy(true);
  try {
    var summary = await pipeline.runBatch(
      { cfg: cfg, tasks: tasks, pool: pool, psLock: psLock, log: log },
      prompts
    );
    log('这一批结束：成功 ' + summary.okCount + ' / 失败 ' + summary.failCount, summary.failCount ? 'warn' : 'ok');
  } catch (e) {
    log('这一批没能启动：' + e.message, 'err');
  } finally {
    running = false;
    setBusy(false);
  }
}

function onStopAll() {
  var n = tasks.cancelAll();
  var dropped = pool.clear();
  log('已中断 ' + n + ' 个任务，清掉 ' + dropped + ' 个排队任务', 'warn');
}

function setBusy(b) {
  $('btnGenerate').disabled = b;
}

function onTaskStateChanged() {
  renderTasks(tasks.list());
}

/* ------------------------------------------------------------------ */
/*  启动                                                              */
/* ------------------------------------------------------------------ */

function openSettings() {
  var panel = $('settingsPanel');
  if (panel) panel.className = 'open';
  // 设置与主界面互斥显示：宿主对绝对定位浮层的层叠处理不可靠，
  // 留着主界面在下面会被画到设置上面来。
  var top = $('topbar');
  if (top) top.className = 'hidden';
  var main = $('body');
  if (main) main.className = 'hidden';
  updateApiState();
}

function closeSettings() {
  var panel = $('settingsPanel');
  if (panel) panel.className = '';
  var top = $('topbar');
  if (top) top.className = '';
  var main = $('body');
  if (main) main.className = '';
  updateApiState();
}

async function boot() {
  fillForm();
  var key = await store.loadApiKey();
  if (key) $('apiKey').value = key;

  $('btnSaveCfg').addEventListener('click', onSaveConfig);
  $('btnPullModels').addEventListener('click', onPullModels);
  $('btnGenerate').addEventListener('click', onGenerate);
  $('btnStopAll').addEventListener('click', onStopAll);
  $('btnOpenSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);

  $('modelPicker').addEventListener('change', function (ev) {
    var v = ev.target.value;
    if (!v || v === '__ALL__' || v === '__ALL2__') return;
    $('model').value = v;
    cfg.model = v;
    store.saveConfig(cfg);
    updateApiState();
  });

  renderTasks(tasks.list());
  updateApiState();
  log('面板已就绪', 'ok');
  log('用法：点右上角「设置」配好接口和模型 → 回到主界面写提示词 → 在 PS 里框选 → 从选区生成', 'info');
}

boot();

// 方便将来外部调用/调试
window.__selgen = {
  log: log,
  getConfig: function () {
    return cfg;
  },
  refreshTasks: onTaskStateChanged
};
