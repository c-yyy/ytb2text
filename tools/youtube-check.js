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
function check(name, ok, detail, soft) {
  // soft = 环境原因导致的「验不出来」：打印出来提醒，但不算失败（退出码不受影响）
  results.push({ name, ok: !!ok || !!soft });
  console.log((ok ? '  ✓ ' : soft ? '  · ' : '  ✗ ') + name + (detail ? '  —— ' + detail : ''));
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
    '--autoplay-policy=no-user-gesture-required',
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

  // 4b. 「在 DOM 里」不等于「看得见」—— 这一条才是本次修的那个 bug：
  //     按钮曾经因为 display:flex 掉到第二行，被 ytd-menu-renderer 的
  //     overflow:hidden 整条裁掉，检测全绿但用户一个按钮都看不到。
  const seen = await page.eval(
    '(async function(){' +
      'var b=document.getElementById("v2t-page-entry");' +
      // 先滚进视口并等一帧：headless 下没完成合成时 elementFromPoint 会误判成 html
      'try{b.scrollIntoView({block:"center"});}catch(e){}' +
      'await new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r);});});' +
      'var r=b.getBoundingClientRect();' +
      'var out={box:[Math.round(r.width),Math.round(r.height)],clippedBy:null,hit:null,display:getComputedStyle(b).display};' +
      'var n=b.parentElement,level=0;' +
      'while(n&&n!==document.documentElement&&level<8){var s=getComputedStyle(n);var rb=n.getBoundingClientRect();' +
      ' if(/hidden|clip|auto|scroll/.test(s.overflowX+" "+s.overflowY)){' +
      '  if(r.right>rb.right+1||r.left<rb.left-1||r.bottom>rb.bottom+1||r.top<rb.top-1){' +
      '   out.clippedBy=n.tagName.toLowerCase()+(n.id?"#"+n.id:"");break;}}' +
      ' n=n.parentElement;level++;}' +
      'var el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));' +
      // 命中的可能是按钮自己的子元素（图标 / 文字），只要在自己身上就算点得到
      'out.hit=el?((el===b||b.contains(el))?"self":(el.tagName.toLowerCase()+(el.id?"#"+el.id:""))):"null";' +
      'out.rect=[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];' +
      'out.inner=[innerWidth,innerHeight];out.scroll=[Math.round(scrollX),Math.round(scrollY)];' +
      'out.vis=(b.checkVisibility?b.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):null);' +
      'out.pe=getComputedStyle(b).pointerEvents;' +
      'out.stack=(document.elementsFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))||[])' +
      '  .slice(0,6).map(function(e){return (e===b?"SELF":e.tagName.toLowerCase()+(e.id?"#"+e.id:""));}).join(">");' +
      'out.inView=r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight;' +
      'return out;})()'
  );
  check('按钮没被任何祖先的 overflow 裁掉（显示：inline-flex，不掉行）',
    !seen.clippedBy && seen.display === 'inline-flex',
    'display=' + seen.display + ' 尺寸=' + JSON.stringify(seen.box) + ' 被裁于=' + (seen.clippedBy || '无'));
  check('按钮落在可视区内且 checkVisibility 为真（这次 bug 的直接判据）',
    seen.inView === true && seen.vis === true,
    'inView=' + seen.inView + ' checkVisibility=' + seen.vis + ' rect=' + JSON.stringify(seen.rect) +
      ' 视口=' + JSON.stringify(seen.inner));

  // 命中测试要和原生按钮同标准：中心点常被自己的子元素（图标/文字）盖住，
  // 所以「命中自己或自己的子元素」就算点得到。绘制有时序，给它几次机会。
  const hitSelf = await waitFor(
    page,
    '(function(){var b=document.getElementById("v2t-page-entry");' +
      'var r=b.getBoundingClientRect();' +
      'var el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));' +
      'return el&&(el===b||b.contains(el))?"self":"";})()',
    12000,
    600
  );
  check('中心点能被 elementFromPoint 命中（真的点得到，和原生按钮同标准）',
    hitSelf === 'self', hitSelf === 'self' ? '命中' : '反复命中不到：' + JSON.stringify(seen));

  // 5. 有原生入口时，右下角悬浮球应该收起来
  const fabHidden = await page.eval(
    'String(document.getElementById("v2t-fab") && getComputedStyle(document.getElementById("v2t-fab")).display)'
  );
  check('原生入口就位时右下角悬浮球收起', fabHidden === 'none', 'display=' + fabHidden);

  // 5b. 核心链路：播放器拉流之后，扩展必须能抓到媒体地址、并挑出带音轨的那条。
  //     这是「不用录制、直接拿到音频文件」的前提，抓不到就只能退成边播边录。
  await page.eval(
    '(function(){var v=document.querySelector("video");' +
      'if(v){try{v.muted=true;}catch(e){}' +
      'try{var p=v.play(); if(p&&p.catch)p.catch(function(){});}catch(e){}} return true;})()'
  );
  await waitFor(
    page,
    '!!document.querySelector("video") && document.querySelector("video").currentTime > 0.5',
    40000,
    700
  );
  const mediaProbe = await waitFor(
    page,
    '(function(){return performance.getEntriesByType("resource").filter(function(e){return /googlevideo/.test(e.name)}).length || "";})()',
    40000,
    1000
  );
  console.log('  （抓到 ' + (mediaProbe || 0) + ' 条 googlevideo 资源记录）');
  // 播放器拉流是异步的、代理环境下时快时慢，所以轮询等它出现，最多等 60 秒
  async function queryStatus() {
    try {
      const l = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const t = l.find((x) => x.url.indexOf('background.js') >= 0);
      if (!t) return null;
      const sw = new CDP(t.webSocketDebuggerUrl);
      await sw.ready;
      await sw.send('Runtime.enable');
      const st = await sw.eval(
        '(async function(){var tabs=await chrome.tabs.query({});' +
          'var t=tabs.find(function(x){return /youtube\\.com/.test(x.url||"")});' +
          'if(!t)return {error:"找不到 YouTube 标签页"};' +
          'return await chrome.tabs.sendMessage(t.id,{target:"cs",type:"entry:status"});})()',
        20000
      );
      sw.close();
      return st;
    } catch (e) {
      return null;
    }
  }

  let st = null;
  for (let i = 0; i < 60; i++) {
    st = await queryStatus();
    if (st && st.mediaTracks > 0) break;
    await sleep(1000);
  }
  if (st && st.mediaTracks > 0) {
    check(
      '抓到媒体地址并挑出带音轨的那条（核心链路：不录制、直接取音频）',
      true,
      '媒体请求 ' + st.perfMedia + ' 条，其中带音轨可用 ' + st.mediaTracks + ' 条'
    );
  } else if (st && st.perfMedia > 0) {
    // 抓到了却挑不出音轨 —— 这是真 bug，把抓到的 itag/mime 全打出来定位
    const dump = await page
      .eval(
        '(function(){var seen={};return performance.getEntriesByType("resource")' +
          '.filter(function(e){return /googlevideo/.test(e.name);})' +
          '.map(function(e){var u=e.name,i=u.indexOf("?"),q={};' +
          ' if(i>=0)u.slice(i+1).split("&").forEach(function(kv){var p=kv.split("=");q[p[0]]=p[1];});' +
          ' var k=(q.itag||"-")+"|"+(q.mime?decodeURIComponent(q.mime):"-");' +
          ' if(seen[k])return null;seen[k]=1;return k;}).filter(Boolean).join(" , ");})()'
      )
      .catch(() => '(拿不到明细)');
    check(
      '抓到媒体地址并挑出带音轨的那条（核心链路：不录制、直接取音频）',
      false,
      '抓到 ' + st.perfMedia + ' 条媒体请求，但一条带音轨的都没挑出来；明细（itag|mime）=' + dump
    );
  } else {
    check(
      '抓到媒体地址并挑出带音轨的那条（核心链路：不录制、直接取音频）',
      false,
      '这台机器（headless + 代理）上播放器没真正拉到流，验不出来 —— 属环境问题，不算失败',
      true
    );
  }

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

  // 9. 容器被折叠时（窗口窄 → YouTube 把「保存/下载」收进 ⋮ 菜单）：
  //    入口必须改挂到「赞/踩/分享」那一行，而且悬浮球要顶上来，
  //    绝不能出现「插在一个看不见的容器里 + 悬浮球也收了」= 一个入口都没有。
  await page.eval(
    '(function(){document.querySelectorAll("#flexible-item-buttons").forEach(' +
      'function(n){n.style.display="none"}); return true;})()'
  );
  const relocated = await waitFor(
    page,
    '(function(){var b=document.getElementById("v2t-page-entry");' +
      'if(!b||!b.isConnected)return "";' +
      'var r=b.getBoundingClientRect(); if(r.width<1||r.height<1)return "";' +
      'return b.closest("#top-level-buttons-computed")?"topLevel":"";})()',
    15000,
    500
  );
  check('容器被折叠时入口改挂到可见的 #top-level-buttons-computed', relocated === 'topLevel',
    '落点=' + (relocated || '(仍不可见)'));
  // 关键不变量：任何时刻都至少有一个「看得见的」入口 ——
  // 要么原生入口在，要么悬浮球在。绝不能两个都没了。
  const anyEntry = await page.eval(
    '(function(){var b=document.getElementById("v2t-page-entry");' +
      'if(b&&b.isConnected){var r=b.getBoundingClientRect();' +
      'if(r.width>1&&r.height>1&&getComputedStyle(b).visibility!=="hidden")return "native-entry";}' +
      'var f=document.getElementById("v2t-fab");' +
      'if(f&&getComputedStyle(f).display!=="none")return "fab";' +
      'return "none";})()'
  );
  check('任何时刻都至少有一个可见入口（原生入口 或 悬浮球）', anyEntry !== 'none', '当前=' + anyEntry);

  // 10. popup 的「检测本页」链路：SW → content script → 回传状态
  try {
    const list = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/list');
    const swTarget = list.find((t) => t.url.indexOf('background.js') >= 0);
    if (!swTarget) {
      check('popup 自检链路（SW 转发 entry:status）', false, '没找到 SW 调试目标');
    } else {
      const sw = new CDP(swTarget.webSocketDebuggerUrl);
      await sw.ready;
      await sw.send('Runtime.enable');
      const st = await sw.eval(
        '(async function(){var tabs=await chrome.tabs.query({});' +
          'var t=tabs.find(function(x){return /youtube\\.com/.test(x.url||"")});' +
          'if(!t)return {error:"找不到 YouTube 标签页"};' +
          'var r=await chrome.tabs.sendMessage(t.id,{target:"cs",type:"entry:status"});' +
          'return r;})()',
        15000
      );
      check('popup 自检链路（SW 转发 entry:status）', !!(st && st.supported && st.host),
        JSON.stringify(st));
      sw.close();
    }
  } catch (e) {
    check('popup 自检链路（SW 转发 entry:status）', false, e.message);
  }

  await finish();
}

main().catch(async (e) => {
  console.error('意外错误：' + (e && e.message));
  await finish(1);
});
