/**
 * tools/yt-perf-probe.js —— 验证「用 performance 资源时间线抓媒体 URL」是否可行。
 * 若可行，扩展就不需要 webRequest 权限，也不用往页面注入脚本。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CDP, sleep, getJSON, waitFor } = require('./cdp');

const argOf = (k) => {
  const hit = process.argv.find((a) => a.indexOf('--' + k + '=') === 0);
  return hit ? hit.slice(k.length + 3) : null;
};
const PROXY = argOf('proxy') || process.env.YT_PROXY || 'http://127.0.0.1:7897';
const VIDEO = argOf('url') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CDP_PORT = 9257;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

let child = null;
async function main() {
  const chromePath = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-perf-'));
  child = spawn(chromePath, [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--window-size=1400,900', '--proxy-server=' + PROXY,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new', 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/version'); break; }
    catch (e) { await sleep(500); }
  }
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;

  const created = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(VIDEO),
    { method: 'PUT' }).then((r) => r.json());
  const page = new CDP(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  await waitFor(page, '!!document.querySelector("video")', 45000, 700);
  await page.eval('(function(){var v=document.querySelector("video"); if(v){try{v.muted=true;v.play();}catch(e){}} return 1;})()').catch(() => {});
  await waitFor(page, '!!document.querySelector("video") && document.querySelector("video").currentTime > 2', 40000, 700);
  await sleep(8000);

  const res = await page.eval(`(function(){
    var all = performance.getEntriesByType('resource');
    var gv = all.filter(function(e){ return /googlevideo\\.com/.test(e.name); });
    var vp = gv.filter(function(e){ return /videoplayback/.test(e.name); });
    function brief(e){ return {name: e.name.slice(0,120), transfer: e.transferSize, enc: e.encodedBodySize, dur: Math.round(e.duration), itag: (e.name.match(/[?&]itag=(\\d+)/)||[])[1], mime: (e.name.match(/[?&]mime=([^&]+)/)||[])[1]}; }
    return {total: all.length, googlevideo: gv.length, videoplayback: vp.length,
      sample: vp.slice(0, 6).map(brief),
      itags: vp.map(function(e){return (e.name.match(/[?&]itag=(\\d+)/)||[])[1];}).filter(Boolean)};
  })()`);
  console.log(JSON.stringify(res, null, 1));

  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('意外错误：', e && e.message);
  if (child) child.kill();
  process.exit(1);
});
