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
  // 设置页打开时，主界面的日志是看不见的（两个视图互斥），
  // 所以同一句话也要写到设置页里那行状态上，否则点按钮像「没反应」。
  if (settingsOpen()) setState(message, type);
}

/* 设置页里的一行即时反馈：拉取/保存的结果都写在这里 */
function setState(text, kind) {
  var el = $('pullState');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind === 'err' ? ' bad' : kind === 'ok' ? ' good' : '');
}

function settingsOpen() {
  var p = $('settingsPanel');
  return !!(p && String(p.className).indexOf('open') !== -1);
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
  cfg.protocol = segValue('protocolSeg') || 'openai';
  cfg.model = $('model').value.trim();
  cfg.sizeTier = segValue('sizeTierSeg') || '2048';
  cfg.concurrency = Math.max(1, Math.min(8, parseInt($('concurrency').value, 10) || 1));
  cfg.timeout = Math.max(10, Math.min(900, parseInt($('timeout').value, 10) || 180));
  return cfg;
}

function fillForm() {
  $('baseUrl').value = cfg.baseUrl || '';
  setSeg('protocolSeg', cfg.protocol || 'openai');
  $('model').value = cfg.model || '';
  setSeg('sizeTierSeg', cfg.sizeTier || '2048');
  $('concurrency').value = cfg.concurrency || 2;
  $('timeout').value = cfg.timeout || 180;
  updateProtocolHint();
}

/* ---- 档位切换（自绘，不用原生下拉框） ------------------------------ */

/* 每个协议的接口路径，写在设置里当说明用 */
var PROTOCOL_HINT = {
  openai: '选区图当参考图 POST 到 /v1/images/edits，多数中转站用这个。',
  gemini: '直连 Google Gemini / nano banana 选这个（:generateContent）。',
  chat: '只有对话接口的中转站选这个，nano banana 中转常见。'
};

function segButtons(id) {
  var seg = $(id);
  return seg ? seg.children : [];
}

/* 取当前选中的档位值 */
function segValue(id) {
  var btns = segButtons(id);
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].className && btns[i].className.indexOf('active') !== -1) {
      return btns[i].getAttribute('data-v');
    }
  }
  return '';
}

/* 设置选中项，并把高亮同步到按钮上 */
function setSeg(id, value) {
  var btns = segButtons(id);
  for (var i = 0; i < btns.length; i++) {
    var on = btns[i].getAttribute('data-v') === String(value);
    btns[i].className = on ? 'active' : '';
  }
}

function wireSeg(id, onChange) {
  var seg = $(id);
  if (!seg) return;
  seg.addEventListener('click', function (ev) {
    var t = ev.target;
    var v = t && t.getAttribute ? t.getAttribute('data-v') : '';
    if (!v) return;
    setSeg(id, v);
    if (onChange) onChange(v);
  });
}

function updateProtocolHint() {
  var el = $('protocolHint');
  if (!el) return;
  el.textContent = PROTOCOL_HINT[segValue('protocolSeg') || 'openai'] || '';
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
    setState('先填「接口地址」，再拉取模型列表。', 'err');
    log('先填接口地址', 'err');
    return;
  }
  var btn = $('btnPullModels');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  setState('拉取中…（最多等 15 秒）');

  // 拉取也要有超时：地址不通时不给超时，按钮会永远停在「拉取中…」。
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 15000);

  try {
    var res = await api.listModels({ baseUrl: cfg.baseUrl, apiKey: $('apiKey').value }, controller.signal);
    modelsAll = res.ids;
    var likely = api.prioritizeImageModels(modelsAll);
    renderModelList(likely, modelsAll);
    log('拉取成功（' + res.source + '），共 ' + modelsAll.length + ' 个模型，点下面的列表选一个', 'ok');
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    if (controller.signal.aborted) {
      msg = '等了 15 秒没回应：地址不通、网络被挡，或 Key 无效';
    } else {
      msg = friendlyNetError(msg, cfg.baseUrl);
    }
    log('拉取失败：' + msg, 'err');
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = '拉取模型列表';
    updateApiState();
  }
}

/* 把底层报错翻成人看得懂的话。UXP 里地址不通时原话就是一句 "Failed to fetch"，
   对着这句话没人知道该改什么。 */
function friendlyNetError(msg, baseUrl) {
  var m = String(msg || '');
  if (/failed to fetch|network ?error|econnrefused|enotfound|getaddrinfo|dns|socket|refused/i.test(m)) {
    return '连不上 ' + baseUrl + ' —— 检查地址是不是写错了（只写到域名，不要带 /v1），或者网络被挡了';
  }
  if (/abort/i.test(m)) return '请求被取消';
  if (/json/i.test(m)) return '连上了，但返回的不是模型列表（' + m + '）';
  return m;
}

/* ---- 模型列表（自绘列表，点一行即选中） ---------------------------- */

function modelSep(text) {
  var d = document.createElement('div');
  d.className = 'model-sep';
  d.textContent = text;
  return d;
}

function modelRow(value) {
  var d = document.createElement('div');
  d.className = 'model-item';
  d.setAttribute('data-v', value);
  d.textContent = value;
  return d;
}

function renderModelList(likely, all) {
  var box = $('modelList');
  if (!box) return;
  box.innerHTML = '';
  if (!all.length) {
    var empty = document.createElement('div');
    empty.className = 'model-item empty';
    empty.textContent = '（没拉到模型：检查地址和 Key）';
    box.appendChild(empty);
    return;
  }
  box.appendChild(modelSep('疑似生图模型（' + likely.length + ' / 共 ' + all.length + '）'));
  for (var i = 0; i < likely.length; i++) box.appendChild(modelRow(likely[i]));
  if (likely.length !== all.length) {
    box.appendChild(modelSep('全部模型'));
    for (var j = 0; j < all.length; j++) {
      if (likely.indexOf(all[j]) !== -1) continue;
      box.appendChild(modelRow(all[j]));
    }
  }
  markActiveModel();
}

/* 让已选中的模型在列表里高亮 */
function markActiveModel() {
  var box = $('modelList');
  if (!box) return;
  var items = box.children;
  for (var i = 0; i < items.length; i++) {
    var v = items[i].getAttribute ? items[i].getAttribute('data-v') : '';
    if (!v) continue;
    items[i].className = v === cfg.model ? 'model-item active' : 'model-item';
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

  wireSeg('sizeTierSeg', function (v) {
    cfg.sizeTier = v;
  });
  wireSeg('protocolSeg', function (v) {
    cfg.protocol = v;
    updateProtocolHint();
  });

  $('modelList').addEventListener('click', function (ev) {
    var t = ev.target;
    var v = t && t.getAttribute ? t.getAttribute('data-v') : '';
    if (!v) return;
    $('model').value = v;
    cfg.model = v;
    store.saveConfig(cfg);
    markActiveModel();
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
