/**
 * tools/yt-diag.js —— 真机实验台：入口按钮为什么看不见 / 怎么放才看得见。
 *
 * 它会把按钮当前的几何、各级祖先的裁剪情况打出来，
 * 然后现场试几种修法（inline-flex / 图标-only / 改挂到 top-level 行），
 * 每种都重新量一次尺寸与「有没有被祖先裁掉」，用数据挑方案。
 *
 * 用法：
 *   node tools/yt-diag.js [--headed] [--url=...] [--proxy=...]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CDP, sleep, getJSON, waitFor } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const HEADED = process.argv.includes('--headed');
const argOf = (k) => {
  const hit = process.argv.find((a) => a.indexOf('--' + k + '=') === 0);
  return hit ? hit.slice(k.length + 3) : null;
};
const PROXY = argOf('proxy') || process.env.YT_PROXY || 'http://127.0.0.1:7897';
const VIDEO = argOf('url') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CDP_PORT = 9255;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

const MEASURE = `(function(){
  function box(el){ var r = el.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; }
  var b = document.getElementById('v2t-page-entry');
  if (!b) return {error:'no entry'};
  var out = {box: box(b), clippedBy: null, rowOverflow: null};
  var bb = b.getBoundingClientRect();
  var n = b.parentElement, level = 0;
  while (n && n !== document.documentElement && level < 8) {
    var s = getComputedStyle(n);
    var rb = n.getBoundingClientRect();
    var clips = /hidden|clip|auto|scroll/.test(s.overflowX + ' ' + s.overflowY);
    var inside = !(bb.right > rb.right + 1 || bb.left < rb.left - 1 || bb.bottom > rb.bottom + 1 || bb.top < rb.top - 1);
    if (clips && !inside) { out.clippedBy = n.tagName + (n.id ? '#'+n.id : '') + ' overflow=' + s.overflow + ' box=' + JSON.stringify(box(n)); break; }
    n = n.parentElement; level++;
  }
  var menu = b.closest('ytd-menu-renderer');
  if (menu) out.rowOverflow = {scrollW: menu.scrollWidth, clientW: menu.clientWidth, box: box(menu)};
  var flex = b.closest('#flexible-item-buttons');
  if (flex) out.flexBox = box(flex);
  return out;
})()`;

let child = null;
async function main() {
  const chromePath = findChrome();
  if (!chromePath) { console.error('找不到 Chrome'); process.exit(2); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-diag-'));
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--window-size=1400,900', '--proxy-server=' + PROXY,
  ];
  if (!HEADED) args.push('--headless=new');
  args.push('about:blank');
  child = spawn(chromePath, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/version'); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) { console.error('调试端口没起来'); process.exit(1); }
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  const ext = await browser.send('Extensions.loadUnpacked', { path: ROOT }, 30000);
  console.log('扩展 id:', ext.id);

  const created = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(VIDEO),
    { method: 'PUT' }).then((r) => r.json());
  const page = new CDP(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  await waitFor(page, '!!document.querySelector("ytd-watch-metadata")', 45000, 700);
  const got = await waitFor(page, '!!document.getElementById("v2t-page-entry")', 25000, 500);
  console.log('入口注入:', got, '\n');

  // 0) 现状
  console.log('[现状]', JSON.stringify(await page.eval(MEASURE)));

  const donors = await page.eval(`(function(){
    function vis(el){ var r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; }
    var box = document.querySelector('ytd-watch-metadata #flexible-item-buttons') || document.querySelector('#flexible-item-buttons');
    if (!box) return {err:'没找到 flexible-item-buttons'};
    var row = box.closest('ytd-menu-renderer') || box.parentElement;
    var out = {boxTag: box.tagName + '#' + box.id, rowTag: row.tagName, buttons: []};
    var bs = row.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i]; var r = b.getBoundingClientRect();
      out.buttons.push({tag: b.tagName, id: b.id, aria: (b.getAttribute('aria-label')||'').slice(0,14),
        w: Math.round(r.width), h: Math.round(r.height), vis: vis(b), svg: !!b.querySelector('svg'),
        txt: (b.textContent||'').trim().slice(0,8)});
    }
    return out;
  })()`);
  console.log('\n[捐赠者候选]', JSON.stringify(donors, null, 1));

  const cmp = await page.eval(`(async function(){
    function probe(el, name){
      if (!el) return {name: name, err: '没找到'};
      var r = el.getBoundingClientRect();
      var cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
      var hit = document.elementFromPoint(cx, cy);
      var stack = (document.elementsFromPoint(cx, cy) || []).slice(0,4).map(function(e){
        return (e === el ? 'SELF' : e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''));
      }).join('>');
      return {name: name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        point: [cx, cy], hit: hit ? (hit === el ? 'SELF' : (el.contains(hit) ? 'CHILD' : hit.tagName.toLowerCase())) : 'null',
        stack: stack,
        cva: el.checkVisibility ? el.checkVisibility({contentVisibilityAuto: true, checkOpacity: true, checkVisibilityCSS: true}) : null};
    }
    await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
    var out = [];
    out.push(probe(document.getElementById('v2t-page-entry'), '我们的按钮'));
    var box = document.querySelector('ytd-watch-metadata #flexible-item-buttons') || document.querySelector('#flexible-item-buttons');
    if (box) {
      var native = box.querySelector('yt-button-view-model button') || box.querySelector('button');
      out.push(probe(native, '原生保存按钮'));
      out.push(probe(box, '容器本身'));
    }
    return out;
  })()`);
  const mediaDump = await page.eval(`(function(){
    var list = performance.getEntriesByType('resource').filter(function(e){return /googlevideo/.test(e.name);});
    var seen = {};
    return list.map(function(e){
      var u = e.name; var q = {};
      var i = u.indexOf('?');
      if (i >= 0) u.slice(i+1).split('&').forEach(function(kv){ var p = kv.split('='); q[p[0]] = p[1]; });
      var key = (q.itag||'') + '|' + (q.mime||'');
      if (seen[key]) return null; seen[key] = 1;
      return { host: (u.split('/')[2]||'').slice(0, 28), tail: (u.split('?')[0]||'').split('/').slice(-1)[0],
        itag: q.itag, mime: q.mime ? decodeURIComponent(q.mime) : null, sq: q.sq, c: q.c };
    }).filter(Boolean);
  })()`);
  console.log('\n[媒体请求（去重）]', JSON.stringify(mediaDump, null, 1));

  console.log('\n[命中对照]', JSON.stringify(cmp, null, 1));

  // 1) 行里还有多少余量
  const row = await page.eval(`(function(){
    function box(el){var r=el.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
    var menu = document.querySelector('ytd-watch-metadata ytd-menu-renderer') || document.querySelector('ytd-menu-renderer');
    var out = {menu: box(menu), scrollW: menu.scrollWidth, clientW: menu.clientWidth, kids: []};
    var kids = menu.children;
    for (var i=0;i<kids.length;i++){ var k=kids[i];
      out.kids.push({tag:k.tagName, id:k.id, box:box(k), display:getComputedStyle(k).display, flex:getComputedStyle(k).flex}); }
    var flex = menu.querySelector('#flexible-item-buttons');
    if (flex) { out.flexible = {box: box(flex), display:getComputedStyle(flex).display, kids: []};
      for (var j=0;j<flex.children.length;j++){ var f=flex.children[j];
        out.flexible.kids.push({tag:f.tagName,id:f.id,box:box(f),display:getComputedStyle(f).display}); } }
    var top = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
    if (top) { out.topLevel = {box: box(top), scrollW: top.scrollWidth, clientW: top.clientWidth, kids: []};
      for (var m=0;m<top.children.length;m++){ var t=top.children[m];
        out.topLevel.kids.push({tag:t.tagName,id:t.id,box:box(t),display:getComputedStyle(t).display}); } }
    return out;
  })()`);
  console.log('\n[行内余量]', JSON.stringify(row, null, 1));

  // 2) 试修法 A：inline-flex + 不许被压
  await page.eval(`(function(){var b=document.getElementById('v2t-page-entry');
    b.style.setProperty('display','inline-flex','important');
    b.style.setProperty('flex','0 0 auto','important');
    b.style.setProperty('vertical-align','middle','important'); return true;})()`);
  await sleep(300);
  console.log('\n[修法A inline-flex]', JSON.stringify(await page.eval(MEASURE)));

  // 3) 试修法 B：A + 只留图标（收起文字）
  await page.eval(`(function(){var b=document.getElementById('v2t-page-entry');
    var t=b.querySelector('.ytSpecButtonShapeNextButtonTextContent'); if(t) t.style.setProperty('display','none','important');
    b.style.setProperty('padding','0 10px','important'); return true;})()`);
  await sleep(300);
  console.log('[修法B 图标-only]', JSON.stringify(await page.eval(MEASURE)));

  try {
    const shotDir = path.join(ROOT, 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }, 40000);
    fs.writeFileSync(path.join(shotDir, 'yt-diag.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图：screenshots/yt-diag.png');
  } catch (e) { console.log('截图失败：' + e.message); }

  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('意外错误：', e && e.message);
  if (child) child.kill();
  process.exit(1);
});
