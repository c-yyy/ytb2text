/**
 * offscreen.js —— 真正干活的地方（无构建版，普通脚本）。
 *
 * 为什么必须有它：MV3 的 Service Worker 里没有 WebGPU / AudioContext，
 * 模型跑不了、音也解不了。扩展页面（Offscreen Document）两样都有。
 *
 * 消息协议（全部经 Service Worker 转发，见 background.js）：
 *   content → SW → 这里：msg.target === 'offscreen' && msg._forwarded === true
 *   这里 → SW → content：msg.target === 'ui'，由 SW 用 chrome.tabs.sendMessage 送货
 *
 * 长任务（推理）不走「请求-等响应」：收到就立刻 ACK，结果与进度走 'ui' 广播，
 * 这样 Service Worker 不用为了维持端口而吊着 5 分钟（会被回收）。
 *
 * 二进制一律走分块 base64：
 *   chrome.runtime.sendMessage 是 JSON 序列化，ArrayBuffer 到了对面会变成 {}。
 *   音频在 content 侧就统一解码成 16kHz 单声道 Float32Array 再传，
 *   比传整个 mp4 容器小一个数量级。
 */
(function () {
  'use strict';

  var A = self.V2T.audio;
  var ASR = self.V2T.asr;

  /* ---------------- 与 UI 的单向广播 ---------------- */

  function postToUI(type, payload) {
    try {
      chrome.runtime.sendMessage({ target: 'ui', type: type, payload: payload || {} }).catch(function () {});
    } catch (e) {
      /* 扩展上下文失效（重载/更新中）时会抛，直接吞掉 */
    }
  }

  function jobProgress(requestId, p) {
    postToUI('progress', { requestId: requestId, progress: p });
  }

  /* ---------------- base64 分块收发 ---------------- */

  function b64ToU8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // 与 content.js 的 MAX_CHUNK_FLOATS 必须一致（改一处就要改两处）
  var MAX_CHUNK_FLOATS = 4 * 1024 * 1024; // 每块 4M 个 float ≈ 16MB，base64 后约 21MB

  /* ---------------- 文件（已解码 PCM）会话 ---------------- */

  // requestId -> { options, total, parts: [], seen: Set, name }
  var fileSessions = new Map();

  var jobToken = 0;

  /* ---------------- 推理任务 ---------------- */

  async function runJob(audio, options, requestId) {
    var token = ++jobToken;
    var startedAt = Date.now();
    var duration = A.audioDuration(audio);

    jobProgress(requestId, {
      stage: 'prepare',
      message: '音频已就绪：' + A.formatTime(duration),
      duration: duration,
    });

    if (A.isSilent(audio)) {
      var err = '没有检测到有效声音（可能是视频没在播放、被静音，或选错了音轨）';
      postToUI('error', { requestId: requestId, message: err });
      return;
    }

    try {
      var result = await ASR.transcribe(audio, options, {
        onProgress: function (p) {
          jobProgress(requestId, p);
        },
        shouldStop: function () {
          return token !== jobToken;
        },
      });
      result.meta = Object.assign({}, result.meta || {}, {
        duration: duration,
        elapsedMs: Date.now() - startedAt,
      });
      postToUI('result', { requestId: requestId, result: result });
    } catch (e) {
      var message = String((e && e.message) || e);
      if (message.indexOf('__CANCELLED__') >= 0) {
        postToUI('cancelled', { requestId: requestId });
        return;
      }
      postToUI('error', { requestId: requestId, message: message });
    }
  }

  /* ---------------- 消息处理 ---------------- */

  async function handle(msg) {
    var payload = msg.payload || {};

    switch (msg.type) {
      case 'ping':
        return { ok: true };

      case 'asr:preload':
        await ASR.loadModel({
          modelId: payload.options.modelId,
          device: payload.options.device,
          mirror: payload.options.mirror,
          onProgress: function (p) {
            jobProgress(payload.requestId, p);
          },
        });
        return { ok: true };

      // ---- 页面音频 / 字幕：分块 PCM 会话 ----
      case 'job:file-init':
        fileSessions.set(payload.requestId, {
          name: payload.name || '',
          options: payload.options,
          total: payload.total || 0,
          parts: [],
          received: 0,
          seen: new Set(),
        });
        fileSessions.get(payload.requestId).parts.length = Math.max(1, Math.ceil((payload.total || 0) / MAX_CHUNK_FLOATS));
        return { ok: true };

      case 'job:file-chunk': {
        var s = fileSessions.get(payload.requestId);
        if (!s) return { ok: false, error: '会话不存在（init 未到达或已清理）' };
        if (s.seen.has(payload.index)) return { ok: true }; // 重发的重复块
        s.seen.add(payload.index);
        var floats = new Float32Array(b64ToU8(payload.b64).buffer);
        s.parts[payload.index] = floats;
        s.received += floats.length;
        return { ok: true };
      }

      case 'job:file-go': {
        var sess = fileSessions.get(payload.requestId);
        if (!sess) return { ok: false, error: '会话不存在（分块可能丢失）' };
        fileSessions.delete(payload.requestId);
        var merged = new Float32Array(sess.received);
        var off = 0;
        for (var i = 0; i < sess.parts.length; i++) {
          var part = sess.parts[i];
          if (!part) continue;
          merged.set(part, off);
          off += part.length;
        }
        sess.parts.length = 0;
        jobProgress(payload.requestId, { stage: 'decode', message: '音频解码完成，准备推理…' });
        runJob(merged, sess.options, payload.requestId);
        return { ok: true, accepted: true };
      }

      case 'job:cancel':
        jobToken++;
        postToUI('cancelled', { requestId: payload.requestId });
        return { ok: true };

      case 'asr:dispose':
        await ASR.disposeModel();
        return { ok: true };

      default:
        return { ok: false, error: '未知的 Offscreen 指令：' + msg.type };
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.target !== 'offscreen') return undefined;
    // 只处理 Service Worker 转发过来的干净副本。
    // content / popup 的 sendMessage 会广播到扩展的每个上下文 —— 不经这道安检，
    // 同一条指令会被 offscreen 处理两次（分块重复累加、任务跑两遍）。
    if (!msg._forwarded || sender.tab) return undefined;

    handle(msg)
      .then(respond)
      .catch(function (e) {
        var message = String((e && e.message) || e);
        postToUI('error', { requestId: (msg.payload || {}).requestId, message: message });
        respond({ ok: false, error: message });
      });
    return true;
  });

  console.log('[v2t] offscreen 就绪');
})();
