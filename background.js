/**
 * background.js —— Manifest V3 Service Worker（无构建版，普通脚本）。
 *
 * 职责极简，三件事：
 *   1. 消息路由：content / popup ←→ offscreen 之间的中转站
 *   2. Offscreen Document 生命周期：按需创建、就绪等待
 *   3. 代页面调用只有 SW 能用的 API（tabCapture.getMediaStreamId、scripting）
 *
 * 它本身不跑模型 —— MV3 的 SW 里没有 WebGPU / AudioContext / MediaRecorder，
 * 而且随时会被回收，重活全部交给 Offscreen Document。
 *
 * 消息约定（三个 target）：
 *   target:'sw'        —— 需要 SW 亲自办事（拿 streamId、开面板、建 offscreen）
 *   target:'offscreen' —— 要往 Offscreen 送指令；SW 补 _forwarded 后再转一手
 *   target:'ui'        —— Offscreen 单向广播进度/结果，SW 负责送到页面里的面板
 *
 * 「补 _forwarded」这步不能省：
 *   chrome.runtime.sendMessage 会广播给扩展的每个上下文，content 发的指令
 *   SW 和 offscreen 会各收到一份。offscreen 只认带 _forwarded 的那份，
 *   否则同一条指令会被处理两遍（分块重复累加、任务跑两趟）。
 */

const OFFSCREEN_URL = 'offscreen.html';

/* ---------------- Offscreen 生命周期 ---------------- */

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

let creating = null;

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS', 'LOCAL_STORAGE', 'BLOBS'],
      justification: '在后台运行 Whisper 本地推理（WebGPU / WASM 需要 Worker，模型缓存在本地存储）',
    })
    .catch((err) => {
      // 已经存在同名文档时会抛错，忽略即可
      if (!/already exists/i.test(String(err && err.message))) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/* ---------------- 工具 ---------------- */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * 注入到页面 MAIN world 执行 —— 这里读的是页面自己的 window，
 * 所以**不能引用本文件里的任何外部变量**（函数体会被序列化后丢进页面）。
 * 现在只认 YouTube 的 ytInitialPlayerResponse；其它站点返回空数组。
 */
function readPageCaptionTracks() {
  try {
    const r = window.ytInitialPlayerResponse;
    const tracks =
      r &&
      r.captions &&
      r.captions.playerCaptionsTracklistRenderer &&
      r.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!tracks || !tracks.length) return [];
    return tracks.map(function (t) {
      const name = t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text));
      return { baseUrl: t.baseUrl, lang: t.languageCode, name: name || t.languageCode };
    });
  } catch (e) {
    return [];
  }
}

/** 页面侧脚本必须的四个文件，顺序不能乱（content.js 依赖前三个挂的全局） */
const CS_FILES = ['lib/constants.js', 'lib/audio.js', 'lib/export.js', 'content.js'];

/**
 * 向目标标签页的面板发消息；页面是扩展安装/更新前就打开的、或者刚被刷新丢了
 * 注入时，content script 不存在会发送失败 —— 此时补一次手动注入再重试。
 *
 * 面板只在 YouTube 上出现，所以非 YouTube 页面一律不补注入（补了也没用，
 * 还会在受限页面上刷一堆报错）。
 */
const YOUTUBE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtube-nocookie\.com)\//i;

async function isYoutubeTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return !!(t && t.url && YOUTUBE.test(t.url));
  } catch (e) {
    return false;
  }
}

async function sendToPanel(tabId, message) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, res };
  } catch (e) {
    if (!(await isYoutubeTab(tabId))) {
      throw new Error('这个页面不是 YouTube，面板只在 YouTube 上出现。');
    }
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: CS_FILES });
      const res = await chrome.tabs.sendMessage(tabId, message);
      return { ok: true, injected: true, res };
    } catch (e2) {
      throw new Error('无法在该页面注入面板（chrome:// 等受限页面不支持）：' + (e2.message || e2));
    }
  }
}

/**
 * 把 offscreen 的进度/结果广播给所有页面的面板。
 * 不精确定向到某一个 tab：面板自己会用 requestId 过滤，不属于自己的直接忽略。
 * 这样 SW 重启后也不用维护任何「任务 → 标签页」的映射。
 */
async function broadcastToPanels(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) =>
      t.id == null ? null : chrome.tabs.sendMessage(t.id, message).catch(() => undefined)
    )
  );
  // 顺带送给 popup（扩展页之间用 runtime 通道）
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

/* ---------------- SW 自己处理的指令 ---------------- */

async function handleSW(type, payload) {
  switch (type) {
    case 'panel:toggle': {
      let tabId = payload.tabId;
      if (tabId == null) {
        const tab = await getActiveTab();
        tabId = tab && tab.id;
      }
      if (tabId == null) throw new Error('找不到当前标签页');
      const r = await sendToPanel(tabId, { target: 'cs', type: 'panel:toggle' });
      return Object.assign({ tabId }, r);
    }

    case 'panel:open': {
      let tabId = payload.tabId;
      if (tabId == null) {
        const tab = await getActiveTab();
        tabId = tab && tab.id;
      }
      if (tabId == null) throw new Error('找不到当前标签页');
      const r = await sendToPanel(tabId, { target: 'cs', type: 'panel:open' });
      return Object.assign({ tabId }, r);
    }

    // 页面里「原生入口」到底挂上没有 —— 面板不显示时用它定位卡在哪一步
    case 'panel:status': {
      let tabId = payload.tabId;
      if (tabId == null) {
        const tab = await getActiveTab();
        tabId = tab && tab.id;
      }
      if (tabId == null) throw new Error('找不到当前标签页');
      const r = await sendToPanel(tabId, { target: 'cs', type: 'entry:status' });
      return Object.assign({ tabId, status: r && r.res }, r);
    }

    case 'offscreen:ensure':
      await ensureOffscreen();
      return { ok: true };

    // 页面自带字幕（YouTube 等）。
    // 必须 inject 到 MAIN world 才能读到页面自己的 window 变量 ——
    // content script 跑在隔离世界，看不到页面的 ytInitialPlayerResponse。
    case 'page:captions': {
      let tabId = payload.tabId;
      if (tabId == null) {
        const tab = await getActiveTab();
        tabId = tab && tab.id;
      }
      if (tabId == null) return { ok: true, tracks: [] };
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readPageCaptionTracks,
        });
        const tracks = (results && results[0] && results[0].result) || [];
        return { ok: true, tracks };
      } catch (e) {
        // 受限页面 / 站点不支持，返回空列表即可，不要打断面板
        return { ok: true, tracks: [] };
      }
    }

    // 页面内下载被拦（CORS / 403）时的备用链路：SW 有 host 权限，不受 CORS 限制。
    // 二进制走 base64 回传（sendMessage 是 JSON 序列化），所以限制在 40MB 以内。
    case 'media:fetch': {
      const r = await fetch(payload.url, { credentials: 'omit' });
      if (!r.ok) throw new Error('媒体下载失败：HTTP ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength > 40 * 1024 * 1024) throw new Error('媒体太大（>40MB），已放弃');
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      return { ok: true, b64: btoa(s), bytes: buf.byteLength };
    }

    // 字幕文件由 SW 去取：扩展 SW 有 <all_urls> 的 host 权限，不受 CORS 限制；
    // 而页面侧 fetch 去 youtube.com 会被 CORS 拦掉。
    case 'captions:fetch': {
      const r = await fetch(payload.url, { credentials: 'omit' });
      if (!r.ok) throw new Error('字幕请求 HTTP ' + r.status);
      return { ok: true, text: await r.text() };
    }

    default:
      throw new Error('未知的 SW 指令：' + type);
  }
}

/* ---------------- 统一入口 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.target) return undefined;

  // 1) SW 亲自办
  if (msg.target === 'sw') {
    handleSW(msg.type, msg.payload || {})
      .then(respond)
      .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // 2) 转发给 Offscreen。
  //    sender.tab 有值 = 来自页面 content script，需要转发；
  //    没有 sender.tab = 来自 Offscreen 自己（它不会听自己的消息，这里是防御性判断）
  //    或来自 popup —— popup 要转，但 offscreen 自己发的不转。
  if (msg.target === 'offscreen') {
    if (msg._forwarded) return undefined; // 这就是我们自己刚转出去的那份，别回环
    (async () => {
      // popup 也能发 offscreen 指令，来源不同但都要保证文档已就绪
      await ensureOffscreen();
      return chrome.runtime.sendMessage(Object.assign({}, msg, { _forwarded: true }));
    })()
      .then(respond)
      .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // 3) Offscreen 的广播 → 送到页面里的面板
  if (msg.target === 'ui') {
    if (sender && sender.tab) return undefined; // 页面自己发的 ui 消息不用再兜一圈
    broadcastToPanels(msg).catch(() => undefined);
    return undefined;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[v2t] 已安装/更新');
});
