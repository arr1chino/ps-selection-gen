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
  sizeTier: '2048',
  concurrency: 2,
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
  return cfg;
}

function saveConfig(cfg) {
  try {
    localStorage.setItem(KEY_CONFIG, JSON.stringify(cfg));
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
