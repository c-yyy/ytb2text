function pad(n, len = 2) {
  return String(Math.floor(n)).padStart(len, '0');
}

/** 秒 -> 00:01:23,456（SRT 用逗号） */
export function srtTime(sec) {
  const s = Math.max(0, sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`;
}

/** 秒 -> 00:01:23.456（VTT 用点） */
export function vttTime(sec) {
  return srtTime(sec).replace(',', '.');
}

export function toPlainText(segments) {
  return segments.map((s) => s.text).join('\n');
}

export function toTimestampedText(segments) {
  return segments
    .map((s) => `[${srtTime(s.start).replace(',', '.')}] ${s.text}`)
    .join('\n');
}

export function toSRT(segments) {
  return segments
    .map((s, i) => {
      const end = typeof s.end === 'number' ? s.end : s.start + 3;
      return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(end)}\n${s.text}\n`;
    })
    .join('\n');
}

export function toVTT(segments) {
  const body = segments
    .map((s) => {
      const end = typeof s.end === 'number' ? s.end : s.start + 3;
      return `${vttTime(s.start)} --> ${vttTime(end)}\n${s.text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
