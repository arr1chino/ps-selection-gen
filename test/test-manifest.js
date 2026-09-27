/**
 * 清单自检。
 *
 * 这里每一条都对应一次真实的翻车：
 * - host 必须是对象，不能是字符串（PS 报 "Expected the host attribute to be an object"）
 * - icons 里同一 path + 同一 theme 不能出现两次（PS 报 "Duplicate 'root' icons not allowed"）
 * - path 写基名，宿主自己往扩展名前插 @1x / @2x，所以这两个文件必须真实存在
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

console.log('\n[清单] manifest.json');

let text = '';
try {
  text = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
} catch (e) {
  check('能读到 manifest.json', false, e.message);
}

let m = null;
try {
  m = JSON.parse(text);
  check('是合法 JSON', true);
} catch (e) {
  check('是合法 JSON', false, e.message);
}

if (m) {
  check('有 id', typeof m.id === 'string' && m.id.length > 0);
  check('有版本号', typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version));
  check('入口文件 index.html 存在', fs.existsSync(path.join(ROOT, m.main || '')));
  check('host 是对象（字符串写法会被 PS 拒绝）', m.host && typeof m.host === 'object' && !Array.isArray(m.host));
  check('host.app 是 PS', !!m.host && m.host.app === 'PS');
  check('至少一个面板入口', Array.isArray(m.entrypoints) && m.entrypoints.some((e) => e.type === 'panel'));

  // 同一 path 配同一 theme 会被宿主判为重复图标，整个清单直接不加载
  const groups = [
    ['root', m.icons],
    ['entrypoint', m.entrypoints && m.entrypoints[0] ? m.entrypoints[0].icons : undefined]
  ];

  for (const [who, arr] of groups) {
    if (!Array.isArray(arr)) {
      check(who + ' 图标数组存在', false);
      continue;
    }
    const seen = new Set();
    let dup = null;
    for (const e of arr) {
      const key = e.path + '|' + (e.theme || []).slice().sort().join(',');
      if (seen.has(key) && !dup) dup = key;
      seen.add(key);
    }
    check(who + ' 图标无重复（同 path + 同 theme）', !dup, dup);

    // path 是基名，宿主会往扩展名前插 @1x / @2x
    const wanted = new Set();
    for (const e of arr) {
      for (const s of e.scale || []) {
        wanted.add(String(e.path).replace(/\.png$/i, '@' + s + 'x.png'));
      }
    }
    for (const f of wanted) {
      check('图标文件存在 ' + f, fs.existsSync(path.join(ROOT, f)));
    }
  }

  check('声明了网络权限', !!(m.requiredPermissions && m.requiredPermissions.network));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
