/**
 * content.js —— 注入到每个页面的面板 UI（无构建版，普通脚本）。
 *
 * 交互对标 bili-mux：右下角一颗悬浮按钮，点开是页面内的卡片面板。
 * 面板本身不做任何重活 —— 录音、解码重采样、Whisper 推理全在 Offscreen Document 里，
 * 这里只负责「采集音频 → 交给 offscreen → 展示进度与结果」。
 *
 * 两个必须记住的约束：
 *   1. chrome.runtime.sendMessage 是 JSON 序列化，ArrayBuffer 到对面会变成 {}。
 *      所以音频统一在这里先解码成 16kHz 单声道 Float32Array，再分块 base64 传输。
 *      好处是传的是 PCM 而不是整个 mp4 容器，体积小一个数量级。
 *   2. 面板 DOM 全部用 createElement 拼，不用 innerHTML ——
 *      部分站点（如 Google 系）强制 Trusted Types，innerHTML 赋值会直接抛错。
 */
(function () {
  'use strict';

  // 重复注入保护：SW 在 content script 不存在时会补注入一次，
  // 页面已经注入过的话直接退出，免得出现两个面板。
  if (self.__V2T_PANEL_LOADED__) return;
  self.__V2T_PANEL_LOADED__ = true;

  var C = self.V2T.consts;
  var EX = self.V2T.ex;
  var AUD = self.V2T.audio;

  // 与 offscreen.js 的 MAX_CHUNK_FLOATS 必须一致（改一处就要改两处）
  var MAX_CHUNK_FLOATS = 4 * 1024 * 1024;

  /* ==================== 小工具 ==================== */

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'on') {
          Object.keys(v).forEach(function (ev) {
            el.addEventListener(ev, v[ev]);
          });
        } else if (k === 'data') {
          Object.keys(v).forEach(function (d) {
            el.dataset[d] = v[d];
          });
        } else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (kid) {
        if (kid == null || kid === false) return;
        el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
      });
    }
    return el;
  }

  function svgIcon(path) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }

  function newRequestId() {
    return 'v2t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function floatsToB64(view) {
    var bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return bytesToB64(bytes);
  }

  function callSW(type, payload) {
    return chrome.runtime.sendMessage({ target: 'sw', type: type, payload: payload || {} });
  }

  function callOffscreen(type, payload) {
    return chrome.runtime.sendMessage({ target: 'offscreen', type: type, payload: payload || {} });
  }

  function escapeText(s) {
    return String(s == null ? '' : s);
  }

  /* ==================== 状态 ==================== */

  var state = {
    busy: false,
    requestId: null,
    segments: [],
    view: 'plain',
    source: '',
    recTimerId: null,
    recStart: 0,
    inferTimerId: null,
    inferStart: 0,
    audioDuration: 0,
    mountedAt: Date.now(),
  };

  /* ==================== DOM 骨架 ==================== */

  var badge, body, mediaList, captionList, recPanel, recTimer, pagePanel;
  var progressCard, barFill, progressText, progressDetail;
  var resultCard, resultBox, resultMeta, fileInput, panel, fab, fabDot, srcHint;
  var modelSelect, langSelect, deviceSelect, mirrorSelect, translateChk, filterChk, modelHint;
  var srcButtons = [];

  function buildUI() {
    badge = h('span', { class: 'v2t-badge', text: '未加载' });
    recTimer = h('span', { class: 'v2t-rec-timer', text: '00:00' });
    srcHint = h('p', {
      class: 'v2t-hint',
      text: '首次使用会下载一次模型（之后缓存在本地，完全离线可跑）。',
    });

    mediaList = h('div', { class: 'v2t-list' });
    captionList = h('div', { class: 'v2t-list' });
    pagePanel = h('div', { class: 'v2t-sub-panel', hidden: true }, [mediaList, captionList]);

    recPanel = h('div', { class: 'v2t-sub-panel', hidden: true }, [
      h('div', { class: 'v2t-rec-row' }, [
        h('span', { class: 'v2t-rec-dot' }),
        recTimer,
        h('span', { class: 'v2t-rec-tip', text: '正在录制标签页声音，请保持视频播放' }),
      ]),
      h('button', {
        class: 'v2t-btn v2t-danger v2t-full',
        id: 'v2t-stop-rec',
        text: '停止并开始转录',
        on: { click: stopRecordingAndTranscribe },
      }),
    ]);

    modelSelect = h('select', { id: 'v2t-model' });
    langSelect = h('select', { id: 'v2t-lang' });
    deviceSelect = h('select', { id: 'v2t-device' });
    mirrorSelect = h('select', { id: 'v2t-mirror' });
    translateChk = h('input', { type: 'checkbox', id: 'v2t-translate' });
    filterChk = h('input', { type: 'checkbox', id: 'v2t-filter', checked: true });
    modelHint = h('p', { class: 'v2t-hint v2t-small' });

    barFill = h('div', { class: 'v2t-bar-fill' });
    progressText = h('p', { class: 'v2t-hint', text: '准备中…' });
    progressDetail = h('p', { class: 'v2t-hint v2t-small v2t-mono' });
    progressCard = h('section', { class: 'v2t-card', id: 'v2t-progress-card', hidden: true }, [
      h('h2', { text: '进度' }),
      h('div', { class: 'v2t-bar' }, [barFill]),
      progressText,
      progressDetail,
      h('button', {
        class: 'v2t-btn v2t-ghost v2t-full',
        text: '取消',
        on: { click: cancelJob },
      }),
    ]);

    resultBox = h('div', { class: 'v2t-result' });
    resultMeta = h('p', { class: 'v2t-hint v2t-small' });
    resultCard = h('section', { class: 'v2t-card', id: 'v2t-result-card', hidden: true }, [
      h('h2', {}, [
        h('span', { text: '结果' }),
        h('span', { class: 'v2t-seg-tabs' }, [
          h('button', {
            class: 'v2t-seg on',
            data: { view: 'plain' },
            text: '纯文本',
            on: { click: function () { switchView('plain'); } },
          }),
          h('button', {
            class: 'v2t-seg',
            data: { view: 'time' },
            text: '带时间轴',
            on: { click: function () { switchView('time'); } },
          }),
        ]),
      ]),
      resultBox,
      h('div', { class: 'v2t-btn-row' }, [
        h('button', {
          class: 'v2t-btn',
          id: 'v2t-copy',
          text: '复制',
          on: { click: copyResult },
        }),
        h('button', {
          class: 'v2t-btn',
          text: 'TXT',
          on: { click: function () { exportAs('txt'); } },
        }),
        h('button', {
          class: 'v2t-btn',
          text: 'SRT',
          on: { click: function () { exportAs('srt'); } },
        }),
        h('button', {
          class: 'v2t-btn',
          text: 'VTT',
          on: { click: function () { exportAs('vtt'); } },
        }),
      ]),
      resultMeta,
    ]);

    srcButtons = [
      mkSrcButton('tab', '●', '录制当前标签页', '边播边录，通用'),
      mkSrcButton('file', '▲', '本地音视频文件', '最稳定'),
      mkSrcButton('page', '▶', '页面内视频', '免录制 / 取字幕'),
    ];

    fileInput = h('input', {
      type: 'file',
      accept: 'audio/*,video/*',
      style: 'display:none',
      on: { change: onFilePicked },
    });

    body = h('div', { class: 'v2t-body' }, [
      h('section', { class: 'v2t-card' }, [
        h('h2', { text: '1 · 选择音频来源' }),
        h('div', { class: 'v2t-sources' }, srcButtons),
        srcHint,
        recPanel,
        pagePanel,
        fileInput,
      ]),
      h('section', { class: 'v2t-card' }, [
        h('h2', { text: '2 · 设置' }),
        h('label', { class: 'v2t-field' }, [h('span', { text: '模型' }), modelSelect]),
        modelHint,
        h('div', { class: 'v2t-row2' }, [
          h('label', { class: 'v2t-field' }, [h('span', { text: '语言' }), langSelect]),
          h('label', { class: 'v2t-field' }, [h('span', { text: '运行设备' }), deviceSelect]),
        ]),
        h('label', { class: 'v2t-field' }, [h('span', { text: '模型下载源' }), mirrorSelect]),
        h('label', { class: 'v2t-check' }, [
          translateChk,
          h('span', { text: '翻译成英文（task=translate）' }),
        ]),
        h('label', { class: 'v2t-check' }, [filterChk, h('span', { text: '过滤静音 / 幻觉片段' })]),
        h('button', {
          class: 'v2t-btn v2t-ghost v2t-full',
          text: '预加载模型',
          on: { click: preloadModel },
        }),
      ]),
      progressCard,
      resultCard,
    ]);

    panel = h('section', { class: 'v2t-panel', id: 'v2t-panel', hidden: true }, [
      h('header', { class: 'v2t-head' }, [
        h('div', { class: 'v2t-logo' }, [
          '视频转文字',
          h('span', { class: 'v2t-tag', text: 'V2T' }),
        ]),
        h('div', { class: 'v2t-head-right' }, [
          badge,
          h('button', {
            class: 'v2t-icon-btn',
            title: '收起面板',
            text: '×',
            on: { click: function () { setPanelOpen(false); } },
          }),
        ]),
      ]),
      body,
      h('footer', { class: 'v2t-foot', text: '音频与模型都在本机处理，不经过任何服务器' }),
    ]);

    fabDot = h('span', { class: 'v2t-fab-dot' });
    fab = h(
      'button',
      {
        class: 'v2t-fab',
        id: 'v2t-fab',
        title: '视频转文字（本地 Whisper）',
        on: { click: function () { setPanelOpen(panel.hidden); } },
      },
      // 圆形里的「文字线条」图标：三条长短不一的横线 + 一个方框
      [
        svgIcon('M4 6h16M4 11h10M4 16h13'),
        fabDot,
      ]
    );

    var root = h('div', { id: 'v2t-root' }, [panel, fab]);

    function mount() {
      if (document.body) document.body.appendChild(root);
      else document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(root);
      });
    }
    mount();

    bindSettings();
    return root;
  }

  function mkSrcButton(src, ico, label, sub) {
    return h(
      'button',
      {
        class: 'v2t-src',
        data: { src: src },
        on: { click: function () { pickSource(src); } },
      },
      [
        h('span', { class: 'v2t-ico', text: ico }),
        h('span', { class: 'v2t-lbl', text: label }),
        h('span', { class: 'v2t-sub', text: sub }),
      ]
    );
  }

  /* ==================== 面板开合 ==================== */

  function setPanelOpen(open) {
    panel.hidden = !open;
    fab.classList.toggle('on', open);
    if (open) {
      try {
        chrome.storage.local.set({ v2t_panel_open: true });
      } catch (e) {
        /* ignore */
      }
      refreshPageMedia();
    }
  }

  /* ==================== 设置 ==================== */

  function fillSelect(select, items, value) {
    select.textContent = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.id == null ? it.code : it.id;
      o.textContent = it.label;
      select.appendChild(o);
    });
    if (value !== undefined) select.value = value;
  }

  function getSettings() {
    return {
      modelId: modelSelect.value,
      language: langSelect.value,
      device: deviceSelect.value,
      mirror: mirrorSelect.value,
      translate: translateChk.checked,
      filterNoise: filterChk.checked,
    };
  }

  function applySettings(s) {
    var m = Object.assign({}, C.DEFAULT_SETTINGS, s || {});
    fillSelect(modelSelect, C.MODELS, m.modelId);
    fillSelect(langSelect, C.LANGUAGES, m.language);
    fillSelect(deviceSelect, C.DEVICES, m.device);
    fillSelect(mirrorSelect, C.MIRRORS, m.mirror);
    translateChk.checked = !!m.translate;
    filterChk.checked = m.filterNoise !== false;
    updateModelHint();
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ v2t_settings: getSettings() });
    } catch (e) {
      /* ignore */
    }
  }

  function updateModelHint() {
    var id = modelSelect.value;
    var m = null;
    for (var i = 0; i < C.MODELS.length; i++) if (C.MODELS[i].id === id) m = C.MODELS[i];
    if (!m) return;
    modelHint.textContent =
      m.note +
      '｜首次下载约 ' +
      C.formatBytes(C.estimateModelBytes(m.id, 'q8')) +
      '（CPU / q8）或 ' +
      C.formatBytes(C.estimateModelBytes(m.id, 'fp16')) +
      '（WebGPU / fp16）';
  }

  function bindSettings() {
    modelSelect.addEventListener('change', function () {
      updateModelHint();
      saveSettings();
    });
    [langSelect, deviceSelect, mirrorSelect].forEach(function (s) {
      s.addEventListener('change', saveSettings);
    });
    [translateChk, filterChk].forEach(function (c) {
      c.addEventListener('change', saveSettings);
    });
  }

  /* ==================== 进度 / 忙碌态 ==================== */

  function setBusy(busy) {
    state.busy = busy;
    srcButtons.forEach(function (b) {
      b.disabled = busy;
    });
    progressCard.hidden = !busy;
    if (busy) {
      resultCard.hidden = true;
      barFill.style.width = '0%';
      barFill.classList.remove('v2t-indet', 'v2t-bad');
      progressText.textContent = '准备中…';
      progressDetail.textContent = '';
    }
  }

  function setProgress(text, detail, ratio) {
    progressText.textContent = text;
    progressDetail.textContent = detail || '';
    barFill.classList.remove('v2t-indet', 'v2t-bad');
    if (typeof ratio === 'number' && isFinite(ratio)) {
      barFill.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
    }
  }

  function setIndeterminate() {
    barFill.classList.add('v2t-indet');
  }

  function fail(message) {
    stopTimers();
    setBusy(false);
    progressCard.hidden = false;
    progressText.textContent = '失败';
    progressDetail.textContent = escapeText(message);
    barFill.classList.remove('v2t-indet');
    barFill.classList.add('v2t-bad');
    barFill.style.width = '100%';
  }

  function stopTimers() {
    if (state.recTimerId) clearInterval(state.recTimerId);
    if (state.inferTimerId) clearInterval(state.inferTimerId);
    state.recTimerId = null;
    state.inferTimerId = null;
  }

  function startInferTimer() {
    if (state.inferTimerId) clearInterval(state.inferTimerId);
    state.inferStart = Date.now();
    state.inferTimerId = setInterval(function () {
      var sec = (Date.now() - state.inferStart) / 1000;
      var total = state.audioDuration ? ' / 音频 ' + AUD.formatTime(state.audioDuration) : '';
      setProgress(
        '正在转录… 已用 ' + AUD.formatTime(sec) + total,
        'WebGPU 下通常 1~3 倍速，CPU 下会慢很多，请耐心等待'
      );
      setIndeterminate();
    }, 500);
  }

  function startRecTimer() {
    if (state.recTimerId) clearInterval(state.recTimerId);
    state.recStart = Date.now();
    state.recTimerId = setInterval(function () {
      recTimer.textContent = AUD.formatTime((Date.now() - state.recStart) / 1000);
    }, 500);
  }

  /* ==================== 结果 ==================== */

  function switchView(view) {
    state.view = view;
    var tabs = resultCard.querySelectorAll('.v2t-seg');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].dataset.view === view);
    }
    renderResult();
  }

  function renderResult() {
    resultBox.textContent =
      state.view === 'time' ? EX.toTimestampedText(state.segments) : EX.toPlainText(state.segments);
  }

  function setResult(result, extraMeta) {
    state.segments = (result && result.segments) || [];
    resultBox.textContent = '';
    renderResult();
    var meta = (result && result.meta) || {};
    var parts = [];
    if (meta.source) parts.push(meta.source);
    if (meta.modelId) parts.push(String(meta.modelId).replace('Xenova/', ''));
    if (meta.device) parts.push(meta.device + '/' + (meta.dtype || ''));
    if (meta.duration) parts.push('音频 ' + AUD.formatTime(meta.duration));
    if (meta.elapsedMs) parts.push('耗时 ' + (meta.elapsedMs / 1000).toFixed(1) + 's');
    if (extraMeta) parts.push(extraMeta);
    resultMeta.textContent = parts.filter(Boolean).join(' · ');
    resultCard.hidden = false;
    progressCard.hidden = true;
    setBusy(false);
    stopTimers();
    try {
      chrome.storage.local.set({
        v2t_last: { segments: state.segments, meta: resultMeta.textContent, at: Date.now() },
      });
    } catch (e) {
      /* ignore */
    }
  }

  function copyResult() {
    var text = resultBox.textContent || '';
    var btn = resultCard.querySelector('#v2t-copy');
    var done = function () {
      if (!btn) return;
      btn.textContent = '已复制';
      setTimeout(function () {
        btn.textContent = '复制';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text, done);
      });
    } else {
      fallbackCopy(text, done);
    }
  }

  // 部分页面没有 clipboard 权限（非 https / iframe），退回 execCommand
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      /* ignore */
    }
    ta.remove();
  }

  function exportAs(kind) {
    var base = EX.baseName();
    if (kind === 'txt') {
      EX.downloadFile(base + '.txt', EX.toPlainText(state.segments));
    } else if (kind === 'srt') {
      EX.downloadFile(base + '.srt', EX.toSRT(state.segments), 'application/x-subrip;charset=utf-8');
    } else {
      EX.downloadFile(base + '.vtt', EX.toVTT(state.segments), 'text/vtt;charset=utf-8');
    }
  }

  /* ==================== 三条音频链路 ==================== */

  function pickSource(src) {
    if (state.busy) return;
    state.source = src;
    srcButtons.forEach(function (b) {
      b.classList.toggle('on', b.dataset.src === src);
    });
    recPanel.hidden = src !== 'tab';
    pagePanel.hidden = src !== 'page';

    if (src === 'tab') startTabRecording();
    else if (src === 'file') fileInput.click();
    else if (src === 'page') refreshPageMedia();
  }

  /* ---- 1) 录制当前标签页 ---- */

  async function startTabRecording() {
    setBusy(true);
    setProgress('正在获取标签页音频权限…', '');
    try {
      var res = await callSW('tab:getStreamId', {});
      if (!res || !res.ok) throw new Error((res && res.error) || '无法获取标签页音频');

      var rid = newRequestId();
      state.requestId = rid;

      recPanel.hidden = false;
      recTimer.textContent = '00:00';
      startRecTimer();
      setProgress('录制中…', '请让视频保持播放；完成后点「停止并开始转录」');
      setIndeterminate();
      srcHint.textContent = '录制中：标签页音频（最长 15 分钟自动停止）';

      var r = await callOffscreen('rec:start', {
        requestId: rid,
        streamId: res.streamId,
        options: getSettings(),
        maxSeconds: C.DEFAULT_SETTINGS.maxRecordSeconds,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '录制启动失败');
    } catch (e) {
      recPanel.hidden = true;
      stopTimers();
      fail(String((e && e.message) || e));
    }
  }

  async function stopRecordingAndTranscribe() {
    recPanel.hidden = true;
    if (state.recTimerId) clearInterval(state.recTimerId);
    state.recTimerId = null;
    setBusy(true);
    setProgress('正在解码录音…', '');
    setIndeterminate();
    try {
      var res = await callOffscreen('rec:stop', { requestId: state.requestId });
      if (!res || !res.ok) throw new Error((res && res.error) || '停止录制失败');
      // 之后走 'ui' 广播：progress → result / error
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  }

  /* ---- 2) 本地文件 ---- */

  function onFilePicked() {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    submitFileObject(file);
  }

  async function submitFileObject(file) {
    setBusy(true);
    setProgress('正在读取文件…', file.name + '（' + C.formatBytes(file.size) + '）');
    setIndeterminate();
    try {
      var buf = await file.arrayBuffer();
      await submitAudioBuffer(buf, file.name);
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  }

  /* ---- 3) 页面内视频 ---- */

  function scanMedia() {
    var nodes = document.querySelectorAll('video, audio');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var src = el.currentSrc || el.src || '';
      if (!src) continue;
      out.push({
        tag: (el.tagName || '').toLowerCase(),
        src: src,
        duration: el.duration && isFinite(el.duration) ? el.duration : 0,
        title: el.getAttribute('title') || document.title,
      });
    }
    return out;
  }

  function mediaBadge() {
    var n = scanMedia().length;
    fabDot.classList.toggle('show', n > 0);
  }

  async function refreshPageMedia() {
    mediaList.textContent = '';
    captionList.textContent = '';

    var medias = scanMedia().filter(function (m) {
      return /^https?:|^blob:/.test(m.src);
    });
    if (!medias.length) {
      mediaList.appendChild(
        h('div', {
          class: 'v2t-empty',
          text: '当前页面没有可直接抓取的 video/audio。这类站点（B站、腾讯视频等）请用「录制当前标签页」。',
        })
      );
    }
    medias.forEach(function (m) {
      var name = (m.title || m.src).slice(0, 58);
      mediaList.appendChild(
        h('div', { class: 'v2t-item' }, [
          h('span', { class: 'v2t-name' }, [
            h('span', { class: 'v2t-kind', text: m.tag }),
            name,
          ]),
          h('button', {
            class: 'v2t-mini',
            text: '转录',
            on: { click: function () { transcribeMedia(m); } },
          }),
        ])
      );
    });

    // 页面自带字幕（YouTube 等）：能取就别跑模型，快 100 倍且 100% 准确
    try {
      var res = await callSW('page:captions', {});
      var tracks = (res && res.tracks) || [];
      tracks.forEach(function (t) {
        captionList.appendChild(
          h('div', { class: 'v2t-item' }, [
            h('span', { class: 'v2t-name' }, [
              h('span', { class: 'v2t-kind', text: '字幕' }),
              (t.name || t.lang) + ' (' + t.lang + ')',
            ]),
            h('button', {
              class: 'v2t-mini',
              text: '直接取字幕',
              on: { click: function () { fetchCaptions(t); } },
            }),
          ])
        );
      });
    } catch (e) {
      /* 不支持获取字幕的站点，静默跳过 */
    }
  }

  async function transcribeMedia(m) {
    if (state.busy) return;
    setBusy(true);
    setProgress('正在下载媒体…', m.src.slice(0, 90));
    setIndeterminate();
    try {
      if (!/^https?:/.test(m.src)) {
        throw new Error('该媒体是 blob:/流媒体地址，浏览器无法直接取到原始文件，请改用「录制当前标签页」。');
      }
      var head = await fetch(m.src, { method: 'HEAD', credentials: 'include' }).catch(function () {
        return null;
      });
      var len = head && head.headers.get('content-length');
      if (len && Number(len) > 600 * 1024 * 1024) {
        var okBig = confirm(
          '该视频约 ' + C.formatBytes(Number(len)) + '，下载与解码都比较慢。继续吗？'
        );
        if (!okBig) {
          setBusy(false);
          return;
        }
      }
      var r = await fetch(m.src, { credentials: 'include' });
      if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
      var buf = await r.arrayBuffer();
      await submitAudioBuffer(buf, (m.title || 'page-media').slice(0, 60));
    } catch (e) {
      fail(
        String((e && e.message) || e) +
          '（若站点限制了下载，请改用「录制当前标签页」）'
      );
    }
  }

  async function fetchCaptions(track) {
    if (state.busy) return;
    setBusy(true);
    setProgress('正在读取页面自带字幕…', '');
    setIndeterminate();
    try {
      var url = track.baseUrl + (track.baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3';
      var res = await callSW('captions:fetch', { url: url });
      if (!res || !res.ok) throw new Error((res && res.error) || '字幕请求失败');
      var data = JSON.parse(res.text);
      var segments = (data.events || [])
        .map(function (ev) {
          return {
            start: (ev.tStartMs || 0) / 1000,
            end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000,
            text: (ev.segs || [])
              .map(function (s) {
                return s.utf8 || '';
              })
              .join('')
              .replace(/\n/g, ' ')
              .trim(),
          };
        })
        .filter(function (s) {
          return s.text;
        });
      if (!segments.length) throw new Error('字幕内容为空');
      setResult({ segments: segments, meta: { source: '页面自带字幕' } });
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  }

  /* ---- 共用：解码 → 分块上传 → 触发推理 ---- */

  async function submitAudioBuffer(buf, label) {
    setProgress('正在解码音频…', label + '（' + C.formatBytes(buf.byteLength) + '）');
    setIndeterminate();

    var mono;
    try {
      mono = await AUD.decodeToMono16k(buf);
    } catch (e) {
      throw new Error('音频解码失败：' + String((e && e.message) || e) + '（该格式浏览器可能不支持）');
    }
    buf = null; // 主动放掉原始容器字节，长视频很占内存

    if (!mono.length) throw new Error('解码后没有音频数据');

    var rid = newRequestId();
    state.requestId = rid;
    state.audioDuration = AUD.audioDuration(mono);
    var total = mono.length;

    var init = await callOffscreen('job:file-init', {
      requestId: rid,
      options: getSettings(),
      total: total,
      name: label,
    });
    if (!init || !init.ok) throw new Error((init && init.error) || '初始化失败');

    for (var off = 0, index = 0; off < total; off += MAX_CHUNK_FLOATS, index++) {
      var slice = mono.subarray(off, Math.min(total, off + MAX_CHUNK_FLOATS));
      var chunk = await callOffscreen('job:file-chunk', {
        requestId: rid,
        index: index,
        b64: floatsToB64(slice),
      });
      if (!chunk || !chunk.ok) throw new Error((chunk && chunk.error) || '音频传输失败');
      var ratio = (off + slice.length) / total;
      setProgress(
        '正在传输音频到推理进程…',
        Math.round(ratio * 100) + '%｜' + C.formatBytes(total * 4),
        ratio
      );
    }

    var go = await callOffscreen('job:file-go', { requestId: rid });
    if (!go || !go.ok) throw new Error((go && go.error) || '启动转录失败');
    setProgress('正在转录…', '音频时长 ' + AUD.formatTime(state.audioDuration));
    setIndeterminate();
  }

  function cancelJob() {
    callOffscreen('job:cancel', { requestId: state.requestId }).catch(function () {});
    stopTimers();
    setBusy(false);
    progressCard.hidden = true;
  }

  async function preloadModel() {
    setBusy(true);
    setProgress('正在加载模型…', '');
    setIndeterminate();
    try {
      var res = await callOffscreen('asr:preload', {
        requestId: state.requestId || newRequestId(),
        options: getSettings(),
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '预加载失败');
      setBusy(false);
      progressCard.hidden = false;
      setProgress('模型已加载', '现在开始转录就不会再等下载了', 1);
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  }

  /* ==================== 进度事件（来自 offscreen 广播） ==================== */

  function onProgress(p) {
    switch (p.stage) {
      case 'initiate':
        setProgress(p.message || '正在初始化模型…', '后端 ' + p.device + ' / ' + p.dtype);
        setIndeterminate();
        break;

      case 'fallback':
        setProgress('正在切换推理后端…', p.message || '');
        setIndeterminate();
        break;

      case 'download': {
        var total = p.total || 0;
        setProgress(
          '下载模型 ' + (p.file || '权重'),
          total ? C.formatBytes(p.loaded) + ' / ' + C.formatBytes(total) : C.formatBytes(p.loaded),
          total ? p.loaded / total : 0
        );
        break;
      }

      case 'ready':
        badge.textContent = p.device + ' / ' + p.dtype;
        setProgress(
          '模型就绪（' + p.device + ' / ' + p.dtype + '）',
          p.cached ? '命中本地缓存' : '已缓存到本地，下次无需下载',
          1
        );
        break;

      case 'decode':
        setProgress(p.message || '正在解码音频…', '');
        setIndeterminate();
        break;

      case 'prepare':
        if (p.duration) state.audioDuration = p.duration;
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

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return undefined;

    // SW 补注入后要求打开面板
    if (msg.target === 'cs') {
      if (msg.type === 'panel:toggle') setPanelOpen(panel.hidden);
      else if (msg.type === 'panel:open') setPanelOpen(true);
      return undefined;
    }

    if (msg.target !== 'ui') return undefined;
    var payload = msg.payload || {};
    // 面板自己发起的任务才会带 requestId；不属于本面板的广播直接忽略
    if (payload.requestId && state.requestId && payload.requestId !== state.requestId) {
      return undefined;
    }

    switch (msg.type) {
      case 'progress':
        onProgress(payload.progress || {});
        break;
      case 'result':
        setResult(payload.result || {});
        break;
      case 'error':
        fail(payload.message || '出错了');
        break;
      case 'cancelled':
        stopTimers();
        setBusy(false);
        progressCard.hidden = true;
        break;
      case 'recording':
        if (!payload.active) {
          if (state.recTimerId) clearInterval(state.recTimerId);
          state.recTimerId = null;
        }
        break;
      default:
        break;
    }
    return undefined;
  });

  /* ==================== 启动 ==================== */

  (async function init() {
    buildUI();

    try {
      var stored = await chrome.storage.local.get(['v2t_settings', 'v2t_last', 'v2t_panel_open']);
      applySettings(stored.v2t_settings);
      if (stored.v2t_last && Array.isArray(stored.v2t_last.segments) && stored.v2t_last.segments.length) {
        state.segments = stored.v2t_last.segments;
        renderResult();
        resultMeta.textContent = stored.v2t_last.meta || '上次的结果';
        resultCard.hidden = false;
      }
      if (stored.v2t_panel_open) setPanelOpen(true);
    } catch (e) {
      applySettings(null);
    }

    mediaBadge();
    // 有些页面是懒加载视频，隔一会儿再看一眼（仅用于点亮小圆点，开销可忽略）
    setTimeout(mediaBadge, 2500);
    setTimeout(mediaBadge, 7000);
  })();
})();
