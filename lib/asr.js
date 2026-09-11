/**
 * lib/asr.js —— 本地 Whisper 推理封装（无构建版，挂到 V2T.asr）。
 *
 * 运行环境：Offscreen Document（Extension Page）。
 *   MV3 的 Service Worker 里没有 WebGPU / AudioContext / MediaRecorder，
 *   既跑不了模型也录不了音，所以重活必须在 offscreen 文档里做。
 *
 * 两个必须处理的坑：
 *   1. MV3 的 CSP 是 `script-src 'self'`，禁止加载远程脚本。
 *      ONNX Runtime 默认会去 jsDelivr 拉 wasm/mjs，在扩展页里会被直接拦掉，
 *      所以 wasmPaths 必须指向扩展本地的 lib/transformers/。
 *   2. transformers.min.js 是 ESM 包，由 offscreen.html 以 <script type="module">
 *      加载后挂到 window.__V2T_TF。本文件是普通脚本，**不能**在加载期去读它
 *      （module 是 defer 的，早于它执行），所以一律在调用期惰性取。
 */
(function (root) {
  'use strict';

  var TF_URL = 'lib/transformers/';
  var TF_WAIT_MS = 15000;

  var cached = null; // { key, pipe, modelId, device, dtype }

  /** 等 module 脚本把 transformers 命名空间挂上来 */
  function getTF() {
    if (root.__V2T_TF) return Promise.resolve(root.__V2T_TF);
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var timer = setInterval(function () {
        if (root.__V2T_TF) {
          clearInterval(timer);
          resolve(root.__V2T_TF);
          return;
        }
        waited += 50;
        if (waited >= TF_WAIT_MS) {
          clearInterval(timer);
          reject(
            new Error('transformers 运行时未加载（lib/transformers/transformers.min.js 是否缺失？）')
          );
        }
      }, 50);
    });
  }

  function configureEnv(remoteHost) {
    return getTF().then(function (T) {
      var env = T.env;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      // 国内直连 huggingface.co 经常很慢或不通，允许切到镜像站
      if (remoteHost) env.remoteHost = String(remoteHost).replace(/\/+$/, '');

      var onnx = env.backends && env.backends.onnx;
      if (onnx && onnx.wasm) {
        // 关键：把 ORT 运行时指到扩展本地目录，否则会被 MV3 的 CSP 拦掉。
        // transformers.min.js 本身就在这个目录里，它的 webpack publicPath 也是
        // 由 import.meta.url 推出来的同一目录，两边一致。
        try {
          onnx.wasm.wasmPaths = chrome.runtime.getURL(TF_URL);
        } catch (e) {
          console.warn('[v2t] wasmPaths 设置失败', e);
        }
        // 扩展页没有 COOP/COEP，拿不到 SharedArrayBuffer，线程池只能是 1。
        // 显式写死，省掉 ORT 内部的探测与告警。
        try {
          onnx.wasm.numThreads = 1;
        } catch (e) {
          /* 老版本 ORT 可能没有这个字段 */
        }
      }
      return env;
    });
  }

  function currentModelKey() {
    return cached ? cached.key : null;
  }

  async function hasWebGPU() {
    if (!root.navigator || !root.navigator.gpu) return false;
    try {
      var adapter = await root.navigator.gpu.requestAdapter();
      return !!adapter;
    } catch (e) {
      return false;
    }
  }

  /** 按优先级排出「设备 + 精度」尝试顺序，前一个失败就退到后一个 */
  async function resolveAttempts(devicePref) {
    if (devicePref === 'webgpu') {
      return [
        { device: 'webgpu', dtype: 'fp16' },
        { device: 'webgpu', dtype: 'fp32' },
        { device: 'wasm', dtype: 'q8' },
      ];
    }
    if (devicePref === 'wasm') return [{ device: 'wasm', dtype: 'q8' }];
    // auto
    return (await hasWebGPU())
      ? [
          { device: 'webgpu', dtype: 'fp16' },
          { device: 'webgpu', dtype: 'fp32' },
          { device: 'wasm', dtype: 'q8' },
        ]
      : [{ device: 'wasm', dtype: 'q8' }];
  }

  function normalizeProgress(p) {
    if (!p) return null;
    if (p.status === 'progress' && p.total) {
      return {
        file: p.file || '',
        name: p.name || '',
        loaded: p.loaded == null ? 0 : p.loaded,
        total: p.total,
        ratio: p.loaded / p.total,
      };
    }
    return {
      file: p.file || '',
      name: p.name || '',
      loaded: p.loaded == null ? 0 : p.loaded,
      total: p.total == null ? 0 : p.total,
      ratio: 0,
    };
  }

  /**
   * 加载（或复用已加载的）Whisper 模型。
   * onProgress({ stage, message, ... })
   */
  async function loadModel(opts) {
    var modelId = opts.modelId;
    var devicePref = opts.device || 'auto';
    var mirror = opts.mirror;
    var onProgress = opts.onProgress;

    var env = await configureEnv(mirror);
    var T = await getTF();
    var attempts = await resolveAttempts(devicePref);

    var lastError = null;

    for (var i = 0; i < attempts.length; i++) {
      var attempt = attempts[i];
      var key = modelId + '|' + attempt.device + '|' + attempt.dtype + '|' + env.remoteHost;

      // 命中同一组合的缓存实例，直接复用
      if (cached && cached.key === key) {
        if (onProgress) {
          onProgress({ stage: 'ready', device: attempt.device, dtype: attempt.dtype, cached: true });
        }
        return { modelId: modelId, device: attempt.device, dtype: attempt.dtype };
      }

      if (onProgress) {
        onProgress({
          stage: 'initiate',
          device: attempt.device,
          dtype: attempt.dtype,
          message: '准备加载模型（' + attempt.device + ' / ' + attempt.dtype + '）',
        });
      }

      try {
        var pipe = await T.pipeline('automatic-speech-recognition', modelId, {
          device: attempt.device,
          dtype: attempt.dtype,
          progress_callback: function (p) {
            var n = normalizeProgress(p);
            // ratio 可能是 NaN（总长还没探到时），页面侧还会再兜一层
            if (n && isFinite(n.ratio) && onProgress) {
              onProgress({
                stage: 'download',
                file: n.file,
                name: n.name,
                loaded: n.loaded,
                total: n.total,
                ratio: n.ratio,
              });
            }
          },
        });

        var previous = cached;
        cached = {
          key: key,
          pipe: pipe,
          modelId: modelId,
          device: attempt.device,
          dtype: attempt.dtype,
        };
        // 换模型时把旧实例释放掉，否则显存/内存会一直涨
        if (previous) {
          try {
            await previous.pipe.dispose();
          } catch (e) {
            /* 旧实例可能已被回收，忽略 */
          }
        }

        if (onProgress) onProgress({ stage: 'ready', device: attempt.device, dtype: attempt.dtype });
        return { modelId: modelId, device: attempt.device, dtype: attempt.dtype };
      } catch (err) {
        lastError = err;
        console.warn('[v2t] ' + attempt.device + '/' + attempt.dtype + ' 加载失败，尝试下一档', err);
        if (onProgress) {
          onProgress({
            stage: 'fallback',
            device: attempt.device,
            dtype: attempt.dtype,
            message:
              attempt.device +
              '/' +
              attempt.dtype +
              ' 不可用：' +
              ((err && err.message) || String(err)) +
              '，正在切换下一档…',
          });
        }
      }
    }

    throw lastError || new Error('模型加载失败（所有后端组合都不可用）');
  }

  // Whisper 常见的幻觉输出 / 静音占位，默认过滤掉
  var NOISE_PATTERNS = [
    /^\[\s*(blank_audio|silence|inaudible|music|noise)\s*\]$/i,
    /^\[[^\]]{1,24}\]$/,
    /^\s*$/,
    /^(请不吝点赞|订阅|转发|打赏|字幕由|by\s+subtitles?)/i,
  ];

  function cleanText(text) {
    return String(text || '')
      .replace(/<\|[^|]*\|>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isNoise(text) {
    for (var i = 0; i < NOISE_PATTERNS.length; i++) {
      if (NOISE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /**
   * 转录 16kHz 单声道 Float32Array。
   * 长音频交给 transformers.js 内置的分块逻辑（30s 窗口 + 5s 步长），
   * 它会在块之间保留上下文，比自己硬切 30s 更不容易切断句子。
   */
  async function transcribe(audio, options, hooks) {
    var onProgress = (hooks && hooks.onProgress) || null;
    var shouldStop = (hooks && hooks.shouldStop) || null;
    var language = options.language || '';
    var translate = !!options.translate;
    var filterNoise = options.filterNoise !== false;

    await loadModel({
      modelId: options.modelId,
      device: options.device || 'auto',
      mirror: options.mirror,
      onProgress: onProgress,
    });

    if (onProgress) onProgress({ stage: 'infer', message: '正在转录…' });

    var out = await cached.pipe(audio, {
      language: language || undefined,
      task: translate ? 'translate' : 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      force_full_sequences: false,
    });

    if (shouldStop && shouldStop()) throw new Error('__CANCELLED__');

    var raw = Array.isArray(out.chunks) && out.chunks.length ? out.chunks : [{ text: out.text }];
    var segments = [];
    var cursor = 0;

    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      var text = cleanText(c.text);
      if (!text) continue;
      if (filterNoise && isNoise(text)) continue;

      var start = Array.isArray(c.timestamp) ? c.timestamp[0] : undefined;
      var end = Array.isArray(c.timestamp) ? c.timestamp[1] : undefined;
      if (typeof start !== 'number' || isNaN(start)) start = cursor;
      if (typeof end !== 'number' || isNaN(end)) end = null;
      cursor = end == null ? start : end;

      segments.push({ start: start, end: end, text: text });
    }

    if (!segments.length && out.text) {
      segments.push({ start: 0, end: null, text: cleanText(out.text) });
    }

    return {
      text: segments
        .map(function (s) {
          return s.text;
        })
        .join('\n'),
      segments: segments,
      meta: { modelId: options.modelId, device: cached.device, dtype: cached.dtype },
    };
  }

  async function disposeModel() {
    if (!cached) return;
    var p = cached.pipe;
    cached = null;
    try {
      await p.dispose();
    } catch (e) {
      /* ignore */
    }
  }

  root.V2T = root.V2T || {};
  root.V2T.asr = {
    configureEnv: configureEnv,
    currentModelKey: currentModelKey,
    resolveAttempts: resolveAttempts,
    loadModel: loadModel,
    transcribe: transcribe,
    disposeModel: disposeModel,
  };
})(typeof self !== 'undefined' ? self : this);
