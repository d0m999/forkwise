const relations = {
  supports: '支持依据',
  opposes: '相反依据',
  qualifies: '限定依据',
  background: '背景资料',
  unjudged: '作用待判断',
  insufficient: '证据不足',
};
const aspects = {
  reported_fact: '已披露事实核对',
  current_basis: '预测的当前依据',
  inference_basis: '推导根据',
};
const statuses = {
  current: '对应当前内容',
  stale: '对应旧内容或前提',
  withdrawn: '所属研究已撤销',
  unbound: '缺少可核对的版本范围',
};

export function researchSummary(state, overview, id) {
  if (overview?.projectId !== state?.project.id || overview?.revision !== state?.project.revision)
    return null;
  return overview.targets.find((row) => row.target.id === id) ?? null;
}
export function researchLabel(summary) {
  if (!summary) return { status: '查证摘要待更新', explanation: '请读取对应当前内容的结果' };
  const { evidence, checks, latest } = summary,
    parts = [];
  if (evidence.candidate) parts.push(`候选依据 ${evidence.candidate}`);
  if (evidence.adopted) parts.push(`已采用依据 ${evidence.adopted}`);
  if (latest?.relation === 'insufficient') parts.push('最近核对证据不足');
  if (!parts.length && checks.current) parts.push('有核对记录');
  if (!parts.length && (checks.stale || evidence.stale)) parts.push('旧结果需复核');
  if (!parts.length && (checks.unbound || evidence.unbound)) parts.push('结果范围待核对');
  if (!parts.length && checks.withdrawn) parts.push('研究结果已撤销');
  if (!parts.length) parts.push('尚无查证记录');
  return {
    status: parts.join(' · '),
    explanation: latest
      ? `${aspects[latest.aspect] ?? '本次核对'}：${latest.explanationPreview}`
      : '查证依据和个人立场分别记录',
  };
}

export function attachObjectResults({
  api,
  getState,
  getSelected,
  getOverview,
  write,
  run,
  refresh,
  readCitation,
  showJob,
}) {
  const box = document.querySelector('#object-results');
  let key = '',
    generation = 0;
  const paragraph = (text, tag = 'p') => {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  };
  function render(force = false) {
    const state = getState(),
      target = state?.objects.find((e) => e.id === getSelected());
    const summary = target && researchSummary(state, getOverview(), target.id);
    const nextKey = JSON.stringify([
      state?.project.id,
      state?.project.revision,
      target?.id,
      summary,
    ]);
    if (!force && key === nextKey) return;
    key = nextKey;
    const currentGeneration = ++generation;
    const active = () =>
      generation === currentGeneration &&
      getState()?.project.id === state?.project.id &&
      getState()?.project.revision === state?.project.revision &&
      getSelected() === target?.id;
    box.replaceChildren();
    box.hidden = !target || !['statement', 'inference'].includes(target.kind);
    if (box.hidden) return;
    const label = researchLabel(summary),
      heading = paragraph('查证依据与记录', 'h3');
    box.append(
      heading,
      paragraph(label.status),
      paragraph('依据作用、验证节点和个人立场分别记录；条数不代表独立来源数量。'),
    );
    const loading = paragraph('正在读取此对象的查证记录…'),
      evidenceBox = document.createElement('div'),
      checksBox = document.createElement('div');
    const reload = document.createElement('button');
    reload.textContent = '重新读取查证结果';
    reload.onclick = () =>
      run(async () => {
        await refresh(true);
        render(true);
      });
    box.append(loading, evidenceBox, checksBox, reload);
    function citation(parent, value) {
      parent.append(
        paragraph(
          value.kind === 'image' ? '原图区域引用' : value.quote || '原文不可查看',
          'blockquote',
        ),
      );
      const button = document.createElement('button');
      button.textContent = '定位这条依据';
      button.onclick = () => {
        if (active()) void readCitation(value);
      };
      parent.append(button);
    }
    async function load(cursor) {
      try {
        const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const result = await api(
          `/projects/${state.project.id}/objects/${target.id}/research-results${suffix}`,
        );
        if (!active()) return;
        if (result.revision !== state.project.revision) {
          loading.textContent = '后台有更新，请重新读取并核对。当前编辑草稿保持。';
          evidenceBox.replaceChildren();
          checksBox.replaceChildren();
          return;
        }
        loading.textContent = '';
        if (!cursor) {
          evidenceBox.replaceChildren(paragraph('依据关联', 'h4'));
          if (!result.evidenceLinks.length)
            evidenceBox.append(paragraph('尚无依据关联；下方保留已执行的核对和缺口。'));
          for (const entry of result.evidenceLinks) {
            const link = state.objects.find((e) => e.id === entry.id),
              evidence = state.objects.find((e) => e.id === link?.data.evidenceId);
            if (!link) continue;
            const section = document.createElement('details');
            section.dataset.evidenceLink = link.id;
            section.append(
              paragraph(
                `${relations[link.data.relation]} · ${link.data.participation === 'adopted' ? '本人已采用' : '候选待审阅'} · ${statuses[entry.applicability]}`,
                'summary',
              ),
            );
            section.append(
              paragraph(
                `${link.data.origin === 'ai' ? 'AI 提出' : '本人记录'}：${link.data.explanation}`,
              ),
            );
            if (evidence?.data.citation) citation(section, evidence.data.citation);
            if (entry.applicability === 'current' && link.data.participation === 'candidate') {
              const adopt = document.createElement('button');
              adopt.textContent = '采用这条依据';
              adopt.onclick = () => {
                if (active()) run(() => write([{ op: 'evidence.adopt', id: link.id }]));
              };
              section.append(adopt);
            }
            evidenceBox.append(section);
          }
          checksBox.replaceChildren(paragraph('逐次核对记录', 'h4'));
          if (!result.checks.length) checksBox.append(paragraph('尚无已完成的核对记录。'));
        }
        checksBox.querySelector('[data-next-results]')?.remove();
        for (const entry of result.checks) {
          const section = document.createElement('details');
          section.dataset.resultJob = entry.jobId;
          section.open = entry.applicability === 'current';
          section.append(
            paragraph(
              `${aspects[entry.check.aspect] ?? '本次核对'} · ${relations[entry.check.relation]} · ${statuses[entry.applicability]}`,
              'summary',
            ),
          );
          section.append(paragraph(entry.finishedAt), paragraph(entry.check.explanation));
          const coverage = entry.coverage;
          section.append(
            paragraph(
              `模型：${coverage.modelCalled === null ? '未记录' : coverage.modelCalled ? '已调用' : '未调用'}；${coverage.mode === 'retrieved_passages' ? '仅所选检索片段' : coverage.mode === 'selected_materials' ? '所选材料' : '材料范围见原任务'}。${coverage.networkQueries.length ? `记录检索 ${coverage.networkQueries.length} 次` : '本核对任务未记录联网搜索'}。`,
            ),
          );
          for (const gap of [...entry.check.gaps, ...entry.taskGaps])
            section.append(paragraph(`缺口：${gap}`));
          for (const value of entry.check.citations) citation(section, value);
          const task = document.createElement('button');
          task.textContent = '查看此次任务与取材范围';
          task.onclick = () =>
            run(async () => {
              const job = await api(`/projects/${state.project.id}/jobs/${entry.jobId}`);
              if (active()) showJob(job);
            });
          section.append(task);
          checksBox.append(section);
        }
        if (result.nextCursor) {
          const next = document.createElement('button');
          next.dataset.nextResults = '';
          next.textContent = '读取更早的核对记录';
          next.onclick = async () => {
            next.disabled = true;
            await load(result.nextCursor);
            if (next.isConnected) next.disabled = false;
          };
          checksBox.append(next);
        }
      } catch (error) {
        if (active()) loading.textContent = `查证记录读取失败：${error.message}。可重新读取。`;
      }
    }
    void load();
  }
  return {
    render,
    open() {
      render();
      box.scrollIntoView({ block: 'start' });
    },
  };
}
