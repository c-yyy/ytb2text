/**
 * Service Worker（MV3）。
 * 它本身不跑模型 —— MV3 的 SW 里没有 WebGPU / AudioContext / MediaRecorder，
 * 所以重活全部交给 Offscreen Document。SW 只负责三件事：
 *   1. 点击图标打开侧边栏
 *   2. 按需创建 Offscreen Document 并转发消息
 *   3. 代侧边栏调用 tabCapture / tabs 这类只能在 SW 用的 API
 */

const OFFSCREEN_URL = 'offscreen.html';

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
      reasons: ['USER_MEDIA', 'WORKERS', 'LOCAL_STORAGE', 'BLOBS'],
      justification: '在后台运行 Whisper 本地推理，并对标签页音频进行录制',
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

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function handleSW(type, payload) {
  switch (type) {
    case 'tab:getStreamId': {
      const tabId = payload.tabId || (await getActiveTabId());
      if (!tabId) throw new Error('找不到当前标签页');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      return { ok: true, streamId, tabId };
    }

    case 'page:scan': {
      const tabId = payload.tabId || (await getActiveTabId());
      if (!tabId) throw new Error('找不到当前标签页');
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'v2t:scan' });
        return res || { ok: false, error: '页面未响应（可能是 chrome:// 等受限页面）' };
      } catch (e) {
        return { ok: false, error: '无法访问该页面：' + (e.message || e) };
      }
    }

    case 'offscreen:ensure':
      await ensureOffscreen();
      return { ok: true };

    default:
      throw new Error('未知的 SW 指令：' + type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.target) return undefined;

  if (msg.target === 'sw') {
    handleSW(msg.type, msg.payload || {})
      .then(respond)
      .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.target === 'offscreen') {
    (async () => {
      await ensureOffscreen();
      return chrome.runtime.sendMessage(msg);
    })()
      .then(respond)
      .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});
