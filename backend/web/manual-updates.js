import { RequestStore } from './request-store.js';
import { RequestJournal } from './request-journal.js';
import { updateEventsView, renderUpdatePreview } from './manual-update-events.js';
export function attachManualUpdates({
  api,
  run,
  getState,
  getSelected,
  refresh,
  openReviews,
  showJob,
  textReader,
  openResearchEntry,
}) {
  const journal = new RequestJournal(api, new RequestStore()),
    dialog = document.createElement('dialog');
  dialog.id = 'manual-update-dialog';
  dialog.setAttribute('aria-label', '手动更新与复核');
  dialog.innerHTML = `<header><strong>手动更新与复核</strong><button type="button" data-close>返回画布</button></header>
    <p role="status" data-feedback></p><div data-recovery></div>
    <form><label>本次研究的公司或主题<input name="scopeLabel" maxlength="200" required></label>
    <label>材料方式<select name="mode"><option value="text">向已登记来源补充新原文</option><option value="existing">使用已保存材料版本</option></select></label>
    <div data-new><label>已登记且有权使用的来源<select name="sourceId"><option value="">请选择来源</option></select></label>
    <label>本次取得的原文<textarea name="text" maxlength="1000000" rows="5"></textarea></label>
    <label>发布时间（未知可留空）<input name="publishedAt" type="datetime-local"></label>
    <label>原文覆盖<select name="coverage"><option value="unknown">范围未知</option><option value="excerpt">片段</option><option value="full">全文</option></select></label></div>
    <label data-existing hidden>已保存的材料版本<select name="sourceVersionId"><option value="">请选择材料版本</option></select></label>
    <fieldset data-targets><legend>仅匹配明确选择的主张与推导</legend></fieldset>
    <button type="submit">预览更新范围与用量</button></form>
    <section data-preview></section><fieldset data-confirm disabled><button type="button" data-submit>确认范围，保存并分析</button></fieldset>
    <h2>已保存的更新</h2><button type="button" data-reload>刷新更新记录</button><section data-events></section>`;
  document.body.append(dialog);
  const $ = (s) => dialog.querySelector(s),
    form = $('form'),
    fields = form.elements;
  let projectId = null,
    preview = null,
    requestInput = null,
    retrievedAt = null,
    sequence = 0;
  const active = (id) => dialog.open && projectId === id && getState()?.project.id === id;
  const feedback = (text, error = false) => {
    $('[data-feedback]').textContent = text;
    $('[data-feedback]').dataset.error = String(error);
  };
  const work = (fn) =>
    run(async () => {
      try {
        await fn();
      } catch (e) {
        if (dialog.open) feedback(e.message, true);
      }
    });
  const el = (tag, text, parent) => {
    const n = document.createElement(tag);
    n.textContent = text;
    parent.append(n);
    return n;
  };
  const key = (id) => `forkwise-update-draft:${id}`;
  const names = [
    'scopeLabel',
    'mode',
    'sourceId',
    'text',
    'publishedAt',
    'coverage',
    'sourceVersionId',
  ];
  const draft = () => ({
    ...Object.fromEntries(names.map((n) => [n, fields[n].value])),
    targetIds: [...$('[data-targets]').querySelectorAll('input:checked')].map((e) => e.value),
    retrievedAt,
  });
  function save() {
    try {
      localStorage.setItem(key(projectId), JSON.stringify(draft()));
    } catch {
      feedback('草稿存储不足，当前输入仍保留在页面；保存请求前还会校验恢复存储。', true);
    }
  }
  function invalidate() {
    preview = null;
    requestInput = null;
    sequence++;
    $('[data-preview]').replaceChildren();
    $('[data-confirm]').disabled = true;
  }
  function mode() {
    $('[data-new]').hidden = fields.mode.value !== 'text';
    $('[data-existing]').hidden = fields.mode.value !== 'existing';
  }
  form.oninput = (event) => {
    if (event.target.name === 'text') retrievedAt = new Date().toISOString();
    invalidate();
    mode();
    save();
  };
  form.onchange = () => {
    invalidate();
    mode();
    save();
  };
  function restore() {
    form.reset();
    let d = null;
    try {
      d = JSON.parse(localStorage.getItem(key(projectId)) ?? 'null');
    } catch {
      feedback('原草稿无法读取，未删除。', true);
    }
    const state = getState(),
      sourceSelect = fields.sourceId,
      materialSelect = fields.sourceVersionId;
    sourceSelect.replaceChildren(new Option('请选择来源', ''));
    materialSelect.replaceChildren(new Option('请选择材料版本', ''));
    for (const e of state.objects) {
      if (e.kind === 'source')
        sourceSelect.add(
          new Option(
            `${e.data.title} · ${e.data.rights === 'public' ? '公开' : e.data.rights === 'authorized' ? '本人有权访问' : '限制导出'}`,
            e.id,
          ),
        );
      if (
        e.kind === 'source_version' &&
        e.data.parseStatus === 'complete' &&
        e.data.textLength > 0
      ) {
        const source = state.objects.find((s) => s.id === e.data.sourceId);
        materialSelect.add(
          new Option(`${source?.data.title ?? e.id} · ${e.data.retrievedAt}`, e.id),
        );
      }
    }
    for (const name of names) if (typeof d?.[name] === 'string') fields[name].value = d[name];
    retrievedAt = d?.retrievedAt ?? new Date().toISOString();
    const box = $('[data-targets]');
    box.replaceChildren();
    el('legend', '仅匹配明确选择的主张与推导', box);
    const ids = d?.targetIds ?? [getSelected()];
    for (const e of state.objects.filter((e) => ['statement', 'inference'].includes(e.kind))) {
      const label = el('label', '', box),
        check = document.createElement('input');
      check.type = 'checkbox';
      check.value = e.id;
      check.checked = ids.includes(e.id);
      label.append(
        check,
        `${e.kind === 'statement' ? '主张' : '推导'}：${e.data.text ?? e.data.reason}`,
      );
    }
    mode();
    invalidate();
  }
  function input() {
    const d = draft();
    if (!d.scopeLabel.trim()) throw new Error('请说明本次研究的公司或主题');
    if (!d.targetIds.length) throw new Error('请明确选择至少一项主张或推导');
    if (d.mode === 'text' && (!d.sourceId || !d.text.trim()))
      throw new Error('请选择已登记来源并填写原文；来源可先通过材料入口登记');
    if (d.mode === 'existing' && !d.sourceVersionId) throw new Error('请选择已保存的材料版本');
    return {
      scopeLabel: d.scopeLabel,
      material:
        d.mode === 'text'
          ? {
              kind: 'text',
              sourceId: d.sourceId,
              text: d.text,
              publishedAt: d.publishedAt ? new Date(d.publishedAt).toISOString() : null,
              retrievedAt: d.retrievedAt,
              coverage: d.coverage,
            }
          : { kind: 'existing', sourceVersionId: d.sourceVersionId },
      targetIds: d.targetIds,
    };
  }
  const events = updateEventsView({
    api,
    container: $('[data-events]'),
    active,
    project: () => projectId,
    run: work,
    close: () => dialog.close(),
    openReviews,
    showJob,
    textReader,
  });
  async function recovery() {
    const id = projectId,
      record = await journal.get(id);
    if (!active(id)) return;
    const box = $('[data-recovery]');
    box.replaceChildren();
    if (!record || record.state === 'completed') return;
    el(
      'p',
      `${record.label}：${record.state === 'rejected' ? '服务端已拒绝，草稿保留。' : '结果尚未确认，须先恢复原请求。'} ${record.error ?? ''}`,
      box,
    );
    const own = record.steps.every((s) => s.endpoint === '/manual-updates');
    const b = el('button', own ? '恢复原更新请求' : '处理上次研究请求', box);
    b.type = 'button';
    b.dataset.recover = 'true';
    b.onclick = () =>
      work(async () => {
        if (!own) {
          dialog.close();
          await openResearchEntry();
          return;
        }
        await finished(await journal.resume(id, record.id));
      });
    if (record.state === 'rejected') {
      const discard = el('button', '保留草稿，重新预览', box);
      discard.type = 'button';
      discard.dataset.discard = 'true';
      discard.onclick = () =>
        work(async () => {
          await journal.discard(id);
          if (active(id)) {
            invalidate();
            await recovery();
            feedback('旧请求已结束，请按当前版本重新预览。');
          }
        });
    }
  }
  async function finished(record) {
    const id = record.projectId;
    if (!active(id)) return;
    invalidate();
    await refresh(true);
    if (!active(id)) return;
    feedback(record.results.at(-1).message);
    await recovery();
    await events.load();
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    work(async () => {
      const id = projectId,
        body = input(),
        ticket = ++sequence;
      const p = await api(`/projects/${id}/manual-updates/preview`, 'POST', body);
      if (!active(id) || ticket !== sequence) return;
      preview = p;
      requestInput = body;
      renderUpdatePreview(p, $('[data-preview]'));
      $('[data-preview]').scrollIntoView({ block: 'nearest' });
      $('[data-confirm]').disabled = false;
      feedback('预览不会保存材料或调用模型；确认后仅分析上述范围。');
    });
  };
  $('[data-submit]').onclick = () =>
    work(async () => {
      if (!preview || !requestInput) throw new Error('请先预览本次更新');
      const id = projectId;
      try {
        const record = await journal.start(id, {
          label: '保存材料并分析更新',
          meta: { kind: 'update' },
          steps: [
            {
              endpoint: '/manual-updates',
              body: { ...requestInput, previewHash: preview.previewHash },
            },
          ],
        });
        await finished(await journal.resume(id, record.id));
      } catch (e) {
        if (active(id)) {
          await recovery();
          throw e;
        }
      }
    });
  $('[data-close]').onclick = () => dialog.close();
  $('[data-reload]').onclick = () => work(() => events.load());
  document.querySelector('#open-manual-updates').onclick = () =>
    work(async () => {
      projectId = getState()?.project.id;
      if (!projectId) throw new Error('请先选择项目');
      restore();
      feedback('明确本次材料与目标，再预览新增范围；实际研究判断保持。');
      dialog.showModal();
      await recovery();
      await events.load();
    });
  return {
    onStateChange() {
      if (dialog.open && getState()?.project.id !== projectId) {
        sequence++;
        dialog.close();
      }
    },
  };
}
