/**
 * popup：读写守卫配置。改完立刻广播给已打开的标签页，不用刷新页面。
 */
(function () {
  'use strict';

  const DEFAULTS = { enabled: true, minLevel: 1, strategy: 'mask', disabledHosts: [] };
  const $ = (id) => document.getElementById(id);

  function load() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ psGuardConfig: DEFAULTS, psGuardStats: { alerted: 0, masked: 0 } }, (d) => {
        resolve({
          config: Object.assign({}, DEFAULTS, d.psGuardConfig),
          stats: Object.assign({ alerted: 0, masked: 0 }, d.psGuardStats),
        });
      });
    });
  }

  function save(cfg) {
    chrome.storage.local.set({ psGuardConfig: cfg });
    // 通知所有页面的 content script 立刻生效
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((t) => {
        if (!t.id) return;
        chrome.tabs.sendMessage(t.id, { type: 'psGuardConfig', config: cfg }, () => {
          void chrome.runtime.lastError;   // 页面没注入 content script 时会报错，忽略
        });
      });
    });
  }

  let cfg = Object.assign({}, DEFAULTS);
  let host = '';

  load().then(({ config, stats }) => {
    cfg = config;
    $('enabled').checked = cfg.enabled !== false;
    $('minLevel').value = String(cfg.minLevel || 1);
    $('strategy').value = cfg.strategy || 'mask';
    $('statAlerted').textContent = stats.alerted || 0;
    $('statMasked').textContent = stats.masked || 0;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try { host = new URL(tabs[0].url).hostname; } catch (_) { host = '当前站点'; }
      $('hostName').textContent = host;
      $('muteHost').checked = (cfg.disabledHosts || []).indexOf(host) >= 0;
    });
  });

  $('enabled').addEventListener('change', (e) => { cfg.enabled = e.target.checked; save(cfg); });
  $('minLevel').addEventListener('change', (e) => { cfg.minLevel = Number(e.target.value) || 1; save(cfg); });
  $('strategy').addEventListener('change', (e) => { cfg.strategy = e.target.value; save(cfg); });

  $('muteHost').addEventListener('change', (e) => {
    const list = (cfg.disabledHosts || []).slice();
    const i = list.indexOf(host);
    if (e.target.checked && i < 0) list.push(host);
    if (!e.target.checked && i >= 0) list.splice(i, 1);
    cfg.disabledHosts = list;
    save(cfg);
  });

  // 默认指向同源的本地/线上检测工具，可在部署后改为实际地址
  $('openTool').href = 'https://privacy-sentinel.onrender.com/';
})();
