/**
 * tools/yt-audio-probe.js —— 真机验证「直接拿到音频文件」这条路走不走得通。
 *
 * 结论要点（实测）：
 *   · ytInitialPlayerResponse 里的音频轨通常没有 url，只有 signatureCipher（要解签名，不划算）
 *   · 但播放器自己一定会去请求音频分片 —— 用 CDP 的 Network 域把这些真实 URL 抓下来最稳
 *
 * 本脚本回答：
 *   1. 播放器实际请求的音频 URL 长什么样（整条 / sq 分段 / range 分片）
 *   2. 这些 URL 在页面上下文 fetch 会不会被 CORS / 403 拦掉
 *   3. 抓下来的字节能不能被 decodeAudioData 解码
 *
 * 用法：node tools/yt-audio-probe.js [--url=...] [--proxy=...]
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
const CDP_PORT = 9256;

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
  if (!chromePath) { console.error('找不到 Chrome'); process.exit(2); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-audio-'));
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--window-size=1400,900', '--proxy-server=' + PROXY,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new',
    'about:blank',
  ];
  child = spawn(chromePath, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/version'); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) { console.error('调试端口没起来'); process.exit(1); }
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;

  const created = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(VIDEO),
    { method: 'PUT' }).then((r) => r.json());
  const page = new CDP(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');

  const seen = [];
  page.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request && m.params.request.url;
      if (u && /googlevideo\.com\/videoplayback/.test(u)) {
        seen.push({ url: u, type: m.params.type, method: m.params.request.method,
          range: (m.params.request.headers && (m.params.request.headers.Range || m.params.request.headers.range)) || '' });
      }
    }
  });

  const allUrls = [];
  page.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request && m.params.request.url;
      if (!u) return;
      allUrls.push(u);
      if (u && /googlevideo\.com\//.test(u)) {
        seen.push({ url: u, type: m.params.type, method: m.params.request.method, headers: m.params.request.headers || {},
          range: (m.params.request.headers && (m.params.request.headers.Range || m.params.request.headers.range)) || '' });
      }
    }
  });

  await waitFor(page, '!!document.querySelector("video")', 45000, 700);
  await page.eval('(function(){var v=document.querySelector("video"); if(v){ try{v.muted=true;}catch(e){} try{v.play();}catch(e){} } return true;})()').catch(() => {});
  const played = await waitFor(page, '!!document.querySelector("video") && document.querySelector("video").currentTime > 1', 40000, 700);
  const vstate = await page.eval(`(function(){var v=document.querySelector("video"); if(!v) return null;
    return {src:(v.currentSrc||'').slice(0,60), paused:v.paused, t:v.currentTime, ready:v.readyState, dur:v.duration, err:v.error?v.error.code:null};})()`);
  console.log('播放器状态：', JSON.stringify(vstate), ' 播放推进：', !!played);
  console.log('总请求数：' + allUrls.length + '｜googlevideo：' + seen.length);
  const hostCount = {};
  allUrls.forEach((u) => { try { const h = new URL(u).host; hostCount[h] = (hostCount[h] || 0) + 1; } catch (e) {} });
  console.log('域名分布：', JSON.stringify(hostCount, null, 1));
  // 等到真的抓到带 itag 的媒体请求（播放器刚起步时可能只有 generate_204）
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !seen.some((s) => /[?&]itag=/.test(s.url))) await sleep(1000);
  await sleep(5000);

  // —— 1. 抓到的真实请求长什么样 ——
  // 去重：同一个 URL 会被按 Range 分片请求多次
  const byUrl = new Map();
  seen.forEach((s) => {
    const key = s.url.split('&rn=')[0].split('&rbuf=')[0];
    if (!byUrl.has(key)) byUrl.set(key, { url: s.url, ranges: [], itag: null, mime: null });
    const e = byUrl.get(key);
    if (s.range) e.ranges.push(s.range);
    try { const q = new URL(s.url).searchParams; e.itag = q.get('itag'); e.mime = q.get('mime'); } catch (err) {}
  });
  console.log('\n去重后 ' + byUrl.size + ' 条 URL：');
  Array.from(byUrl.values()).forEach((e, i) => {
    console.log('  [' + i + '] itag=' + e.itag + ' mime=' + e.mime + ' 分片请求 ' + (e.ranges.length + 1) + ' 次');
    console.log('      range: ' + JSON.stringify(e.ranges.slice(0, 4)) + (e.ranges.length > 4 ? ' …' : ''));
    console.log('      url: ' + e.url.slice(0, 200));
  });

  const cands = Array.from(byUrl.values()).filter((e) => e.itag);
  const first = cands[0] || Array.from(byUrl.values())[0];
  if (first) {
    const probe = await page.eval(`(async function(){
      var url = ${JSON.stringify(first.url)};
      var out = {itag: ${JSON.stringify(first.itag)}};
      var t0 = Date.now();
      try {
        var res = await fetch(url);
        out.status = res.status; out.ok = res.ok;
        out.ct = res.headers.get('content-type');
        out.cl = res.headers.get('content-length');
        out.acao = res.headers.get('access-control-allow-origin');
        var buf = await res.arrayBuffer();
        out.bytes = buf.byteLength; out.ms = Date.now() - t0;
        try {
          var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
          var ctx = new Ctx(1, 1, 16000);
          var ab = await ctx.decodeAudioData(buf.slice(0));
          out.decoded = { seconds: +(ab.length / ab.sampleRate).toFixed(1), channels: ab.numberOfChannels };
        } catch (e) { out.decodeErr = String((e && e.message) || e); }
      } catch (e) { out.err = String(e); }
      return out;
    })()`, 180000);
    const ipCheck = await page.eval(`(async function(){
      async function ip(){ try { var r = await fetch('https://api.ipify.org?format=json'); return (await r.json()).ip; } catch(e){ return 'err:'+e.message; } }
      var a = await ip(); var b = await ip(); var c = await ip();
      return [a,b,c];
    })()`, 60000);
    const bodyOf403 = await page.eval(`(async function(){
      var url = ${JSON.stringify(first.url)};
      try { var r = await fetch(url); var t = await r.text(); return {status:r.status, body:t.slice(0,300)}; }
      catch(e){ return {err:String(e)}; }
    })()`, 60000);
    console.log('[403 正文]', JSON.stringify(bodyOf403));

    const withHeaders = await page.eval(`(async function(){
      var url = ${JSON.stringify(first.url)};
      var hs = ${JSON.stringify(first.headers || {})};
      var clean = {};
      Object.keys(hs).forEach(function(k){ if(!/^(host|content-length|connection|sec-fetch|origin|referer)/i.test(k)) clean[k]=hs[k]; });
      try {
        var r = await fetch(url, {headers: clean});
        return {status:r.status, ct:r.headers.get('content-type'), cl:r.headers.get('content-length'), sent:Object.keys(clean)};
      } catch(e){ return {err:String(e), sent:Object.keys(clean)}; }
    })()`, 60000);
    console.log('[照抄播放器请求头]', JSON.stringify(withHeaders));

    console.log('\n[出口 IP 是否轮换]', JSON.stringify(ipCheck));

    const retry = await page.eval(`(async function(){
      var url = ${JSON.stringify(first.url)};
      var out = {};
      try {
        var r2 = await fetch(url, {headers:{Range:'bytes=0-1048575'}});
        out.rangeStatus = r2.status; out.rangeCt = r2.headers.get('content-type');
        out.rangeCr = r2.headers.get('content-range');
        var b2 = await r2.arrayBuffer(); out.rangeBytes = b2.byteLength;
      } catch(e) { out.rangeErr = String(e); }
      return out;
    })()`, 120000);
    console.log('[带 Range 重试]', JSON.stringify(retry));

    console.log('\n[页面上下文整条 fetch + 解码]', JSON.stringify(probe, null, 1));
  }

  console.log('\n带 sq= 的音频请求数：' + seen.filter((s) => /[?&]sq=/.test(s.url)).length + ' / ' + seen.length);

  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('意外错误：', e && e.message);
  if (child) child.kill();
  process.exit(1);
});
