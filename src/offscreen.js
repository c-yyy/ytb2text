/**
 * Offscreen Document —— 真正干活的地方。
 * Extension Page 拥有完整的 DOM / WebGPU / WebAudio / MediaRecorder，
 * 而 Service Worker 没有，所以：录音 + 解码 + Whisper 推理全部放在这里。
 */
import { decodeToMono16k, isSilent, audioDuration, formatTime } from './lib/audio.js';
import { transcribe, loadModel, disposeModel } from './lib/asr.js';
import { postToUI } from './lib/bus.js';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

const recorderState = {
  active: false,
  recorder: null,
  stream: null,
  chunks: [],
  options: null,
  maxTimer: null,
};

let jobToken = 0;

function stopStream() {
  if (recorderState.stream) {
    recorderState.stream.getTracks().forEach((t) => t.stop());
    recorderState.stream = null;
  }
  if (recorderState.maxTimer) {
    clearTimeout(recorderState.maxTimer);
    recorderState.maxTimer = null;
  }
  recorderState.active = false;
  recorderState.recorder = null;
}

async function startRecording({ streamId, options, maxSeconds }) {
  if (recorderState.active) return { ok: false, error: '已有录制在进行中' };

  // 新版 Chrome 用普通约束，旧版用 mandatory，两种都试一遍
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      video: false,
    });
  } catch (e1) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorderState.stream = stream;
  recorderState.recorder = recorder;
  recorderState.chunks = [];
  recorderState.options = options;
  recorderState.active = true;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recorderState.chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    postToUI('error', { message: '录制出错：' + (e.error?.message || e.error || '未知错误') });
  };

  recorder.start(1000);
  postToUI('recording', { active: true });

  if (maxSeconds && maxSeconds > 0) {
    recorderState.maxTimer = setTimeout(() => {
      postToUI('progress', {
        stage: 'prepare',
        message: `已达最长录制时长（${formatTime(maxSeconds)}），自动停止`,
      });
      stopAndTranscribe();
    }, maxSeconds * 1000);
  }

  return { ok: true, mimeType: mimeType || 'default' };
}

function finalizeRecording() {
  return new Promise((resolve) => {
    const recorder = recorderState.recorder;
    if (!recorder) {
      resolve({ ok: false, error: '当前没有进行中的录制' });
      return;
    }
    recorder.onstop = async () => {
      const options = recorderState.options;
      try {
        const blob = new Blob(recorderState.chunks, {
          type: recorder.mimeType || 'audio/webm',
        });
        stopStream();
        postToUI('recording', { active: false });
        if (!blob.size) {
          resolve({ ok: false, error: '没有录到任何音频数据' });
          return;
        }
        const buf = await blob.arrayBuffer();
        const audio = await decodeToMono16k(buf);
        resolve({ ok: true, audio, options, rawBytes: buf.byteLength });
      } catch (e) {
        stopStream();
        postToUI('recording', { active: false });
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    };
    recorder.stop();
  });
}

async function stopAndTranscribe() {
  const res = await finalizeRecording();
  if (!res.ok) {
    postToUI('error', { message: res.error });
    return res;
  }
  if (res.options) return runJob(res.audio, res.options);
  return res;
}

async function runJob(audio, options) {
  const token = ++jobToken;
  const startedAt = Date.now();
  const duration = audioDuration(audio);

  postToUI('progress', {
    stage: 'prepare',
    message: `音频已就绪：${formatTime(duration)}`,
    duration,
  });

  if (isSilent(audio)) {
    const err = '没有检测到有效声音（可能是标签页未播放、被静音，或选错了音频源）';
    postToUI('error', { message: err });
    return { ok: false, error: err };
  }

  try {
    const result = await transcribe(audio, options, {
      onProgress: (p) => postToUI('progress', p),
      shouldStop: () => token !== jobToken,
    });
    result.meta = { ...(result.meta || {}), duration, elapsedMs: Date.now() - startedAt };
    postToUI('done', { duration, elapsedMs: Date.now() - startedAt });
    return { ok: true, ...result };
  } catch (e) {
    const message = String((e && e.message) || e);
    if (message.includes('__CANCELLED__')) {
      postToUI('cancelled', {});
      return { ok: false, cancelled: true };
    }
    postToUI('error', { message });
    return { ok: false, error: message };
  }
}

async function handle(msg) {
  const { type, payload = {} } = msg;

  switch (type) {
    case 'ping':
      return { ok: true };

    case 'asr:preload':
      await loadModel({
        modelId: payload.options.modelId,
        device: payload.options.device,
        mirror: payload.options.mirror,
        onProgress: (p) => postToUI('progress', p),
      });
      return { ok: true };

    case 'rec:start':
      return startRecording(payload);

    case 'rec:stop':
      return stopAndTranscribe();

    case 'job:file': {
      const bytes = payload.bytes;
      if (!bytes) return { ok: false, error: '缺少音频数据' };
      postToUI('progress', { stage: 'decode', message: '正在解码音频…' });
      try {
        const audio = await decodeToMono16k(bytes);
        return runJob(audio, payload.options);
      } catch (e) {
        const message = '音频解码失败：' + String((e && e.message) || e);
        postToUI('error', { message });
        return { ok: false, error: message };
      }
    }

    case 'job:cancel':
      jobToken++;
      if (recorderState.active) stopStream();
      postToUI('cancelled', {});
      return { ok: true };

    case 'asr:dispose':
      await disposeModel();
      return { ok: true };

    default:
      return { ok: false, error: '未知的 Offscreen 指令：' + type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.target !== 'offscreen') return undefined;
  handle(msg)
    .then(respond)
    .catch((e) => {
      const message = String((e && e.message) || e);
      postToUI('error', { message });
      respond({ ok: false, error: message });
    });
  return true;
});
