// 模型 / 语言 / 运行设备的元数据
// 注意：带 .en 后缀的模型是「仅英文」版本，无法转写中文。中文必须用多语言版。

export const MODELS = [
  {
    id: 'Xenova/whisper-tiny',
    label: 'Tiny · 多语言',
    params: 39e6,
    note: '最快，CPU 也能跑；中文准确率一般',
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

export const LANGUAGES = [
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

export const DEVICES = [
  { id: 'auto', label: '自动（有独显走 WebGPU，否则 CPU）' },
  { id: 'webgpu', label: 'WebGPU（显卡，快很多）' },
  { id: 'wasm', label: 'WASM（CPU，兼容性最好）' },
];

// 模型权重的下载源。国内直连 huggingface.co 经常很慢甚至不通，
// hf-mirror.com 是国内常用的镜像，路径结构与官方一致。
export const MIRRORS = [
  { id: 'https://huggingface.co', label: 'HuggingFace 官方' },
  { id: 'https://hf-mirror.com', label: 'hf-mirror 镜像（国内推荐）' },
];

export const DEFAULT_SETTINGS = {
  modelId: 'Xenova/whisper-base',
  language: 'zh',
  device: 'auto',
  mirror: 'https://hf-mirror.com',
  translate: false, // true = 转成英文（task=translate）
  filterNoise: true,
  maxRecordSeconds: 900,
};

export const TARGET_SAMPLE_RATE = 16000;

// 各精度下每个参数占用的字节数
const BYTES_PER_PARAM = { q8: 1, fp16: 2, fp32: 4 };

export function estimateModelBytes(modelId, dtype) {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) return 0;
  return Math.round(m.params * (BYTES_PER_PARAM[dtype] ?? 1) * 1.06); // 含 tokenizer 等杂项
}

export function formatBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
