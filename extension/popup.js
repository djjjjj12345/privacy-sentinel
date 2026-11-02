/**
 * popup 两部分：
 *   1. 输入守卫配置（读写 chrome.storage，改完广播给所有标签页）
 *   2. 检测工具（粘贴 → 本地检测 → 只显示脱敏值 → 复制/下载）
 *
 * 检测部分刻意「不联网、不上传」：用的就是扩展自带的同一份引擎，
 * 规则与网页版、SDK 三处同源，改规则只改 services/ 一份。
 * 结果列表只渲染 masked，绝不回显原文——弹窗本身不能成为第二个泄露点。
 */
(function () {
  'use strict';

  const DEFAULTS = { enabled: true, minLevel: 1, strategy: 'mask', disabledHosts: [] };
  const $ = (id) => document.getElementById(id);

  /* ---------------- 标签页 ---------------- */

  function showPage(name) {
    const guard = name === 'pageDetect' ? false : true;
    $('pageGuard').hidden = !guard;
    $('pageDetect').hidden = guard;
    $('tabGuard').classList.toggle('active', guard);
    $('tabDetect').classList.toggle('active', !guard);
    $('tabGuard').setAttribute('aria-selected', String(guard));
    $('tabDetect').setAttribute('aria-selected', String(!guard));
    try { chrome.storage.local.set({ psPopupTab: name }); } catch (_) { /* 忽略 */ }
  }

  $('tabGuard').addEventListener('click', () => showPage('pageGuard'));
  $('tabDetect').addEventListener('click', () => showPage('pageDetect'));

  /* ---------------- 统计 ---------------- */

  function bumpMasked(n) {
    chrome.storage.local.get({ psGuardStats: { alerted: 0, masked: 0 } }, (d) => {
      const s = Object.assign({ alerted: 0, masked: 0 }, d.psGuardStats);
      s.masked = (s.masked || 0) + (n || 1);
      chrome.storage.local.set({ psGuardStats: s });
      $('statMasked').textContent = s.masked;
    });
  }

  /* ---------------- 检测工具 ---------------- */

  let lastMasked = '';

  function renderResult(text, items, level, summary) {
    const list = $('detectList');
    list.innerHTML = '';
    items.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'item lv' + (Number(it.level) || 1);

      const lv = document.createElement('span');
      lv.className = 'lv-badge';
      lv.textContent = 'L' + (Number(it.level) || 1);

      const name = document.createElement('b');
      name.textContent = it.label || it.type || '敏感信息';

      const val = document.createElement('code');
      val.textContent = it.masked || '';      // 只显示脱敏值

      li.appendChild(lv);
      li.appendChild(name);
      li.appendChild(val);
      list.appendChild(li);
    });

    const sum = $('detectSummary');
    sum.hidden = false;
    sum.textContent = summary + (level ? `（最高 L${level}）` : '');
    sum.className = 'summary' + (items.length ? ' hit lv' + level : '');
    $('detectExport').hidden = !items.length;
  }

  function runDetect() {
    const local = window.PSLocal;
    const schema = window.PSSchema;
    const guard = window.PSGuardCore;

    if (!local || typeof local.detect !== 'function' || !guard) {
      $('detectSummary').hidden = false;
      $('detectSummary').textContent = '引擎未加载，请重新加载扩展';
      $('detectSummary').className = 'summary err';
      return;
    }

    const text = $('detectInput').value || '';
    const items = guard.pickItems(local.detect(text) || [], 1);
    const strategy = $('detectStrategy').value || 'mask';

    lastMasked = guard.buildMaskedText(text, items, strategy);
    const level = schema && schema.maxLevelOf ? schema.maxLevelOf(items) : 0;
    const summary = schema && schema.summarize ? schema.summarize(items) : '';
    renderResult(text, items, level, summary);
  }

  $('detectRun').addEventListener('click', runDetect);

  $('detectClear').addEventListener('click', () => {
    $('detectInput').value = '';
    $('detectList').innerHTML = '';
    $('detectSummary').hidden = true;
    $('detectExport').hidden = true;
    lastMasked = '';
    $('detectInput').focus();
  });

  $('detectStrategy').addEventListener('change', () => {
    if ($('detectInput').value) runDetect();
  });

  $('detectInput').addEventListener('input', () => {
    // 边打字边检测：本地引擎足够快，长文本会被 guardCore 的 MAX_SCAN_CHARS 兜住
    if ($('detectInput').value) runDetect();
    else { $('detectList').innerHTML = ''; $('detectSummary').hidden = true; $('detectExport').hidden = true; }
  });

  $('detectCopy').addEventListener('click', () => {
    if (!lastMasked) return;
    const done = () => bumpMasked(1);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lastMasked).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      ta.value = lastMasked;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  });

  $('detectDownload').addEventListener('click', () => {
    if (!lastMasked) return;
    const blob = new Blob([lastMasked], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '隐私哨兵-脱敏文本.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    bumpMasked(1);
  });

  /* ---------------- 守卫配置（原有逻辑） ---------------- */

  function load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        { psGuardConfig: DEFAULTS, psGuardStats: { alerted: 0, masked: 0 }, psPopupTab: 'pageGuard' },
        (d) => resolve({
          config: Object.assign({}, DEFAULTS, d.psGuardConfig),
          stats: Object.assign({ alerted: 0, masked: 0 }, d.psGuardStats),
          tab: d.psPopupTab || 'pageGuard',
        })
      );
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

  load().then(({ config, stats, tab }) => {
    cfg = config;
    $('enabled').checked = cfg.enabled !== false;
    $('minLevel').value = String(cfg.minLevel || 1);
    $('strategy').value = cfg.strategy || 'mask';
    $('detectStrategy').value = cfg.strategy || 'mask';
    $('statAlerted').textContent = stats.alerted || 0;
    $('statMasked').textContent = stats.masked || 0;
    showPage(tab === 'pageDetect' ? 'pageDetect' : 'pageGuard');

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
