/**
 * popup.js —— 扩展弹窗。
 * 只做一件事：把「打开面板」的请求交给 Service Worker（它才知道怎么在受限页面上兜底注入）。
 * 版本号从 manifest 读，避免和 manifest.json 里的版本号对不上。
 */
'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var verEl = document.getElementById('ver');
  var openBtn = document.getElementById('open');
  var errEl = document.getElementById('err');

  try {
    verEl.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    /* ignore */
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  openBtn.addEventListener('click', function () {
    errEl.hidden = true;
    openBtn.disabled = true;
    chrome.runtime
      .sendMessage({ target: 'sw', type: 'panel:open', payload: {} })
      .then(function (res) {
        openBtn.disabled = false;
        if (res && res.ok) {
          window.close();
        } else {
          showError((res && res.error) || '无法在当前页面打开面板');
        }
      })
      .catch(function (e) {
        openBtn.disabled = false;
        showError('无法在当前页面打开面板：' + ((e && e.message) || e));
      });
  });
});
