(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const input = el('original');
  const outgoing = el('outgoing');
  const send = el('send');
  const status = el('status');
  let review = null;

  function invalidate() {
    review = null;
    send.disabled = true;
    outgoing.textContent = '生成预览后在这里检查。';
    status.textContent = '';
    el('result').hidden = true;
    el('masked').textContent = '';
  }

  function prepare(source) {
    const local = window.PSLocal.detect(source);
    const segments = [];
    let text = '';
    let cursor = 0;
    function keep(end) {
      const value = source.slice(cursor, end);
      segments.push({ value, start: cursor });
      text += value;
    }
    for (const item of local) {
      keep(item.start);
      text += `【已隐藏：${item.label}】`;
      cursor = item.end;
    }
    keep(source.length);
    return { source, local, text, segments };
  }

  function locate(segmentList, raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let start = null;
    for (const segment of segmentList) {
      const offset = segment.value.indexOf(raw);
      if (offset < 0) continue;
      if (start !== null || segment.value.indexOf(raw, offset + 1) >= 0) return null;
      start = segment.start + offset;
    }
    return start === null ? null : { start, end: start + raw.length };
  }

  function render(snapshot, items = []) {
    const additional = [];
    let skipped = 0;
    const aiItems = items.filter((item) => item?.engine === 'ai');
    // 优先处理完整片段，模型的坐标和标签由本机重新校验。
    aiItems.sort((a, b) => (b.raw?.length || 0) - (a.raw?.length || 0));
    for (const item of aiItems) {
      const span = locate(snapshot.segments, item.raw);
      const label = Object.hasOwn(window.PSSchema.TYPE_LABEL, item.type) && window.PSSchema.TYPE_LABEL[item.type];
      if (!span || !label || additional.some((hit) => hit.start < span.end && hit.end > span.start)) {
        skipped++;
        continue;
      }
      additional.push({ ...span, label });
    }
    el('masked').textContent = window.PSGuardCore.buildMaskedText(snapshot.source, [...snapshot.local, ...additional], 'label');
    el('result').hidden = false;
    return { added: additional.length, skipped };
  }

  input.addEventListener('input', invalidate);
  el('example').addEventListener('click', () => {
    invalidate();
    input.value = '请把值班表交给周星禾。她的收件地址是云杉街道春雨路17号2栋502室。\n联系电话：138（0013）8000。\n退款银行卡：4111.1111.1111.1111。';
  });
  el('inspect').addEventListener('click', () => {
    invalidate();
    if (!input.value.trim() || input.value.length > 12000) {
      status.textContent = '请填写 1 至 12000 字的文本。';
      return;
    }
    if (!window.PSLocal || !window.PSGuardCore || !window.PSSchema) {
      status.textContent = '本地检测引擎加载失败，请刷新页面。';
      return;
    }
    review = prepare(input.value);
    outgoing.textContent = review.text;
    render(review);
    if (review.text.length > 12000) {
      status.textContent = '脱敏预览超过 AI 接口长度上限。请缩短输入并重新预览。';
      return;
    }
    send.disabled = false;
    status.textContent = `本机已替换 ${review.local.length} 处，等待你确认预览。`;
  });

  send.addEventListener('click', async () => {
    const snapshot = review;
    if (send.disabled || !snapshot || input.value !== snapshot.source) return;
    send.disabled = true;
    status.textContent = '正在复检已确认的文本…';
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'text', mode: 'full', text: snapshot.text }),
      });
      const data = await response.json();
      if (review !== snapshot || input.value !== snapshot.source) return;
      if (!response.ok || !data.success || !Array.isArray(data.items)) throw new Error('复检失败');
      if (data.source !== 'hybrid' && data.source !== 'ai') {
        status.textContent = 'AI 复检暂不可用，已保留本机脱敏结果。';
        return;
      }
      const { added, skipped } = render(snapshot, data.items);
      status.textContent = `本机已替换 ${snapshot.local.length} 处，AI 新增 ${added} 处，${skipped} 条因无法唯一定位或与已有标注重叠而跳过。`;
    } catch {
      if (review === snapshot) status.textContent = 'AI 复检暂不可用，已保留本机脱敏结果。';
    } finally {
      if (review === snapshot) send.disabled = false;
    }
  });
})();
