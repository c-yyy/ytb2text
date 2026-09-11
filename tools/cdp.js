/**
 * tools/cdp.js —— 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 只用 node 内置的 WebSocket / fetch，不依赖任何第三方包。
 * smoke.js 与 youtube-check.js 共用这一份。
 *
 * 连接方式回顾（踩过的坑都在这）：
 *   · 正版 Chrome 137+ 已忽略 `--load-extension`，必须走 CDP 的 Extensions.loadUnpacked
 *   · 启动时要带 `--enable-unsafe-extension-debugging`
 *   · `/json/list` 里可能出现内置组件扩展，别拿它当自己的扩展 —— 用 loadUnpacked 的返回值
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return fetch(url).then((r) => r.json());
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  send(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, timeoutMs || 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async eval(expression, timeoutMs) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    );
    if (r.exceptionDetails) {
      const d =
        r.exceptionDetails.exception && r.exceptionDetails.exception.description
          ? r.exceptionDetails.exception.description
          : JSON.stringify(r.exceptionDetails);
      throw new Error('页面内表达式抛错：' + d);
    }
    return r.result && r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

/** 连上浏览器级 WebSocket（用于 Extensions.* 这类浏览器域命令） */
async function connectBrowser(cdpPort, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await getJSON('http://127.0.0.1:' + cdpPort + '/json/version');
      const client = new CDP(v.webSocketDebuggerUrl);
      await client.ready;
      return client;
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw new Error('连不上 Chrome 调试端口 ' + cdpPort + '：' + (lastErr && lastErr.message));
}

/** 新开一个标签页并连上它，返回 { targetId, page } */
async function newPage(cdpPort, url) {
  const t = await fetch(
    'http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(url),
    { method: 'PUT' }
  ).then((r) => r.json());
  const page = new CDP(t.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return { targetId: t.id, page };
}

/** 轮询等待条件成立；expr 需返回真值 */
async function waitFor(page, expr, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    let v = null;
    try {
      v = await page.eval(expr);
    } catch (e) {
      /* 页面可能还在导航，忽略 */
    }
    if (v) return v;
    await sleep(intervalMs || 400);
  }
  return null;
}

module.exports = { CDP, sleep, getJSON, connectBrowser, newPage, waitFor };
