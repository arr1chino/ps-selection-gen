/**
 * api.js — 对接生图接口
 *
 * 支持三种协议族，覆盖市面上绝大多数中转站：
 *   openai  → POST {base}/v1/images/edits                        (multipart，支持带参考图)
 *   gemini  → POST {base}/v1beta/models/{model}:generateContent  (JSON，inlineData)
 *   chat    → POST {base}/v1/chat/completions                    (JSON，对话式出图)
 *
 * 第三种是给「只在对话接口里提供出图能力」的模型留的，
 * nano banana（gemini-2.5-flash-image / gemini-3-pro-image）在中转站上大多是这个形状。
 *
 * 没有引入任何第三方库：UXP 里没有 npm，multipart 和 base64 都自己拼。
 *
 * 另外：不同模型对「可选字段」的容忍度不一样（有的见到 imageConfig 直接 400）。
 * 所以每个协议都列了几个"变体"，只在报错明确指向某个字段时才降级重试，最多多花一次请求。
 */

var U = require('./util.js');

// 用来从模型列表里挑出"看起来能生图"的那些
/*
 * 判断"这个模型能不能生图"。
 *
 * 用的是**只认生图特征**的思路：名字里出现生图线索才留下，其余一律过滤掉。
 * 也就是说没匹配上的（不认识的模型）当作不能用——宁可漏，不滥。
 * 漏掉的那些由主界面「手打模型名」兜底。
 *
 * 之前的老写法是"优先展示像生图的、一个都没有就原样返回全部"，
 * 结果把 gpt-4o 这类纯文字模型也当成生图模型塞进列表里。
 */

/* 这些词够独特，出现在名字里就算数 */
var IMAGE_WORDS = [
  'image', 'img', 'dall', 'flux', 'diffusion', 'sdxl', 'sd3', 'sd15',
  'sd-turbo', 'stable-diffusion', 'seedream', 'seededit', 'banana', 'nano',
  'imagen', 'kolors', 'cogview', 'janus', 'lumina', 'hidream', 'recraft',
  'ideogram', 'midjourney', 'doubao', 'hunyuan', 'playground', 'kandinsky',
  'krea', 'photon', 'wanx', 'draw', 'paint'
];

/* 这几个太短或者太通用（sd、mj、wan），要求前后是分隔符或结尾才算数，
   免得匹配到无关的词里去 */
var IMAGE_WORDS_BOUNDED = ['sd', 'mj', 'wan'];

function guessIsImageModel(id) {
  var low = String(id || '').toLowerCase();
  if (!low) return false;
  for (var i = 0; i < IMAGE_WORDS.length; i++) {
    if (low.indexOf(IMAGE_WORDS[i]) !== -1) return true;
  }
  for (var j = 0; j < IMAGE_WORDS_BOUNDED.length; j++) {
    var w = IMAGE_WORDS_BOUNDED[j];
    var re = new RegExp('(^|[-_/])' + w + '([-_/0-9.]|$)');
    if (re.test(low)) return true;
  }
  return false;
}

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

/**
 * 只留下像生图模型的那些，纯文字模型（gpt-4o、deepseek-chat、embedding……）全部丢掉。
 * 一个都没匹配上就返回空数组——界面据此提示"去手打模型名"。
 */
function filterImageModels(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter(guessIsImageModel);
}

/* ------------------------------------------------------------------ */
/*  尺寸换算                                                           */
/* ------------------------------------------------------------------ */

function buildSize(kind, selW, selH, tier) {
  // 对话式接口不带尺寸参数，出多大由模型决定
  if (kind === 'chat') return {};
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

// 只列 Gemini imageConfig 真正接受的比例。
// 多列一个不被支持的比例，用户框一条细长选区就会吃到 400，不如就近取一个能用的。
var COMMON_RATIOS = [
  [1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [5, 4], [4, 5], [21, 9]
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

/** "data:image/png;base64,XXXX" → "XXXX"；其它原样返回 */
function stripDataUrl(s) {
  if (typeof s !== 'string') return s;
  if (s.indexOf('data:') !== 0) return s;
  var i = s.indexOf('base64,');
  return i === -1 ? s : s.slice(i + 7);
}

/** 一个字符串可能是 base64、可能是图片 URL，也可能是 data URL，统一成两者之一 */
function asImageOrUrl(s) {
  if (typeof s !== 'string' || !s) return null;
  if (s.indexOf('data:') === 0) return stripDataUrl(s);
  if (/^https?:\/\//i.test(s)) return { url: s };
  return s;
}

/**
 * 从一段正文里抠出图片。
 *
 * 有些中转站不按图片字段返回，而是**把图当正文发回来**，写成
 *   ![image](data:image/png;base64,....)
 * Gemini 路线上它出现在 candidates[].content.parts[].text 里，
 * 对话式路线上出现在 message.content 里。只认 inlineData 就会
 * "图明明出了，插件却说没找到"。
 *
 * 只认真正的 data URL（必须带 `;base64,`），这样正文里顺口提一句
 * "data:image/png" 不会被误当成图。
 */
function scrapeImageFromText(text) {
  if (typeof text !== 'string' || !text) return null;

  var m = /data:image\/(png|jpe?g|webp|avif);base64,/i.exec(text);
  if (m) {
    var from = m.index + m[0].length;
    var chars = '';
    for (var i = from; i < text.length; i++) {
      var ch = text.charAt(i);
      // 有的站会把 base64 折行，换行当作"没有"、接着往下收
      if (ch === '\n' || ch === '\r' || ch === '\t') continue;
      var isB64 =
        (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
        (ch >= '0' && ch <= '9') || ch === '+' || ch === '/' || ch === '=';
      if (!isB64) break; // 碰到 ) 、引号、空格这类分隔符就收工
      chars += ch;
    }
    // 太短的当作没找到，避免把正文里的半句话当成图
    if (chars.length >= 8) return chars;
  }

  // 正文里给外链的也有，交给调用方去下载
  var u = text.match(/https?:\/\/[^\s"'<>()]+\.(?:png|jpe?g|webp|avif)/i);
  if (u) return { url: u[0] };
  return null;
}

/** 从各种返回结构里挖出图片 base64（或一个待下载的 URL） */
function extractImageBase64(data) {
  if (!data) return null;
  // OpenAI 图片接口风格
  if (Array.isArray(data.data) && data.data.length > 0) {
    var d0 = data.data[0];
    if (d0 && d0.b64_json) return stripDataUrl(d0.b64_json);
    if (d0 && d0.url) return { url: d0.url };
  }
  if (data.b64_json) return stripDataUrl(data.b64_json);

  // OpenAI 对话式：nano banana 之类在中转站上常走这条路，
  // 图片挂在 choices[0].message.images[] 里
  var choice = data.choices && data.choices[0];
  if (choice) {
    var msg = choice.message || choice.delta || {};
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      var im = msg.images[0] || {};
      var iu = (im.image_url && (im.image_url.url || im.image_url)) || im.url || im.b64_json || im.image;
      var got = asImageOrUrl(iu);
      if (got) return got;
    }
    if (Array.isArray(msg.content)) {
      for (var ci = 0; ci < msg.content.length; ci++) {
        var cp = msg.content[ci];
        if (!cp) continue;
        var cu = (cp.image_url && cp.image_url.url) || cp.image || (cp.inlineData && cp.inlineData.data) ||
          (cp.inline_data && cp.inline_data.data);
        var got2 = asImageOrUrl(cu);
        if (got2) return got2;
      }
    }
    // 有的站干脆把图片塞在正文里，形如 ![](data:image/png;base64,...)
    var fromChatText = scrapeImageFromText(msg.content);
    if (fromChatText) return fromChatText;
  }

  // Gemini 风格
  var cands = Array.isArray(data.candidates) ? data.candidates : [];
  for (var ci = 0; ci < cands.length; ci++) {
    var cand = cands[ci];
    if (!cand || !cand.content || !Array.isArray(cand.content.parts)) continue;
    for (var i = 0; i < cand.content.parts.length; i++) {
      var p = cand.content.parts[i];
      if (!p) continue;
      if (p.inlineData && p.inlineData.data) return stripDataUrl(p.inlineData.data);
      if (p.inline_data && p.inline_data.data) return stripDataUrl(p.inline_data.data);
      // 图被当成正文发回来：parts[].text 里就是一段 ![](data:image/png;base64,...)
      var fromPart = scrapeImageFromText(p.text);
      if (fromPart) return fromPart;
    }
  }
  // 有些中转站会直接给 base64 或图片 URL
  var direct = asImageOrUrl(data.image) || asImageOrUrl(data.b64) || asImageOrUrl(data.result);
  if (direct) return direct;
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
 * 上游不认某个字段时会回 400，并且正文里会点名那个字段。
 * 只有这种错误才值得"换个写法重发一次"，其它 400 重发也是浪费一次请求。
 */
function isUnknownFieldError(status, detail, field) {
  if (status !== 400 && status !== 422) return false;
  var low = String(detail || '').toLowerCase();
  var looksLikeFieldProblem =
    low.indexOf('unknown name') !== -1 ||
    low.indexOf('cannot find field') !== -1 ||
    low.indexOf('unknown field') !== -1 ||
    low.indexOf('unrecognized') !== -1 ||
    low.indexOf('unsupported') !== -1 ||
    low.indexOf('not supported') !== -1 ||
    low.indexOf('invalid') !== -1;
  if (!looksLikeFieldProblem) return false;
  return low.indexOf(String(field).toLowerCase()) !== -1;
}

/**
 * 列出一个协议下要依次尝试的请求变体。
 * 第一个是"最全的那个"，后面的都带着 drops：只有报错点名了这些字段才会走到它。
 */
function buildAttempts(protocol, cfg, req, base, sizeInfo) {
  if (protocol === 'gemini') {
    var gurl = base + '/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
    var parts = [{ text: req.prompt }];
    if (req.imageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: req.imageBase64 } });
    }
    var contents = [{ role: 'user', parts: parts }];
    var payload = function (modalities, withImageConfig) {
      var gc = { responseModalities: modalities, temperature: 0.9 };
      if (withImageConfig) {
        gc.imageConfig = { imageSize: sizeInfo.imageSize, aspectRatio: sizeInfo.aspectRatio };
      }
      return { contents: contents, generationConfig: gc };
    };
    var p1 = payload(['IMAGE'], true);
    var p2 = payload(['TEXT', 'IMAGE'], true);
    var p3 = payload(['TEXT', 'IMAGE'], false);
    return [
      { url: gurl, payload: p1 },
      { url: gurl, payload: p2, drops: ['responseModalities', 'response_modalities'] },
      { url: gurl, payload: p3, drops: ['imageConfig', 'image_config', 'image_size', 'aspectRatio'] }
    ];
  }

  if (protocol === 'chat') {
    var curl = base + '/v1/chat/completions';
    var content = [{ type: 'text', text: req.prompt }];
    if (req.imageBase64) {
      content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + req.imageBase64 } });
    }
    var cbase = { model: cfg.model, messages: [{ role: 'user', content: content }] };
    var cfull = {};
    var k;
    for (k in cbase) {
      if (Object.prototype.hasOwnProperty.call(cbase, k)) cfull[k] = cbase[k];
    }
    // OpenRouter 一类要求显式声明要图；不认这个字段的站会回 400，那就退回不带它的写法
    cfull.modalities = ['image', 'text'];
    return [
      { url: curl, payload: cfull },
      { url: curl, payload: cbase, drops: ['modalities'] }
    ];
  }

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
  return [{
    url: base + '/v1/images/edits',
    headers: Object.assign({ 'Content-Type': mp.contentType }, authHeaders(cfg)),
    body: mp.body
  }];
}

/** 按顺序发；只有"字段不被认识"的报错才继续下一个变体，别的一律当场停下 */
async function sendAttempts(attempts, cfg, signal) {
  var lastResp = null;
  var lastDetail = '';

  for (var i = 0; i < attempts.length; i++) {
    var a = attempts[i];
    var resp;
    if (a.body) {
      resp = await fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, signal: signal });
    } else {
      resp = await fetch(a.url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg)),
        body: JSON.stringify(a.payload),
        signal: signal
      });
    }
    if (resp.ok) return resp;

    lastResp = resp;
    lastDetail = await readErrorBody(resp);

    var next = attempts[i + 1];
    if (!next || !next.drops) break;
    var worthRetry = false;
    for (var d = 0; d < next.drops.length; d++) {
      if (isUnknownFieldError(resp.status, lastDetail, next.drops[d])) {
        worthRetry = true;
        break;
      }
    }
    if (!worthRetry) break;
  }

  var err = new Error(errorText(lastResp.status) + (lastDetail ? ' — ' + lastDetail : ''));
  err.status = lastResp.status;
  throw err;
}

/**
 * 生成一张图。
 * req: { prompt, imageBase64, selW, selH, tier, signal }
 * 返回 { base64 }
 */
async function generate(cfg, req) {
  var base = normalizeBase(cfg.baseUrl);
  if (!cfg.model) throw new Error('还没有选择模型');

  var protocol = cfg.protocol === 'gemini' ? 'gemini' : cfg.protocol === 'chat' ? 'chat' : 'openai';
  var sizeInfo = buildSize(protocol, req.selW, req.selH, req.tier);
  var resp = await sendAttempts(buildAttempts(protocol, cfg, req, base, sizeInfo), cfg, req.signal);

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
  filterImageModels: filterImageModels,
  generate: generate,
  buildSize: buildSize,
  normalizeBase: normalizeBase,
  // 下面几个是为了能脱离 Photoshop 单独测（见 test/test-core.js）
  guessIsImageModel: guessIsImageModel,
  extractImageBase64: extractImageBase64,
  stripDataUrl: stripDataUrl,
  isUnknownFieldError: isUnknownFieldError,
  buildAttempts: buildAttempts,
  authHeaders: authHeaders,
  scrapeImageFromText: scrapeImageFromText
};
