export function updateEventsView({
  api,
  container,
  active,
  project,
  run,
  close,
  openReviews,
  showJob,
  textReader,
}) {
  const el = (tag, text, parent) => {
    const e = document.createElement(tag);
    e.textContent = text;
    parent.append(e);
    return e;
  };
  const button = (label, parent, fn) => {
    const b = el('button', label, parent);
    b.type = 'button';
    b.onclick = () => run(fn);
    return b;
  };
  const states = {
    queued: '等待处理',
    running: '处理中',
    succeeded: '分析完成',
    failed: '失败，可从任务重试',
    partial: '部分完成',
    interrupted: '中断，可从任务重试',
    cancelled: '已取消',
  };
  let sequence = 0;
  async function tasks(key, box, cursor) {
    const id = project(),
      ticket = sequence;
    const page = await api(
      `/projects/${id}/manual-updates/${key}/tasks?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`,
    );
    if (!active(id) || ticket !== sequence) return;
    if (!cursor) box.replaceChildren();
    else box.querySelector('[data-more]')?.remove();
    for (const item of page.items) {
      const row = el('section', '', box);
      row.className = 'update-task';
      el(
        'p',
        `${item.scopeLabel} · ${states[item.state] ?? item.state} · 匹配 ${item.targetIds.length} 项 · 建议 ${item.proposalCount} 条`,
        row,
      );
      el('small', `本批创建于 ${item.createdAt}`, row);
      if (item.error) el('p', item.error, row);
      button('查看任务与结果', row, async () => {
        const job = await api(`/projects/${id}/jobs/${item.id}`);
        if (active(id)) {
          close();
          showJob(job);
        }
      });
      button('阅读此次材料', row, async () => {
        if (active(id)) await textReader.open(item.sourceVersionId);
      });
      if (item.proposalCount)
        button('复核本批建议', row, async () => {
          if (active(id)) {
            close();
            await openReviews({ jobId: item.id });
          }
        });
    }
    if (page.nextCursor)
      button('更多分析任务', box, () => tasks(key, box, page.nextCursor)).dataset.more = 'true';
  }
  async function load(cursor) {
    const id = project(),
      ticket = ++sequence;
    const page = await api(
      `/projects/${id}/manual-updates?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`,
    );
    if (!active(id) || ticket !== sequence) return;
    if (!cursor) container.replaceChildren();
    else container.querySelector('[data-more-events]')?.remove();
    if (!page.items.length && !cursor) el('p', '尚无手动更新事件。', container);
    for (const event of page.items) {
      const row = el('section', '', container);
      row.className = 'update-event';
      row.dataset.event = event.eventKey;
      el('h3', event.sourceTitle, row);
      el(
        'p',
        `${event.taskCount} 批分析 · ${event.proposalCount} 条建议 · ${event.activeCount} 批处理中 · ${event.blockedCount} 批待处理`,
        row,
      );
      el('small', `${event.latestAt} · 同一来源内容版本共用此记录`, row);
      const box = el('div', '', row);
      button('展开本次更新', row, () => tasks(event.eventKey, box));
    }
    if (page.nextCursor)
      button('更多更新事件', container, () => load(page.nextCursor)).dataset.moreEvents = 'true';
  }
  return { load };
}

export function renderUpdatePreview(p, box) {
  const el = (tag, text, parent) => {
    const n = document.createElement(tag);
    n.textContent = text;
    parent.append(n);
    return n;
  };
  box.replaceChildren();
  el('h2', '请核对本次更新范围', box);
  el(
    'p',
    `${p.sourceTitle} · ${p.newMaterial ? '将保存新材料版本' : '复用已有材料版本'} · 本次 ${p.estimate.materialCharacters} 个原文字符`,
    box,
  );
  el(
    'p',
    `发布时间：${p.publishedAt ?? '未知'}；取得时间：${p.retrievedAt}。复用材料保留原时间。`,
    box,
  );
  const list = el('ul', '', box);
  for (const t of p.targets)
    el('li', `${t.kind === 'statement' ? '主张' : '推导'}：${t.text}`, list);
  if (p.context.length) {
    el('h3', '一并提供的直接前提与结论', box);
    const context = el('ul', '', box);
    for (const t of p.context) el('li', t.text, context);
  }
  el(
    'p',
    `新增分析 ${p.newTargetIds.length} 项，共 ${p.estimate.newTaskCount} 个任务；复用 ${p.existingJobIds.length} 个已有任务。预计金额：未知。`,
    box,
  );
  el('p', `图中另有 ${p.downstream.count} 项下游对象可能需要查看，本次不会自动分析或修改。`, box);
  if (p.downstream.items.length) {
    const d = el('details', '', box);
    el('summary', p.downstream.truncated ? '查看前 100 项下游对象' : '查看下游对象', d);
    for (const t of p.downstream.items) el('p', t.text, d);
  }
  for (const gap of p.gaps) el('p', gap, box);
}
