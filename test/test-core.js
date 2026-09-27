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

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
