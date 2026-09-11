/**
 * tools/youtube-check.js —— 在**真实的 YouTube 观看页**上验证「操作栏原生入口」。
 *
 * 为什么需要它：入口是插进别人的 DOM 里的，这类代码只有放到真页面上跑才作数 ——
 * 选择器对不对、class 抄不抄得到、YouTube 重渲染会不会把它冲掉、
 * 点一下面板到底开不开，静态检查一个都答不上来。
 *
 * 与 smoke.js 的分工：
 *   smoke.js         —— 离线自足（自己起本地测试页），验扩展本身
 *   youtube-check.js —— 需要能访问 youtube.com，验「插进第三方页面」这条链路
 *
 * 用法：
 *   node tools/youtube-check.js                      # 默认走 http://127.0.0.1:7897 代理
 *   node tools/youtube-check.js --proxy=http://127.0.0.1:13030
 *   node tools/youtube-check.js --no-proxy           # 直连（能直连 YouTube 时用）
 *   node tools/youtube-check.js --headed             # 有头，方便肉眼看
 *   node tools/youtube-check.js --url=https://...    # 换一个视频
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CDP, sleep, getJSON, waitFor } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const HEADED = process.argv.includes('--headed');
const NO_PROXY = process.argv.includes('--no-proxy');
const argOf = (k) => {
  const hit = process.argv.find((a) => a.indexOf('--' + k + '=') === 0);
  return hit ? hit.slice(k.length + 3) : null;
};
const PROXY = argOf('proxy') || process.env.YT_PROXY || 'http://127.0.0.1:7897';
const VIDEO = argOf('url') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CDP_PORT = 9242;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  —— ' + detail : ''));
}

let child = null;

async function finish(code) {
  if (child) {
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  if (failed) console.log('结果：' + results.length + ' 项里 ' + failed + ' 项失败');
  else console.log('结果：' + results.length + ' 项全部通过 ✓');
  process.exit(code != null ? code : failed ? 1 : 0);
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('找不到 Chrome（退出码 2）');
    process.exit(2);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-yt-'));
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--window-size=1400,900',
  ];
  if (!NO_PROXY) args.push('--proxy-server=' + PROXY);
  if (!HEADED) args.push('--headless=new');
  args.push('about:blank');

  console.log('Chrome：' + chromePath);
  console.log('代理：' + (NO_PROXY ? '(直连)' : PROXY));
  console.log('视频：' + VIDEO + '\n');
  child = spawn(chromePath, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/version');
      break;
    } catch (e) {
      await sleep(500);
    }
  }
  if (!version) {
    console.error('Chrome 的调试端口没起来');
    await finish(1);
    return;
  }
  console.log('Chrome 版本：' + version.Browser + '\n');

  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;

  let extId = null;
  try {
    const r = await browser.send('Extensions.loadUnpacked', { path: ROOT }, 30000);
    extId = r && r.id;
  } catch (e) {
    check('加载扩展', false, e.message);
  }
  check('加载扩展', !!extId, extId ? 'id=' + extId : '');
  if (!extId) return finish(1);

  // 打开视频页
  const created = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(VIDEO),
    { method: 'PUT' }
  ).then((r) => r.json());
  const page = new CDP(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // 1. 页面本体得先真的打开（代理不通的话这里就会失败，早失败早排除）
  const title = await waitFor(page, 'document.title || ""', 45000, 800);
  const onYouTube = await waitFor(
    page,
    '/youtube\\.com$/.test(location.hostname) ? location.hostname : ""',
    20000,
    500
  );
  check('YouTube 页面打开', !!onYouTube, (onYouTube || '?') + '｜' + String(title).slice(0, 60));
  if (!onYouTube) return finish(1);

  const hasMetadata = await waitFor(page, '!!document.querySelector("ytd-watch-metadata")', 30000, 700);
  check('观看页渲染完成（ytd-watch-metadata 就位）', hasMetadata);
  if (!hasMetadata) return finish(1);

  // 2. 入口按钮被注入
  const injected = await waitFor(page, '!!document.getElementById("v2t-page-entry")', 20000, 500);
  check('入口按钮已注入 ytd-menu-renderer', injected, '找不到 #v2t-page-entry');
  if (!injected) return finish(1);

  // 3. 位置：必须落在「保存 / 下载」那一组的末尾，且属于观看页元数据区
  const place = await page.eval(
    '(function(){var b=document.getElementById("v2t-page-entry");' +
      'var box=b.closest("#flexible-item-buttons");' +
      'var meta=b.closest("ytd-watch-metadata");' +
      'var row=b.closest("ytd-menu-renderer");' +
      'return {inFlexible:!!box, inMetadata:!!meta, inMenu:!!row,' +
      ' siblings: box?box.children.length:0, last: box?box.lastElementChild.id:"",' +
      ' label:(b.textContent||"").trim()};})()'
  );
  check('插入位置在 #flexible-item-buttons 内', place.inFlexible, JSON.stringify(place));
  check('位于观看页元数据区（未误插到首页/侧栏）', place.inMetadata);
  check('落在该组末尾（「更多」按钮之前）', place.last === 'v2t-page-entry', 'last=' + place.last);
  check('按钮带「转文字」文字', place.label === '转文字', 'label=' + place.label);

  // 4. 皮肤抄成功没有：class 应该和**同一行**的原生按钮同源（不是兜底的 plain）
  const skin = await page.eval(
    '(function(){var b=document.getElementById("v2t-page-entry");' +
      'var cls=String(b.className);' +
      'var row=b.closest("ytd-menu-renderer");' +
      'var donors=row?row.querySelectorAll("button[aria-label]"):[];' +
      'var mine=cls.split(/\\s+/);' +
      'var shared=0, sameH=0, h=Math.round(b.getBoundingClientRect().height);' +
      'for(var i=0;i<donors.length;i++){var dc=String(donors[i].className).split(/\\s+/);' +
      ' for(var j=0;j<dc.length;j++){if(dc[j]&&mine.indexOf(dc[j])>=0){shared++;break;}}' +
      ' if(Math.abs(Math.round(donors[i].getBoundingClientRect().height)-h)<=1) sameH++;}' +
      'var svg=b.querySelector("svg"); var box=svg?svg.getBoundingClientRect():null;' +
      'return {plain:/v2t-entry-plain/.test(cls), donors:donors.length, shared:shared, sameH:sameH, h:h,' +
      ' size: box?[Math.round(box.width),Math.round(box.height)]:null,' +
      ' stroke: svg?getComputedStyle(svg).stroke:null};})()'
  );
  check('抄到了原生 class（自动跟随站点配色 / 暗色主题）', skin.shared > 0 && !skin.plain,
    '同行原生按钮 ' + skin.donors + ' 个，其中 ' + skin.shared + ' 个与我们共用 class' +
      (skin.plain ? '（走了兜底样式）' : ''));
  check('高度与同行原生按钮一致（不会高出一截）', skin.sameH > 0,
    '本按钮 ' + skin.h + 'px，同高原生按钮 ' + skin.sameH + ' 个');
  check('图标真的渲染出来了（不是 0 尺寸 / stroke:none）',
    !!(skin.size && skin.size[0] > 8 && skin.size[1] > 8 && skin.stroke !== 'none'),
    'svg ' + JSON.stringify(skin.size) + ' stroke=' + skin.stroke);

  // 5. 有原生入口时，右下角悬浮球应该收起来
  const fabHidden = await page.eval(
    'String(document.getElementById("v2t-fab") && getComputedStyle(document.getElementById("v2t-fab")).display)'
  );
  check('原生入口就位时右下角悬浮球收起', fabHidden === 'none', 'display=' + fabHidden);

  // 6. 点一下：面板应该弹出来
  const before = await page.eval('document.getElementById("v2t-panel").hidden');
  await page.eval('document.getElementById("v2t-page-entry").click(); true');
  const opened = await waitFor(page, '!document.getElementById("v2t-panel").hidden', 6000, 200);
  check('点击入口后面板弹出', before === true && !!opened, '点击前 hidden=' + before);

  // 7. 再点一下：收起
  await page.eval('document.getElementById("v2t-page-entry").click(); true');
  const closed = await waitFor(page, 'document.getElementById("v2t-panel").hidden', 6000, 200);
  check('再点一次收起（toggle 生效）', !!closed);

  // 8. 抗重渲染：模拟 YouTube 把那一组清空，看会不会自动补挂
  await page.eval(
    '(function(){var box=document.querySelector("ytd-watch-metadata #flexible-item-buttons");' +
      'if(box)box.textContent=""; return !!box;})()'
  );
  const remounted = await waitFor(page, '!!document.getElementById("v2t-page-entry")', 8000, 300);
  check('节点被重渲染冲掉后会自动补挂', !!remounted);

  // 截图留档
  try {
    const shotDir = path.join(ROOT, 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    await page.eval('document.getElementById("v2t-page-entry").click(); true');
    await sleep(700);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }, 30000);
    fs.writeFileSync(path.join(shotDir, 'youtube-entry.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  截图：screenshots/youtube-entry.png');
  } catch (e) {
    console.log('\n  （截图失败：' + e.message + '）');
  }

  await finish();
}

main().catch(async (e) => {
  console.error('意外错误：' + (e && e.message));
  await finish(1);
});
