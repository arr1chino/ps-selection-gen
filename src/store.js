/**
 * store.js — 配置持久化
 *
 * 分两处存：
 *   - 普通配置（地址、协议、模型、参数）→ localStorage
 *   - API Key → 加密存储（uxp secureStorage）与 localStorage **同时写**
 *
 * 为什么 Key 要写两份：secureStorage 在部分环境下会「写进去不报错、下次读却读不到」
 * （插件没签名、或宿主版本对它的支持不完整时都会这样），而原来的逻辑是
 * 「加密存储成功就不再写 localStorage」，于是重启后两边都空，只能重新填一次。
 * 现在两边都写、读取时两边都试，只要有一个活着，Key 就不会丢。
 * 代价是 Key 在本机有一份明文副本——这是本机单用户使用的插件，可以接受；
 * 换成"更安全但存不住"没有意义。
 */

var uxp = require('uxp');

var KEY_CONFIG = 'selectiongen.config.v1';
var KEY_SECRET = 'selectiongen.apikey.v1';

var DEFAULTS = {
  baseUrl: '',
  protocol: 'openai',
  model: '',
  /* 拉取到的生图模型列表。存在配置里，重启后主界面的下拉框还能直接用，
     不用每次开面板都重新拉一遍。 */
  imageModels: [],
  sizeTier: '2048',
  /* 这条提示词生成几张（老配置里的字段叫 concurrency，读的时候会接过来）。 */
  count: 1,
  timeout: 180
};

var _secure = null;
try {
  _secure = uxp.storage.secureStorage;
} catch (e) {
  _secure = null;
}

function loadConfig() {
  var raw = null;
  try {
    raw = localStorage.getItem(KEY_CONFIG);
  } catch (e) {
    raw = null;
  }
  var cfg = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = DEFAULTS[k];
  }
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      for (var k2 in parsed) {
        if (Object.prototype.hasOwnProperty.call(parsed, k2)) cfg[k2] = parsed[k2];
      }
    } catch (e2) {
      // 配置损坏就回到默认值，不要让插件起不来
    }
  }
  // cfg.apiKey 是运行时字段（每次发请求前由面板填好），
  // 它的持久化位置是下面的 KEY_SECRET，不该从配置 blob 里读回来
  delete cfg.apiKey;
  return cfg;
}

/*
 * 落盘前把 apiKey 剔掉。
 * 这份配置在每个小动作里都会被重写（点一次模型、存一次设置），
 * 让 Key 跟着在第二个地方多留一份，既没必要，也容易和真正的
 * Key 存储不一致（改了 Key 而这份还是旧的）。
 */
function saveConfig(cfg) {
  try {
    var out = {};
    for (var k in cfg) {
      if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
      if (k === 'apiKey') continue;
      out[k] = cfg[k];
    }
    localStorage.setItem(KEY_CONFIG, JSON.stringify(out));
    return true;
  } catch (e) {
    return false;
  }
}

async function loadApiKey() {
  var info = await loadApiKeyDetailed();
  return info.key;
}

/**
 * 同 loadApiKey，但多告诉调用方"是从哪儿读到的"，方便启动时写一行日志。
 * 返回 { key, from }，from 取值：'local' / 'secure' / ''（没存过）
 */
async function loadApiKeyDetailed() {
  // localStorage 是同步读、最不容易出岔子，先问它
  try {
    var local = localStorage.getItem(KEY_SECRET);
    if (local) return { key: local, from: 'local' };
  } catch (e) {
    // 读不到就往下问
  }
  if (_secure) {
    try {
      var v = await _secure.getItem(KEY_SECRET);
      if (v) return { key: v, from: 'secure' };
    } catch (e2) {
      // 忽略
    }
  }
  return { key: '', from: '' };
}

/**
 * 存 Key。两边都写，返回一句能直接读的中文，说明存到哪儿了。
 */
async function saveApiKey(key) {
  var v = key || '';
  var okLocal = false;
  var okSecure = false;

  try {
    localStorage.setItem(KEY_SECRET, v);
    okLocal = true;
  } catch (eL) {
    // 本地存储不可用（极少见）
  }
  if (_secure) {
    try {
      await _secure.setItem(KEY_SECRET, v);
      okSecure = true;
    } catch (eS) {
      // 加密存储不可用就只靠本地存储
    }
  }

  if (okSecure && okLocal) return '加密存储 + 本地存储';
  if (okLocal) return '本地存储';
  if (okSecure) return '加密存储';
  return '存不下来';
}

module.exports = {
  DEFAULTS: DEFAULTS,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  loadApiKey: loadApiKey,
  loadApiKeyDetailed: loadApiKeyDetailed,
  saveApiKey: saveApiKey
};
