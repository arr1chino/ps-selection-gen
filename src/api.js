/**
 * api.js — 对接生图接口
 *
 * 支持两种协议族，覆盖市面上绝大多数中转站：
 *   openai  → POST {base}/v1/images/edits        (multipart，支持带参考图)
 *   gemini  → POST {base}/v1beta/models/{model}:generateContent  (JSON，inlineData)
 *
 * 没有引入任何第三方库：UXP 里没有 npm，multipart 和 base64 都自己拼。
 */

var U = require('./util.js');

// 用来从模型列表里挑出"看起来能生图"的那些
var IMAGE_HINTS = [
  'image', 'img', 'dall', 'flux', 'sd', 'stable', 'diffusion', 'seedream',
  'banana', 'imagen', 'kolors', 'qwen-image', 'wan', 'midjourney', 'mj',
  'nano', 'gpt-4o', 'doubao', 'hunyuan', 'grok-image', 'recraft', 'ideogram',
  'luma', 'runway', 'firefly', 'kling', 'jimeng', 'draw'
];

function normalizeBase(url) {
  var b = String(url || '').trim();
  if (!b) throw new Error('还没有填写接口地址');
  b = b.replace(/\/+$/, '');
  // 允许用户顺手粘上 /v1，帮忙去掉，避免拼出 /v1/v1
  b = b.replace(/\/v1$/, '');
  return b;
}

function authHeaders(cfg) {
  var h = {};
  if (cfg.apiKey) h['Authorization'] = 'Bearer ' + cfg.apiKey;
  return h;
}

function errorText(status) {
  if (status === 401 || status === 403) return '鉴权失败（' + status + '）：Key 不对或没有该模型的权限';
  if (status === 404) return '接口不存在（404）：检查地址，或换个协议试试';
  if (status === 429) return '触发限流（429）：稍后重试或调低并发';
  if (status >= 500) return '服务端错误（' + status + '）：中转站或上游故障';
  return '请求失败（' + status + '）';
}

async function readErrorBody(resp) {
  try {
    var text = await resp.text();
    if (!text) return '';
    try {
      var j = JSON.parse(text);
      var msg = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
      if (msg) return msg;
    } catch (e) {
      // 不是 JSON，直接截一段原文
    }
    return text.slice(0, 240);
  } catch (e2) {
    return '';
  }
}

/** 把 typed array 编码成 base64（用于把下载回来的图片转成 base64） */
function bytesToBase64(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = [];
  var i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(chars[(n >> 18) & 63], chars[(n >> 12) & 63], chars[(n >> 6) & 63], chars[n & 63]);
  }
  var rest = bytes.length - i;
  if (rest === 1) {
    var n1 = bytes[i] << 16;
    out.push(chars[(n1 >> 18) & 63], chars[(n1 >> 12) & 63], '=', '=');
  } else if (rest === 2) {
    var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(chars[(n2 >> 18) & 63], chars[(n2 >> 12) & 63], chars[(n2 >> 6) & 63], '=');
  }
  return out.join('');
}

/** 拼 multipart/form-data 请求体 */
function buildMultipart(fields, file) {
  var boundary = '----selgen' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var head = [];
  var k;
  for (k in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    if (fields[k] === undefined || fields[k] === null) continue;
    head.push('--' + boundary + '\r\n');
    head.push('Content-Disposition: form-data; name="' + k + '"\r\n\r\n');
    head.push(String(fields[k]) + '\r\n');
  }
  if (file) {
    head.push('--' + boundary + '\r\n');
    head.push(
      'Content-Disposition: form-data; name="' + file.name + '"; filename="' + file.filename + '"\r\n'
    );
    head.push('Content-Type: ' + file.mime + '\r\n\r\n');
  }
  var headBytes = U.utf8Bytes(head.join(''));
  var tailBytes = U.utf8Bytes('\r\n--' + boundary + '--\r\n');
  var body = new Uint8Array(headBytes.length + (file ? file.bytes.length : 0) + tailBytes.length);
  body.set(headBytes, 0);
  if (file) body.set(file.bytes, headBytes.length);
  body.set(tailBytes, headBytes.length + (file ? file.bytes.length : 0));
  return { body: body, contentType: 'multipart/form-data; boundary=' + boundary };
}

/* ------------------------------------------------------------------ */
/*  模型列表                                                           */
/* ------------------------------------------------------------------ */

function guessIsImageModel(id) {
  var low = String(id || '').toLowerCase();
  for (var i = 0; i < IMAGE_HINTS.length; i++) {
    if (low.indexOf(IMAGE_HINTS[i]) !== -1) return true;
  }
  return false;
}

async function listModels(cfg, signal) {
  var base = normalizeBase(cfg.baseUrl);
  var attempts = [
    { url: base + '/v1/models', name: 'OpenAI 兼容 (/v1/models)' },
    { url: base + '/sdapi/v1/sd-models', name: 'A1111 (/sdapi/v1/sd-models)' }
  ];
  var lastErr = null;
  for (var i = 0; i < attempts.length; i++) {
    try {
      var resp = await fetch(attempts[i].url, {
        method: 'GET',
        headers: authHeaders(cfg),
        signal: signal
      });
      if (!resp.ok) {
        lastErr = new Error(errorText(resp.status) + ' @ ' + attempts[i].name);
        continue;
      }
      var data = await resp.json();
      var ids = extractModelIds(data);
      if (ids.length > 0) {
        return { source: attempts[i].name, ids: ids };
      }
      lastErr = new Error('接口能通，但没解析出模型名 @ ' + attempts[i].name);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('拉取模型列表失败');
}

function extractModelIds(data) {
  var ids = [];
  var push = function (v) {
    if (typeof v === 'string' && v && ids.indexOf(v) === -1) ids.push(v);
  };
  if (!data) return ids;
  var list = null;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data.models)) list = data.models;
  else if (Array.isArray(data.model_list)) list = data.model_list;
  if (!list) return ids;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (typeof item === 'string') push(item);
    else if (item) push(item.id || item.name || item.model_name || item.title);
  }
  return ids;
}

/** 优先返回像生图模型的那些；一个都没有就原样返回，交给人自己挑 */
function prioritizeImageModels(ids) {
  var hit = ids.filter(guessIsImageModel);
  return hit.length > 0 ? hit : ids.slice();
}

/* ------------------------------------------------------------------ */
/*  尺寸换算                                                           */
/* ------------------------------------------------------------------ */

function buildSize(kind, selW, selH, tier) {
  var edge = parseInt(tier, 10) || 2048;
  var w = Math.max(1, Math.round(selW));
  var h = Math.max(1, Math.round(selH));
  if (kind === 'gemini') {
    var tierName = edge >= 4096 ? '4K' : edge >= 2048 ? '2K' : '1K';
    return { imageSize: tierName, aspectRatio: simplifyRatio(w, h) };
  }
  var outW, outH;
  if (w >= h) {
    outH = edge;
    outW = U.roundTo((edge * w) / h, 16);
  } else {
    outW = edge;
    outH = U.roundTo((edge * h) / w, 16);
  }
  outW = U.clamp(outW, 256, edge * 4);
  outH = U.clamp(outH, 256, edge * 4);
  return { size: outW + 'x' + outH };
}

var COMMON_RATIOS = [
  [1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [5, 4], [4, 5], [21, 9], [9, 21]
];

function simplifyRatio(w, h) {
  var target = w / h;
  var best = COMMON_RATIOS[0];
  var bestDiff = Infinity;
  for (var i = 0; i < COMMON_RATIOS.length; i++) {
    var diff = Math.abs(COMMON_RATIOS[i][0] / COMMON_RATIOS[i][1] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = COMMON_RATIOS[i];
    }
  }
  return best[0] + ':' + best[1];
}

/* ------------------------------------------------------------------ */
/*  生成                                                               */
/* ------------------------------------------------------------------ */

/** 从各种返回结构里挖出图片 base64 */
function extractImageBase64(data) {
  if (!data) return null;
  // OpenAI 风格
  if (Array.isArray(data.data) && data.data.length > 0) {
    var d0 = data.data[0];
    if (d0 && d0.b64_json) return d0.b64_json;
    if (d0 && d0.url) return { url: d0.url };
  }
  if (data.b64_json) return data.b64_json;
  // Gemini 风格
  var cand = data.candidates && data.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) {
    for (var i = 0; i < cand.content.parts.length; i++) {
      var p = cand.content.parts[i];
      if (p && p.inlineData && p.inlineData.data) return p.inlineData.data;
      if (p && p.inline_data && p.inline_data.data) return p.inline_data.data;
    }
  }
  // 有些中转站会直接给 base64 或图片 URL
  if (typeof data.image === 'string') return data.image;
  if (typeof data.b64 === 'string') return data.b64;
  if (typeof data.result === 'string') return data.result;
  if (data.url) return { url: data.url };
  return null;
}

function extractBlockReason(data) {
  if (!data) return '';
  if (data.promptFeedback && data.promptFeedback.blockReason) return data.promptFeedback.blockReason;
  var cand = data.candidates && data.candidates[0];
  if (cand && cand.finishReason && String(cand.finishReason).toUpperCase().indexOf('SAFETY') !== -1) {
    return cand.finishReason;
  }
  return '';
}

async function downloadAsBase64(url, signal) {
  var resp = await fetch(url, { method: 'GET', signal: signal });
  if (!resp.ok) throw new Error('下载生成结果失败（' + resp.status + '）');
  var buf = await resp.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

/**
 * 生成一张图。
 * req: { prompt, imageBase64, selW, selH, tier, signal }
 * 返回 { base64 }
 */
async function generate(cfg, req) {
  var base = normalizeBase(cfg.baseUrl);
  if (!cfg.model) throw new Error('还没有选择模型');

  var sizeInfo = buildSize(cfg.protocol === 'gemini' ? 'gemini' : 'openai', req.selW, req.selH, req.tier);
  var resp;

  if (cfg.protocol === 'gemini') {
    var url = base + '/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
    var parts = [{ text: req.prompt }];
    if (req.imageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: req.imageBase64 } });
    }
    var payload = {
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        temperature: 0.9,
        imageConfig: {
          imageSize: sizeInfo.imageSize,
          aspectRatio: sizeInfo.aspectRatio
        }
      }
    };
    resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg)),
      body: JSON.stringify(payload),
      signal: req.signal
    });
  } else {
    var fields = {
      model: cfg.model,
      prompt: req.prompt,
      n: 1
    };
    if (sizeInfo.size) fields.size = sizeInfo.size;
    var file = null;
    if (req.imageBase64) {
      file = {
        name: 'image',
        filename: 'input.jpg',
        mime: 'image/jpeg',
        bytes: U.base64ToBytes(req.imageBase64)
      };
    }
    var mp = buildMultipart(fields, file);
    var headers = Object.assign({ 'Content-Type': mp.contentType }, authHeaders(cfg));
    resp = await fetch(base + '/v1/images/edits', {
      method: 'POST',
      headers: headers,
      body: mp.body,
      signal: req.signal
    });
  }

  if (!resp.ok) {
    var detail = await readErrorBody(resp);
    var err = new Error(errorText(resp.status) + (detail ? ' — ' + detail : ''));
    err.status = resp.status;
    throw err;
  }

  var data = await resp.json();

  var blocked = extractBlockReason(data);
  if (blocked) {
    throw new Error('被上游安全策略拦截（' + blocked + '），换个说法再试');
  }

  var found = extractImageBase64(data);
  if (!found) {
    var keys = Object.keys(data || {}).slice(0, 8).join(', ');
    throw new Error('返回里没找到图片数据，字段有：' + keys);
  }
  if (typeof found === 'object' && found.url) {
    return { base64: await downloadAsBase64(found.url, req.signal) };
  }
  return { base64: found };
}

module.exports = {
  listModels: listModels,
  prioritizeImageModels: prioritizeImageModels,
  generate: generate,
  buildSize: buildSize,
  normalizeBase: normalizeBase
};
