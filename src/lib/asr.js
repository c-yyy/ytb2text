import { pipeline, env } from '@huggingface/transformers';

/**
 * 本地 Whisper 推理封装。
 *
 * 运行环境：Offscreen Document（Extension Page），而不是 Service Worker ——
 * SW 里没有 WebGPU / AudioContext / MediaRecorder，跑不了模型也录不了音。
 *
 * 关键点：
 * 1. ONNX Runtime 的 wasm 运行时必须走本地路径（MV3 禁止加载远程脚本），
 *    所以构建时要把 ort-*.wasm / ort-*.mjs 拷到 dist/ort/。
 * 2. 模型权重首次从 HuggingFace 下载，之后由浏览器 Cache Storage 缓存，
 *    后续运行完全离线、零 API 成本。
 */

export function configureEnv({ remoteHost } = {}) {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  // 国内直连 huggingface.co 经常很慢或不通，允许切到镜像站
  if (remoteHost) env.remoteHost = remoteHost.replace(/\/+$/, '');
  try {
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    }
  } catch (e) {
    console.warn('[v2t] 设置 wasmPaths 失败', e);
  }
}

// 模块一加载就把 wasmPaths 指到本地。
// 否则 transformers.js 会默认用 jsDelivr CDN 拉 ORT 运行时，
// 而 MV3 的 CSP 禁止远程脚本，wasm 会直接加载失败。
configureEnv();

let cached = null; // { key, pipe, modelId, device, dtype }

export function currentModelKey() {
  return cached ? cached.key : null;
}

async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/** 按优先级排出「设备 + 精度」尝试顺序，前一个失败就退到后一个 */
export async function resolveAttempts(devicePref) {
  switch (devicePref) {
    case 'webgpu':
      return [
        { device: 'webgpu', dtype: 'fp16' },
        { device: 'webgpu', dtype: 'fp32' },
        { device: 'wasm', dtype: 'q8' },
      ];
    case 'wasm':
      return [{ device: 'wasm', dtype: 'q8' }];
    case 'auto':
    default:
      return (await hasWebGPU())
        ? [
            { device: 'webgpu', dtype: 'fp16' },
            { device: 'webgpu', dtype: 'fp32' },
            { device: 'wasm', dtype: 'q8' },
          ]
        : [{ device: 'wasm', dtype: 'q8' }];
  }
}

function normalizeProgress(p) {
  if (!p) return null;
  const base = {
    file: p.file || '',
    name: p.name || '',
    status: p.status || '',
  };
  if (p.status === 'progress' && p.total) {
    return { ...base, loaded: p.loaded ?? 0, total: p.total, ratio: p.loaded / p.total };
  }
  return { ...base, loaded: p.loaded ?? 0, total: p.total ?? 0, ratio: 0 };
}

/**
 * 加载（或复用已加载的）Whisper 模型。
 * onProgress({ stage, message, ... })
 */
export async function loadModel({ modelId, device = 'auto', mirror, onProgress }) {
  configureEnv({ remoteHost: mirror });
  const attempts = await resolveAttempts(device);

  let lastError = null;
  for (const attempt of attempts) {
    const key = `${modelId}|${attempt.device}|${attempt.dtype}|${env.remoteHost}`;
    if (cached && cached.key === key) {
      onProgress?.({ stage: 'ready', device: attempt.device, dtype: attempt.dtype, cached: true });
      return { modelId, device: attempt.device, dtype: attempt.dtype };
    }

    try {
      onProgress?.({
        stage: 'initiate',
        device: attempt.device,
        dtype: attempt.dtype,
        message: `准备加载模型（${attempt.device} / ${attempt.dtype}）`,
      });

      const pipe = await pipeline('automatic-speech-recognition', modelId, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: (p) => {
          const n = normalizeProgress(p);
          if (n) onProgress?.({ stage: 'download', ...n });
        },
      });

      if (cached) {
        try {
          await cached.pipe.dispose();
        } catch {
          /* ignore */
        }
      }
      cached = { key, pipe, modelId, device: attempt.device, dtype: attempt.dtype };
      onProgress?.({ stage: 'ready', device: attempt.device, dtype: attempt.dtype });
      return { modelId, device: attempt.device, dtype: attempt.dtype };
    } catch (err) {
      lastError = err;
      console.warn(`[v2t] ${attempt.device}/${attempt.dtype} 加载失败，尝试下一个组合`, err);
      onProgress?.({
        stage: 'fallback',
        device: attempt.device,
        dtype: attempt.dtype,
        message: `${attempt.device}/${attempt.dtype} 不可用：${err?.message || err}`,
      });
    }
  }
  throw lastError || new Error('模型加载失败');
}

// Whisper 常见的幻觉输出 / 静音占位，默认过滤掉
const NOISE_PATTERNS = [
  /^\[\s*(blank_audio|silence|inaudible|music|noise)\s*\]$/i,
  /^\[[^\]]{1,24}\]$/,
  /^\s*$/,
  /^(请不吝点赞|订阅|转发|打赏|字幕由|by\s+subtitles?)/i,
];

function cleanText(text) {
  return (text || '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoise(text) {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

/**
 * 转录 16kHz 单声道 Float32Array。
 * 长音频交给 transformers.js 内置的分块逻辑（30s 窗口 + 5s 步长），
 * 它会在块之间保留上下文，比自己硬切 30s 更不容易切断句子。
 */
export async function transcribe(audio, options, { onProgress, shouldStop } = {}) {
  configureEnv({ remoteHost: options.mirror });
  const {
    modelId,
    device = 'auto',
    mirror,
    language = '',
    translate = false,
    filterNoise = true,
  } = options;

  await loadModel({ modelId, device, mirror, onProgress });

  onProgress?.({ stage: 'infer', message: '正在转录…' });

  const out = await cached.pipe(audio, {
    language: language || undefined,
    task: translate ? 'translate' : 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    force_full_sequences: false,
  });

  if (shouldStop?.()) throw new Error('__CANCELLED__');

  const raw = Array.isArray(out.chunks) && out.chunks.length ? out.chunks : [{ text: out.text }];
  const segments = [];
  let cursor = 0;

  for (const c of raw) {
    const text = cleanText(c.text);
    if (!text) continue;
    if (filterNoise && isNoise(text)) continue;

    let start = Array.isArray(c.timestamp) ? c.timestamp[0] : undefined;
    let end = Array.isArray(c.timestamp) ? c.timestamp[1] : undefined;
    if (typeof start !== 'number' || Number.isNaN(start)) start = cursor;
    if (typeof end !== 'number' || Number.isNaN(end)) end = null;
    cursor = end ?? start;

    segments.push({ start, end, text });
  }

  if (!segments.length && out.text) {
    segments.push({ start: 0, end: null, text: cleanText(out.text) });
  }

  return {
    text: segments.map((s) => s.text).join('\n'),
    segments,
    meta: { modelId, device: cached.device, dtype: cached.dtype },
  };
}

export async function disposeModel() {
  if (!cached) return;
  try {
    await cached.pipe.dispose();
  } catch {
    /* ignore */
  }
  cached = null;
}
