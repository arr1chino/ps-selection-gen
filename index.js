/**
 * index.js — 面板入口：把 UI 和上面几个模块接起来
 */

var store = require('./src/store.js');
var api = require('./src/api.js');
var queueLib = require('./src/queue.js');
var pipeline = require('./src/pipeline.js');
var U = require('./src/util.js');

function $(id) {
  return document.getElementById(id);
}

var cfg = store.loadConfig();
/* 旧配置里这个字段叫 concurrency（原来表示"同时跑几个"），现在这个数字的含义
   变成了"这条提示词生成几张"。含义虽然变了，值可以直接沿用（原来一张就是一个任务），
   所以这里只补一个新名字，不动老的值。 */
if (cfg.count === undefined) cfg.count = cfg.concurrency;
var tasks = queueLib.createTaskManager(renderTasks);
var pool = queueLib.createPool(cfg.count);
var psLock = queueLib.createPSLock();
var running = false;
var modelsAll = [];
/* 上一次存过的 Key。用来避免每次失焦都重复写盘、重复刷日志。 */
var lastSavedKey = '';

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

/* 设置页「拉取模型列表」按钮下面的一行即时反馈。
   设置页打开时主界面是收起的，日志在另一视图里，点按钮必须就近给结果。 */
function setPullState(text, kind) {
  var el = $('pullState');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind === 'err' ? ' bad' : kind === 'ok' ? ' good' : '');
}

/* 设置页「当前状态」那行：保存的结果写在这里。
   设置页打开时主界面是收起的，日志看不见，反馈必须落在本页。 */
function setSettingsState(text, kind) {
  var el = $('settingsState');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind === 'err' ? ' bad' : kind === 'ok' ? ' good' : '');
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
      : '共 ' + c.total + '｜排队 ' + c.queued + '｜进行 ' + ((c.running || 0) + (c.pasting || 0)) + '｜完成 ' + c.done +
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
  cfg.count = Math.max(1, Math.min(8, parseInt($('count').value, 10) || 1));
  cfg.timeout = Math.max(10, Math.min(900, parseInt($('timeout').value, 10) || 180));
  return cfg;
}

function fillForm() {
  $('baseUrl').value = cfg.baseUrl || '';
  setSeg('protocolSeg', cfg.protocol || 'openai');
  $('model').value = cfg.model || '';
  setSeg('sizeTierSeg', cfg.sizeTier || '2048');
  $('count').value = cfg.count || 1;
  $('timeout').value = cfg.timeout || 180;
  updateProtocolHint();
}

/* 「张数」右端那对上下箭头：按一下 ±1。
 *
 * 这个数字的含义是「这一句提示词生成几张」，不是"同时跑几个"。
 * 边界直接用输入框自己写的 min / max，不在代码里再抄一份，
 * 免得以后改了刻度两处对不上。
 * 改完立刻落盘；正在跑的那批已经按老张数排好队了，下一批生效。
 */
function stepCount(delta) {
  var el = $('count');
  if (!el) return;
  var min = parseInt(el.getAttribute('min'), 10);
  var max = parseInt(el.getAttribute('max'), 10);
  if (!isFinite(min)) min = 1;
  if (!isFinite(max)) max = 8;
  var now = parseInt(el.value, 10);
  if (!isFinite(now)) now = min;
  var next = Math.max(min, Math.min(max, now + delta));
  el.value = next;
  cfg.count = next;
  store.saveConfig(cfg);
}

/* 取这次请求要用的 API Key，并把它挂到 cfg.apiKey 上。
 *
 * 这个函数是补一个实打实的漏洞：api.js 的鉴权头只认 cfg.apiKey，
 * 但之前面板里没有任何一处给它赋过值——输入框里填了、也存盘了，
 * 就是没进 cfg，于是生成请求是裸着发出去的，中转站一律回
 * 401 Invalid token。而「拉取模型列表」那条路是自己现拼了
 * { baseUrl, apiKey } 传进去的，所以它能通、生成不能通。
 *
 * 取值顺序：输入框优先；输入框空着（读回来失败、被清掉等）就回落到
 * 存过的那份，并顺手回填输入框，免得再出现「明明存过却当成没填」。
 */
async function resolveApiKey() {
  var el = $('apiKey');
  var typed = el ? String(el.value || '').trim() : '';
  if (typed) {
    if (typed !== lastSavedKey) {
      lastSavedKey = typed;
      await store.saveApiKey(typed);
    }
    cfg.apiKey = typed;
    return typed;
  }

  var info = await store.loadApiKeyDetailed();
  if (info.key) {
    if (el) el.value = info.key;
    lastSavedKey = info.key;
    cfg.apiKey = info.key;
    log(
      '输入框里没读到 Key，改用上次存过的（来自' +
        (info.from === 'secure' ? '加密存储' : '本地存储') +
        '，共 ' + info.key.length + ' 个字符）',
      'info'
    );
    return info.key;
  }

  cfg.apiKey = '';
  return '';
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

/* 顶部状态条 + 设置页状态行。
   模型的选择和当前值都放在主界面「① 模型」那块，这里只说配好没有，
   顶部不再重复模型名，免得同一件事在两个地方各写一份、还会不一致。 */
function updateApiState() {
  var hasUrl = !!cfg.baseUrl;
  var ready = !!(cfg.baseUrl && cfg.model);

  var bar = $('apiState');
  if (bar) {
    bar.textContent = ready ? '已配置' : hasUrl ? '已填地址，未选模型' : '未配置 API（点右上角「设置」）';
    bar.className = ready ? 'ok' : '';
  }
  var box = $('settingsState');
  if (box) {
    box.className = 'hint';
    box.textContent = ready
      ? '已配置：' + cfg.baseUrl + ' ｜ 协议 ' + (cfg.protocol || 'openai') +
        '。当前模型 ' + cfg.model + '，在主界面最上面那块切换。'
      : hasUrl
        ? '地址已填。回到主界面最上面那块「模型」里拉取并选一个模型。'
        : '还没配好。至少要填「接口地址」并选定「模型」，才能生成。';
  }
  markActiveModel();
}

/* ------------------------------------------------------------------ */
/*  按钮                                                              */
/* ------------------------------------------------------------------ */

async function onSaveConfig() {
  readForm();
  var stored = store.saveConfig(cfg);
  // Key 末尾多一个空格就会认证失败，统一去掉首尾空白再存
  var keyToSave = $('apiKey').value.trim();
  $('apiKey').value = keyToSave;
  var where = await store.saveApiKey(keyToSave);
  lastSavedKey = keyToSave;
  // 必须同步进 cfg：真正发请求时读的是 cfg.apiKey，只停在输入框里没用
  cfg.apiKey = keyToSave;
  updateApiState();
  if (!stored) {
    setSettingsState('配置写入本地失败', 'err');
    log('配置写入本地失败', 'err');
    return;
  }
  if (where === '存不下来') {
    setSettingsState('地址和模型已保存，但 Key 没存下来——关掉面板就要重填。', 'err');
    log('Key 没存下来：本地存储和加密存储都用不了', 'err');
    return;
  }
  setSettingsState('已保存（Key 存储位置：' + where + '）。回主界面拉取并选模型。', 'ok');
  log('配置已保存（Key 存储位置：' + where + '）', 'ok');
}

/* 下拉框展开 / 收起。收起时整块不占地方，免得长列表把提示词和按钮顶走。 */
function openModelPick(on) {
  var wrap = $('modelPickWrap');
  if (wrap) wrap.className = on ? '' : 'hidden';
}

function modelPickOpen() {
  var wrap = $('modelPickWrap');
  return !!(wrap && wrap.className.indexOf('hidden') === -1);
}

async function onPullModels() {
  readForm();
  if (!cfg.baseUrl) {
    setPullState('上面「接口地址」还没填，填好再拉取。', 'err');
    log('还没填接口地址：设置页「接口地址」那一栏', 'err');
    return;
  }
  var keyNow = await resolveApiKey();
  if (!keyNow) {
    setPullState('上面「API Key」还没填，填好再拉取。', 'err');
    log('还没填 API Key：设置页「API Key」那一栏', 'err');
    return;
  }
  cfg.apiKey = keyNow;
  var btn = $('btnPullModels');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  setPullState('拉取中…（最多等 15 秒）');

  // 拉之前先把 Key 落盘：不然拉完直接关面板，刚填的 Key 又没了。
  if (keyNow !== lastSavedKey) {
    var where = await store.saveApiKey(keyNow);
    lastSavedKey = keyNow;
    log('API Key 已保存（' + where + '）', 'ok');
  }

  // 拉取也要有超时：地址不通时不给超时，按钮会永远停在「拉取中…」。
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 15000);

  try {
    var res = await api.listModels({ baseUrl: cfg.baseUrl, apiKey: keyNow }, controller.signal);
    modelsAll = res.ids;
    // 只留生图模型，纯文字模型（gpt-4o / deepseek-chat / embedding……）全丢掉
    var picked = api.filterImageModels(modelsAll);
    cfg.imageModels = picked;
    store.saveConfig(cfg);
    renderModelList();
    updateApiState();
    if (picked.length) {
      setPullState(
        '拉取成功：' + modelsAll.length + ' 个模型里筛出 ' + picked.length + ' 个生图模型。回主界面，在最上面那个下拉框里选。',
        'ok'
      );
      log(
        '拉取成功（' + res.source + '）：共 ' + modelsAll.length + ' 个模型，筛出 ' + picked.length +
          ' 个生图模型，回主界面下拉框选',
        'ok'
      );
    } else {
      setPullState(
        '接口能通，但 ' + modelsAll.length +
          ' 个模型里没认出哪个能生图。回主界面点开下拉框，用下面的「手打」直接填模型名。',
        'err'
      );
      log('拉取成功（' + res.source + '），但没筛出能生图的模型，请在主界面手打模型名', 'warn');
    }
  } catch (e) {
    var msg = U.describeError(e) || '拉取失败，但没拿到原因';
    if (controller.signal.aborted) {
      msg = '等了 15 秒没回应：地址不通、网络被挡，或 Key 无效';
    } else {
      msg = friendlyNetError(msg, cfg.baseUrl);
    }
    setPullState('拉取失败：' + msg, 'err');
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

function modelRow(value) {
  var d = document.createElement('div');
  d.className = 'model-item';
  d.setAttribute('data-v', value);
  d.textContent = value;
  return d;
}

/* 列表只画「拉取时筛出来的生图模型」，没拉过就留一句提示。 */
function renderModelList() {
  var box = $('modelList');
  if (!box) return;
  box.innerHTML = '';
  var list = cfg.imageModels || [];
  if (!list.length) {
    var empty = document.createElement('div');
    empty.className = 'model-item empty';
    empty.textContent = '（还没拉取：去「设置」里点「拉取模型列表」）';
    box.appendChild(empty);
    syncModelLabel();
    return;
  }
  for (var i = 0; i < list.length; i++) box.appendChild(modelRow(list[i]));
  markActiveModel();
  syncModelLabel();
}

/* 收起状态下那一行显示的当前模型名 */
function syncModelLabel() {
  var el = $('modelValue');
  if (!el) return;
  var v = cfg.model || '';
  el.textContent = v || '未选择 —— 先去「设置」拉取模型列表';
  el.className = v ? 'pick-v' : 'pick-v empty';
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
  if (!cfg.baseUrl) {
    log('还没配好接口：先在「设置」里填接口地址', 'err');
    openSettings();
    return;
  }
  if (!cfg.model) {
    log('还没选模型：先去「设置」点「拉取模型列表」，再回主界面下拉框选一个，或点开下拉框用「手打」填', 'err');
    return;
  }
  // 没 Key 就别发了：裸着发出去一定是一句看不懂的 401，不如当场说清楚去哪填。
  // （这里之前是个坑：输入框的值读出来存了盘，就是没进 cfg.apiKey。）
  var keyNow = await resolveApiKey();
  if (!keyNow) {
    log('还没填 API Key：点右上角「设置」，在「API Key」那一栏填好再生成', 'err');
    openSettings();
    return;
  }
  store.saveConfig(cfg);
  log('本次请求携带 API Key：共 ' + keyNow.length + ' 个字符', 'info');

  // 提示词框里就一条。张数按「这句生成几张」在 pipeline 里复制成 N 个任务。
  running = true;
  setBusy(true);
  try {
    var summary = await pipeline.runBatch(
      { cfg: cfg, tasks: tasks, pool: pool, psLock: psLock, log: log },
      $('prompt').value
    );
    log('这一批结束：成功 ' + summary.okCount + ' / 失败 ' + summary.failCount, summary.failCount ? 'warn' : 'ok');
  } catch (e) {
    log('这一批没能启动：' + (U.describeError(e) || 'Photoshop 拒绝了这次操作，但没给出原因'), 'err');
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
  var keyInfo = await store.loadApiKeyDetailed();
  if (keyInfo.key) {
    $('apiKey').value = keyInfo.key;
    lastSavedKey = keyInfo.key;
    log(
      '已读取上次保存的 API Key（来自' +
        (keyInfo.from === 'secure' ? '加密存储' : '本地存储') +
        '，共 ' + keyInfo.key.length + ' 个字符）',
      'ok'
    );
  } else {
    log('本地还没存过 API Key。填一次就会自动保存，之后不用再填。', 'warn');
  }

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

  // 张数的上下箭头：点一下加/减一张，取值范围还是输入框里的 1–8
  $('countUp').addEventListener('click', function () {
    stepCount(1);
  });
  $('countDown').addEventListener('click', function () {
    stepCount(-1);
  });

  // 点收起状态那一行 → 展开 / 收起下面的模型列表
  $('modelPick').addEventListener('click', function () {
    openModelPick(!modelPickOpen());
  });

  $('modelList').addEventListener('click', function (ev) {
    var t = ev.target;
    var v = t && t.getAttribute ? t.getAttribute('data-v') : '';
    if (!v) return;
    $('model').value = v;
    cfg.model = v;
    store.saveConfig(cfg);
    markActiveModel();
    syncModelLabel();
    updateApiState();
    log('已选模型：' + v, 'ok');
    openModelPick(false);
  });

  // 手打的模型名也要落盘：不然关掉面板再打开就丢了。
  var commitModel = function () {
    var v = $('model').value.trim();
    if (v === cfg.model) return;
    cfg.model = v;
    store.saveConfig(cfg);
    markActiveModel();
    syncModelLabel();
    updateApiState();
  };
  $('model').addEventListener('change', commitModel);
  $('model').addEventListener('blur', commitModel);

  // Key 也自动保存：填完离开输入框就落盘，不用去点「保存配置」。
  // 之前只在点保存或点生成时才写，人填完直接关面板，Key 就没了。
  var commitKey = async function () {
    var v = $('apiKey').value.trim();
    if (v === lastSavedKey) return;
    var where = await store.saveApiKey(v);
    lastSavedKey = v;
    cfg.apiKey = v;
    if (where === '存不下来') {
      setSettingsState('Key 没存下来：本地存储和加密存储都用不了。', 'err');
      log('Key 没存下来：本地存储和加密存储都用不了', 'err');
      return;
    }
    log('API Key 已自动保存（' + where + '）', 'ok');
  };
  $('apiKey').addEventListener('change', commitKey);
  $('apiKey').addEventListener('blur', commitKey);

  renderModelList();
  openModelPick(false);
  syncModelLabel();
  renderTasks(tasks.list());
  updateApiState();
  log('面板已就绪', 'ok');
  log('用法：点右上角「设置」填接口地址和 Key → 点「拉取模型列表」 → 回主界面下拉框选模型 → 写提示词 → 在 PS 里框选 → 从选区生成', 'info');
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
