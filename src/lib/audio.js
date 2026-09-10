import { TARGET_SAMPLE_RATE } from './constants.js';

/**
 * 解码任意浏览器可播放的音频/视频二进制数据，输出 16kHz 单声道 Float32Array。
 * Whisper 的特征提取器要求输入采样率固定为 16000。
 */
function makeDecodeContext() {
  const Ctor =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Ctor) {
    try {
      return new Ctor(1, 1, TARGET_SAMPLE_RATE);
    } catch {
      /* 落到 AudioContext */
    }
  }
  return new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_SAMPLE_RATE,
  });
}

function downmixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) {
    // getChannelData 返回的是内部缓冲的视图，拷贝一份避免被回收后内容异常
    return new Float32Array(audioBuffer.getChannelData(0));
  }
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= channels;
  return out;
}

/**
 * @param {ArrayBuffer} arrayBuffer 原始音频/视频字节（mp3/mp4/webm/wav/ogg…）
 * @returns {Promise<Float32Array>} 16kHz 单声道 PCM
 */
export async function decodeToMono16k(arrayBuffer) {
  const ctx = makeDecodeContext();
  try {
    // decodeAudioData 会 detach 传入的 ArrayBuffer，所以传副本
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return downmixToMono(decoded);
  } finally {
    if (ctx.close) ctx.close().catch(() => {});
  }
}

export function audioDuration(mono16k) {
  return mono16k.length / TARGET_SAMPLE_RATE;
}

export function sliceAudio(mono16k, startSec, endSec) {
  const s = Math.max(0, Math.floor(startSec * TARGET_SAMPLE_RATE));
  const e = Math.min(mono16k.length, Math.ceil(endSec * TARGET_SAMPLE_RATE));
  return mono16k.slice(s, e);
}

/** 简单的音量检测，用来提前拦掉「完全静音」的录音 */
export function isSilent(mono16k, threshold = 0.0005) {
  const step = Math.max(1, Math.floor(mono16k.length / 20000));
  let peak = 0;
  for (let i = 0; i < mono16k.length; i += step) {
    const v = Math.abs(mono16k[i]);
    if (v > peak) peak = v;
  }
  return peak < threshold;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}
