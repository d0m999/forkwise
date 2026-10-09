import { attachManualUpdates } from './manual-updates.js';
import { attachImpactReviews } from './impact-reviews.js';
import { CanvasRecoveryStore, attachCanvasRecovery } from './canvas-recovery.js';
import { DraftStore } from './drafts.js';
import { attachCanvas } from './canvas-bridge.js';
import { client, applyChangeSet, applySync } from './api-client.js';
import { expectedVersions } from './operation-versions.js';
import { attachMaintenance } from './maintenance.js';
import { attachMaterials } from './materials.js';
import { attachResearch } from './research.js';
import { attachResearchEntry } from './research-entry.js';
import { attachConditions } from './conditions.js';
import { attachVerification } from './verification.js';
import { attachPrototypeMigration } from './prototype-migration.js';
import { attachTextReader } from './text-reader.js';
import { attachObjectResults } from './research-results.js';
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
if (params.has('token')) {
  sessionStorage.setItem('forkwise-token', params.get('token'));
  history.replaceState(null, '', location.pathname);
}
const api = client(sessionStorage.getItem('forkwise-token') ?? '');
let state = null,
  selected = null,
  layout = { version: 0, data: { positions: {}, drawings: [] } },
  busy = false;
let actionHistory = null;
let researchOverview = null,
  researchSequence = 0,
  objectResults = null,
  impactReviews = null,
  manualUpdates = null;
let reasonDraft = null,
  impactDraft = null,
  showJob = () => {},
  canvas = null,
  verification = null,
  conditions = null,
  researchEntry = null;
const drafts = new DraftStore();
const uid = () => crypto.randomUUID();
const message = (text, error = false) => {
  $('#notice').textContent = text;
  $('#notice').dataset.error = String(error);
};
const current = () => state?.objects.find((e) => e.id === selected);
const route = (suffix) => `/projects/${state.project.id}${suffix}`;
let writeTail = Promise.resolve(),
  blocking = 0;
function lockControls() {
  document
    .querySelectorAll('button,input,select,textarea')
    .forEach((control) => (control.disabled = blocking > 0));
  $('#native-canvas').dataset.busy = String(blocking > 0);
  if (!blocking) $('#edit').elements.scope.disabled = current()?.kind !== 'statement';
}
function exclusive(fn, silent = false) {
  if (!silent) {
    blocking++;
    lockControls();
  }
  const result = writeTail.then(async () => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
      if (!silent) {
        blocking--;
        lockControls();
      }
    }
  });
  writeTail = result.catch(() => {});
  return result;
}
async function run(fn) {
  return exclusive(async () => {
    try {
      await fn();
    } catch (error) {
      message(error.message, true);
      if (error.code?.includes('CONFLICT')) await refresh(true);
    }
  });
}
async function projects(select) {
  const list = await api('/projects');
  const options = $('#project');
  options.replaceChildren();
  for (const p of list) {
    const option = new Option(p.name, p.id);
    options.add(option);
  }
  if (select) options.value = select;
  if (options.value) {
    const workspace = await api(`/projects/${options.value}/workspace`);
    state = workspace.state;
    selected = null;
    layout = workspace.layout;
    actionHistory = workspace.history;
    render();
    await jobs();
  } else {
    state = null;
    actionHistory = null;
    selected = null;
    layout = { version: 0, data: { positions: {}, drawings: [] } };
    canvas?.publish(true);
    $('#object-list').replaceChildren();
    $('#edit').hidden = true;
    $('#revision').textContent = '';
    $('#conditions').replaceChildren();
    $('#verification-node').hidden = true;
    researchOverview = null;
    objectResults?.render();
    $('#jobs').replaceChildren();
    await researchEntry?.update([]);
    impactReviews?.onStateChange();
    manualUpdates?.onStateChange();
  }
  $('#connection').textContent = '已连接本机后端';
}
async function refresh(preserveDraft = false) {
  if (!state) return;
  const form = $('#edit');
  const draft =
    preserveDraft && !form.hidden
      ? {
          text: form.elements.text.value,
          stance: form.elements.stance.value,
          reason: form.elements.reason.value,
          scope: form.elements.scope.value,
          choices: [...document.querySelectorAll('#inference-choices input:checked')].map(
            (x) => x.value,
          ),
        }
      : null;
  const workspace = await api(route('/workspace'));
  state = workspace.state;
  layout = workspace.layout;
  actionHistory = workspace.history;
  render();
  if (draft !== null && !form.hidden) {
    for (const name of ['text', 'stance', 'reason', 'scope'])
      form.elements[name].value = draft[name];
    $('#inference-choices').hidden = draft.scope !== 'selected';
    document.querySelectorAll('#inference-choices input').forEach((x) => {
      x.checked = draft.choices.includes(x.value);
    });
    message('已重新读取，保留了正文、立场理由和作用范围草稿。请核对后重试。');
  }
  await jobs();
}
async function write(commands, options = {}) {
  if (!state) throw new Error('请先创建研究项目');
  if (sessionStorage.getItem('forkwise-pending'))
    throw new Error('上次写入结果尚未确认，请先恢复上次操作');
  const expected = options.expected ?? expectedVersions(state.objects, commands);
  for (const c of commands)
    if (
      [
        'statement.edit',
        'statement.derive',
        'inference.edit',
        'impact.adopt',
        'stance.set',
      ].includes(c.op)
    ) {
      const draft = drafts.get(state.project.id, c.id);
      if (draft && draft.baseVersion !== state.objects.find((e) => e.id === c.id)?.version)
        throw new Error('草稿起点已改变，请核对当前内容后选择“以当前版本继续编辑”');
    }
  const request = { expected, commands, ...(options.layout ? { layout: options.layout } : {}) };
  const key = uid();
  sessionStorage.setItem(
    'forkwise-pending',
    JSON.stringify({ projectId: state.project.id, key, request }),
  );
  let change;
  try {
    change = await api(route('/operations'), 'POST', request, key);
  } catch (error) {
    if (error.code && error.code !== 'INTERNAL_ERROR')
      sessionStorage.removeItem('forkwise-pending');
    $('#recover-operation').hidden = !sessionStorage.getItem('forkwise-pending');
    throw error;
  }
  sessionStorage.removeItem('forkwise-pending');
  try {
    state = applyChangeSet(state, change);
  } catch {
    await refresh(true);
  }
  for (const c of commands) {
    const draft = drafts.get(state.project.id, c.id);
    if (!draft) continue;
    const e = state.objects.find((e) => e.id === c.id);
    if (!e) continue;
    if (['statement.edit', 'statement.derive', 'inference.edit', 'impact.adopt'].includes(c.op)) {
      draft.impactDraft = null;
      draft.text = e.kind === 'statement' ? e.data.text : e.data.reason;
      draft.scope = '';
      draft.choices = [];
    }
    if (c.op === 'stance.set') {
      draft.stance = e.data.stance.value;
      draft.reason = e.data.stance.reason;
      draft.reasonDraft = null;
    }
    draft.baseVersion = e.version;
    drafts.put(state.project.id, c.id, draft);
  }
  if (change.layout) layout = change.layout;
  if (change.history) actionHistory = change.history;
  if (commands.length) {
    render();
    message('已保存到本机数据库');
    await jobs();
  } else canvas?.publish();
  return change;
}
async function travel(direction) {
  if (!state) throw new Error('请先创建研究项目');
  if (sessionStorage.getItem('forkwise-pending'))
    throw new Error('上次写入结果未知，请先恢复上次操作');
  if (!actionHistory?.[direction])
    throw new Error(direction === 'undo' ? '没有可撤销的操作' : '没有可重做的操作');
  const projectId = state.project.id,
    key = uid(),
    endpoint = '/action-history/travel';
  const request = {
    direction,
    expectedRevision: state.project.revision,
    expectedHistoryVersion: actionHistory.version,
    expectedLayoutVersion: layout.version,
  };
  sessionStorage.setItem('forkwise-pending', JSON.stringify({ projectId, key, request, endpoint }));
  let change;
  try {
    change = await api(`/projects/${projectId}${endpoint}`, 'POST', request, key);
  } catch (error) {
    if (error.code && error.code !== 'INTERNAL_ERROR')
      sessionStorage.removeItem('forkwise-pending');
    $('#recover-operation').hidden = !sessionStorage.getItem('forkwise-pending');
    if (error.code?.includes('CONFLICT')) await refresh(true);
    throw error;
  }
  sessionStorage.removeItem('forkwise-pending');
  try {
    state = applyChangeSet(state, change);
  } catch {
    await refresh(true);
  }
  if (change.layout) layout = change.layout;
  actionHistory = change.history;
  render();
  message(direction === 'undo' ? '已撤销；材料和审计记录保持' : '已重做');
  await jobs();
}
function render() {
  if (!state) return;
  $('#revision').textContent = `项目修订 ${state.project.revision}`;
  const statements = state.objects.filter((e) => e.kind === 'statement');
  const inferences = state.objects.filter((e) => e.kind === 'inference');
  const list = $('#object-list');
  list.replaceChildren();
  for (const e of [...statements, ...inferences]) {
    const button = document.createElement('button');
    button.dataset.id = e.id;
    button.textContent = (
      e.kind === 'statement' ? e.data.text : e.data.reason || '推导理由待补充'
    ).slice(0, 35);
    button.onclick = () => {
      selected = e.id;
      render();
      canvas?.command('reveal', e.id);
    };
    list.append(button);
  }
  canvas?.publish();
  for (const name of ['from', 'to']) {
    const select = $('#connect').elements[name];
    const previous = select.value;
    select.replaceChildren();
    statements.forEach((e) => select.add(new Option(e.data.text.slice(0, 18), e.id)));
    if (statements.some((e) => e.id === previous)) select.value = previous;
  }
  detail();
  if (blocking)
    document.querySelectorAll('button,input,select,textarea').forEach((control) => {
      control.disabled = true;
    });
}
function detail() {
  impactReviews?.onStateChange();
  manualUpdates?.onStateChange();
  verification?.render();
  objectResults?.render();
  const e = current();
  const editable = e && ['statement', 'inference'].includes(e.kind);
  $('#empty').hidden = Boolean(editable);
  $('#edit').hidden = !editable;
  if (editable) {
    const form = $('#edit');
    form.elements.text.value = e.kind === 'statement' ? e.data.text : e.data.reason;
    form.elements.stance.value = e.data.stance.value;
    form.elements.reason.value = e.data.stance.reason;
    form.elements.scope.value = '';
    const choices = $('#inference-choices');
    choices.innerHTML = '<legend>改接到新主张的推导</legend>';
    choices.hidden = true;
    state.objects
      .filter((i) => i.kind === 'inference' && i.data.premiseIds.includes(e.id))
      .forEach((i) => {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = i.id;
        label.append(box, i.data.reason);
        choices.append(label);
      });
    form.elements.scope.disabled = e.kind !== 'statement';
    const draft = drafts.get(state.project.id, e.id);
    reasonDraft = draft?.reasonDraft ?? null;
    impactDraft = draft?.impactDraft ?? null;
    if (draft) {
      for (const name of ['text', 'stance', 'reason', 'scope'])
        form.elements[name].value = draft[name];
      choices.hidden = draft.scope !== 'selected';
      choices
        .querySelectorAll('input')
        .forEach((x) => (x.checked = draft.choices.includes(x.value)));
    }
    const stale = draft && draft.baseVersion !== e.version;
    $('#rebase-draft').hidden = !stale;
    $('#draft-status').textContent = stale
      ? `草稿基于 v${draft.baseVersion}；当前 v${e.version}：${e.kind === 'statement' ? e.data.text : e.data.reason}`
      : draft
        ? '编辑草稿已保留在此浏览器'
        : '';
    if (impactDraft)
      $('#draft-status').textContent += ' · 正文来自 AI 修改建议；保存时记录来历与作用范围';
  }
  conditions?.render();
}
async function jobs() {
  if (!state) return;
  const projectId = state.project.id,
    sequence = ++researchSequence;
  const [list, overview] = await Promise.all([
    api(`/projects/${projectId}/jobs`),
    api(`/projects/${projectId}/research-results`),
  ]);
  if (state?.project.id !== projectId || sequence !== researchSequence) return;
  researchOverview = overview;
  canvas?.publish();
  objectResults?.render();
  await researchEntry?.update(list);
  conditions?.updateJobs(list);
  const box = $('#jobs');
  box.replaceChildren();
  const visible = [
    ...new Map(
      [
        ...list
          .filter((j) => j.kind === 'workflow.initial')
          .slice(-3)
          .reverse(),
        ...list.slice(-8).reverse(),
      ].map((j) => [j.id, j]),
    ).values(),
  ];
  for (const job of visible) {
    const item = document.createElement('div');
    item.className = 'job';
    const historyNote =
      job.historyState === 'undone'
        ? ' · 研究结果已撤销，原任务记录保留'
        : job.historyState === 'stopped'
          ? ' · 已停止执行；仅保留已完成结果'
          : '';
    item.textContent = `${job.kind === 'workflow.initial' ? '首次研究' : job.kind}：${job.state}${job.error ? ' · ' + job.error : ''}${historyNote}`;
    if (
      job.kind.startsWith('research.') ||
      job.kind === 'workflow.initial' ||
      ['source.sec-filing', 'source.sec-history'].includes(job.kind)
    ) {
      const view = document.createElement('button');
      view.textContent = '查看任务结果';
      view.onclick = () =>
        run(async () => showJob(await api(`/projects/${projectId}/jobs/${job.id}`)));
      item.append(view);
    }
    const action =
      job.historyState && job.historyState !== 'applied'
        ? null
        : ['failed', 'interrupted', 'partial'].includes(job.state)
          ? 'retry'
          : ['running', 'queued'].includes(job.state)
            ? 'cancel'
            : null;
    if (action) {
      const button = document.createElement('button');
      button.textContent = action === 'retry' ? '重试' : '取消';
      button.onclick = () =>
        run(async () => {
          await api(route(`/jobs/${job.id}/${action}`), 'POST', undefined, uid());
          await jobs();
        });
      item.append(button);
    }
    box.append(item);
  }
}
function saveDraft() {
  const e = current(),
    f = $('#edit').elements;
  if (!e || $('#edit').hidden) return;
  const previous = drafts.get(state.project.id, e.id);
  try {
    drafts.put(state.project.id, e.id, {
      baseVersion: previous?.baseVersion ?? e.version,
      text: f.text.value,
      stance: f.stance.value,
      reason: f.reason.value,
      scope: f.scope.value,
      choices: [...$('#inference-choices').querySelectorAll('input:checked')].map((x) => x.value),
      reasonDraft,
      impactDraft,
    });
  } catch {
    message('浏览器空间不足，草稿尚未持久保存，请先复制文字', true);
  }
}
$('#edit').addEventListener('input', saveDraft);
$('#edit').addEventListener('change', saveDraft);
$('#rebase-draft').onclick = () => {
  const e = current(),
    draft = drafts.get(state.project.id, e.id);
  draft.baseVersion = e.version;
  drafts.put(state.project.id, e.id, draft);
  detail();
  message('已保留草稿并使用当前对象版本，保存时仍校验并发变化');
};
$('#list-drafts').onclick = () => {
  const box = $('#draft-list');
  box.replaceChildren();
  for (const { id, draft } of drafts.list(state.project.id)) {
    const row = document.createElement('div'),
      text = document.createElement('pre');
    text.textContent = `${draft.text}\n立场理由：${draft.reason}`;
    const button = document.createElement('button');
    button.textContent = '回到此对象';
    button.disabled = !state.objects.some((e) => e.id === id);
    button.onclick = () => {
      selected = id;
      render();
    };
    const discard = document.createElement('button');
    discard.textContent = '放弃此草稿';
    discard.onclick = () => {
      drafts.remove(state.project.id, id);
      row.remove();
      detail();
    };
    row.append(text, button, discard);
    box.append(row);
  }
};
$('#new-project').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const p = await api('/projects', 'POST', { name: event.target.elements.name.value }, uid());
    event.target.reset();
    await projects(p.id);
    message('新项目已保存');
  });
};
$('#project').onchange = () => run(() => projects($('#project').value));
$('#refresh').onclick = () => run(() => refresh(true));
$('#add').onclick = () =>
  run(async () => {
    const id = uid();
    await write([
      {
        op: 'statement.create',
        id,
        data: {
          text: '待编辑主张',
          origin: 'user',
          participation: 'personal',
          stance: { value: 'pending', reason: '' },
          citations: [],
        },
      },
    ]);
    selected = id;
    detail();
    $('#edit').elements.text.focus();
  });
$('#connect').onsubmit = (event) => {
  event.preventDefault();
  const f = event.target.elements;
  run(() =>
    write([
      {
        op: 'inference.create',
        id: uid(),
        data: {
          premiseIds: [f.from.value],
          conclusionId: f.to.value,
          reason: f.reason.value,
          combination: 'independent',
          origin: 'user',
          participation: 'personal',
          stance: { value: 'pending', reason: '' },
          citations: [],
        },
      },
    ]),
  );
};
$('#edit').elements.scope.onchange = (event) => {
  $('#inference-choices').hidden = event.target.value !== 'selected';
};
$('#edit').onsubmit = (event) => {
  event.preventDefault();
  const e = current();
  const f = event.target.elements;
  run(async () => {
    if (impactDraft?.target === e.id) {
      const scope = e.kind === 'statement' ? f.scope.value : 'all';
      if (!scope) throw new Error('请明确选择全部引用或选定推导');
      const newId = scope === 'selected' ? uid() : undefined;
      const inferenceIds =
        scope === 'selected'
          ? [...$('#inference-choices').querySelectorAll('input:checked')].map((x) => x.value)
          : [];
      await write([
        {
          op: 'impact.adopt',
          id: e.id,
          jobId: impactDraft.jobId,
          proposalIndex: impactDraft.index,
          text: f.text.value,
          scope,
          inferenceIds,
          ...(newId ? { newId } : {}),
        },
      ]);
      if (newId) {
        selected = newId;
        render();
      }
      return;
    }
    if (e.kind === 'statement') {
      if (!f.scope.value) throw new Error('请明确选择全部引用或选定推导');
      if (f.scope.value === 'all')
        await write([{ op: 'statement.edit', id: e.id, text: f.text.value, scope: 'all' }]);
      else {
        const id = uid();
        const inferenceIds = [...$('#inference-choices').querySelectorAll('input:checked')].map(
          (x) => x.value,
        );
        await write([
          { op: 'statement.derive', id: e.id, newId: id, text: f.text.value, inferenceIds },
        ]);
        selected = id;
        render();
      }
    } else
      await write([
        {
          op: 'inference.edit',
          id: e.id,
          premiseIds: e.data.premiseIds,
          conclusionId: e.data.conclusionId,
          reason: f.text.value,
          combination: e.data.combination,
        },
      ]);
  });
};
$('#save-stance').onclick = () =>
  run(() =>
    write([
      {
        op: 'stance.set',
        id: selected,
        stance: {
          value: $('#edit').elements.stance.value,
          reason: $('#edit').elements.reason.value,
          ...(reasonDraft?.target === selected
            ? {
                reasonProvenance: {
                  jobId: reasonDraft.jobId,
                  proposalIndex: reasonDraft.index,
                  modified: $('#edit').elements.reason.value !== reasonDraft.reason,
                },
              }
            : {}),
        },
      },
    ]),
  );
$('#delete').onclick = () =>
  run(async () => {
    if (!window.confirm('删除所选对象及其依赖关系？历史版本仍保留。')) return;
    await write([{ op: 'object.delete', id: selected }]);
    selected = null;
    render();
  });
$('#history').onclick = () =>
  run(async () => {
    $('#history-content').textContent = JSON.stringify(
      await api(route(`/objects/${selected}/history`)),
      null,
      2,
    );
  });
$('#material').onsubmit = (event) => {
  event.preventDefault();
  const f = event.target.elements;
  run(async () => {
    const sourceId = uid();
    await write([
      {
        op: 'source.create',
        id: sourceId,
        data: {
          title: f.title.value,
          publisher: '',
          rights: 'authorized',
          ...(f.url.value.trim() ? { url: f.url.value.trim() } : {}),
        },
      },
      {
        op: 'source.import',
        id: uid(),
        sourceId,
        text: f.text.value,
        coverage: f.coverage.value,
        retrievedAt: new Date().toISOString(),
        publishedAt: f.publishedAt.value ? new Date(f.publishedAt.value).toISOString() : null,
      },
    ]);
    event.target.reset();
  });
};
$('#search-button').onclick = () =>
  run(async () => {
    const found = await api(route('/search'), 'POST', { query: $('#search').value });
    const box = $('#search-results');
    box.replaceChildren();
    for (const row of found.results) {
      const button = document.createElement('button');
      button.textContent = row.text.slice(0, 90);
      button.onclick = () => {
        selected = row.entityId;
        render();
      };
      box.append(button);
    }
    message(
      `找到 ${found.results.length} 个片段；${found.mode === 'full_text' ? '全文检索' : '混合检索'}`,
    );
  });
$('#export').onclick = () =>
  run(async () => {
    const data = await api(route('/export'));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'forkwise-project.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
$('#export-summary').onclick = () =>
  run(async () => {
    if (!state) throw new Error('请先选择项目');
    const { markdown } = await api(route('/summary'));
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'forkwise-summary.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
$('#record').onclick = () =>
  run(async () => {
    if (!state) throw new Error('请先选择项目');
    const result = await api(
      route('/judgments'),
      'POST',
      { title: `研究判断 ${new Date().toLocaleString()}` },
      uid(),
    );
    $('#history-content').textContent =
      `已记录：${result.title}\n${result.objects.length} 个对象版本`;
  });
$('#list-grants').onclick = () =>
  run(async () => {
    const box = $('#grant-list');
    box.replaceChildren();
    for (const grant of await api('/agent-grants')) {
      const row = document.createElement('p');
      row.textContent = `${grant.id.slice(0, 20)} · ${grant.expired ? '已过期' : new Date(grant.expiresAt).toLocaleString()} `;
      const button = document.createElement('button');
      button.textContent = '撤销';
      button.onclick = () =>
        run(async () => {
          await api(`/agent-grants/${grant.id}`, 'DELETE', undefined, uid());
          row.remove();
          message('授权已撤销，该 Agent 不能继续访问');
        });
      row.append(button);
      box.append(row);
    }
  });
$('#grant').onclick = () =>
  run(async () => {
    const result = await api('/agent-grants', 'POST', { projectIds: [state.project.id] }, uid());
    $('#credential').hidden = false;
    $('#credential').open = true;
    $('#credential textarea').value =
      `FORKWISE_URL=${location.origin}\nFORKWISE_AGENT_TOKEN=${result.token}`;
    message('已授权当前项目，请将配置保存在本机 Agent 中');
  });
$('#recover-operation').onclick = () =>
  run(async () => {
    const pending = JSON.parse(sessionStorage.getItem('forkwise-pending') ?? 'null');
    if (!pending) return;
    try {
      await api(`/projects/${pending.projectId}/operations/${pending.key}`);
    } catch (error) {
      if (error.code !== 'OPERATION_NOT_FOUND') throw error;
      await api(
        `/projects/${pending.projectId}${pending.endpoint ?? '/operations'}`,
        'POST',
        pending.request,
        pending.key,
      );
    }
    sessionStorage.removeItem('forkwise-pending');
    $('#recover-operation').hidden = true;
    await refresh(true);
    message('原操作结果已恢复，未重复创建操作');
  });
$('#import-archive').onchange = (event) =>
  run(async () => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 9_000_000) throw new Error('此入口单次支持 9 MB，请使用本机备份恢复更大的资产');
    const result = await api('/imports', 'POST', JSON.parse(await file.text()), uid());
    await projects(result.project.id);
    message(
      `研究资产已导入；${result.provenance.omissions.length} 份材料保留缺失说明。导入历史的作者身份未经外部认证。`,
    );
  });
const canvasRecovery = new CanvasRecoveryStore();
const textReader = attachTextReader({ api, getState: () => state });
const recoveryChanged = attachCanvasRecovery({
  store: canvasRecovery,
  getProjectId: () => state?.project.id,
  message,
});
canvas = attachCanvas({
  recovery: canvasRecovery,
  recoveryChanged,
  frame: $('#native-canvas'),
  getState: () => state,
  getLayout: () => layout,
  getHistory: () => actionHistory,
  getResearchOverview: () => researchOverview,
  travel: (direction) => exclusive(() => travel(direction)),
  getSelected: () => selected,
  isBusy: () => busy,
  write: (commands, options) => exclusive(() => write(commands, options), commands.length === 0),
  select: (id) => {
    selected = id;
    detail();
  },
  message,
  refresh,
  task: (action) => {
    if (action.id) {
      selected = action.id;
      detail();
    }
    if (action.type === 'image-material') {
      run(() => materials.canvas(action));
      return;
    }
    if (action.type === 'source') {
      if (action.ref?.kind === 'image') {
        run(() => materials.readCitation(action.ref, action.id));
        return;
      }
      void textReader.open(action.ref, {
        returnSource: () =>
          canvas.command('restore-source', { id: action.id, scroll: action.returnScroll ?? 0 }),
      });
      return;
    }
    if (action.type === 'details') {
      $('#edit').elements.text.focus();
      return;
    }
    if (['results', 'judgment'].includes(action.task)) {
      objectResults?.open();
      return;
    }
    if (action.task === 'history') $('#history').click();
    else if (action.task === 'materials') {
      $('#list-materials').closest('details').open = true;
      run(() => materials.open(selected));
    } else if (action.task === 'ai') {
      $('#task-kind').closest('details').open = true;
      $('#choose-task-materials').click();
    } else if (action.task === 'question') {
      const text = prompt('为当前对象记录待查问题');
      if (text?.trim())
        run(() => write([{ op: 'note.create', id: uid(), targetId: selected, text }]));
    } else if (action.task === 'adopt') run(() => write([{ op: 'object.adopt', id: selected }]));
    else if (['stance', 'judgment', 'results'].includes(action.task))
      $('#edit').elements.reason.focus();
    else message('该操作请在右侧研究面板中继续；当前研究内容保持。');
  },
});
attachMaintenance({ api, run, message, getState: () => state, projects, jobs });
attachPrototypeMigration({ api, run, message, getState: () => state, projects });
const materials = attachMaterials({
  submitFile: (id, input) =>
    researchEntry.submitTask(id, '/files/import', input, `导入 ${input.file.name}`),
  textReader,
  api,
  run,
  message,
  getState: () => state,
  getSelected: () => selected,
  getLayout: () => layout,
  getHistory: () => actionHistory,
  travel: (direction) => exclusive(() => travel(direction)),
  acceptChanges: async (change) => {
    try {
      state = applyChangeSet(state, change);
      render();
    } catch {
      await refresh(true);
    }
  },
  write,
  jobs,
});
conditions = attachConditions({
  readCitation: (citation) =>
    citation.kind === 'image'
      ? run(() => materials.readCitation(citation, selected))
      : textReader.open(citation),
  getState: () => state,
  getSelected: () => selected,
  write,
  run,
  api,
  jobs,
  message,
});
impactReviews = attachImpactReviews({
  api,
  run,
  message,
  getState: () => state,
  getSelected: () => selected,
  write,
  textReader,
  showJob: (job) => showJob(job),
});
manualUpdates = attachManualUpdates({
  api,
  run,
  getState: () => state,
  getSelected: () => selected,
  refresh,
  openReviews: (filter) => impactReviews.open(filter),
  showJob: (job) => showJob(job),
  textReader,
  openResearchEntry: () => researchEntry.open(),
});
verification = attachVerification({
  getState: () => state,
  getSelected: () => selected,
  write,
  run,
  refresh,
  api,
  message,
});
objectResults = attachObjectResults({
  api,
  getState: () => state,
  getSelected: () => selected,
  getOverview: () => researchOverview,
  write,
  run,
  refresh,
  showJob: (job) => showJob(job),
  readCitation: (citation) =>
    citation.kind === 'image'
      ? run(() => materials.readCitation(citation, selected))
      : textReader.open(citation),
});
showJob = attachResearch({
  submitTask: (id, endpoint, body, label) => researchEntry.submitTask(id, endpoint, body, label),
  textReader,
  api,
  run,
  message,
  getState: () => state,
  getSelected: () => selected,
  write,
  jobs,
  openImpactReviews: (jobId) => impactReviews.open({ jobId }),
  useImpact: (job, index, proposal) => {
    const target = state.objects.find((e) => e.id === proposal.target.id);
    if (!target || target.contentVersionId !== proposal.target.versionId)
      throw new Error('该建议属于旧内容版本，请重新分析');
    selected = target.id;
    render();
    $('#edit').elements.text.value = proposal.proposedText;
    $('#edit').elements.scope.value = '';
    impactDraft = { target: target.id, jobId: job.id, index };
    saveDraft();
    detail();
  },
  useReason: (job, index, proposal) => {
    const target = state.objects.find((e) => e.id === proposal.target.id);
    if (!target || target.contentVersionId !== proposal.target.versionId)
      throw new Error('该理由属于旧内容版本，请重新起草或自行编辑');
    selected = target.id;
    render();
    $('#edit').elements.reason.value = proposal.reason;
    reasonDraft = { target: target.id, jobId: job.id, index, reason: proposal.reason };
    saveDraft();
  },
});
researchEntry = attachResearchEntry({
  api,
  run,
  getState: () => state,
  refresh,
  showJob: (job) => showJob(job),
  message,
  openMaterials: async () => {
    $('#list-materials').closest('details').open = true;
    await materials.open();
  },
});
await run(async () => {
  await projects();
  const pending = JSON.parse(sessionStorage.getItem('forkwise-pending') ?? 'null');
  if (pending) {
    try {
      await api(`/projects/${pending.projectId}/operations/${pending.key}`);
      sessionStorage.removeItem('forkwise-pending');
      message('上次操作结果已核实并恢复');
    } catch {
      $('#recover-operation').hidden = false;
      message(
        '上次操作结果仍未知，原请求和操作键已保留。使用“恢复上次操作”查询或以原键重试。',
        true,
      );
    }
  }
});
function editorDirty() {
  if (verification?.hasDraft() || conditions?.hasDraft()) return true;
  const e = current(),
    form = $('#edit');
  return (
    e &&
    !form.hidden &&
    (form.elements.text.value !== (e.kind === 'statement' ? e.data.text : e.data.reason) ||
      form.elements.stance.value !== e.data.stance.value ||
      form.elements.reason.value !== e.data.stance.reason ||
      form.elements.scope.value !== '')
  );
}
let polling = false;
setInterval(async () => {
  if (busy || polling || canvas?.pending() || !state || document.hidden) return;
  polling = true;
  const base = state,
    baseLayout = layout,
    projectId = base.project.id;
  // Compare object identities as well as project IDs: a local write, refresh or
  // project switch can finish while the request is in flight.
  const unchanged = () => !busy && !canvas?.pending() && state === base && layout === baseLayout;
  try {
    const sync = await api(
      `/projects/${projectId}/sync?afterRevision=${base.project.revision}&layoutVersion=${baseLayout.version}`,
    );
    if (!unchanged()) return;
    if (sync.revision !== base.project.revision && editorDirty()) {
      message('后台有新结果或 Agent 修改。草稿保持，请“重新读取”并核对后保存。');
      await jobs();
      return;
    }
    let next = base;
    let nextLayout = sync.layout;
    let nextHistory = sync.history;
    if (sync.needsSnapshot) {
      const workspace = await api(`/projects/${projectId}/workspace`);
      next = workspace.state;
      nextLayout = workspace.layout;
      nextHistory = workspace.history;
      if (!unchanged() || editorDirty()) return;
    } else next = applySync(base, sync);
    const graphChanged = next !== base;
    const historyChanged = nextHistory?.version !== actionHistory?.version;
    actionHistory = nextHistory;
    state = next;
    if (nextLayout) layout = nextLayout;
    if (graphChanged) {
      render();
      message('已读取后台最新研究状态');
    } else if (nextLayout || historyChanged) canvas?.publish(true);
    await jobs();
  } catch (error) {
    if (!busy && state?.project.id === projectId) message(error.message, true);
  } finally {
    polling = false;
  }
}, 1500);
