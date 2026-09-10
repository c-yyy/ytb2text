import {
  MODELS,
  LANGUAGES,
  DEVICES,
  MIRRORS,
  DEFAULT_SETTINGS,
  estimateModelBytes,
  formatBytes,
} from './lib/constants.js';
import { sendToSW, sendToOffscreen, isForUI } from './lib/bus.js';
import {
  toPlainText,
  toTimestampedText,
  toSRT,
  toVTT,
  downloadFile,
} from './lib/export.js';
import { formatTime } from './lib/audio.js';

const $ = (id) => document.getElementById(id);

const el = {
  modelSelect: $('modelSelect'),
  langSelect: $('langSelect'),
  deviceSelect: $('deviceSelect'),
  mirrorSelect: $('mirrorSelect'),
  translateChk: $('translateChk'),
  filterChk: $('filterChk'),
  modelHint: $('modelHint'),
  runtimeBadge: $('runtimeBadge'),
  preloadBtn: $('preloadBtn'),

  sourceHint: $('sourceHint'),
  recPanel: $('recPanel'),
  recTimer: $('recTimer'),
  stopRecBtn: $('stopRecBtn'),
  pagePanel: $('pagePanel'),
  pageMediaList: $('pageMediaList'),
  pageCaptionList: $('pageCaptionList'),
  fileInput: $('fileInput'),

  progressCard: $('progressCard'),
  barFill: $('barFill'),
  progressText: $('progressText'),
  progressDetail: $('progressDetail'),
  cancelBtn: $('cancelBtn'),

  resultCard: $('resultCard'),
  resultBox: $('resultBox'),
  resultMeta: $('resultMeta'),
  copyBtn: $('copyBtn'),
  txtBtn: $('txtBtn'),
  srtBtn: $('srtBtn'),
  vttBtn: $('vttBtn'),
};

const state = {
  busy: false,
  segments: [],
  view: 'plain',
  recTimerId: null,
  recStart: 0,
  inferTimerId: null,
  inferStart: 0,
  audioDuration: 0,
  resolved: null, // { device, dtype }
};

/* ---------------- 设置 ---------------- */

function fillSelect(select, items, value) {
  select.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id ?? it.code;
    o.textContent = it.label;
    select.appendChild(o);
  }
  if (value !== undefined) select.value = value;
}

function getSettings() {
  return {
    modelId: el.modelSelect.value,
    language: el.langSelect.value,
    device: el.deviceSelect.value,
    mirror: el.mirrorSelect.value,
    translate: el.translateChk.checked,
    filterNoise: el.filterChk.checked,
  };
}

function applySettings(s) {
  const merged = { ...DEFAULT_SETTINGS, ...(s || {}) };
  fillSelect(el.modelSelect, MODELS, merged.modelId);
  fillSelect(el.langSelect, LANGUAGES, merged.language);
  fillSelect(el.deviceSelect, DEVICES, merged.device);
  fillSelect(el.mirrorSelect, MIRRORS, merged.mirror);
  el.translateChk.checked = !!merged.translate;
  el.filterChk.checked = merged.filterNoise !== false;
  updateModelHint();
}

function saveSettings() {
  chrome.storage.local.set({ v2t_settings: getSettings() });
}

function updateModelHint() {
  const m = MODELS.find((x) => x.id === el.modelSelect.value);
  if (!m) return;
  const q8 = estimateModelBytes(m.id, 'q8');
  const fp16 = estimateModelBytes(m.id, 'fp16');
  el.modelHint.textContent = `${m.note}｜首次下载约 ${formatBytes(q8)}（CPU / q8）或 ${formatBytes(
    fp16
  )}（WebGPU / fp16）`;
}

/* ---------------- 通用 UI ---------------- */

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('.src-btn').forEach((b) => {
    b.disabled = busy;
  });
  el.preloadBtn.disabled = busy;
  el.progressCard.hidden = !busy;
  if (busy) {
    el.resultCard.hidden = true;
    el.barFill.style.width = '0%';
    el.progressText.textContent = '准备中…';
    el.progressDetail.textContent = '';
  }
}

function setProgress(text, detail, ratio) {
  el.progressText.textContent = text;
  el.progressDetail.textContent = detail || '';
  el.barFill.classList.remove('indet');
  if (typeof ratio === 'number') {
    el.barFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  }
}

function setIndeterminate() {
  el.barFill.classList.add('indet');
}

function fail(message) {
  stopInferTimer();
  stopRecTimer();
  setBusy(false);
  el.progressCard.hidden = false;
  el.progressText.textContent = '失败';
  el.progressDetail.textContent = message;
  el.barFill.classList.remove('indet');
  el.barFill.style.width = '100%';
  el.barFill.style.background = 'var(--danger)';
}

function okDone(message) {
  stopInferTimer();
  stopRecTimer();
  setBusy(false);
  el.progressCard.hidden = true;
  el.barFill.style.background = '';
  el.resultCard.hidden = false;
  el.resultMeta.textContent = message || '';
}

function startInferTimer() {
  stopInferTimer();
  state.inferStart = Date.now();
  state.inferTimerId = setInterval(() => {
    const sec = (Date.now() - state.inferStart) / 1000;
    const total = state.audioDuration ? ` / 音频 ${formatTime(state.audioDuration)}` : '';
    setProgress(`正在转录… 已用 ${formatTime(sec)}${total}`, 'WebGPU 下通常 1~3 倍速，CPU 下会慢很多，请耐心等待');
    setIndeterminate();
  }, 500);
}

function stopInferTimer() {
  if (state.inferTimerId) clearInterval(state.inferTimerId);
  state.inferTimerId = null;
}

function startRecTimer() {
  stopRecTimer();
  state.recStart = Date.now();
  state.recTimerId = setInterval(() => {
    el.recTimer.textContent = formatTime((Date.now() - state.recStart) / 1000);
  }, 500);
}

function stopRecTimer() {
  if (state.recTimerId) clearInterval(state.recTimerId);
  state.recTimerId = null;
}

/* ---------------- 结果 ---------------- */

function setResult(result, extraMeta) {
  state.segments = result.segments || [];
  el.resultCard.hidden = false;
  renderResult();
  const meta = result.meta || {};
  const parts = [];
  if (meta.source) parts.push(meta.source);
  if (meta.modelId) parts.push(meta.modelId.replace('Xenova/', ''));
  if (meta.device) parts.push(`${meta.device}/${meta.dtype || ''}`);
  if (meta.duration) parts.push(`音频 ${formatTime(meta.duration)}`);
  if (meta.elapsedMs) parts.push(`耗时 ${(meta.elapsedMs / 1000).toFixed(1)}s`);
  if (extraMeta) parts.push(extraMeta);
  el.resultMeta.textContent = parts.filter(Boolean).join(' · ');
  chrome.storage.local.set({ v2t_last: { segments: state.segments, meta: parts.join(' · ') } });
}

function renderResult() {
  el.resultBox.textContent =
    state.view === 'time' ? toTimestampedText(state.segments) : toPlainText(state.segments);
}

function baseName() {
  return `transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
}

/* ---------------- 三条音频链路 ---------------- */

async function startTabRecording() {
  setBusy(true);
  setProgress('正在获取标签页音频权限…', '');
  try {
    const res = await sendToSW('tab:getStreamId', {});
    if (!res || !res.ok) throw new Error((res && res.error) || '无法获取标签页音频');

    el.recPanel.hidden = false;
    el.recTimer.textContent = '00:00';
    startRecTimer();
    setProgress('录制中…', '请让视频保持播放；完成后点「停止并开始转录」');
    setIndeterminate();

    const r = await sendToOffscreen('rec:start', {
      streamId: res.streamId,
      options: getSettings(),
      maxSeconds: 900,
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '录制启动失败');
    el.sourceHint.textContent = '录制中：标签页音频（最长 15 分钟自动停止）';
  } catch (e) {
    el.recPanel.hidden = true;
    fail(String((e && e.message) || e));
  }
}

async function stopAndTranscribe() {
  el.recPanel.hidden = true;
  stopRecTimer();
  setBusy(true);
  setProgress('正在解码录音…', '');
  try {
    const res = await sendToOffscreen('rec:stop', {});
    handleJobResponse(res);
  } catch (e) {
    fail(String((e && e.message) || e));
  }
}

async function runBytes(bytes, label) {
  setBusy(true);
  setProgress('正在解码音频…', `${label}（${formatBytes(bytes.byteLength)}）`);
  try {
    const res = await sendToOffscreen('job:file', { bytes, options: getSettings() });
    handleJobResponse(res);
  } catch (e) {
    fail(String((e && e.message) || e));
  }
}

function handleJobResponse(res) {
  if (!res || !res.ok) {
    if (res && res.cancelled) {
      setBusy(false);
      el.progressCard.hidden = true;
      return;
    }
    fail((res && res.error) || '转录失败');
    return;
  }
  setResult(res);
  okDone(el.resultMeta.textContent);
}

async function scanPage() {
  el.pagePanel.hidden = false;
  el.pageMediaList.innerHTML = '';
  el.pageCaptionList.innerHTML = '';
  const res = await sendToSW('page:scan', {});
  if (!res || !res.ok) {
    el.pageMediaList.innerHTML = `<div class="list-item"><span>${
      (res && res.error) || '未找到可处理的媒体'
    }</span></div>`;
    return;
  }

  const medias = (res.medias || []).filter((m) => /^https?:|^blob:/.test(m.src));
  if (!medias.length) {
    el.pageMediaList.innerHTML =
      '<div class="list-item"><span>当前页面没有可抓取的 video/audio 元素。<br/>这类站点（如 B 站、腾讯视频）建议用「录制当前标签页」。</span></div>';
  }
  medias.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const name = (m.title || m.src).slice(0, 60);
    item.innerHTML = `<span class="name"><span class="tag">${m.tag}</span>${escapeHtml(name)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = '转录';
    btn.onclick = async () => {
      try {
        if (!/^https?:/.test(m.src)) {
          alert('该视频是 blob:/流媒体地址，无法直接下载。请改用「录制当前标签页」。');
          return;
        }
        setBusy(true);
        setProgress('正在下载视频…', m.src.slice(0, 80));
        const head = await fetch(m.src, { method: 'HEAD' }).catch(() => null);
        const len = head && head.headers.get('content-length');
        if (len && Number(len) > 800 * 1024 * 1024) {
          if (!confirm(`文件约 ${formatBytes(Number(len))}，较大，继续？`)) {
            setBusy(false);
            return;
          }
        }
        const r = await fetch(m.src);
        if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
        runBytes(await r.arrayBuffer(), name);
      } catch (e) {
        fail(String((e && e.message) || e));
      }
    };
    item.appendChild(btn);
    el.pageMediaList.appendChild(item);
  });

  const captions = res.captions || [];
  captions.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<span class="name"><span class="tag">字幕</span>${escapeHtml(
      t.name
    )} (${escapeHtml(t.lang)})</span>`;
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = '直接取字幕';
    btn.onclick = () => fetchPageCaptions(t);
    item.appendChild(btn);
    el.pageCaptionList.appendChild(item);
  });
}

async function fetchPageCaptions(track) {
  setBusy(true);
  setProgress('正在读取页面自带字幕…', '');
  try {
    const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const res = await fetch(url);
    if (!res.ok) throw new Error('字幕请求失败 HTTP ' + res.status);
    const data = await res.json();
    const segments = (data.events || [])
      .map((ev) => ({
        start: (ev.tStartMs || 0) / 1000,
        end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000,
        text: (ev.segs || [])
          .map((s) => s.utf8 || '')
          .join('')
          .replace(/\n/g, ' ')
          .trim(),
      }))
      .filter((s) => s.text);
    if (!segments.length) throw new Error('字幕为空');
    setResult({ segments, meta: { source: '页面自带字幕' } });
    okDone(el.resultMeta.textContent);
  } catch (e) {
    fail(String((e && e.message) || e));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 进度 / 事件 ---------------- */

function onProgress(p) {
  switch (p.stage) {
    case 'initiate':
      setProgress(p.message || '正在初始化模型…', `后端 ${p.device} / ${p.dtype}`);
      setIndeterminate();
      break;

    case 'fallback':
      setProgress('正在切换推理后端…', p.message || '');
      setIndeterminate();
      break;

    case 'download': {
      const total = p.total || 0;
      const ratio = total ? p.loaded / total : 0;
      setProgress(
        `下载模型 ${p.file || '权重'}`,
        total ? `${formatBytes(p.loaded)} / ${formatBytes(total)}` : formatBytes(p.loaded),
        ratio
      );
      break;
    }

    case 'ready':
      state.resolved = { device: p.device, dtype: p.dtype };
      el.runtimeBadge.textContent = `${p.device} / ${p.dtype}`;
      setProgress(`模型就绪（${p.device} / ${p.dtype}）`, p.cached ? '命中本地缓存' : '已缓存到本地，下次无需下载', 1);
      break;

    case 'decode':
      setProgress(p.message || '正在解码音频…', '');
      setIndeterminate();
      break;

    case 'prepare':
      state.audioDuration = p.duration || state.audioDuration;
      setProgress(p.message || '音频已就绪', '');
      setIndeterminate();
      break;

    case 'infer':
      startInferTimer();
      break;

    default:
      if (p.message) setProgress(p.message, '');
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!isForUI(msg)) return undefined;
  const { type, payload } = msg;
  if (type === 'progress') onProgress(payload);
  else if (type === 'error') fail(payload.message || '出错了');
  else if (type === 'cancelled') {
    stopInferTimer();
    setBusy(false);
    el.progressCard.hidden = true;
  } else if (type === 'recording') {
    if (!payload.active) stopRecTimer();
  } else if (type === 'done') {
    stopInferTimer();
  }
  return undefined;
});

/* ---------------- 绑定 ---------------- */

document.querySelectorAll('.src-btn').forEach((btn) => {
  btn.onclick = () => {
    if (state.busy) return;
    document.querySelectorAll('.src-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const src = btn.dataset.src;
    el.recPanel.hidden = src !== 'tab';
    el.pagePanel.hidden = src !== 'page';
    if (src === 'tab') startTabRecording();
    else if (src === 'file') el.fileInput.click();
    else if (src === 'page') scanPage();
  };
});

el.fileInput.onchange = () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  el.fileInput.value = '';
  if (!file) return;
  file.arrayBuffer().then((buf) => runBytes(buf, file.name)).catch((e) => fail(String(e.message || e)));
};

el.stopRecBtn.onclick = stopAndTranscribe;
el.cancelBtn.onclick = () => sendToOffscreen('job:cancel', {}).catch(() => {});

el.preloadBtn.onclick = async () => {
  setBusy(true);
  try {
    const res = await sendToOffscreen('asr:preload', { options: getSettings() });
    if (!res || !res.ok) fail((res && res.error) || '预加载失败');
    else {
      setBusy(false);
      el.progressCard.hidden = false;
      setProgress('模型已加载', '现在开始转录音频就不会再等下载了', 1);
    }
  } catch (e) {
    fail(String((e && e.message) || e));
  }
};

el.modelSelect.onchange = () => {
  updateModelHint();
  saveSettings();
};
el.langSelect.onchange = saveSettings;
el.deviceSelect.onchange = saveSettings;
el.mirrorSelect.onchange = saveSettings;
el.translateChk.onchange = saveSettings;
el.filterChk.onchange = saveSettings;

document.querySelectorAll('.seg').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.seg').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.view = b.dataset.view;
    renderResult();
  };
});

el.copyBtn.onclick = async () => {
  const text = el.resultBox.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent = '已复制';
  } catch {
    el.copyBtn.textContent = '复制失败';
  }
  setTimeout(() => (el.copyBtn.textContent = '复制'), 1500);
};
el.txtBtn.onclick = () => downloadFile(`${baseName()}.txt`, toPlainText(state.segments));
el.srtBtn.onclick = () => downloadFile(`${baseName()}.srt`, toSRT(state.segments));
el.vttBtn.onclick = () => downloadFile(`${baseName()}.vtt`, toVTT(state.segments));

/* ---------------- 启动 ---------------- */

(async function init() {
  const stored = await chrome.storage.local.get(['v2t_settings', 'v2t_last']);
  applySettings(stored.v2t_settings);
  if (stored.v2t_last && Array.isArray(stored.v2t_last.segments)) {
    state.segments = stored.v2t_last.segments;
    el.resultCard.hidden = false;
    renderResult();
    el.resultMeta.textContent = stored.v2t_last.meta || '上次的结果';
  }
})();
