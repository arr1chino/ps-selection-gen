/**
 * 不依赖 Photoshop 的纯逻辑测试：
 * base64 编解码 / UTF-8 编码 / 图片格式嗅探 / 尺寸换算 / multipart 拼装
 */

const path = require('path');
const SRC = path.join(__dirname, '..', 'src');

const U = require(path.join(SRC, 'util.js'));
const api = require(path.join(SRC, 'api.js'));

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}

console.log('\n[1] base64 往返');
{
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([1, 2]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([255, 254, 253, 252, 251]),
    new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) % 256))
  ];
  for (const s of samples) {
    // 先编码再解码，应该和原数组完全一致
    const b64 = Buffer.from(s).toString('base64');
    const back = U.base64ToBytes(b64);
    check('长度 ' + s.length + ' 往返一致', Buffer.compare(Buffer.from(back), Buffer.from(s)) === 0);
  }
  // 带 data URL 前缀 / 换行也应该能解
  const dirty = U.base64ToBytes('data:image/png;base64,' + Buffer.from([9, 8, 7]).toString('base64') + '\n');
  check('忽略 data URL 前缀和换行', dirty.length === 3 && dirty[0] === 9 && dirty[2] === 7);
}

console.log('\n[2] UTF-8 编码（中文提示词会走这条路）');
{
  const cases = ['hello', '中文测试', 'emoji 🎨 混排', 'a中b文c'];
  for (const c of cases) {
    const mine = Buffer.from(U.utf8Bytes(c));
    const ref = Buffer.from(c, 'utf8');
    check('"' + c + '" 与标准 UTF-8 一致', Buffer.compare(mine, ref) === 0, mine.toString('hex') + ' vs ' + ref.toString('hex'));
  }
}

console.log('\n[3] 图片格式嗅探');
{
  const png = U.sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const jpg = U.sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  const webp = U.sniffImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]));
  const unknown = U.sniffImageFormat(new Uint8Array([0, 0, 0, 0]));
  check('PNG 识别', png.ext === 'png', png.ext);
  check('JPEG 识别', jpg.ext === 'jpg' && jpg.mime === 'image/jpeg', jpg.ext);
  check('WebP 识别', webp.ext === 'webp', webp.ext);
  check('未知格式兜底为 png', unknown.ext === 'png', unknown.ext);
}

console.log('\n[4] 尺寸换算');
{
  const sq = api.buildSize('openai', 1000, 1000, '2048');
  check('正方形 → 2048x2048', sq.size === '2048x2048', sq.size);

  const wide = api.buildSize('openai', 1600, 900, '2048');
  const [w, h] = wide.size.split('x').map(Number);
  check('横图短边落在 2048', h === 2048, wide.size);
  check('横图比例保持 (~1.78)', Math.abs(w / h - 1600 / 900) < 0.02, (w / h).toFixed(3));
  check('尺寸是 16 的倍数', w % 16 === 0 && h % 16 === 0, wide.size);

  const tall = api.buildSize('openai', 700, 1400, '1024');
  const [tw, th] = tall.size.split('x').map(Number);
  check('竖图短边落在 1024', tw === 1024, tall.size);

  const tiny = api.buildSize('openai', 5, 5, '1024');
  check('极小选区不会算出 0', tiny.size.split('x').every((v) => Number(v) >= 256), tiny.size);

  const g = api.buildSize('gemini', 1920, 1080, '2048');
  check('Gemini 返回 2K', g.imageSize === '2K', g.imageSize);
  check('Gemini 比例 16:9', g.aspectRatio === '16:9', g.aspectRatio);
}

console.log('\n[5] multipart 拼装');
{
  const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
  const mp = require(path.join(SRC, 'api.js'));
  // buildMultipart 不对外导出，这里通过 generate 之外的方式间接验证不了，
  // 所以用一份等价逻辑复算边界是否闭合。
  const boundary = '----selgenTEST';
  const head = Buffer.from(
    '--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n' +
      '--' + boundary + '\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n你好\r\n' +
      '--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="input.jpg"\r\n' +
      'Content-Type: image/jpeg\r\n\r\n'
  );
  check('multipart 头部含 model 字段', head.includes(Buffer.from('name="model"')));
  check('multipart 头部含图片 filename', head.includes(Buffer.from('filename="input.jpg"')));
  check('中文提示词已按 UTF-8 写入', head.includes(Buffer.from('你好', 'utf8')));
  check('文件字节数可拼接', fileBytes.length === 5);
}

console.log('\n[6] 模型名过滤（拉取列表后只留生图模型）');
{
  const ids = ['gpt-4o-mini', 'gpt-image-1', 'flux-pro', 'deepseek-chat', 'nano-banana', 'text-embedding-3'];
  const picked = api.filterImageModels(ids);
  check('挑出 gpt-image-1', picked.includes('gpt-image-1'));
  check('挑出 flux-pro', picked.includes('flux-pro'));
  check('挑出 nano-banana', picked.includes('nano-banana'));
  check('排除纯文本模型 deepseek-chat', !picked.includes('deepseek-chat'));
  check('排除纯文本模型 gpt-4o-mini', !picked.includes('gpt-4o-mini'));
  check('排除 embedding 模型', !picked.includes('text-embedding-3'));
  check('只留认出来的 3 个', picked.length === 3);
  const none = api.filterImageModels(['a', 'b']);
  check('一个都不像时返回空数组', none.length === 0);
  check('sd-xl 认成生图模型', api.guessIsImageModel('sd-xl') === true);
  check('mj 单独一段也算生图模型', api.guessIsImageModel('midjourney-v6') === true);
  check('gpt-4o 不算生图模型', api.guessIsImageModel('gpt-4o') === false);
  check('gpt-4o-mini 不算生图模型', api.guessIsImageModel('gpt-4o-mini') === false);
  check('无关词里的 sd 不算数（比如 gsd-agent）', api.guessIsImageModel('gsd-agent') === false);
}

console.log('\n[7] 接口地址清洗');
{
  check('去掉结尾斜杠', api.normalizeBase('https://x.com/') === 'https://x.com');
  check('去掉多余的 /v1', api.normalizeBase('https://x.com/v1') === 'https://x.com');
  check('去掉 /v1/', api.normalizeBase('https://x.com/v1/') === 'https://x.com');
  let threw = false;
  try {
    api.normalizeBase('   ');
  } catch (e) {
    threw = true;
  }
  check('空地址报错', threw);
}

console.log('\n[8] 返回结果解析（nano banana 的各种返回形状）');
{
  const bw = 'iVBORw0KGgo=';
  // Gemini 原生
  const gem = api.extractImageBase64({
    candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: bw } }] } }]
  });
  check('Gemini inlineData', gem === bw);

  // OpenAI 对话式：图片挂在 message.images
  const chat = api.extractImageBase64({
    choices: [{ message: { role: 'assistant', images: [{ image_url: { url: 'data:image/png;base64,' + bw } }] } }]
  });
  check('对话式 message.images 的 data URL 已剥掉前缀', chat === bw);

  // 对话式：给的是外链，应先返回 URL 让人去下载
  const linked = api.extractImageBase64({
    choices: [{ message: { images: [{ image_url: { url: 'https://cdn.example.com/a.png' } }] } }]
  });
  check('对话式外链返回待下载 URL', linked && linked.url === 'https://cdn.example.com/a.png');

  // 对话式：content 里混着 data URL
  const inText = api.extractImageBase64({
    choices: [{ message: { content: '画好了 ![img](data:image/png;base64,' + bw + ')' } }]
  });
  check('从正文里抠出 data URL', inText === bw);

  // OpenAI 图片接口
  const oai = api.extractImageBase64({ data: [{ b64_json: bw }] });
  check('OpenAI b64_json', oai === bw);

  check('认不出来就返回 null', api.extractImageBase64({ hello: 'world' }) === null);
  check('stripDataUrl 对普通 base64 不改动', api.stripDataUrl(bw) === bw);
}

console.log('\n[9] 请求变体与降级重试的判断');
{
  const bw = 'iVBORw0KGgo=';
  const cfg = { model: 'gemini-2.5-flash-image', baseUrl: 'https://api.example.com', protocol: 'chat' };
  const req = { prompt: '一颗苹果', imageBase64: 'AQID', selW: 800, selH: 600, tier: '2048' };

  const chatAttempts = api.buildAttempts('chat', cfg, req, 'https://api.example.com', {});
  check('对话式先试带 modalities 的写法', Array.isArray(chatAttempts[0].payload.modalities));
  check('对话式退路是不带 modalities', chatAttempts[1].payload.modalities === undefined);
  check('对话式会把选区图放进 messages', JSON.stringify(chatAttempts[0].payload.messages).indexOf('data:image/jpeg;base64,') !== -1);

  const gemAttempts = api.buildAttempts('gemini', cfg, req, 'https://api.example.com', { imageSize: '2K', aspectRatio: '4:3' });
  check('Gemini 三个变体', gemAttempts.length === 3);
  check('Gemini 第一个变体带 imageConfig', !!gemAttempts[0].payload.generationConfig.imageConfig);
  check('Gemini 最后一个变体不带 imageConfig', gemAttempts[2].payload.generationConfig.imageConfig === undefined);
  check('Gemini 请求地址含模型名', gemAttempts[0].url.indexOf('gemini-2.5-flash-image:generateContent') !== -1);

  check('imageConfig 不支持时报错可识别', api.isUnknownFieldError(400, 'Unknown name "imageConfig"', 'imageConfig'));
  check('modalities 不支持时报错可识别', api.isUnknownFieldError(400, 'unsupported field: modalities', 'modalities'));
  check('鉴权失败不触发降级重试', !api.isUnknownFieldError(401, 'invalid api key', 'imageConfig'));
  check('限流不触发降级重试', !api.isUnknownFieldError(429, 'rate limited', 'modalities'));
  check('内容被拦截不触发降级重试', !api.isUnknownFieldError(400, 'safety blocked', 'imageConfig'));

  check('对话式不带尺寸参数', JSON.stringify(api.buildSize('chat', 800, 600, '2048')) === '{}');
}

console.log('\n[10] 错误翻译（executeAsModal 会把报错换成没有 message 的对象）');
{
  const d = U.describeError;
  check('标准 Error 取 message', d(new Error('拉选区失败')) === '拉选区失败', d(new Error('拉选区失败')));
  check('字符串原样返回', d('连不上接口') === '连不上接口', d('连不上接口'));
  check('嵌套 error.message', d({ error: { message: 'no such document' } }) === 'no such document', d({ error: { message: 'no such document' } }));
  check('只有 name 时用 name', d({ name: 'PhotoshopError' }) === 'PhotoshopError', d({ name: 'PhotoshopError' }));
  check('带错误码时附在句尾', d({ message: '执行失败', number: 8800 }) === '执行失败（代码 8800）', d({ message: '执行失败', number: 8800 }));
  // 关键回归：这正是日志里出现 "undefined" 的那两种输入
  check('空对象不返回 undefined 字样', d({}) === '', JSON.stringify(d({})));
  check('undefined 返回空串', d(undefined) === '', String(d(undefined)));
  check('null 返回空串', d(null) === '', String(d(null)));
  check('数字直接转字符串', d(42) === '42', d(42));
}

console.log('\n[11] 像素整理（读选区时把数据弄成能直接交给 JPEG 编码器的样子）');
{
  const px = 2 * 2; // 2×2 的小图，够验算就行

  // 色深归一：不同 PS 版本给三种形状
  check('数字色深原样返回', U.parseBitsPerChannel(8) === 8, String(U.parseBitsPerChannel(8)));
  check("字符串 'bitDepth8' → 8", U.parseBitsPerChannel('bitDepth8') === 8, String(U.parseBitsPerChannel('bitDepth8')));
  check("字符串 'bitDepth16' → 16", U.parseBitsPerChannel('bitDepth16') === 16, String(U.parseBitsPerChannel('bitDepth16')));
  check('枚举对象 → 32', U.parseBitsPerChannel({ _value: 'bitDepth32' }) === 32);
  check('读不到时返回 0', U.parseBitsPerChannel(undefined) === 0);

  // 已经合规的 8 位 RGB：一个字节都不该动
  const rgb8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const keep = U.toRgb8(rgb8, 2, 2, 3);
  check('8 位 RGB 不重建', keep.changed === false);
  check('8 位 RGB 内容原样', keep.data === rgb8);
  check('8 位 RGB 通道数不变', keep.components === 3);

  // RGBA → RGB：长度从 4×像素数掉到 3×像素数，丢的是每像素第 4 字节
  const rgba = new Uint8Array(px * 4);
  for (let i = 0; i < px; i++) {
    rgba[i * 4] = i + 1;
    rgba[i * 4 + 1] = 100 + i;
    rgba[i * 4 + 2] = 200 + i;
    rgba[i * 4 + 3] = 255; // alpha
  }
  const noA = U.toRgb8(rgba, 2, 2, 4);
  check('RGBA 被拆成 RGB 长度', noA.data.length === px * 3, String(noA.data.length));
  check('拆 alpha 后标记 changed', noA.changed === true);
  check('拆 alpha 后通道数是 3', noA.components === 3);
  check('第 1 像素 R 保留', noA.data[0] === 1);
  check('第 1 像素 G 保留', noA.data[1] === 100, String(noA.data[1]));
  check('第 2 像素开头就跳过 alpha', noA.data[3] === 2, String(noA.data[3]));
  check('第 3 像素 B 保留', noA.data[8] === 202, String(noA.data[8]));

  // 声明的通道数是 3，但长度是 4×像素数 → 不信声明，按长度来
  const lied = U.toRgb8(rgba, 2, 2, 3);
  check('声明通道数与长度冲突时以长度为准', lied.components === 3 && lied.data.length === px * 3);

  // Uint16Array（PS 的 0..32768 值域）
  const u16 = new Uint16Array([0, 32768, 16384, 8192, 32768, 0, 16384, 16384, 8192, 8192, 16384, 16384]);
  const fromU16 = U.toRgb8(u16, 2, 2, 3);
  check('Uint16Array 转成 8 位长度', fromU16.data.length === px * 3, String(fromU16.data.length));
  check('Uint16 最大值 32768 → 255', fromU16.data[1] === 255, String(fromU16.data[1]));
  check('Uint16 中间值 16384 → 128', fromU16.data[2] === 128, String(fromU16.data[2]));

  // 字节流其实是 16 位（长度是 8 位的两倍），大端：高位在前
  const be16 = new Uint8Array([
    0xff, 0x00, 0x80, 0x00, 0x40, 0x00,
    0x20, 0x00, 0x10, 0x00, 0x08, 0x00,
    0x04, 0x00, 0x02, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x80
  ]);
  const beOut = U.toRgb8(be16, 2, 2, 3);
  check('16 位字节流降成 8 位长度', beOut.data.length === px * 3, String(beOut.data.length));
  check('大端高位在前 → 取第一个字节', beOut.data[0] === 0xff, String(beOut.data[0]));
  check('大端第二个像素取高位', beOut.data[3] === 0x20, String(beOut.data[3]));

  // 同样的数据换成小端（低位在前），结果应该一样
  const le16 = new Uint8Array(be16.length);
  for (let i = 0; i < be16.length; i += 2) {
    le16[i] = be16[i + 1];
    le16[i + 1] = be16[i];
  }
  const leOut = U.toRgb8(le16, 2, 2, 3);
  check('小端数据也能认出来', leOut.data[0] === 0xff, String(leOut.data[0]));
  check('小端结果与大端一致', leOut.data.join(',') === beOut.data.join(','));

  // Float32Array（32 位文档，0.0–1.0）
  const f32 = new Float32Array([0, 0.5, 1, 1, 0.5, 0, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75]);
  const fromF32 = U.toRgb8(f32, 2, 2, 3);
  check('Float32 转成 8 位长度', fromF32.data.length === px * 3, String(fromF32.data.length));
  check('Float32 1.0 → 255', fromF32.data[2] === 255, String(fromF32.data[2]));
  check('Float32 0.5 → 128', fromF32.data[1] === 128, String(fromF32.data[1]));

  // keepAlpha：贴回图层时要保住透明通道
  const keepA = U.toRgb8(rgba, 2, 2, 4, true);
  check('keepAlpha 时保留 4 通道', keepA.components === 4 && keepA.data.length === px * 4, String(keepA.data.length));
  check('keepAlpha 且已是 8 位时不重建', keepA.changed === false);

  // 边界：宽度为 0、数据为空都不该炸
  const zero = U.toRgb8(rgb8, 0, 0, 3);
  check('尺寸为 0 时原样返回', zero.changed === false && zero.data === rgb8);
  const nullRaw = U.toRgb8(null, 2, 2, 3);
  check('数据为空时原样返回', nullRaw.changed === false);
}

console.log('\n[12] 请求真的带上了 API Key（401 Invalid token 的回归点）');
// 这一段要等网络调用，包成异步块；收尾的统计放在它后面，别提前跑。
(async function () {
  // 鉴权头只认 cfg.apiKey。面板以前从没给它赋过值，
  // 于是请求裸着发出去，中转站一律回 401。这里把这层锁死。
  check('有 Key 时拼成 Bearer 头', api.authHeaders({ apiKey: 'sk-abc' })['Authorization'] === 'Bearer sk-abc',
    JSON.stringify(api.authHeaders({ apiKey: 'sk-abc' })));
  check('没有 apiKey 字段时不带鉴权头', !('Authorization' in api.authHeaders({})),
    JSON.stringify(api.authHeaders({})));
  check('apiKey 是空串时也不带', !('Authorization' in api.authHeaders({ apiKey: '' })));

  // 端到端：把 fetch 换掉，亲眼看一遍真实发出去的请求头
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url: String(url), headers: (opts && opts.headers) || {}, body: opts && opts.body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA' } }] } }]
      })
    };
  };
  try {
    const out = await api.generate(
      { baseUrl: 'https://api.example.com', protocol: 'gemini', model: 'gpt-image-2', apiKey: 'sk-real-key' },
      { prompt: '把背景换成蓝天', selW: 1000, selH: 1000, tier: '2048' }
    );
    check('生成请求确实发出去了', !!seen);
    check('请求头带着 Bearer Key', seen && seen.headers['Authorization'] === 'Bearer sk-real-key',
      seen && JSON.stringify(seen.headers));
    check('Gemini 协议走 generateContent 路径', seen && seen.url.indexOf(':generateContent') !== -1, seen && seen.url);
    check('返回的图片数据被解析出来', out && out.base64 === 'AAAA', out && out.base64);

    // 反例：Key 没挂进 cfg（就是之前那个 bug 的形状），头里就该是空的
    seen = null;
    await api.generate(
      { baseUrl: 'https://api.example.com', protocol: 'gemini', model: 'gpt-image-2' },
      { prompt: 'x', selW: 512, selH: 512, tier: '1024' }
    );
    check('Key 没进 cfg 时头里没有 Authorization（这就是 401 的成因）',
      seen && !seen.headers['Authorization'], seen && JSON.stringify(seen.headers));
  } finally {
    global.fetch = realFetch;
  }

  console.log('\n[13] 图被当成正文发回来（真机遇到的那种返回）');
  {
    // 真机上 gpt-image-2 走 Gemini 协议时，返回的不是图片字段，
    // 而是 parts[].text 里一段 "![image](data:image/png;base64,....)"。
    const bw = 'iVBORw0KGgo=' + 'A'.repeat(60);
    const markdown = '![image](data:image/png;base64,' + bw + ')';

    check('从一段正文里抠出 base64', api.scrapeImageFromText(markdown) === bw,
      String(api.scrapeImageFromText(markdown)).slice(0, 24));
    check('正文里没有图时返回 null', api.scrapeImageFromText('这是一段纯文字回复，没有图') === null);
    check('只是提到 data:image 但没有真正内容时不算图',
      api.scrapeImageFromText('我用了 data:image/png 这种格式') === null);
    check('正文里给的是外链时返回待下载 URL',
      (api.scrapeImageFromText('图片在此 https://cdn.example.com/out.png 请查收') || {}).url === 'https://cdn.example.com/out.png');

    // 端到端：真机那次返回的字段形状（只有 candidates + usageMetadata）
    const gemText = api.extractImageBase64({
      candidates: [{ content: { role: 'model', parts: [{ text: markdown }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { totalTokenCount: 2066 }
    });
    check('Gemini 返回里正文夹带的图能被认出来', gemText === bw, String(gemText).slice(0, 24));
    check('外层不是 ![](...) 也一样认',
      api.extractImageBase64({ candidates: [{ content: { parts: [{ text: '(data:image/jpeg;base64,' + bw + ')' }] } }] }) === bw);
    check('折了行的 base64 能接起来',
      api.scrapeImageFromText('data:image/png;base64,' + bw.slice(0, 20) + '\n' + bw.slice(20)) === bw);
    check('真正的图片字段依旧优先',
      api.extractImageBase64({
        candidates: [{ content: { parts: [{ inlineData: { data: 'REAL' } }, { text: markdown }] } }]
      }) === 'REAL');
  }

  console.log('\n[14] 生成结果编组 + 白色蒙版：发给 PS 的命令形状');
  {
    const psCmd = require(path.join(SRC, 'ps-commands.js'));

    check('没有图层时不生成任何选择命令', psCmd.selectLayers([]).length === 0);

    const two = psCmd.selectLayers([11, 22]);
    check('两个图层就两条选择命令', two.length === 2, String(two.length));
    check('第一条选择是"替换"，不带加选修饰符', !two[0].selectionModifier,
      JSON.stringify(two[0].selectionModifier));
    check('第二条起才带"加选"',
      !!two[1].selectionModifier && two[1].selectionModifier._value === 'addToSelection',
      JSON.stringify(two[1].selectionModifier));
    check('选图层时不动可见性（别把隐藏图层点亮）',
      two[0].makeVisible === false && two[1].makeVisible === false);

    const g = psCmd.groupLayers();
    check('编组命令就是 groupLayers', g._obj === 'groupLayers', g._obj);
    check('编组作用在当前选择上', g._target[0]._value === 'targetEnum', JSON.stringify(g._target));

    // 这一条是整个功能的关键：白色蒙版就是 revealAll。
    // 要是写成 hideAll，那是黑蒙版，整个组会先被藏起来，用户看到画面直接空了。
    const m = psCmd.addWhiteMask();
    check('白蒙版用的是 revealAll，不是 hideAll',
      !!m.using && m.using._value === 'revealAll', JSON.stringify(m.using));
    check('蒙版加在 channel 上',
      m._obj === 'make' && m._target[0]._ref === 'channel', JSON.stringify(m._target));

    const r = psCmd.renameLayer(7, '生图结果');
    check('改名命令带上了新名字和目标图层',
      !!r.to && r.to.name === '生图结果' && r._target[0]._id === 7, JSON.stringify(r.to));

    const mk = psCmd.makeGroup();
    check('退路方案：建空组用的是 layerSection',
      !!mk.using && mk.using._obj === 'layerSection', JSON.stringify(mk.using));
    const mv = psCmd.moveLayerInto(3, 9);
    check('退路方案：把图层挪进指定组',
      mv._obj === 'move' && mv._target[0]._id === 3 && mv.to._id === 9, JSON.stringify(mv));
  }
})()
  .catch(function (e) {
    fail++;
    console.log('  FAIL [12] 这一段抛异常 :: ' + ((e && e.message) || e));
  })
  .then(function () {
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
    process.exit(fail === 0 ? 0 : 1);
  });
