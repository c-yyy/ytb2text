/**
 * tools/smoke.js —— 真机冒烟测试（不需要 playwright，直接用 CDP 驱动本机 Chrome）。
 *
 * 为什么要真机跑：扩展有很多错是「静态看不出来、一装就崩」的，比如
 *   · manifest 的 CSP 被 Chrome 判为不安全（`worker-src ... blob:` 就会）
 *   · vendored 的 wasm 路径写错 → 运行时才发现取不到文件
 *   · content script 注入失败 / 选择器和 CSS 对不上
 * 这个脚本把这些都在真实浏览器里跑一遍。
 *
 * 关于加载方式：正版 Google Chrome（137+）已经忽略 `--load-extension` 命令行开关，
 * 所以这里走 CDP 的 `Extensions.loadUnpacked`（需要 --enable-unsafe-extension-debugging）。
 * 附带好处：这个调用的报错信息就是 Chrome 的 manifest 校验结果，天然是个 manifest 检查器。
 *
 * 用法：
 *   node tools/smoke.js                  # 快速自检（装扩展 + UI + vendor 文件）
 *   node tools/smoke.js --with-inference  # 额外真跑一次 tiny 模型（要下 ~40MB，慢）
 *   node tools/smoke.js --headed          # 有头模式，方便肉眼看面板
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HEADED = process.argv.includes('--headed');
const WITH_INFERENCE = process.argv.includes('--with-inference');
const PORT = 8765;
const CDP_PORT = 9231;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const { CDP, sleep, getJSON, waitFor } = require('./cdp');

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

/* ---------------- 测试页 ---------------- */

const TEST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V2T 冒烟测试页</title></head>
<body style="font:14px sans-serif;padding:40px">
  <h1>V2T 冒烟测试页</h1>
  <p>本页含一个 &lt;video&gt; 元素，用于验证 content script 注入与媒体扫描。</p>
  <video id="v" src="/media/sample.mp4" controls width="320"></video>
  <p>下面这个的 src 会被换成 blob:（模拟 MSE 流媒体），用于验证「边播边录」。</p>
  <audio id="a" controls></audio>
</body></html>`;

/** 生成一段真实可播的 WAV 正弦波 —— 「边播边录」必须真的有声音才能录到 */
function makeToneWav(seconds, freq, rate) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const TONE_WAV = makeToneWav(20, 440, 8000);

const testServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url.indexOf('/test') === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_HTML);
    return;
  }
  if (req.url.indexOf('/media/tone.wav') === 0) {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': TONE_WAV.length });
    res.end(TONE_WAV);
    return;
  }
  // 假的媒体文件：只为让 <video src> 能解析出 URL，内容不需要合法
  res.writeHead(200, { 'Content-Type': 'video/mp4' });
  res.end(Buffer.alloc(1024));
});

/* ---------------- 断言 ---------------- */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  —— ' + detail : ''));
}

/* ---------------- 主流程 ---------------- */

let child = null;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('找不到 Chrome，跳过冒烟测试（退出码 2）');
    process.exit(2);
  }

  await new Promise((r) => testServer.listen(PORT, '127.0.0.1', r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-smoke-'));
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,900',
  ];
  if (!HEADED) args.push('--headless=new');
  args.push('about:blank');

  console.log('Chrome：' + chromePath);
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
    process.exit(1);
  }
  console.log('Chrome 版本：' + version.Browser + '\n');

  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;

  // 1. 加载扩展。这一步的报错就是 Chrome 的 manifest 校验结果。
  let extId = null;
  try {
    const r = await browser.send('Extensions.loadUnpacked', { path: ROOT }, 30000);
    extId = r && r.id;
  } catch (e) {
    check('Chrome 接受 manifest 并加载扩展', false, e.message);
  }
  check('Chrome 接受 manifest 并加载扩展', !!extId, extId ? 'id=' + extId : '没有拿到扩展 id');

  if (!extId) {
    await finish(1);
    return;
  }

  // 2. Service Worker 真的要起来（manifest.background 配置对不对）
  let swUp = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !swUp) {
    const list = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/list').catch(() => []);
    swUp = list.some((t) => t.type === 'service_worker' && t.url.indexOf(extId) >= 0);
    if (!swUp) await sleep(400);
  }
  check('Service Worker 启动成功（background.js 没写崩）', swUp);

  // 3. content script 注入 + 面板结构
  //    面板只在 YouTube 上自动注入（manifest 的 matches 只写了 YouTube），
  //    所以本地测试页要手动注入一次 —— 走的是和 popup「打开面板」一样的兜底路径。
  const created = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + PORT + '/test'),
    { method: 'PUT' }
  ).then((r) => r.json());

  const page = new CDP(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const swList = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json/list').catch(() => []);
  const swTarget =
    swList.find((t) => t.type === 'service_worker' && t.url.indexOf(extId) >= 0) ||
    swList.find((t) => t.url.indexOf('background.js') >= 0);
  let injectMsg = '(没找到 SW 调试目标)';
  if (swTarget) {
    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.ready;
    await sw.send('Runtime.enable');
    injectMsg = await sw.eval(
      `(async function(){
        var tabs = await chrome.tabs.query({});
        var t = tabs.find(function(x){ return /127\\.0\\.0\\.1|localhost/.test(x.url || ''); });
        if (!t) return '找不到测试页标签';
        try {
          await chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ['content.css'] });
          await chrome.scripting.executeScript({ target: { tabId: t.id },
            files: ['lib/constants.js', 'lib/audio.js', 'lib/export.js', 'content.js'] });
          return 'ok';
        } catch (e) { return 'err:' + e.message; }
      })()`,
      30000
    );
    sw.close();
  }
  check('本地测试页手动注入 content script（popup 的兜底路径）', injectMsg === 'ok', String(injectMsg));

  // 截图工具：顺便产出 README 用的图，也方便肉眼验收 UI
  const shotDir = path.join(ROOT, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  async function shot(name) {
    try {
      const r = await page.send('Page.captureScreenshot', { format: 'png' }, 30000);
      fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.data, 'base64'));
      return true;
    } catch (e) {
      return false;
    }
  }

  let injected = false;
  for (let i = 0; i < 30; i++) {
    injected = await page.eval("!!document.getElementById('v2t-root')").catch(() => false);
    if (injected) break;
    await sleep(400);
  }
  check('content script 在页面里注入了面板根节点 #v2t-root', injected);

  if (injected) {
    // 下拉是读到 storage 之后才填的，等它填完再量结构
    await waitFor(
      page,
      "!!document.getElementById('v2t-model') && document.getElementById('v2t-model').options.length > 0",
      15000,
      200
    );
    const shape = await page.eval(`(function(){
      var root = document.getElementById('v2t-root');
      var panel = root.querySelector('.v2t-panel');
      var fab = root.querySelector('.v2t-fab');
      var cs = getComputedStyle(fab);
      var rs = getComputedStyle(root);
      return {
        hasFab: !!fab,
        hasPanel: !!panel,
        panelHidden: panel.hidden,
        goBtn: !!root.querySelector('#v2t-go'),
        selects: root.querySelectorAll('select').length,
        modelOptions: root.querySelector('#v2t-model').options.length,
        langOptions: root.querySelector('#v2t-lang').options.length,
        // 样式是否真的生效（不被站点样式或写错类名搞挂）
        fabBorder: cs.borderTopWidth,
        rootPos: rs.position,
        rootZ: rs.zIndex,
        visible: fab.getBoundingClientRect().width > 0
      };
    })()`);
    check(
      '面板结构完整（悬浮按钮 + 面板 + 一键转写按钮 + 4 个设置下拉）',
      shape.hasFab && shape.hasPanel && shape.goBtn && shape.selects === 4,
      JSON.stringify(shape)
    );
    check('模型/语言下拉已用 constants 填充', shape.modelOptions === 5 && shape.langOptions === 12,
      '模型 ' + shape.modelOptions + ' 项 / 语言 ' + shape.langOptions + ' 项');
    check('content.css 真的生效（根节点 fixed + 高 z-index + 按钮粗黑边）',
      shape.rootPos === 'fixed' && Number(shape.rootZ) > 1000000 && shape.fabBorder === '3px',
      'position=' + shape.rootPos + ' z=' + shape.rootZ + ' border=' + shape.fabBorder);
    check('悬浮按钮可见（不是 0 尺寸）', shape.visible);
    check('面板默认收起', shape.panelHidden === true);

    await page.eval("document.getElementById('v2t-root').querySelector('.v2t-fab').click(); true");
    await sleep(150);
    check(
      '点悬浮按钮能展开面板',
      await page.eval("!document.getElementById('v2t-root').querySelector('.v2t-panel').hidden")
    );
    check(
      '检测到页面里的 <video> 并点亮提示圆点',
      await page.eval(
        "document.getElementById('v2t-root').querySelector('.v2t-fab-dot').classList.contains('show')"
      )
    );

    const shotted = await shot('panel-overview.png');
    check('截图产出 screenshots/panel-overview.png', shotted);

    // 给页面塞一条真的能出声的媒体（WAV 正弦波），并把它变成 blob: 源 ——
    // 模拟 YouTube 那种拿不到直连文件的场景
    const blobReady = await page.eval(`(async function(){
      var r = await fetch('/media/tone.wav');
      var b = await r.blob();
      var el = document.getElementById('a');
      el.src = URL.createObjectURL(b);
      await new Promise(function(res){ el.onloadedmetadata = res; setTimeout(res, 3000); });
      return String(el.currentSrc || el.src).indexOf('blob:') === 0 && el.duration > 0;
    })()`);
    check('测试页就绪：<audio> 是 blob: 源且有真实时长（流媒体场景）', blobReady);

    // 一键转写：这里没有 CDN 媒体请求可抓，应当**自动**退到「边播边录」，
    // 而不是甩一句「请去录制」的死胡同 —— 这条同时验证兜底链路是通的。
    await page.eval("(function(){ var b = document.getElementById('v2t-go'); if (b) b.click(); return true; })()");

    const recState = await waitFor(
      page,
      `(function(){
        var root = document.getElementById('v2t-root');
        var rp = root.querySelector('.v2t-sub-panel');
        if (!rp || rp.hidden) return '';
        var timer = root.querySelector('.v2t-rec-timer');
        var el = document.getElementById('a');
        return JSON.stringify({
          timer: timer ? timer.textContent : null,
          playing: !!el && !el.paused,
          src: String((el && el.currentSrc) || '').slice(0, 12)
        });
      })()`,
      30000,
      500
    );
    let recObj = {};
    try { recObj = JSON.parse(recState || '{}'); } catch (e) { recObj = {}; }
    await sleep(1800);
    const timerNow = await page.eval(
      "(function(){ var t = document.getElementById('v2t-root').querySelector('.v2t-rec-timer'); return t ? t.textContent : null; })()"
    );
    check(
      '拿不到直连地址时自动进入「边播边录」（计时在走 + 播放器自动播起来）',
      !!recState && recObj.playing === true && timerNow && timerNow !== '00:00',
      JSON.stringify({ recObj, timerNow })
    );

    await page.eval(
      "(function(){ var b=document.getElementById('v2t-root').querySelector('#v2t-stop-rec'); if(b) b.click(); return true; })()"
    );
    const afterStop = await waitFor(
      page,
      `(function(){
        var p = document.getElementById('v2t-root').querySelector('#v2t-progress-card');
        var t = p.querySelectorAll('.v2t-hint')[0];
        var d = p.querySelectorAll('.v2t-hint')[1];
        var s = (t ? t.textContent : '') + '|' + (d ? d.textContent : '');
        if (s.indexOf('失败') >= 0) return s;
        if (s.indexOf('解码') >= 0 || s.indexOf('传输') >= 0 || s.indexOf('转录') >= 0 || s.indexOf('模型') >= 0) return s;
        return '';
      })()`,
      15000,
      400
    );
    check('录到的音频能被解码并送入推理链路（没有出现「没有录到音频」）',
      !!afterStop && String(afterStop).indexOf('失败') < 0, '进度=' + afterStop);
    // 立刻取消，别在冒烟阶段真去下载模型
    await page.eval(
      "(function(){ var b=document.getElementById('v2t-root').querySelector('#v2t-progress-card button'); if(b) b.click(); return true; })()"
    );
    await sleep(600);

    // 再点一次应该收起
    await page.eval("document.getElementById('v2t-root').querySelector('.v2t-fab').click(); true");
    await sleep(150);
    check(
      '再点一次能收起面板',
      await page.eval("document.getElementById('v2t-root').querySelector('.v2t-panel').hidden")
    );
  }
  page.close();

  // 4. 扩展页能加载本地 transformers 运行时
  const off = await fetch(
    'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/offscreen.html'),
    { method: 'PUT' }
  ).then((r) => r.json());

  const offPage = new CDP(off.webSocketDebuggerUrl);
  await offPage.ready;
  await offPage.send('Runtime.enable');

  const tf = await offPage
    .eval(
      `new Promise(function(resolve){
        var t0 = Date.now();
        (function poll(){
          if (window.__V2T_TF) resolve({ ok:true, ns: Object.keys(window.__V2T_TF).length });
          else if (Date.now() - t0 > 20000) resolve({ ok:false });
          else setTimeout(poll, 200);
        })();
      })`,
      30000
    )
    .catch((e) => ({ ok: false, error: String(e.message) }));

  check(
    'offscreen.html 加载本地 transformers 运行时（外部 ESM，非内联）',
    tf && tf.ok && tf.ns > 10,
    JSON.stringify(tf)
  );

  // 全局命名空间单独求值：不能从上面那个 promise 的结果里读，
  // 否则一旦它提前返回，这里会跟着变成假阴性。
  const globals = await offPage
    .eval(
      `JSON.stringify({
         hasPipeline: typeof (window.__V2T_TF || {}).pipeline,
         consts: !!(window.V2T && window.V2T.consts && window.V2T.consts.MODELS),
         audio: !!(window.V2T && window.V2T.audio && window.V2T.audio.decodeToMono16k),
         ex: !!(window.V2T && window.V2T.ex && window.V2T.ex.toSRT),
         asr: !!(window.V2T && window.V2T.asr && window.V2T.asr.transcribe)
       })`
    )
    .catch((e) => 'ERR ' + e.message);
  const g = typeof globals === 'string' && globals[0] === '{' ? JSON.parse(globals) : {};
  check(
    'lib/*.js 四个全局命名空间都挂上了',
    g.consts && g.audio && g.ex && g.asr,
    'consts=' + g.consts + ' audio=' + g.audio + ' ex=' + g.ex + ' asr=' + g.asr
  );
  check('transformers 的 pipeline 导出可用', g.hasPipeline === 'function', 'typeof pipeline = ' + g.hasPipeline);

  // 5. ORT wasmPaths 指向扩展本地目录（否则被 MV3 CSP 拦）
  const env = await offPage
    .eval(
      `window.V2T.asr.configureEnv('https://hf-mirror.com').then(function(env){
         var w = env.backends.onnx.wasm;
         return { ok:true, paths: String(w.wasmPaths), numThreads: w.numThreads, remote: env.remoteHost };
       }).catch(function(e){ return { ok:false, why:String((e&&e.message)||e) }; })`,
      30000
    )
    .catch((e) => ({ ok: false, why: String(e.message) }));

  check(
    'ORT wasmPaths 指向扩展本地目录',
    env && env.ok && /chrome-extension:\/\//.test(env.paths || ''),
    JSON.stringify(env)
  );
  check('模型下载源被正确重写（默认走国内镜像）', env && env.remote === 'https://hf-mirror.com', 'remoteHost=' + (env && env.remote));

  // 6. 本地 wasm 文件真的能取到
  //    注：chrome-extension:// 的 HEAD 不带 content-length，所以体积在 node 侧校验
  const head = await offPage
    .eval(
      `fetch(chrome.runtime.getURL('lib/transformers/ort-wasm-simd-threaded.jsep.wasm'))
         .then(function(r){ return { ok:r.ok, status:r.status }; })
         .catch(function(e){ return { ok:false, err:String((e&&e.message)||e) }; })`,
      30000
    )
    .catch((e) => ({ ok: false, err: String(e.message) }));
  const wasmFile = path.join(ROOT, 'lib/transformers/ort-wasm-simd-threaded.jsep.wasm');
  const wasmSize = fs.existsSync(wasmFile) ? fs.statSync(wasmFile).size : 0;
  check(
    '扩展页能读到本地 ORT wasm，且文件体积正常（约 20MB）',
    head && head.ok && wasmSize > 10 * 1024 * 1024,
    'fetch=' + JSON.stringify(head) + ' 磁盘=' + (wasmSize / 1048576).toFixed(1) + 'MB'
  );

  // 7. 推理全链路（可选）：真下模型、真跑一次
  if (WITH_INFERENCE) {
    console.log('\n  … 开始真实推理测试（要下 tiny 模型，慢，请等）');
    const inf = await offPage
      .eval(
        `(function(){
           // 造一段 3 秒 440Hz 正弦波当输入，验证「分块 → 特征提取 → ONNX → 输出解析」整条链路不炸
           var sr = 16000, n = sr * 3, audio = new Float32Array(n);
           for (var i = 0; i < n; i++) audio[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.3;
           var stages = [];
           return window.V2T.asr.transcribe(audio, {
             modelId: 'Xenova/whisper-tiny',
             device: 'wasm',
             mirror: 'https://hf-mirror.com',
             language: 'zh',
             translate: false,
             filterNoise: false
           }, {
             onProgress: function(p){ stages.push(p.stage); }
           }).then(function(r){
             return { ok:true, stages: stages.join(','), segs: (r.segments||[]).length, device: r.meta && r.meta.device, dtype: r.meta && r.meta.dtype };
           }).catch(function(e){ return { ok:false, why:String((e&&e.message)||e), stages: stages.join(',') }; });
         })()`,
        8 * 60 * 1000
      )
      .catch((e) => ({ ok: false, why: String(e.message) }));
    check('Whisper 全链路推理跑通（分块→特征→ONNX→解析）', inf && inf.ok, JSON.stringify(inf));
  } else {
    console.log('\n  · 跳过推理测试（加 --with-inference 可开启）');
  }

  offPage.close();
  await finish(results.filter((r) => !r.ok).length ? 1 : 0);
}

async function finish(code) {
  try {
    if (child) child.kill();
  } catch (e) {
    /* ignore */
  }
  try {
    testServer.close();
  } catch (e) {
    /* ignore */
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过' : '✓ 全部通过'));
  process.exit(code);
}

main().catch(async (e) => {
  console.error('冒烟测试异常：', e);
  await finish(1);
});
