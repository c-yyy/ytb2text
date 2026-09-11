/**
 * lib/constants.js —— 模型 / 语言 / 运行设备的元数据。
 *
 * 无构建：这里不写 import/export，而是挂到全局命名空间 V2T 上。
 *   · 页面侧：由 manifest 的 content_scripts.js 数组按序加载（同一个隔离世界）
 *   · 扩展页：由 offscreen.html 用 <script src> 按序加载
 * 同一个文件两边都能用。
 *
 * 注意：带 .en 后缀的模型是「仅英文」版本，中文会被强行音译成英文字母串，
 * 中文场景必须用多语言版。
 */
(function (root) {
  'use strict';

  var MODELS = [
    {
      id: 'Xenova/whisper-tiny',
      label: 'Tiny · 多语言',
      params: 39e6,
      note: '最快，纯 CPU 也能跑；中文准确率一般',
    },
    {
      id: 'Xenova/whisper-base',
      label: 'Base · 多语言',
      params: 74e6,
      note: '推荐：速度与中文准确率均衡',
    },
    {
      id: 'Xenova/whisper-small',
      label: 'Small · 多语言',
      params: 244e6,
      note: '中文明显更准，但更慢更大',
    },
    {
      id: 'Xenova/whisper-tiny.en',
      label: 'Tiny · 仅英文',
      params: 39e6,
      note: '英文专用，体积最小（不可转中文）',
    },
    {
      id: 'Xenova/whisper-base.en',
      label: 'Base · 仅英文',
      params: 74e6,
      note: '英文专用，效果好于 tiny.en（不可转中文）',
    },
  ];

  var LANGUAGES = [
    { code: '', label: '自动检测' },
    { code: 'zh', label: '中文（普通话）' },
    { code: 'yue', label: '粤语' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'ru', label: 'Русский' },
    { code: 'pt', label: 'Português' },
    { code: 'ar', label: 'العربية' },
  ];

  var DEVICES = [
    { id: 'auto', label: '自动（有独显走 WebGPU，否则 CPU）' },
    { id: 'webgpu', label: 'WebGPU（显卡，快很多）' },
    { id: 'wasm', label: 'WASM（CPU，兼容性最好）' },
  ];

  // 模型权重下载源。国内直连 huggingface.co 经常很慢甚至不通，
  // hf-mirror.com 是国内常用镜像，路径结构与官方一致。
  var MIRRORS = [
    { id: 'https://hf-mirror.com', label: 'hf-mirror 镜像（国内推荐）' },
    { id: 'https://huggingface.co', label: 'HuggingFace 官方' },
  ];

  var DEFAULT_SETTINGS = {
    modelId: 'Xenova/whisper-base',
    language: 'zh',
    device: 'auto',
    mirror: 'https://hf-mirror.com',
    translate: false, // true = 转成英文（task=translate）
    filterNoise: true,
    maxRecordSeconds: 900, // 标签页录制上限 15 分钟
  };

  var TARGET_SAMPLE_RATE = 16000; // Whisper 特征提取的硬要求

  // 各精度下每个参数占用的字节数
  var BYTES_PER_PARAM = { q8: 1, fp16: 2, fp32: 4 };

  function estimateModelBytes(modelId, dtype) {
    var m = null;
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === modelId) m = MODELS[i];
    if (!m) return 0;
    var per = BYTES_PER_PARAM[dtype] == null ? 1 : BYTES_PER_PARAM[dtype];
    return Math.round(m.params * per * 1.06); // 含 tokenizer 等杂项
  }

  function formatBytes(n) {
    if (!n) return '—';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + units[i];
  }

  root.V2T = root.V2T || {};
  root.V2T.consts = {
    MODELS: MODELS,
    LANGUAGES: LANGUAGES,
    DEVICES: DEVICES,
    MIRRORS: MIRRORS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    TARGET_SAMPLE_RATE: TARGET_SAMPLE_RATE,
    estimateModelBytes: estimateModelBytes,
    formatBytes: formatBytes,
  };
})(typeof self !== 'undefined' ? self : this);
