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

/**
 * 一条提示词要生成几张：把这句话原样复制成 N 份。
 *
 * 提示词框里放的是**一条**提示词，不是清单。所以这里做的事就是把同一句话重复 N 次，
 * 每次生成一张。想换一版，得改掉提示词再点一次生成。
 *
 * 顺手把空白收干净：里面的换行、连续空格都并成一个空格。从别处粘过来的提示词常常是
 * 断成好几行的，直接发出去会带上多余的回车，接口那边看着像两个句子。
 *
 * 提示词是空的就返回空数组，交给上层报错。
 */
function expandPrompt(text, count) {
  var p = String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!p) return [];
  var n = Math.floor(Number(count));
  if (!isFinite(n) || n < 1) n = 1;
  var out = [];
  for (var i = 0; i < n; i++) out.push(p);
  return out;
}

/**
 * 把任意东西翻成一句能上屏的话。
 *
 * 为什么需要它：Photoshop / UXP 抛出来的东西不一定是 Error。
 * executeAsModal 有时候会把里面抛的错换成没有 message 的对象（日志里就只剩一个 undefined），
 * 所以这里按 message → error.message → name → JSON → toString 的顺序挨个试，
 * 顺便把 UXP 常见的数字错误码一起附上。
 */
function describeError(e) {
  if (e === undefined || e === null) return '';
  if (typeof e === 'string') return e.trim();
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);

  var inner = e.error && typeof e.error === 'object' ? e.error : null;
  var out = '';

  if (e.message !== undefined && e.message !== null) out = String(e.message).trim();
  if (!out && inner && inner.message) out = String(inner.message).trim();
  if (!out && e.name) out = String(e.name);
  if (!out) {
    try {
      var j = JSON.stringify(e);
      if (j && j !== '{}') out = j;
    } catch (x1) {
      // 环形结构之类，继续往下试
    }
  }
  if (!out) {
    try {
      var s = String(e);
      if (s && s !== '[object Object]') out = s;
    } catch (x2) {
      // 彻底说不出来，返回空串让调用方兜底
    }
  }

  var num = e.number !== undefined && e.number !== null ? e.number : inner ? inner.number : undefined;
  if (num !== undefined && num !== null && Number(num) !== 0) {
    out = out ? out + '（代码 ' + num + '）' : '代码 ' + num;
  }
  return String(out).trim();
}

/**
 * 把文档色深归一成一个数字。
 *
 * 不同 Photoshop 版本给的形状不一样：有的是数字 8，
 * 有的是字符串 'bitDepth8'，有的是枚举对象 { _value: 'bitDepth16' }。
 * 直接拿它去和 8 比，就会把 8 位文档也算成"不是 8 位"——
 * 日志里那句「bitDepth8 位/通道的文档读选区容易失败，建议先转成 8 位」就是这么来的。
 */
function parseBitsPerChannel(v) {
  if (typeof v === 'number' && v > 0) return v;
  if (v && typeof v === 'object' && v._value !== undefined) return parseBitsPerChannel(v._value);
  var s = String(v == null ? '' : v);
  if (!s) return 0;
  if (/sixteen/i.test(s)) return 16;
  if (/thirty/i.test(s)) return 32;
  if (/eight/i.test(s)) return 8;
  var m = s.match(/(32|16|8)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 从字节长度反推"每个像素几个通道、每通道几字节"。
 *
 * 声明的 components 不一定可信（有的 UXP 版本不管实际数据是什么都报 3），
 * 而长度是硬事实：能整除就用长度推出来的那个。
 */
function guessPixelLayout(byteLength, pxCount, declaredComps) {
  var per = pxCount > 0 ? byteLength / pxCount : 0;
  if (per === 3) return { components: 3, depth: 1 };
  if (per === 4) return { components: 4, depth: 1 };
  if (per === 6) return { components: 3, depth: 2 };
  if (per === 8) return { components: 4, depth: 2 };
  return { components: declaredComps || 3, depth: 1 };
}

/**
 * 16 位字节流里哪个位置是高位字节：小端在前、大端在后。
 * 采样若干对字节比一比总和就能看出来——高位字节整体更大。
 */
function highByteOffset(bytes) {
  var pairs = Math.min(2048, Math.floor((bytes.length || 0) / 2));
  var even = 0;
  var odd = 0;
  for (var i = 0; i < pairs; i++) {
    even += bytes[i * 2];
    odd += bytes[i * 2 + 1];
  }
  return even >= odd ? 0 : 1;
}

/**
 * 把 imaging.getPixels 拿到的像素整理成"能直接交给 JPEG 编码器"的形状。
 *
 * 两件必须做的事：
 *   1) **拆掉 alpha**。JPEG 没有透明通道，带 alpha 的数据送去编码会被
 *      Photoshop 顶回来（"Image data with alpha cannot be encoded as jpeg"）。
 *   2) **统一成每通道 8 位**。部分版本会无视 componentSize: 8，
 *      把 16 位数据当字节数组返回（长度正好是 8 位情况的两倍）。
 *
 * 返回 { data, components, changed }。不需要动的时候 changed 为 false，
 * 调用方据此决定要不要重新建一个 PhotoshopImageData。
 *
 * keepAlpha 传 true 时只做位深统一、保留第 4 个通道——
 * 贴回图层那一步需要 alpha（生图可能是带透明的 PNG），只有送 JPEG 编码时才必须拆掉。
 */
function toRgb8(raw, width, height, components, keepAlpha) {
  var px = (width | 0) * (height | 0);
  if (!raw || px <= 0) return { data: raw, components: components || 3, changed: false };

  var bytes;
  if (raw instanceof Uint16Array) {
    // Photoshop 的 16 位是 0..32768，标准的是 0..65535，先看采样最大值落在哪一档
    var probe = Math.min(raw.length, 4096);
    var maxVal = 0;
    for (var i = 0; i < probe; i++) if (raw[i] > maxVal) maxVal = raw[i];
    var scale = maxVal > 0 && maxVal <= 32769 ? 32768 : 65535;
    var comps16 = components || 3;
    bytes = new Uint8Array(px * comps16);
    for (var j = 0; j < bytes.length && j < raw.length; j++) {
      bytes[j] = Math.min(255, Math.round((raw[j] * 255) / scale));
    }
  } else if (raw instanceof Float32Array) {
    var comps32 = components || 3;
    bytes = new Uint8Array(px * comps32);
    for (var k = 0; k < bytes.length && k < raw.length; k++) {
      bytes[k] = Math.round(Math.min(1, Math.max(0, raw[k])) * 255);
    }
  } else {
    bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer || raw);
  }

  var changed = bytes !== raw;
  var layout = guessPixelLayout(bytes.length, px, components);

  var solid = bytes;
  if (layout.depth === 2) {
    // 每通道两个字节 → 只留高位那一个
    var off = highByteOffset(bytes);
    solid = new Uint8Array(px * layout.components);
    for (var m = 0; m < solid.length; m++) solid[m] = bytes[m * 2 + off];
    changed = true;
  }

  if (layout.components !== 4) {
    return { data: solid, components: layout.components, changed: changed };
  }

  if (keepAlpha === true) {
    return { data: solid, components: 4, changed: changed };
  }

  // RGBA → RGB：丢掉每像素的第 4 个字节
  var rgb = new Uint8Array(px * 3);
  for (var p = 0; p < px; p++) {
    var s = p * 4;
    var d = p * 3;
    rgb[d] = solid[s];
    rgb[d + 1] = solid[s + 1];
    rgb[d + 2] = solid[s + 2];
  }
  return { data: rgb, components: 3, changed: true };
}

module.exports = {
  sleep: sleep,
  uid: uid,
  utf8Bytes: utf8Bytes,
  base64ToBytes: base64ToBytes,
  sniffImageFormat: sniffImageFormat,
  roundTo: roundTo,
  clamp: clamp,
  expandPrompt: expandPrompt,
  describeError: describeError,
  parseBitsPerChannel: parseBitsPerChannel,
  toRgb8: toRgb8
};
