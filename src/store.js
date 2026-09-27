/**
 * store.js — 配置持久化
 *
 * 分两处存：
 *   - 普通配置（地址、协议、模型、参数）→ localStorage
 *   - API Key → secureStorage（系统加密存储），拿不到就退回 localStorage
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
  if (_secure) {
    try {
      var v = await _secure.getItem(KEY_SECRET);
      if (v) return v;
    } catch (e) {
      // 忽略，退回 localStorage
    }
  }
  try {
    return localStorage.getItem(KEY_SECRET) || '';
  } catch (e2) {
    return '';
  }
}

async function saveApiKey(key) {
  if (_secure) {
    try {
      await _secure.setItem(KEY_SECRET, key || '');
      return 'secure';
    } catch (e) {
      // 忽略，退回 localStorage
    }
  }
  try {
    localStorage.setItem(KEY_SECRET, key || '');
    return 'local';
  } catch (e2) {
    return 'none';
  }
}

module.exports = {
  DEFAULTS: DEFAULTS,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  loadApiKey: loadApiKey,
  saveApiKey: saveApiKey
};
