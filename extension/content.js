/**
 * 隐私哨兵 · 输入守卫（content script）
 * ---------------------------------------------------------------
 * 在任意网页的输入框 / 评论框 / 富文本里实时监测，命中隐私信息就浮出提醒条，
 * 支持一键脱敏、删除、忽略。全部计算在浏览器本地完成，不发任何网络请求。
 *
 * 本文件只做两件事：绑定事件 + 画提醒条。
 * 规则判断与文本处理都在 services/guardCore.js（扩展里是 engine/guardCore.js），
 * 与网页版 guard.html 同源，改一处两边同时生效。
 *
 * 三条硬约束（改动时不要破坏）：
 *   1. 提醒条里只展示脱敏后的值，绝不回显原文 —— 否则提示本身就成了第二处泄露。
 *   2. 写回输入框必须走原生 setter + input 事件，否则 React / Vue 受控组件拿不到新值。
 *   3. 密码框、隐藏域一律跳过：在密码框里输入密码是正常行为，不该报警。
 */
(function () {
  'use strict';

  if (window.__PS_GUARD_LOADED__) return;
  window.__PS_GUARD_LOADED__ = true;

  const ENGINE = window.PSLocal;
  const CORE = window.PSGuardCore;
  if (!ENGINE || typeof ENGINE.detect !== 'function') {
    console.warn('[隐私哨兵·守卫] 本地引擎未加载，守卫未启用');
    return;
  }
  if (!CORE) {
    console.warn('[隐私哨兵·守卫] 守卫核心未加载，守卫未启用');
    return;
  }

  const NS = 'psg';
  const TIP_ID = 'ps-guard-tip';

  /* ---------------- 配置存储（chrome.storage 优先，localStorage 兜底） ---------------- */

  const DEFAULT_CONFIG = CORE.DEFAULT_CONFIG;
  const hasChromeStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  function readConfig() {
    return new Promise((resolve) => {
      if (hasChromeStore) {
        chrome.storage.local.get({ psGuardConfig: DEFAULT_CONFIG }, (d) => {
          resolve(Object.assign({}, DEFAULT_CONFIG, d && d.psGuardConfig));
        });
      } else {
        try {
          resolve(Object.assign({}, DEFAULT_CONFIG, JSON.parse(localStorage.getItem('psGuardConfig') || '{}')));
        } catch (_) { resolve(Object.assign({}, DEFAULT_CONFIG)); }
      }
    });
  }

  function writeConfig(c) {
    if (hasChromeStore) chrome.storage.local.set({ psGuardConfig: c });
    else { try { localStorage.setItem('psGuardConfig', JSON.stringify(c)); } catch (_) {} }
  }

  function bumpStat(field) {
    if (!hasChromeStore) return;
    chrome.storage.local.get({ psGuardStats: { alerted: 0, masked: 0 } }, (d) => {
      const s = Object.assign({ alerted: 0, masked: 0 }, d.psGuardStats);
      s[field] = (s[field] || 0) + 1;
      chrome.storage.local.set({ psGuardStats: s });
    });
  }

  /* ---------------- 提醒条 UI ---------------- */

  let tipEl = null;
  let tipTimer = null;
  let ignoredFor = null;
  let currentTarget = null;
  let currentItems = [];
  let cfg = Object.assign({}, DEFAULT_CONFIG);

  function ensureTip() {
    if (tipEl && document.body && document.body.contains(tipEl)) return tipEl;
    tipEl = document.createElement('div');
    tipEl.id = TIP_ID;
    tipEl.className = NS + '-tip';
    tipEl.setAttribute('role', 'alert');
    (document.body || document.documentElement).appendChild(tipEl);
    return tipEl;
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove('show');
    currentTarget = null;
  }

  function renderTip(target, items) {
    const el = ensureTip();
    const maxLevel = items.reduce((m, i) => Math.max(m, Number(i.level) || 1), 1);
    el.className = NS + '-tip ' + CORE.levelClass(maxLevel) + ' show';
    el.textContent = '';

    const head = document.createElement('div');
    head.className = NS + '-head';
    const badge = document.createElement('span');
    badge.className = NS + '-badge';
    badge.textContent = 'L' + maxLevel;
    const title = document.createElement('strong');
    title.textContent = '检测到 ' + items.length + ' 处隐私信息 · ' + CORE.levelTitle(maxLevel);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = NS + '-close';
    close.textContent = '×';
    close.title = '关闭（Esc）';
    close.addEventListener('click', hideTip);
    head.appendChild(badge);
    head.appendChild(title);
    head.appendChild(close);

    const list = document.createElement('ul');
    list.className = NS + '-list';
    items.slice(0, 4).forEach((it) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = NS + '-type';
      t.textContent = it.label || it.type || '隐私信息';
      const v = document.createElement('code');
      // 只显示脱敏值：提醒条本身不能再泄露一次
      v.textContent = CORE.maskOf(it, 'mask');
      li.appendChild(t);
      li.appendChild(v);
      list.appendChild(li);
    });
    if (items.length > 4) {
      const more = document.createElement('li');
      more.className = NS + '-more';
      more.textContent = '……还有 ' + (items.length - 4) + ' 处';
      list.appendChild(more);
    }

    const note = document.createElement('p');
    note.className = NS + '-note';
    note.textContent = '公开平台发布后无法撤回，发送前请确认。';

    const actions = document.createElement('div');
    actions.className = NS + '-actions';
    const mk = (text, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = NS + '-btn ' + cls;
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };
    actions.appendChild(mk('一键脱敏', 'primary', () => applyStrategy('mask')));
    actions.appendChild(mk('直接删除', '', () => applyStrategy('remove')));
    actions.appendChild(mk('本次忽略', 'ghost', () => { ignoredFor = CORE.readValue(target); hideTip(); }));
    actions.appendChild(mk('本站点不再提醒', 'ghost', () => {
      const h = location.hostname;
      if (!cfg.disabledHosts) cfg.disabledHosts = [];
      if (cfg.disabledHosts.indexOf(h) < 0) cfg.disabledHosts.push(h);
      writeConfig(cfg);
      hideTip();
    }));

    el.appendChild(head);
    el.appendChild(list);
    el.appendChild(note);
    el.appendChild(actions);

    positionTip(target);
  }

  function positionTip(target) {
    const el = ensureTip();
    const r = target.getBoundingClientRect();
    const tipH = el.offsetHeight || 150;
    const tipW = el.offsetWidth || 320;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - tipW - 8));
    let top = r.bottom + 8;
    // 下方空间不够就翻到输入框上方
    if (top + tipH > vh - 8) top = Math.max(8, r.top - tipH - 8);

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function applyStrategy(strategy) {
    const target = currentTarget;
    if (!target || !currentItems.length) return;
    CORE.writeValue(target, CORE.buildMaskedText(CORE.readValue(target), currentItems, strategy));
    bumpStat('masked');
    hideTip();
    ignoredFor = CORE.readValue(target);   // 脱敏后不再重复报警
  }

  /* ---------------- 检测调度 ---------------- */

  function scan(el) {
    if (!cfg.enabled) return;
    if ((cfg.disabledHosts || []).indexOf(location.hostname) >= 0) return;
    const text = CORE.readValue(el);
    if (!text || text.length < 4) { hideTip(); return; }
    if (text.length > CORE.MAX_SCAN_CHARS) return;
    if (ignoredFor !== null && ignoredFor === text) return;

    let items = [];
    try {
      items = ENGINE.detect(text) || [];
    } catch (_) { return; }

    items = CORE.pickItems(items, cfg.minLevel);
    if (!items.length) { hideTip(); return; }

    currentTarget = el;
    currentItems = items;
    bumpStat('alerted');
    renderTip(el, items);
  }

  let timer = null;
  function schedule(el) {
    clearTimeout(timer);
    timer = setTimeout(() => scan(el), CORE.DEBOUNCE_MS);
  }

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (CORE.isEditable(el)) { ignoredFor = null; schedule(el); }
  }, true);

  document.addEventListener('focusin', (e) => {
    if (CORE.isEditable(e.target)) schedule(e.target);
  }, true);

  document.addEventListener('focusout', () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 300);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  }, true);

  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  // 鼠标停在提醒条上时不要自动消失，否则点不到按钮
  document.addEventListener('mouseover', (e) => {
    if (e.target && (e.target.id === TIP_ID || (e.target.parentElement && e.target.parentElement.id === TIP_ID))) {
      clearTimeout(tipTimer);
    }
  }, true);

  readConfig().then((c) => { cfg = c; });

  // popup 改配置后立刻同步到已打开的页面，不需要刷新
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'psGuardConfig' && msg.config) {
        cfg = Object.assign({}, DEFAULT_CONFIG, msg.config);
        if (!cfg.enabled) hideTip();
      }
    });
  }
})();
