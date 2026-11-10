(function () {
  'use strict';

  const { scenarios, audiences, observers, surfaces, initialState, evaluate, suggest } = window.PSRehearsal;
  const el = (id) => document.getElementById(id);
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function options(select, values) {
    for (const [value, label] of values) {
      const option = node('option', label);
      option.value = value;
      select.append(option);
    }
  }

  const scenarioPicker = el('scenario');
  const observerPicker = el('observer');
  options(scenarioPicker, scenarios.map((item, index) => [String(index), item.title]));
  options(observerPicker, Object.entries(observers).map(([id, item]) => [id, item.label]));

  let scenario, baseline, state;
  let edited = new Set();
  let plan = [];

  function renderTimeline(result) {
    const container = el('timeline');
    container.replaceChildren();
    el('visible-count').textContent = `可见 ${result.visible.length} 条内容 · ${result.active.length} 条线索`;
    if (!result.visible.length) container.append(node('p', '这个观察者看不到任何发布内容。', 'muted'));
    for (const card of result.visible) {
      const entry = node('article', undefined, 'entry');
      entry.id = `seen-${card.id}`;
      entry.dataset.surface = card.surface;
      entry.append(node('span', `${surfaces[card.surface]} · ${audiences[state[card.id].audience]}`, 'badge'),
        node('h3', card.title), node('p', card.body));
      const clue = state[card.id].hidden ? '发布者已隐藏这一条线索' : `${card.label}：${card.value}`;
      entry.append(node('p', clue, 'clue'));
      container.append(entry);
    }
  }

  function renderFindings(result) {
    const container = el('findings');
    container.replaceChildren();
    if (!result.findings.length) container.append(node('p', '在这个视角下，当前没有凑齐可推断项。', 'muted'));
    for (const finding of result.findings) {
      const block = node('article', undefined, 'finding');
      block.append(node('h3', finding.title), node('p', finding.value, 'finding-value'));
      const path = node('ol', undefined, 'path');
      for (const sources of finding.sources) {
        const step = node('li');
        sources.forEach((source, index) => {
          if (index > 0) step.append(' 或 ');
          const link = node('a', `${surfaces[source.surface]} · ${source.label}`);
          link.href = `#seen-${source.id}`;
          step.append(link);
        });
        path.append(step);
      }
      block.append(path);
      container.append(block);
    }
    for (const conflict of result.conflicts) {
      const sources = conflict.cards.map((card) => `${surfaces[card.surface]} ${card.value}`).join(' / ');
      container.append(node('p', `线索冲突，暂不采信这一项：${sources}`, 'finding'));
    }
  }

  function refresh(message = '') {
    const observer = observerPicker.value;
    const result = evaluate(scenario, state, observer);
    el('before-count').textContent = evaluate(scenario, baseline, observer).findings.length;
    el('after-count').textContent = result.findings.length;
    renderTimeline(result);
    renderFindings(result);
    plan = suggest(scenario, state, observer);
    el('repair').disabled = plan.length === 0;
    el('repair-note').textContent = message || (plan.length
      ? `遮挡 ${plan.length} 条线索就能阻断当前推断，发布正文全部保留。此方案针对当前观察者。`
      : '切换观察者，看看其他人是否仍能拼出信息。');
  }

  function renderEditor() {
    const container = el('editor');
    container.replaceChildren();
    for (const card of scenario.cards) {
      const section = node('article', undefined, edited.has(card.id) ? 'edit repaired' : 'edit');
      section.append(node('span', surfaces[card.surface], 'badge'), node('h3', card.title));
      const scopeLabel = node('label', '可见范围');
      const scope = node('select');
      scope.setAttribute('aria-label', `${card.title}的可见范围`);
      options(scope, Object.entries(audiences));
      scope.value = state[card.id].audience;
      scope.addEventListener('change', () => { state[card.id].audience = scope.value; refresh(); });
      scopeLabel.append(scope);
      const hidden = node('input');
      hidden.type = 'checkbox';
      hidden.checked = state[card.id].hidden;
      hidden.addEventListener('change', () => {
        state[card.id].hidden = hidden.checked;
        edited.delete(card.id);
        section.classList.remove('repaired');
        refresh();
      });
      const hideLabel = node('label');
      hideLabel.append(hidden, `隐藏${card.label}`);
      section.append(scopeLabel, hideLabel);
      container.append(section);
    }
  }

  function reset() {
    scenario = scenarios[Number(scenarioPicker.value)];
    baseline = initialState(scenario);
    state = initialState(scenario);
    edited = new Set();
    el('brief').textContent = scenario.brief;
    renderEditor();
    refresh();
  }

  scenarioPicker.addEventListener('change', reset);
  observerPicker.addEventListener('change', () => refresh());
  el('reset').addEventListener('click', reset);
  el('repair').addEventListener('click', () => {
    if (!plan.length) return;
    const repaired = plan.length;
    for (const id of plan) {
      state[id].hidden = true;
      edited.add(id);
    }
    renderEditor();
    refresh(`已遮挡 ${repaired} 条线索，发布正文全部保留。可以切换视角继续验证。`);
  });
  reset();

  if (location.protocol === 'file:') el('home').hidden = true;
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    const button = el('install');
    button.hidden = false;
    button.onclick = async () => {
      button.hidden = true;
      await event.prompt();
    };
  });
})();
