// 极简消息总线：Side Panel <-> Service Worker <-> Offscreen Document

export function sendToSW(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: 'sw', type, payload });
}

export function sendToOffscreen(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
}

/** Offscreen -> UI 的单向广播（侧边栏可能已关闭，所以静默吞错） */
export function postToUI(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ target: 'ui', type, payload })
    .catch(() => undefined);
}

export function isForUI(msg) {
  return msg && msg.target === 'ui';
}
