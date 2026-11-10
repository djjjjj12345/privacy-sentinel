(function (root) {
  'use strict';

  const audiences = {
    public: '公开', followers: '仅关注者', group: '仅群成员', private: '仅私信收件人', draft: '草稿',
  };
  const observers = {
    stranger: { label: '陌生人', scopes: ['public'] },
    follower: { label: '关注者', scopes: ['public', 'followers'] },
    member: { label: '群成员', scopes: ['public', 'group'] },
    recipient: { label: '私信收件人', scopes: ['public', 'private'] },
  };
  const surfaces = { post: '图文动态', comment: '评论区', video: '短视频字幕', group: '群聊', dm: '私信' };
  const scenarios = [
    {
      title: '社团招新',
      brief: '你要宣传招新并保留活动信息。几条内容分别提到了同一联系号码的不同位置。',
      cards: [
        { id: 'intro', surface: 'post', audience: 'public', title: '社团招新公告', body: '周五 20:00 截止，体验课在创客楼一层。', subject: 'club', slot: 'first', label: '报名电话前三位', value: '138' },
        { id: 'reply', surface: 'comment', audience: 'public', title: '回复报名咨询', body: '报名表提交后会收到回执。', subject: 'club', slot: 'middle', label: '报名电话中间四位', value: '0013' },
        { id: 'clip', surface: 'video', audience: 'public', title: '招新视频的置顶字幕', body: '周末有零基础开放场，可以现场体验。', subject: 'club', slot: 'last', label: '报名电话尾四位', value: '8000' },
        { id: 'reminder', surface: 'group', audience: 'group', title: '群内答疑补充', body: '群成员可以在置顶消息查看活动安排。', subject: 'club', slot: 'last', label: '报名电话尾四位', value: '8000' },
        { id: 'other', surface: 'dm', audience: 'private', title: '另一个社团的合作回复', body: '合作材料通过报名表附件提交。', subject: 'partner', slot: 'middle', label: '合作社团电话中间四位', value: '6728' },
      ],
      rules: [{ title: '可重建联系号码', slots: ['first', 'middle', 'last'], format: (parts) => parts.join(' ') }],
    },
    {
      title: '规律打卡',
      brief: '你想分享训练进度。分散的时间、地点和频率线索可能让别人知道下次去哪找你。',
      cards: [
        { id: 'training', surface: 'post', audience: 'public', title: '本周训练打卡', body: '练完一组新的动作，今天手感不错。', subject: 'player', slot: 'place', label: '训练地点', value: '云杉运动馆东门' },
        { id: 'routine', surface: 'video', audience: 'public', title: '训练剪辑字幕', body: '附上这一周的训练动作。', subject: 'player', slot: 'frequency', label: '固定频率', value: '每周四' },
        { id: 'time', surface: 'comment', audience: 'public', title: '回复什么时候训练', body: '最近会继续按计划训练。', subject: 'player', slot: 'time', label: '固定时刻', value: '19:30' },
        { id: 'oldtime', surface: 'group', audience: 'group', title: '群里的一条时间记录', body: '大家以最终确认的通知为准。', subject: 'player', slot: 'time', label: '另一条时刻记录', value: '18:00' },
        { id: 'meeting', surface: 'dm', audience: 'private', title: '与队友约见', body: '有调整的话我会在当天通知你。', subject: 'teammate', slot: 'place', label: '队友地点', value: '南岸体能馆' },
      ],
      rules: [{ title: '可推断固定出现的地点与时段', slots: ['place', 'frequency', 'time'], format: (parts) => parts.join(' · ') }],
    },
  ];

  function initialState(scenario) {
    return Object.fromEntries(scenario.cards.map(({ id, audience }) => [id, { audience, hidden: false }]));
  }

  function evaluate(scenario, state, observer) {
    const scopes = observers[observer].scopes;
    const visible = scenario.cards.filter((card) => scopes.includes(state[card.id].audience));
    const active = visible.filter((card) => !state[card.id].hidden);
    const findings = [];
    const conflicts = [];
    for (const subject of new Set(active.map((card) => card.subject))) {
      const bySlot = new Map();
      for (const card of active.filter((item) => item.subject === subject)) {
        if (!bySlot.has(card.slot)) bySlot.set(card.slot, []);
        bySlot.get(card.slot).push(card);
      }
      for (const [slot, cards] of bySlot) {
        if (new Set(cards.map((card) => card.value)).size > 1) conflicts.push({ subject, slot, cards });
      }
      for (const rule of scenario.rules) {
        const sources = rule.slots.map((slot) => bySlot.get(slot) || []);
        if (!sources.every((cards) => cards.length && cards.every((card) => card.value === cards[0].value))) continue;
        findings.push({ title: rule.title, value: rule.format(sources.map((cards) => cards[0].value)), sources });
      }
    }
    return { visible, active, findings, conflicts };
  }

  // 按修改数从少到多复算。冲突线索移除后可能产生新推断，因此每个方案都重跑整个视角。
  function suggest(scenario, state, observer) {
    const current = evaluate(scenario, state, observer);
    if (!current.findings.length) return [];
    const candidates = current.active.map((card) => card.id);
    function search(count, next, selected) {
      if (count === 0) {
        const changed = { ...state };
        for (const id of selected) changed[id] = { ...state[id], hidden: true };
        return evaluate(scenario, changed, observer).findings.length === 0 ? selected : null;
      }
      for (let i = next; i <= candidates.length - count; i++) {
        const result = search(count - 1, i + 1, [...selected, candidates[i]]);
        if (result) return result;
      }
      return null;
    }
    for (let count = 1; count <= candidates.length; count++) {
      const solution = search(count, 0, []);
      if (solution) return solution;
    }
    return [];
  }

  const api = { audiences, observers, surfaces, scenarios, initialState, evaluate, suggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PSRehearsal = api;
})(globalThis);
