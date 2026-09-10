/**
 * 页面侧脚本（不参与打包，作为静态资源直接拷贝到 dist）。
 * 只做两件只读的事：
 *   1. 扫描页面里的 <video> / <audio> 元素，把可直接下载的媒体地址交给侧边栏
 *   2. 读取页面自带的字幕轨道（如 YouTube 的 captionTracks），能拿到就完全不用跑模型
 */
(function () {
  'use strict';

  function readYouTubeCaptions() {
    try {
      const tracks =
        window.ytInitialPlayerResponse &&
        window.ytInitialPlayerResponse.captions &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!tracks || !tracks.length) return null;
      return tracks.map(function (t) {
        const name = t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text));
        return { baseUrl: t.baseUrl, lang: t.languageCode, name: name || t.languageCode };
      });
    } catch (e) {
      return null;
    }
  }

  function scan() {
    const nodes = document.querySelectorAll('video, audio');
    const medias = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const src = el.currentSrc || el.src || '';
      if (!src) continue;
      medias.push({
        tag: (el.tagName || '').toLowerCase(),
        src: src,
        duration: el.duration && isFinite(el.duration) ? el.duration : 0,
        title: el.getAttribute('title') || document.title,
      });
    }
    return {
      ok: true,
      title: document.title,
      url: location.href,
      medias: medias,
      captions: readYouTubeCaptions(),
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== 'v2t:scan') return undefined;
    respond(scan());
    return true;
  });
})();
