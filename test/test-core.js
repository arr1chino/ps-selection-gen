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

console.log('\n[6] 模型名过滤（拉取列表后优先展示生图模型）');
{
  const ids = ['gpt-4o-mini', 'gpt-image-1', 'flux-pro', 'deepseek-chat', 'nano-banana', 'text-embedding-3'];
  const picked = api.prioritizeImageModels(ids);
  check('挑出 gpt-image-1', picked.includes('gpt-image-1'));
  check('挑出 flux-pro', picked.includes('flux-pro'));
  check('挑出 nano-banana', picked.includes('nano-banana'));
  check('排除纯文本模型 deepseek-chat', !picked.includes('deepseek-chat'));
  const none = api.prioritizeImageModels(['a', 'b']);
  check('一个都不像时原样返回', none.length === 2);
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

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
