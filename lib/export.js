/**
 * lib/export.js —— 结果格式化与导出（无构建版，挂到 V2T.ex）。
 *
 * 命名用 ex 而不是 export：export 是保留字，做属性名虽然合法，
 * 但在老式解析路径上容易踩坑，索性避开。
 *
 * 页面侧（content.js）与扩展页都能用。
 */
(function (root) {
  'use strict';

  function pad(n, len) {
    var s = String(Math.floor(n));
    var width = len == null ? 2 : len;
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** 秒 -> 00:01:23,456（SRT 用逗号） */
  function srtTime(sec) {
    var s = Math.max(0, sec || 0);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = Math.floor(s % 60);
    var ms = Math.round((s - Math.floor(s)) * 1000);
    // 进位保护：ms 四舍五入到 1000 时归零（否则会出现 ,1000 这种非法时间码）
    if (ms === 1000) ms = 999;
    return pad(h) + ':' + pad(m) + ':' + pad(ss) + ',' + pad(ms, 3);
  }

  /** 秒 -> 00:01:23.456（VTT 用点） */
  function vttTime(sec) {
    return srtTime(sec).replace(',', '.');
  }

  function toPlainText(segments) {
    return (segments || [])
      .map(function (s) {
        return s.text;
      })
      .join('\n');
  }

  function toTimestampedText(segments) {
    return (segments || [])
      .map(function (s) {
        return '[' + srtTime(s.start).replace(',', '.') + '] ' + s.text;
      })
      .join('\n');
  }

  function toSRT(segments) {
    return (segments || [])
      .map(function (s, i) {
        var end = typeof s.end === 'number' ? s.end : s.start + 3;
        return i + 1 + '\n' + srtTime(s.start) + ' --> ' + srtTime(end) + '\n' + s.text + '\n';
      })
      .join('\n');
  }

  function toVTT(segments) {
    var body = (segments || [])
      .map(function (s) {
        var end = typeof s.end === 'number' ? s.end : s.start + 3;
        return vttTime(s.start) + ' --> ' + vttTime(end) + '\n' + s.text + '\n';
      })
      .join('\n');
    return 'WEBVTT\n\n' + body;
  }

  function baseName() {
    // 本地时间，避免 toISOString 把用户带到 UTC 造成文件名差一天
    var d = new Date();
    function p(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return (
      'transcript-' +
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      '-' +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function downloadFile(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
  }

  root.V2T = root.V2T || {};
  root.V2T.ex = {
    srtTime: srtTime,
    vttTime: vttTime,
    toPlainText: toPlainText,
    toTimestampedText: toTimestampedText,
    toSRT: toSRT,
    toVTT: toVTT,
    baseName: baseName,
    escapeHtml: escapeHtml,
    downloadFile: downloadFile,
  };
})(typeof self !== 'undefined' ? self : this);
