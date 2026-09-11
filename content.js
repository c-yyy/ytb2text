/**
 * content.js —— 注入到 YouTube 页面的面板 UI（无构建版，普通脚本）。
 *
 * 交互对标 bili-mux：右下角一颗悬浮按钮，点开是页面内的卡片面板。
 * 面板本身不做重活 —— 解码重采样、Whisper 推理全在 Offscreen Document 里，
 * 这里只负责「拿到音频 → 交给 offscreen → 展示进度与结果」。
 *
 * 两个必须记住的约束：
 *   1. chrome.runtime.sendMessage 是 JSON 序列化，ArrayBuffer 到对面会变成 {}。
 *      所以音频统一在这里先解码成 16kHz 单声道 Float32Array，再分块 base64 传输。
 *      好处是传的是 PCM 而不是整个 mp4 容器，体积小一个数量级。
 *   2. 面板 DOM 全部用 createElement 拼，不用 innerHTML ——
 *      部分站点（如 Google 系）强制 Trusted Types，innerHTML 赋值会直接抛错。
 *
 * 音频从哪来（重点，别再让用户去录）：
 *   播放器一定会去 CDN 拉媒体分片，这些请求的 URL 会留在 performance 资源时间线里。
 *   直接挑一条「带音轨」的 URL 整条下载 → 解码 → 转录，不需要任何录制、不需要权限。
 *   只有在下载这条路彻底走不通时，才自动退到「从播放器 captureStream 边播边录」，
 *   这一步也是自动的，不需要用户做任何事。
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

  // 只在这些站点去探测页面自带字幕轨（其余站点探测是纯浪费）
  var MAY_HAVE_CAPTIONS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

  // 纯音频轨（itag 从高音质到低音质）；YouTube 不一定给得出，给不出就用复合流
  var AUDIO_ONLY_ITAGS = [251, 140, 250, 249, 139, 171, 234, 233, 172, 141];
  // 音视频合在一起的复合流（有音轨，文件会大一些，但一定能解出声音）
  var MUXED_ITAGS = [18, 22, 43, 36, 34, 35, 59, 78];

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

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
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

  function shortErr(e) {
    var s = String((e && e.message) || e || '未知原因');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  /* ==================== 状态 ==================== */

  var state = {
    busy: false,
    requestId: null,
    segments: [],
    view: 'plain',
    recTimerId: null,
    recStart: 0,
    inferTimerId: null,
    inferStart: 0,
    audioDuration: 0,
    // 兜底「边播边录」时用的本地录制句柄
    localRec: null,
  };

  /* ==================== DOM 骨架 ==================== */

  var badge, body, mediaInfo, captionRow, recPanel, recTimer, recTip;
  var progressCard, barFill, progressText, progressDetail;
  var resultCard, resultBox, resultMeta, panel, fab, fabDot, srcHint, goBtn;
  var modelSelect, langSelect, deviceSelect, mirrorSelect, filterChk, modelHint;

  function buildUI() {
    badge = h('span', { class: 'v2t-badge', text: '未加载' });
    recTimer = h('span', { class: 'v2t-rec-timer', text: '00:00' });
    srcHint = h('p', {
      class: 'v2t-hint',
      text: '首次使用会下载一次模型（之后缓存在本地，完全离线可跑）。',
    });

    mediaInfo = h('div', { class: 'v2t-empty', text: '正在检测当前视频的音频轨…' });
    captionRow = h('div', { class: 'v2t-btn-row', hidden: true });

    recTip = h('span', { class: 'v2t-rec-tip', text: '正在录制' });
    recPanel = h('div', { class: 'v2t-sub-panel', hidden: true }, [
      h('div', { class: 'v2t-rec-row' }, [h('span', { class: 'v2t-rec-dot' }), recTimer, recTip]),
      h('button', {
        class: 'v2t-btn v2t-danger v2t-full',
        id: 'v2t-stop-rec',
        text: '停止并开始转录',
        on: { click: stopLocalRecording },
      }),
    ]);

    modelSelect = h('select', { id: 'v2t-model' });
    langSelect = h('select', { id: 'v2t-lang' });
    deviceSelect = h('select', { id: 'v2t-device' });
    mirrorSelect = h('select', { id: 'v2t-mirror' });
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
        h('button', { class: 'v2t-btn', text: 'TXT', on: { click: function () { exportAs('txt'); } } }),
        h('button', { class: 'v2t-btn', text: 'SRT', on: { click: function () { exportAs('srt'); } } }),
        h('button', { class: 'v2t-btn', text: 'VTT', on: { click: function () { exportAs('vtt'); } } }),
      ]),
      resultMeta,
    ]);

    goBtn = h('button', {
      class: 'v2t-btn v2t-primary v2t-full',
      id: 'v2t-go',
      text: '开始转写',
      on: { click: startTranscribe },
    });

    body = h('div', { class: 'v2t-body' }, [
      h('section', { class: 'v2t-card' }, [
        h('h2', { text: '1 · 转写当前视频' }),
        mediaInfo,
        goBtn,
        captionRow,
        recPanel,
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
        h('label', { class: 'v2t-check' }, [filterChk, h('span', { text: '过滤静音 / 幻觉片段' })]),
        h('button', {
          class: 'v2t-btn v2t-ghost v2t-full',
          text: '预加载模型',
          on: { click: preloadModel },
        }),
        srcHint,
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
      // 圆形里的「文字线条」图标：三条长短不一的横线
      [svgIcon('M4 6h16M4 11h10M4 16h13'), fabDot]
    );

    var root = h('div', { id: 'v2t-root' }, [panel, fab]);

    function mount() {
      if (document.body) document.body.appendChild(root);
      else
        document.addEventListener('DOMContentLoaded', function () {
          document.body.appendChild(root);
        });
    }
    mount();

    bindSettings();
    return root;
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
      refreshMediaInfo();
    } else {
      try {
        chrome.storage.local.set({ v2t_panel_open: false });
      } catch (e) {
        /* ignore */
      }
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
      translate: false,
      filterNoise: filterChk.checked,
    };
  }

  function applySettings(s) {
    var m = Object.assign({}, C.DEFAULT_SETTINGS, s || {});
    fillSelect(modelSelect, C.MODELS, m.modelId);
    fillSelect(langSelect, C.LANGUAGES, m.language);
    fillSelect(deviceSelect, C.DEVICES, m.device);
    fillSelect(mirrorSelect, C.MIRRORS, m.mirror);
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
    filterChk.addEventListener('change', saveSettings);
  }

  /* ==================== 进度 / 忙碌态 ==================== */

  function setBusy(busy) {
    state.busy = busy;
    goBtn.disabled = busy;
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

  /* ==================== 音频从哪来 ==================== */
  //
  // 不需要用户录制：播放器为了播下去，一定会去 CDN 拉媒体分片，
  // 而这些请求的 URL 会留在 performance 的资源时间线里（跨域也会留下 name）。
  // 挑一条带音轨的整条下载即可 —— 这也是 bili-mux 那类工具的思路（拿流，不录屏）。

  // 这些路径跟媒体无关（统计 / 心跳 / 广告回传），混进来会让「抓到了几条」失真
  var NOT_MEDIA_PATH = /(generate_204|ptracking|\/api\/|\/stats|initplayback|log_event)/i;

  function mediaUrlsFromTimeline() {
    var out = [];
    try {
      var list = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < list.length; i++) {
        var n = list[i].name || '';
        if (n.indexOf('googlevideo.com/') >= 0 && !NOT_MEDIA_PATH.test(n)) out.push(n);
      }
    } catch (e) {
      /* 极端情况下 performance 不可用 */
    }
    return out;
  }

  function parseMediaUrl(u) {
    var q = {};
    try {
      var s = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
      s.split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (!p[0]) return;
        try {
          q[p[0]] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
        } catch (e) {
          q[p[0]] = p[1] || '';
        }
      });
    } catch (e) {
      /* ignore */
    }
    return { url: u, itag: Number(q.itag || 0) || 0, mime: q.mime || '' };
  }

  // 只有「明确带音轨」的流才要：纯音频轨 > 音视频复合流 > 没标 itag 的（最后试）
  function audioRank(m) {
    if (/^audio\//i.test(m.mime)) {
      var i = AUDIO_ONLY_ITAGS.indexOf(m.itag);
      return i >= 0 ? i : 20;
    }
    var j = MUXED_ITAGS.indexOf(m.itag);
    if (j >= 0) return 100 + j;
    // 有些播放请求不带 itag / mime（站点改版时会这样），只能当「未知媒体流」排在最后，
    // 真正下载前会先用 Range 探一下 Content-Type，不是音视频就不浪费流量
    return 200;
  }

  function itagLabel(m) {
    if (/^audio\//i.test(m.mime)) return '纯音频轨';
    if (MUXED_ITAGS.indexOf(m.itag) >= 0) return '音视频复合流';
    return '未标明 itag 的媒体流';
  }

  /** 当前页面可用的、带音轨的媒体地址（按「最想要」排序） */
  function audioCandidates() {
    var urls = mediaUrlsFromTimeline();
    var byKey = {};
    var out = [];
    urls.forEach(function (u) {
      var m = parseMediaUrl(u);
      var rank = audioRank(m);
      if (rank < 0) return;
      // 同一条流会被按 Range 请求多次，rn / rbuf 是每次随机的，去掉它们做去重
      var key = m.itag + '|' + u.replace(/&rn=[^&]*/g, '').replace(/&rbuf=[^&]*/g, '');
      if (byKey[key]) return;
      byKey[key] = true;
      m.rank = rank;
      out.push(m);
    });
    out.sort(function (a, b) {
      return a.rank - b.rank;
    });
    return out;
  }

  /** 面板里那行「检测到什么」 */
  function refreshMediaInfo() {
    var cands = audioCandidates();
    fabDot.classList.toggle('show', !!pageVideo());
    mediaInfo.textContent = '';
    if (!cands.length) {
      mediaInfo.className = 'v2t-empty';
      mediaInfo.textContent = '还没抓到音频轨。请让视频播放几秒（或刷新页面）后再点「开始转写」。';
      return;
    }
    var best = cands[0];
    mediaInfo.className = 'v2t-item';
    mediaInfo.appendChild(
      h('span', { class: 'v2t-name' }, [
        h('span', { class: 'v2t-kind', text: itagLabel(best) }),
        best.itag
          ? 'itag ' + best.itag + ' · ' + (best.mime || '未知容器') + ' · 共 ' + cands.length + ' 条可用'
          : '共 ' + cands.length + ' 条可用（下载前会先探测类型）',
      ])
    );
  }

  /** 页面里的主播放器：优先挑「真的有内容在播」的那一个 */
  function pageVideo() {
    var list = document.querySelectorAll('video, audio');
    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el.isConnected) continue;
      if (!fallback) fallback = el;
      var d = el.duration;
      if (d && isFinite(d) && d > 0) return el;
    }
    return fallback;
  }

  /**
   * 流式下载并汇报进度。
   * @returns {Promise<ArrayBuffer>}
   */
  async function downloadWithProgress(url, onProgress) {
    var r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var len = Number(r.headers.get('content-length') || 0);
    if (!r.body || typeof r.body.getReader !== 'function') return r.arrayBuffer();

    var reader = r.body.getReader();
    var chunks = [];
    var got = 0;
    var last = 0;
    for (;;) {
      var d = await reader.read();
      if (d.done) break;
      chunks.push(d.value);
      got += d.value.length;
      var now = Date.now();
      if (now - last > 120) {
        last = now;
        onProgress(got, len);
      }
    }
    onProgress(got, len || got);

    var out = new Uint8Array(got);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out.buffer;
  }

  /** 用一小段 Range 请求探一下内容类型，避免为了一条纯视频流浪费几十 MB 流量 */
  async function probeContentType(url) {
    try {
      var r = await fetch(url, { headers: { Range: 'bytes=0-2047' }, credentials: 'omit' });
      return r.headers.get('content-type') || '';
    } catch (e) {
      return '';
    }
  }

  /** 页面内 fetch 不通时，让 SW 代劳（扩展有 host 权限，不受 CORS 限制） */
  async function swDownload(url) {
    var res = await callSW('media:fetch', { url: url });
    if (!res || !res.ok) throw new Error((res && res.error) || 'SW 下载失败');
    return b64ToBytes(res.b64).buffer;
  }

  /* ---- 主流程：一键转写 ---- */

  async function startTranscribe() {
    if (state.busy) return;

    var cands = audioCandidates();
    if (!cands.length) {
      // 播放器还没开始拉流：先帮它播起来，等两秒再看
      var v = pageVideo();
      if (v) {
        try {
          if (v.paused) await v.play();
        } catch (e) {
          /* 用户手势外可能被拦，下面会给出提示 */
        }
      }
      setBusy(true);
      setProgress('正在等待播放器加载音频…', '');
      setIndeterminate();
      for (var w = 0; w < 12 && !audioCandidates().length; w++) {
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
      setBusy(false);
      cands = audioCandidates();
      if (!cands.length) {
        // 真拿不到地址（站点换了 CDN、播放器没在拉流……）—— 自动退到边播边录，
        // 不用用户做任何事；连播放器都没有才报错
        var vf = pageVideo();
        if (vf) {
          startElementCapture({ el: vf, title: document.title }, '没抓到直连地址，已自动改为边播边录：');
          return;
        }
        fail('没能拿到这个视频的音频地址。请确认视频正在播放，然后刷新页面重试。');
        return;
      }
    }

    setBusy(true);
    recPanel.hidden = true;

    var tries = Math.min(3, cands.length);
    var lastErr = null;
    for (var i = 0; i < tries; i++) {
      var m = cands[i];
      var label = m.itag ? 'itag ' + m.itag + '（' + itagLabel(m) + '）' : itagLabel(m);
      // 没标 itag 的「未知流」：先探一下 Content-Type，不是音视频就不下载
      if (m.rank >= 200) {
        var ct = await probeContentType(m.url);
        if (!/^(audio|video)\//i.test(ct)) {
          lastErr = new Error('这条不是音视频流（' + (ct || '探测不到类型') + '）');
          continue;
        }
        label += ' · ' + ct;
      }
      setProgress('正在下载音频…', label);
      setIndeterminate();
      try {
        var buf = await downloadWithProgress(m.url, function (got, len) {
          setProgress(
            '正在下载音频…',
            label + '｜' + C.formatBytes(got) + (len ? ' / ' + C.formatBytes(len) : ''),
            len ? got / len : 0
          );
        });
        if (!buf.byteLength) throw new Error('下载到 0 字节');
        await submitAudioBuffer(buf, label);
        return;
      } catch (e) {
        lastErr = e;
        // 页面内下载被拦（CORS / 403）时换 SW 试一次，再不行就换下一条
        try {
          setProgress('正在换一条链路下载…', label);
          setIndeterminate();
          var buf2 = await swDownload(m.url);
          if (!buf2.byteLength) throw new Error('SW 下载到 0 字节');
          await submitAudioBuffer(buf2, label + '（SW）');
          return;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }

    // 下载这条路彻底不通：自动退到「从播放器边播边录」（不用用户做任何事）
    var v2 = pageVideo();
    if (v2) {
      startElementCapture(
        { el: v2, title: document.title },
        '直连下载失败（' + shortErr(lastErr) + '），已自动改为边播边录：'
      );
      return;
    }
    fail('拿不到音频：' + shortErr(lastErr));
  }

  /* ---- 字幕直取（有字幕就别跑模型，快 100 倍且 100% 准） ---- */

  async function refreshCaptions() {
    captionRow.textContent = '';
    captionRow.hidden = true;
    if (!MAY_HAVE_CAPTIONS.test(location.hostname)) return;
    try {
      var res = await callSW('page:captions', {});
      var tracks = (res && res.tracks) || [];
      if (!tracks.length) return;
      // 优先中文/英文，其次其它
      tracks.sort(function (a, b) {
        function s(t) { return /^zh/i.test(t.lang) ? 0 : /^en/i.test(t.lang) ? 1 : 2; }
        return s(a) - s(b);
      });
      tracks.slice(0, 3).forEach(function (t) {
        captionRow.appendChild(
          h('button', {
            class: 'v2t-btn',
            text: '直接取字幕（' + (t.name || t.lang).slice(0, 8) + '）',
            on: { click: function () { fetchCaptions(t); } },
          })
        );
      });
      captionRow.hidden = false;
    } catch (e) {
      /* 不支持获取字幕的站点，静默跳过 */
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

  /* ---- 兜底：从播放器 captureStream 边播边录（全自动，不需要用户操作） ---- */

  function pickRecMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < cands.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function stopLocalRecording() {
    if (state.localRec) state.localRec.stop();
  }

  function startElementCapture(m, note) {
    var el = m && m.el;
    if (!el || !el.isConnected) {
      fail('这个播放器已经不在页面上了，请刷新页面重试。');
      return;
    }
    if (typeof el.captureStream !== 'function') {
      fail('当前浏览器不支持从播放器捕获音频，且直连下载也失败了（' + (note || '') + '）。');
      return;
    }

    setBusy(true);
    setProgress('正在从播放器捕获音频…', note || '');
    setIndeterminate();

    try {
      if (el.paused) {
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {
      /* 下面音轨为空时会给出更明确的提示 */
    }

    var audioTracks;
    try {
      audioTracks = el.captureStream().getAudioTracks();
    } catch (e) {
      fail('无法从播放器捕获音频：' + shortErr(e));
      return;
    }
    if (!audioTracks.length) {
      fail('这个播放器没有可捕获的音轨（可能还没开始播放，或内容受保护）。');
      return;
    }

    var mime = pickRecMime();
    var rec;
    try {
      rec = new MediaRecorder(new MediaStream(audioTracks), mime ? { mimeType: mime } : undefined);
    } catch (e) {
      fail('无法启动录制：' + shortErr(e));
      return;
    }

    var chunks = [];
    var finished = false;
    var maxMs = (C.DEFAULT_SETTINGS.maxRecordSeconds || 900) * 1000;

    function cleanup() {
      clearTimeout(hardTimer);
      try {
        el.removeEventListener('ended', onEnded);
      } catch (e) {
        /* ignore */
      }
      recPanel.hidden = true;
      state.localRec = null;
      stopTimers();
    }

    function onEnded() {
      if (!finished) stopLocalRecording();
    }

    var hardTimer = setTimeout(function () {
      if (!finished) stopLocalRecording();
    }, maxMs);

    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    rec.onerror = function (e) {
      if (finished) return;
      finished = true;
      cleanup();
      fail('录制出错：' + shortErr((e && e.error) || e));
    };

    rec.onstop = async function () {
      if (finished) return;
      finished = true;
      cleanup();
      setProgress('正在解码录音…', '');
      setIndeterminate();
      try {
        var blob = new Blob(chunks, { type: mime || 'audio/webm' });
        if (!blob.size) throw new Error('没有录到音频（视频可能一直没在播放）');
        var buf = await blob.arrayBuffer();
        await submitAudioBuffer(buf, (m.title || 'page-media').slice(0, 60) + '（边播边录）');
      } catch (e) {
        fail(String((e && e.message) || e));
      }
    };

    state.localRec = {
      stop: function () {
        try {
          if (rec.state !== 'inactive') rec.stop();
        } catch (e) {
          /* ignore */
        }
      },
    };

    recPanel.hidden = false;
    recTip.textContent = '直连下载走不通，正在边播边录（实时速度，请保持播放）';
    recTimer.textContent = '00:00';
    startRecTimer();
    setProgress('边播边录中…', '按播放速度实时录制；视频播完或点「停止并开始转录」即开始识别');
    setIndeterminate();

    el.addEventListener('ended', onEnded, { once: true });

    try {
      rec.start(1000);
    } catch (e) {
      cleanup();
      fail('无法开始录制：' + shortErr(e));
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
    // 用新的 requestId 并写回 state，否则进度广播会被 requestId 过滤器挡掉
    state.requestId = newRequestId();
    try {
      var res = await callOffscreen('asr:preload', {
        requestId: state.requestId,
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

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg) return undefined;

    // SW 补注入后要求打开面板
    if (msg.target === 'cs') {
      if (msg.type === 'panel:toggle') setPanelOpen(panel.hidden);
      else if (msg.type === 'panel:open') setPanelOpen(true);
      else if (msg.type === 'entry:status') {
        respond(entryStatus());
        return true;
      }
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
      default:
        break;
    }
    return undefined;
  });

  /* ==================== YouTube 原生操作栏里的「转文字」按钮 ==================== */
  //
  // 目标是把它做成「分享 / 保存 / 下载」那一行的最后一个按钮，看着像原生的一样。
  //
  // 三个必须记住的坑（都是实测踩出来的）：
  //   1. 千万别 cloneNode 原生按钮 —— 那结构里有自定义元素，插进文档会被 upgrade
  //      并重新渲染，把我们塞进去的内容冲掉。只抄 class，DOM 自己拼。
  //   2. 光抄 class 不够：原生的 <button class="ytSpecButtonShapeNextHost"> 外面
  //      还套着 <yt-button-view-model style="display:inline-block">，裸按钮拿到的是
  //      display:flex（块级）→ 会掉到第二行，而 ytd-menu-renderer 只有 44px 高且
  //      overflow:hidden —— 按钮就被裁没了。必须显式写死 inline-flex。
  //   3. 「在 DOM 里」不等于「看得见」：还要量尺寸 + 逐级检查有没有被祖先的
  //      overflow 裁掉。量不过就换个挂法 / 换成图标-only，再不行就把悬浮球放出来。
  //
  // 图标用内联描边（原生容器会把 fill 设成 currentcolor，
  // 线条类路径是零面积的，不改回 stroke 就什么都不显示）。

  var ENTRY_ID = 'v2t-page-entry';

  // 「真的看得见吗」—— 有尺寸 + 未被 display:none / visibility:hidden 藏掉。
  function visibleBox(el) {
    if (!el || !el.isConnected) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return null;
    return r;
  }

  // 容器里至少得有一个看得见的原生按钮，才算「这一行是展开的」
  function hasVisibleButton(box) {
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (visibleBox(btns[i])) return true;
    }
    return false;
  }

  var ENTRY_SITES = [
    {
      name: 'youtube',
      match: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i,
      /**
       * 返回**所有**可以挂的落点（已按「离原生操作栏多近」排好序）。
       * 每个落点带一个「捐赠者」按钮 —— 抄 class 和外观都从它身上取。
       * 必须限定在观看页里找，否则首页/侧栏的预览菜单也会被插进去。
       */
      anchors: function () {
        var out = [];
        var flexy = document.querySelector('ytd-watch-flexy');
        if (!flexy) return out;
        var scope =
          document.querySelector('ytd-watch-metadata') ||
          document.querySelector('#above-the-fold') ||
          document;

        function collect(sel) {
          var list = scope.querySelectorAll(sel);
          for (var i = 0; i < list.length; i++) {
            var box = list[i];
            if (!visibleBox(box)) continue;
            if (!hasVisibleButton(box)) continue;
            out.push({ box: box, donor: donorNear(box) });
          }
        }
        // 先试「分享/保存/下载」那一行（用户要的就是这里），
        // 窗口窄、那一行被折进「⋮」时再退到「赞/踩/分享」那一行
        collect('#flexible-item-buttons');
        collect('#top-level-buttons-computed');
        return out;
      },
    },
  ];

  // 找「捐赠者」：抄外观用的原生按钮。
  // 关键是**只在插入位置所在的那一行里找** —— YouTube 会把同一段元数据在 DOM 里
  // 渲染好几份（其中靠前的几份是空占位模板），全局 querySelector 很容易抓到空壳。
  function donorNear(anchor) {
    var row = anchor.closest('ytd-menu-renderer') || anchor.parentElement;
    if (!row) return null;
    var btns = row.querySelectorAll('button');
    var withText = null;
    var withIcon = null;
    var any = null;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === ENTRY_ID) continue; // 别把自己当捐赠者
      if (!visibleBox(b)) continue;
      if (!any) any = b;
      // 站点不一定把图标渲染成 <svg>（可能用 CSS mask 或还没渲染出来），
      // 所以 svg 只作为「优先」条件，不能当成门槛
      if (b.querySelector('svg')) withIcon = b;
      // 一直覆盖 → 最终拿到「最后一个有文字」的按钮（分享 / 保存 / 下载那一类），
      // 它的结构（图标 + 文字）和我们做的按钮最贴合
      if (b.textContent.trim()) withText = b;
    }
    return withText || withIcon || any || null;
  }

  function entrySite() {
    for (var i = 0; i < ENTRY_SITES.length; i++) {
      if (ENTRY_SITES[i].match.test(location.hostname)) return ENTRY_SITES[i];
    }
    return null;
  }

  /* ---- 外观：从原生按钮的 computed style 抄，再用内联样式钉死 ---- */

  var SKIN_PROPS = [
    'height', 'minHeight', 'maxHeight', 'minWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'borderRadius', 'backgroundColor', 'color',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'alignItems', 'justifyContent', 'gap', 'boxShadow', 'borderWidth', 'borderStyle', 'borderColor',
  ];

  function kebab(p) {
    return p.replace(/[A-Z]/g, function (c) {
      return '-' + c.toLowerCase();
    });
  }

  function setImportant(el, prop, value) {
    try {
      el.style.setProperty(kebab(prop), value, 'important');
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 把捐赠者的外观抄过来，并钉死几条「布局上不能让步」的属性。
   * 用内联 important 是为了压过站点样式表里所有同名的规则 —— 站点随时会改版，
   * 只有钉死了才能保证按钮不会哪天又变成 display:flex 掉出可视区。
   */
  function applySkin(btn, donor) {
    if (donor) {
      var cs = null;
      try {
        cs = window.getComputedStyle(donor);
      } catch (e) {
        cs = null;
      }
      if (cs) {
        SKIN_PROPS.forEach(function (p) {
          var v = cs[p];
          if (v && v !== 'auto' && v !== 'normal' && v !== '0px') setImportant(btn, p, v);
        });
      }
      btn.className = (donor.className || '') + ' v2t-entry';
    } else {
      btn.className = 'v2t-entry v2t-entry-plain';
      setImportant(btn, 'height', '36px');
      setImportant(btn, 'padding', '0 14px');
      setImportant(btn, 'borderRadius', '18px');
      setImportant(btn, 'backgroundColor', 'rgba(0, 0, 0, 0.05)');
      setImportant(btn, 'color', 'inherit');
      setImportant(btn, 'fontSize', '14px');
      setImportant(btn, 'fontWeight', '500');
    }
    // 这几条是「掉到第二行被裁掉」的直接解药，必须写死
    setImportant(btn, 'display', 'inline-flex');
    setImportant(btn, 'flex', '0 0 auto');
    setImportant(btn, 'verticalAlign', 'middle');
    setImportant(btn, 'boxSizing', 'border-box');
    setImportant(btn, 'whiteSpace', 'nowrap');
    setImportant(btn, 'minWidth', '0');
    setImportant(btn, 'visibility', 'visible');
    setImportant(btn, 'opacity', '1');
    setImportant(btn, 'cursor', 'pointer');
    setImportant(btn, 'position', 'relative');
    setImportant(btn, 'alignItems', 'center');
    setImportant(btn, 'justifyContent', 'center');
  }

  // 描边图标（原生容器的 fill: currentcolor 会让零面积的线条路径消失，所以内联写死 stroke）
  function strokeIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText =
      'display:block;width:100%;height:100%;pointer-events:none;fill:none;' +
      'stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round';
    var p = document.createElementNS(NS, 'path');
    // 一张折角文稿 + 两条文字线
    p.setAttribute('d', 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6');
    svg.appendChild(p);
    return svg;
  }

  function onEntryClick(e) {
    // 原生操作栏里按钮的父级还可能挂着别的行为，这里必须掐断冒泡
    e.preventDefault();
    e.stopPropagation();
    setPanelOpen(panel.hidden);
  }

  /**
   * @param {Element|null} donor 抄外观用的原生按钮
   * @param {'text'|'icon'} variant text = 图标+文字；icon = 只留图标（更窄，防被挤掉）
   */
  function buildEntry(donor, variant) {
    var iconBox = h(
      'div',
      {
        'aria-hidden': 'true',
        style:
          'display:inline-flex;align-items:center;justify-content:center;' +
          'width:24px;height:24px;flex:0 0 auto;' +
          (variant === 'text' ? 'margin-right:6px;' : ''),
      },
      [strokeIcon()]
    );
    var kids = [iconBox];
    if (variant === 'text') {
      kids.push(
        h('div', { style: 'line-height:1;white-space:nowrap;overflow:hidden;', text: '转文字' })
      );
    }
    var btn = h(
      'button',
      {
        id: ENTRY_ID,
        type: 'button',
        title: '视频转文字（本地 Whisper）',
        'aria-label': '视频转文字（本地 Whisper）',
        on: { click: onEntryClick },
      },
      kids
    );
    applySkin(btn, donor);
    // 记下这次用的是「原生外观」还是「兜底外观」—— 首次挂载时原生按钮可能还没渲染，
    // 会先落个兜底的；等捐赠者出现后要能自动换成原生外观（见 syncEntry 的自愈分支）
    btn.dataset.skin = donor ? 'native' : 'plain';
    btn.dataset.variant = variant;
    if (variant === 'icon') setImportant(btn, 'padding', '0 8px');
    return btn;
  }

  /**
   * 「这个入口真的看得见吗」。
   * 三条都过才算：尺寸够大、没被 display/visibility 藏、没被任何祖先的 overflow 裁掉。
   */
  function entryMetrics(node) {
    if (!node || !node.isConnected) return { ok: false, why: '节点不在 DOM 里' };
    var r = node.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) {
      return {
        ok: false,
        why: '只有 ' + Math.round(r.width) + '×' + Math.round(r.height) + ' 像素（被压扁了）',
      };
    }
    var st = window.getComputedStyle(node);
    if (st.display === 'none') return { ok: false, why: 'display:none' };
    if (st.visibility === 'hidden') return { ok: false, why: 'visibility:hidden' };

    var n = node.parentElement;
    var level = 0;
    while (n && n !== document.documentElement && level < 8) {
      var s = window.getComputedStyle(n);
      var rb = n.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(s.overflowX + ' ' + s.overflowY)) {
        if (r.right > rb.right + 1 || r.left < rb.left - 1 || r.bottom > rb.bottom + 1 || r.top < rb.top - 1) {
          return {
            ok: false,
            why: '被 ' + n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ' 的 overflow 裁掉了',
          };
        }
      }
      n = n.parentElement;
      level++;
    }
    return { ok: true, why: '' };
  }

  /**
   * 跟同行的原生按钮对齐高度。
   * 捐赠者的 <button> 有时比它的外层壳子（yt-button-view-model）矮几像素，
   * 直接抄会矮一截；插进去之后拿邻居再校一次，视觉上才真的像一家人。
   */
  function alignToNeighbors(btn, box) {
    var mine = btn.getBoundingClientRect().height;
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === btn || !k.tagName) continue;
      var r = k.getBoundingClientRect();
      if (r.height > mine + 1 && r.height - mine <= 12) {
        setImportant(btn, 'height', Math.round(r.height) + 'px');
        return;
      }
    }
  }

  var lastEntryWhy = '还没尝试挂载';

  function syncEntry() {
    var site = entrySite();
    var chain = site ? site.anchors() : [];
    var node = document.getElementById(ENTRY_ID);

    // 已经挂上了：确认它还在一个「可用落点」里、依然看得见、而且是最好看的版本。
    // 首次挂载时原生按钮常常还没渲染完，会先落一个兜底外观 —— 现在能抄到捐赠者了，
    // 就重建一次换上原生外观（YouTube 是 SPA，这一步躲不掉）。
    if (node && node.isConnected) {
      var m = entryMetrics(node);
      var host = null;
      for (var k = 0; k < chain.length; k++) {
        if (chain[k].box === node.parentElement) host = chain[k];
      }
      var canUpgrade = !!host && !!host.donor && node.dataset.skin === 'plain';
      if (m.ok && host && !canUpgrade) {
        lastEntryWhy = '';
        if (fab) fab.hidden = true;
        return true;
      }
      lastEntryWhy = host ? (canUpgrade ? '正在换成原生外观' : m.why) : '落点已经不展开了';
      node.parentNode.removeChild(node);
      node = null;
    }

    if (!chain.length) {
      lastEntryWhy = '没找到可挂载的操作栏（页面还没渲染完，或这一行被折进 ⋮ 了）';
      if (fab) fab.hidden = false;
      return false;
    }

    // 逐个落点试：先试「图标+文字」，放不下就换成「只留图标」，再不行换下一个落点
    for (var i = 0; i < chain.length; i++) {
      var variants = ['text', 'icon'];
      for (var v = 0; v < variants.length; v++) {
        var btn = buildEntry(chain[i].donor, variants[v]);
        var mm = { ok: false, why: '' };
        try {
          chain[i].box.appendChild(btn);
          alignToNeighbors(btn, chain[i].box);
          mm = entryMetrics(btn);
        } catch (e) {
          mm = { ok: false, why: '插入失败：' + shortErr(e) };
        }
        if (mm.ok) {
          lastEntryWhy = '';
          if (fab) fab.hidden = true;
          return true;
        }
        lastEntryWhy = mm.why;
        try {
          chain[i].box.removeChild(btn);
        } catch (e) {
          /* ignore */
        }
      }
    }

    // 一个落点都放不下：把悬浮球放出来，保证用户至少有一个入口
    if (fab) fab.hidden = false;
    return false;
  }

  // 「现在这个入口是好的吗」
  function entryHealthy() {
    return entryMetrics(document.getElementById(ENTRY_ID)).ok;
  }

  // 给 popup 看的自检结果：入口没显示出来时，一眼能看出卡在哪一步
  function entryStatus() {
    var site = entrySite();
    var chain = site ? site.anchors() : [];
    var node = document.getElementById(ENTRY_ID);
    var m = entryMetrics(node);
    var anyVisible = function (sel) {
      var list = document.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) {
        if (visibleBox(list[i]) && hasVisibleButton(list[i])) return true;
      }
      return false;
    };
    return {
      host: location.hostname,
      supported: !!site,
      siteName: site ? site.name : null,
      anchorFound: chain.length > 0,
      anchorCount: chain.length,
      anchorId: chain.length ? chain[0].box.id || chain[0].box.tagName.toLowerCase() : null,
      mounted: !!(node && node.isConnected),
      visible: m.ok,
      why: m.ok ? '' : m.why || lastEntryWhy,
      mediaTracks: audioCandidates().length,
      perfMedia: mediaUrlsFromTimeline().length,
      flexTotal: document.querySelectorAll('#flexible-item-buttons').length,
      flexVisible: anyVisible('#flexible-item-buttons'),
      topVisible: anyVisible('#top-level-buttons-computed'),
      fabVisible: !!(fab && !fab.hidden),
    };
  }

  function watchEntry() {
    syncEntry();

    // YouTube 是 SPA：路由切换、局部重渲染都会把我们的节点冲掉，得反复补挂。
    // 开销控制：只有在「节点不在了 / 被藏起来了」才做完整同步。
    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        if (entryHealthy()) return;
        syncEntry();
      }, 300);
    }

    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length || muts[i].removedNodes.length) return schedule();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'resize'].forEach(function (ev) {
      window.addEventListener(ev, schedule, true);
    });

    // 兜底轮询：容器被折叠、站点改样式这类变化**不产生 childList 变动**，
    // MutationObserver 等不到（而入口正好会因此变得不可见）。
    // 前 30 秒每秒看一次（覆盖首屏渲染），之后降到每 4 秒一次。
    var tries = 0;
    function tick() {
      if (entryHealthy()) return;
      syncEntry();
    }
    var poll = setInterval(function () {
      tries++;
      if (tries === 30) {
        clearInterval(poll);
        poll = setInterval(tick, 4000);
      }
      tick();
    }, 1000);
  }

  /* ==================== 启动 ==================== */

  (async function init() {
    buildUI();
    watchEntry();

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

    refreshMediaInfo();
    refreshCaptions();
    // 播放器是懒加载的，隔一会儿再看一眼（只更新那行提示文字，开销可忽略）
    setTimeout(refreshMediaInfo, 3000);
    setTimeout(refreshMediaInfo, 8000);
    setInterval(refreshMediaInfo, 15000);
  })();
})();
