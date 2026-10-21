/**
 * ⚠️ 本文件由 scripts/build-extension.js 自动生成，请勿直接修改。
 * 来源：services/guardCore.js（哈希 2a300023ea26）
 * 改规则请改 services/ 下的源文件，然后重新运行：node scripts/build-extension.js
 */
/**
 * 输入守卫核心逻辑（与引擎一样走 UMD：Node 测试 / 浏览器扩展 / 网页版三处同源）
 * ---------------------------------------------------------------
 * 单独抽出来的原因：这部分是纯逻辑，必须能被单元测试直接调用。
 * content.js 只负责「绑定事件 + 画 UI」，规则与文本处理全部落在这里，
 * 网页版 guard.html 与浏览器扩展因此不可能走向两套行为。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.PSGuardCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // Node 环境下没有 window，行为相关函数会自动降级（测试只覆盖纯逻辑部分）
  const win = root && root.document ? root : null;

  const MAX_SCAN_CHARS = 20000;   // 超长文本跳过，避免在富文本编辑器里卡顿
  const DEBOUNCE_MS = 350;

  const LEVEL_STYLE = {
    1: { cls: 'lv1', title: '低危：公开后可能被关联' },
    2: { cls: 'lv2', title: '中危：可用于定向骚扰或社工' },
    3: { cls: 'lv3', title: '高危：可直接造成财产损失' },
    4: { cls: 'lv4', title: '极高危：一旦泄露几乎无法挽回' },
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    minLevel: 1,
    strategy: 'mask',
    disabledHosts: [],
  };

  // 密码框里输入密码是正常行为，不该报警；隐藏域没有可见输入
  const SKIP_TYPES = ['password', 'hidden', 'file', 'checkbox', 'radio', 'button', 'submit'];

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return !el.readOnly && !el.disabled;
    if (tag !== 'input') return false;
    const type = String(el.getAttribute && el.getAttribute('type') || 'text').toLowerCase();
    return SKIP_TYPES.indexOf(type) < 0 && !el.readOnly && !el.disabled;
  }

  function readValue(el) {
    if (!el) return '';
    return el.isContentEditable ? String(el.innerText || '') : String(el.value == null ? '' : el.value);
  }

  /**
   * 写回输入框并触发框架受控更新。
   * 直接赋值 el.value 对 React / Vue 无效：它们的受控组件监听的是 input 事件，
   * 且内部维护了自己的 value tracker，必须走原型上的原生 setter。
   */
  function writeValue(el, value) {
    if (!el) return;
    if (el.isContentEditable) {
      if (el.focus) el.focus();
      const sel = win && win.getSelection ? win.getSelection() : null;
      if (sel && win.document.createRange) {
        const range = win.document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        // insertText 会走浏览器的编辑管线，从而触发 React / Vue 的 onChange
        if (win.document.execCommand && win.document.execCommand('insertText', false, value)) return;
      }
      el.innerText = value;
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    if (el.dispatchEvent && win && win.Event) {
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  }

  function maskOf(item, strategy) {
    if (strategy === 'remove') return '';
    if (strategy === 'label') return '[' + (item.label || item.type || '隐私') + ']';
    // 只显示脱敏值：提醒条本身不能再泄露第二次
    if (item.masked) return item.masked;
    const raw = String(item.raw || '');
    const n = raw.length;
    if (n <= 2) return '*'.repeat(n);
    return raw.slice(0, 1) + '*'.repeat(n - 2) + raw.slice(-1);
  }

  /** 按 start/end 区间重建文本；必须从后往前替换，否则前面的下标会被长度变化带偏 */
  function buildMaskedText(text, items, strategy) {
    const src = String(text == null ? '' : text);
    const spans = (items || [])
      .filter((i) => Number(i.start) >= 0 && Number(i.end) > Number(i.start))
      .sort((a, b) => Number(b.start) - Number(a.start));
    let out = src;
    for (const it of spans) {
      const s = Number(it.start);
      const e = Number(it.end);
      if (e > out.length) continue;   // 文本已被外部改写，跳过越界区间而不是抛错
      out = out.slice(0, s) + maskOf(it, strategy) + out.slice(e);
    }
    return out;
  }

  /** 过滤出达到阈值的项，并按等级从高到低排序，保证最严重的排在最前 */
  function pickItems(items, minLevel) {
    const floor = Number(minLevel) || 1;
    return (items || [])
      .filter((i) => (Number(i.level) || 1) >= floor)
      .sort((a, b) => (Number(b.level) || 1) - (Number(a.level) || 1));
  }

  function levelClass(level) {
    const s = LEVEL_STYLE[Number(level)];
    return s ? s.cls : 'lv1';
  }

  function levelTitle(level) {
    const s = LEVEL_STYLE[Number(level)];
    return s ? s.title : LEVEL_STYLE[1].title;
  }

  return {
    MAX_SCAN_CHARS,
    DEBOUNCE_MS,
    LEVEL_STYLE,
    DEFAULT_CONFIG,
    SKIP_TYPES,
    isEditable,
    readValue,
    writeValue,
    maskOf,
    buildMaskedText,
    pickItems,
    levelClass,
    levelTitle,
  };
});
