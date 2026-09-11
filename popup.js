/**
 * popup.js —— 扩展弹窗。
 * 两件事：
 *   1. 把「打开面板」的请求交给 Service Worker（它才知道怎么在受限页面上兜底注入）
 *   2. 「检测本页」：问页面里挂上了的原生入口到底卡在哪一步
 * 版本号从 manifest 读，避免和 manifest.json 里的版本号对不上。
 */
'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var verEl = document.getElementById('ver');
  var openBtn = document.getElementById('open');
  var probeBtn = document.getElementById('probe');
  var diagEl = document.getElementById('diag');
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

  // 把自检结果翻译成人话，重点是回答「卡在哪一步」
  function describe(s) {
    if (!s) return '没拿到页面状态（页面可能刚刷新，再点一次试试）。';
    var out = [];
    out.push('页面：' + s.host);

    if (!s.supported) {
      out.push('✗ 这个站点没有配置原生入口（目前只做 YouTube）。');
      out.push('→ 面板只在 YouTube 页面出现，请打开一个 YouTube 视频页。');
      return out.join('\n');
    }

    out.push('✓ 命中站点规则：' + s.siteName);
    out.push(
      (s.anchorFound ? '✓ 找到可挂载的操作栏' : '✗ 没找到可挂载的操作栏') +
        (s.anchorFound
          ? '（' + s.anchorId + '，共 ' + s.anchorCount + ' 个落点）'
          : '（还没渲染出来，或已被折叠）')
    );
    out.push((s.mounted ? '✓ 入口已插入 DOM' : '✗ 入口还没插入'));
    if (s.mounted && !s.visible) out.push('✗ 插进去了但看不见：' + (s.why || '未知原因'));
    out.push(
      (s.fabVisible ? '✓ 悬浮按钮可见（可兜底使用）' : '· 悬浮按钮已收起（原生入口正常）')
    );
    out.push(
      '抓取到的媒体请求：' +
        s.perfMedia +
        ' 条，其中带音轨可用 ' +
        s.mediaTracks +
        ' 条' +
        (s.mediaTracks ? '' : '（让视频播几秒再试）')
    );
    out.push(
      '操作栏探测：flexible=' +
        (s.flexVisible ? '可见' : '折叠') +
        '（共 ' +
        s.flexTotal +
        ' 个）｜topLevel=' +
        (s.topVisible ? '可见' : '折叠')
    );

    if (s.mounted && s.visible) out.push('→ 一切正常。');
    else if (s.fabVisible) out.push('→ 原生入口没挂上，但悬浮按钮在，先点那个用。');
    else out.push('→ 两个入口都没有：在扩展页点「重新加载」后刷新本页。');
    return out.join('\n');
  }

  probeBtn.addEventListener('click', function () {
    errEl.hidden = true;
    probeBtn.disabled = true;
    diagEl.textContent = '正在检测…';
    chrome.runtime
      .sendMessage({ target: 'sw', type: 'panel:status', payload: {} })
      .then(function (res) {
        probeBtn.disabled = false;
        if (!res || !res.ok) {
          diagEl.textContent = '检测失败：' + ((res && res.error) || '未知原因');
          return;
        }
        diagEl.textContent = describe(res.status);
      })
      .catch(function (e) {
        probeBtn.disabled = false;
        diagEl.textContent = '检测失败：' + ((e && e.message) || e);
      });
  });
});
