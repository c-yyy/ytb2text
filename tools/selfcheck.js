/**
 * tools/selfcheck.js —— 加载前的静态自检（不需要浏览器）。
 *
 * 检三类最容易犯、又最容易漏的错：
 *   1. manifest / html 里引用的文件是不是真的存在（少一个 lib 文件 = 加载即崩）
 *   2. content.js 里用的 class 名是否都在 content.css 里有定义（拼错类名 = 样式静默失效）
 *   3. popup.js 里 getElementById 的 id 是否都在 popup.html 里
 *
 * 用法：node tools/selfcheck.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function fail(msg) {
  problems.push(msg);
}

/* ---------- 1. 文件引用 ---------- */

const manifest = JSON.parse(read('manifest.json'));

const manifestFiles = [];
manifestFiles.push(manifest.background.service_worker);
if (manifest.action.default_popup) manifestFiles.push(manifest.action.default_popup);
manifest.content_scripts.forEach((cs) => {
  (cs.js || []).forEach((f) => manifestFiles.push(f));
  (cs.css || []).forEach((f) => manifestFiles.push(f));
});
Object.values(manifest.icons || {}).forEach((f) => manifestFiles.push(f));
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((f) =>
  manifestFiles.push(f)
);

manifestFiles.forEach((f) => {
  if (!f) return;
  if (!exists(f)) fail('manifest 引用的文件不存在：' + f);
});

// html 里的 script src / link href
['offscreen.html', 'popup.html'].forEach((htmlFile) => {
  if (!exists(htmlFile)) {
    fail('缺少 ' + htmlFile);
    return;
  }
  const html = read(htmlFile);
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (/^(https?:|data:|#|chrome-extension:)/.test(url)) continue;
    const rel = url.replace(/^\.\//, '');
    if (!exists(rel)) fail(htmlFile + ' 引用的资源不存在：' + url);
  }
});

// offscreen.html 里 import 的 transformers 入口
if (exists('offscreen.html')) {
  const html = read('offscreen.html');
  const imp = /import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/.exec(html);
  if (imp) {
    const rel = imp[1].replace(/^\.\//, '');
    if (!exists(rel)) fail('offscreen.html import 的模块不存在：' + imp[1]);
  }
}

// lib/transformers 里的关键运行时文件
[
  'lib/transformers/transformers.min.js',
  'lib/transformers/ort.bundle.min.mjs',
  'lib/transformers/ort-wasm-simd-threaded.jsep.wasm',
  'lib/transformers/ort-wasm-simd-threaded.jsep.mjs',
].forEach((f) => {
  if (!exists(f)) fail('缺少 vendored 运行时文件：' + f + '（跑一次 node tools/vendor.js）');
});

/* ---------- 2. content.js 用到的 class 是否都有样式 ---------- */

if (exists('content.js') && exists('content.css')) {
  const js = read('content.js');
  const css = read('content.css');

  const used = new Set();
  // 抓 class: 'a b c' 这种字面量
  const re = /class:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(js))) {
    m[1].split(/\s+/).forEach((c) => {
      if (c.indexOf('v2t-') === 0) used.add(c);
    });
  }
  // 拼接写法的 class：' ' + ' v2t-xxx'（注意不要拿 '#v2t-root' 这类选择器误判）
  const re1b = /['"]\s+(v2t-[a-z0-9-]+)['"]/g;
  while ((m = re1b.exec(js))) {
    used.add(m[1]);
  }
  // 抓 classList.add/toggle('x') 与 querySelector('.x')
  const re2 = /classList\.(?:add|toggle|remove)\('([^']+)'/g;
  while ((m = re2.exec(js))) {
    if (m[1].indexOf('v2t-') === 0) used.add(m[1]);
  }

  const missing = [];
  used.forEach((c) => {
    if (css.indexOf('.' + c) < 0) missing.push(c);
  });
  if (missing.length) fail('content.css 里缺少这些 class 的定义：' + missing.join(', '));

  // 反向：CSS 里定义但 JS 完全没用的 class（只提示，不算错）
  // 这几个是刻意留下的设计系统变体，不参与业务逻辑，别报成噪音。
  const INTENTIONAL = new Set(['v2t-primary']);
  const cssClasses = new Set();
  const re3 = /\.(v2t-[a-z0-9-]+)/g;
  while ((m = re3.exec(css))) cssClasses.add(m[1]);
  const unused = [];
  cssClasses.forEach((c) => {
    if (!used.has(c) && !INTENTIONAL.has(c)) unused.push(c);
  });
  if (unused.length) notes.push('content.css 中未被 content.js 直接引用的 class（可能是状态类或子元素，供人工确认）：' + unused.join(', '));
}

/* ---------- 3. popup.js 的 id 是否都在 popup.html ---------- */

if (exists('popup.js') && exists('popup.html')) {
  const js = read('popup.js');
  const html = read('popup.html');
  const re = /getElementById\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(js))) {
    if (html.indexOf('id="' + m[1] + '"') < 0) fail('popup.html 缺少 id="' + m[1] + '"');
  }
}

/* ---------- 4. 两处 MAX_CHUNK_FLOATS 必须一致 ---------- */

if (exists('content.js') && exists('offscreen.js')) {
  const a = /MAX_CHUNK_FLOATS\s*=\s*([0-9*\s]+);/.exec(read('content.js'));
  const b = /MAX_CHUNK_FLOATS\s*=\s*([0-9*\s]+);/.exec(read('offscreen.js'));
  const norm = (s) => (s ? Function('return ' + s[1])() : null);
  if (norm(a) !== norm(b)) {
    fail('content.js 与 offscreen.js 的 MAX_CHUNK_FLOATS 不一致（分块协议会错位）');
  }
}

/* ---------- 输出 ---------- */

if (notes.length) {
  console.log('[selfcheck] 提示：');
  notes.forEach((n) => console.log('  · ' + n));
}

if (problems.length) {
  console.error('[selfcheck] 发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}

console.log('[selfcheck] 通过：文件引用、样式类名、popup id、分块常量一致');
