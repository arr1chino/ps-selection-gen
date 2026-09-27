/**
 * util.js — 零依赖工具函数
 */

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function uid(prefix) {
  return (prefix || 't') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/** 把 JS 字符串编码成 UTF-8 字节（UXP 各版本对 TextEncoder 支持不一致，自己来） */
function utf8Bytes(str) {
  var bytes = [];
  var s = String(str == null ? '' : str);
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      // 代理对 → 4 字节
      var code2 = s.charCodeAt(i + 1);
      var cp = 0x10000 + ((code - 0xd800) << 10) + (code2 - 0xdc00);
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
      i++;
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_LOOKUP = (function () {
  var map = {};
  for (var i = 0; i < B64_CHARS.length; i++) map[B64_CHARS[i]] = i;
  return map;
})();

/** base64 字符串 → Uint8Array（不依赖 atob，UXP 上更稳） */
function base64ToBytes(b64) {
  var clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/[\s\r\n]/g, '');
  var pad = 0;
  while (clean.length > 0 && clean.charAt(clean.length - 1) === '=') {
    pad++;
    clean = clean.slice(0, -1);
  }
  var outLen = Math.floor((clean.length * 3) / 4);
  var out = new Uint8Array(outLen);
  var buf = 0;
  var bits = 0;
  var pos = 0;
  for (var i = 0; i < clean.length; i++) {
    var v = B64_LOOKUP[clean.charAt(i)];
    if (v === undefined) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (pos < outLen) out[pos++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * 从字节头判断图片格式。
 * 生成接口返回的 base64 有时是 png 有时是 jpeg，扩展名写错 Photoshop 会打不开。
 */
function sniffImageFormat(bytes) {
  if (!bytes || bytes.length < 4) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return { ext: 'png', mime: 'image/png' };
}

/** 取整到 n 的倍数（部分生图接口要求尺寸是 16/64 的倍数） */
function roundTo(value, n) {
  var v = Math.round(value / n) * n;
  return v < n ? n : v;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

module.exports = {
  sleep: sleep,
  uid: uid,
  utf8Bytes: utf8Bytes,
  base64ToBytes: base64ToBytes,
  sniffImageFormat: sniffImageFormat,
  roundTo: roundTo,
  clamp: clamp
};
