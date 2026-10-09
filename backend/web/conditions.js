import { DraftStore } from './drafts.js';
import { expectedVersions } from './operation-versions.js';
import { currentEvaluations } from './research.js';
import {
  element,
  button,
  labelOf,
  verdicts,
  modes,
  ruleDraft,
  ruleForm,
  conditionData,
  assessmentForm,
  describeRule,
} from './condition-forms.js';

export function attachConditions({
  getState,
  getSelected,
  write,
  run,
  api,
  jobs,
  message,
  readCitation,
}) {
  const root = document.querySelector('#conditions');
  const store = new DraftStore(localStorage, 'forkwise-condition-draft'),
    memory = new Map();
  let showAll = false;
  let taskList = [];
  const key = (p, id) => p + ':' + id;
  const get = (p, id) => memory.get(key(p, id)) ?? store.get(p, id);
  function keep(p, id, draft) {
    memory.set(key(p, id), draft);
    try {
      store.put(p, id, draft);
    } catch {
      message('条件草稿仅留在当前页面，请复制内容后保存', true);
    }
  }
  function remove(p, id) {
    memory.delete(key(p, id));
    try {
      store.remove(p, id);
    } catch {
      message('浏览器旧草稿未能清除，请核对后放弃', true);
    }
  }
  const versions = (state) => Object.fromEntries(state.objects.map((e) => [e.id, e.version]));
  function begin(kind, condition, candidate) {
    const state = getState(),
      id = condition?.id ?? 'new',
      p = state.project.id;
    if (get(p, id)) {
      message('已有条件草稿，请先保存或放弃');
      return;
    }
    keep(p, id, {
      kind,
      conditionId: condition?.id ?? null,
      ruleVersion: condition?.contentVersionId,
      versions: versions(state),
      evaluationId: candidate?.id,
      values:
        kind === 'rule'
          ? ruleDraft(condition, getSelected())
          : {
              verdict: candidate?.data.verdict ?? 'unknown',
              reason: candidate?.data.reason ?? '',
              evidenceIds: candidate?.data.evidenceIds ?? [],
              citations: candidate?.data.citations ?? [],
            },
    });
    render();
  }
  function guarded(p, draft, commands) {
    const state = getState();
    if (state?.project.id !== p) throw new Error('项目已切换，条件草稿保留');
    const required = expectedVersions(state.objects, commands);
    for (const [id, version] of Object.entries(required))
      if (draft.versions[id] !== version)
        throw new Error('规则、引用对象或材料已变化，请复核当前版本；草稿保留');
    if (draft.conditionId && !state.objects.some((e) => e.id === draft.conditionId))
      throw new Error('原条件已删除，草稿保留供复制');
    return required;
  }
  function draftPanel(parent, condition, draft) {
    const state = getState(),
      p = state.project.id,
      id = condition?.id ?? 'new';
    const panel = element(parent, 'section');
    panel.className = 'condition-draft';
    element(
      panel,
      'h4',
      draft.kind === 'rule'
        ? '编辑判断条件'
        : draft.kind === 'request'
          ? '选择本次评估依据'
          : '记录本人条件判断',
    );
    const error = element(panel, 'p');
    error.setAttribute('role', 'alert');
    error.className = 'condition-error';
    const save = (values) => {
      draft = { ...draft, values };
      keep(p, id, draft);
      run(async () => {
        try {
          let command;
          if (draft.kind === 'rule') {
            if (condition && !values.scope) throw new Error('请明确修改共享条件还是仅选定引用');
            const local = condition && values.scope === 'selected';
            const data = conditionData(values, local ? undefined : condition?.data.lineage);
            if (local) {
              if (
                !values.targetIds.length ||
                values.targetIds.some((target) => !condition.data.targetIds.includes(target))
              )
                throw new Error('局部修改须选择原条件已有的引用');
              command = {
                op: 'condition.derive',
                id: condition.id,
                newId: crypto.randomUUID(),
                targetIds: values.targetIds,
                data,
              };
            } else
              command = condition
                ? { op: 'condition.edit', id: condition.id, scope: 'all', data }
                : { op: 'condition.create', id: crypto.randomUUID(), data };
          } else {
            const scope = { id: condition.id, versionId: draft.ruleVersion };
            const selectedEvidence = values.evidenceIds.map((evidenceId) => {
              const e = getState().objects.find(
                (e) => e.id === evidenceId && e.kind === 'evidence',
              );
              if (!e) throw new Error('选定证据已不可用，请复核后重选');
              return e;
            });
            const citations = [
              ...new Map(
                [...values.citations, ...selectedEvidence.map((e) => e.data.citation)].map((c) => [
                  JSON.stringify(c),
                  c,
                ]),
              ).values(),
            ];
            command = {
              op: 'evaluation.confirm',
              id: crypto.randomUUID(),
              condition: scope,
              verdict: values.verdict,
              reason: values.reason.trim(),
              evidenceIds: values.evidenceIds,
              citations,
              ...(draft.evaluationId ? { evaluationId: draft.evaluationId } : {}),
            };
          }
          const expected = guarded(p, draft, [command]);
          if (draft.kind === 'request') {
            await api(
              '/projects/' + p + '/evaluations',
              'POST',
              {
                conditionId: condition.id,
                ruleVersionId: draft.ruleVersion,
                evidenceIds: values.evidenceIds,
              },
              crypto.randomUUID(),
            );
          } else await write([command], { expected });
          remove(p, id);
          render();
          await jobs();
          message(
            draft.kind === 'rule'
              ? '条件已保存；评估与本人判断分别记录'
              : draft.kind === 'request'
                ? '评估任务已创建，规则保持已保存'
                : '本人条件判断已保存，个人立场保持',
          );
        } catch (cause) {
          error.textContent = cause.message;
          throw cause;
        }
      });
    };
    const update = (values) => {
      draft = { ...draft, values };
      keep(p, id, draft);
    };
    if (draft.kind === 'rule')
      ruleForm(panel, condition, state.objects, draft.values, update, save);
    else {
      if (draft.evaluationId)
        element(panel, 'p', '基于候选 ' + draft.evaluationId + '；沿用其理由时保留原提出者来历。');
      assessmentForm(panel, state.objects, draft.values, draft.kind === 'request', update, save);
    }
    const stale = condition && condition.version !== draft.versions[condition.id];
    element(
      panel,
      'p',
      stale
        ? '条件已更新：当前为 v' + condition.version + '。草稿尚未保存，请对照上方规则复核。'
        : '草稿保留在当前浏览器；保存时校验规则、对象及选定材料版本。',
    );
    button(panel, '已复核，以当前版本继续', () => {
      const latest = getState(),
        current = latest.objects.find((e) => e.id === draft.conditionId);
      if (latest.project.id !== p || (draft.conditionId && !current)) {
        message('条件已删除或项目已切换，请复制草稿', true);
        return;
      }
      if (
        draft.evaluationId &&
        latest.objects.find((e) => e.id === draft.evaluationId)?.data.condition.versionId !==
          current?.contentVersionId
      ) {
        error.textContent =
          '原候选对应旧规则，请放弃本草稿并独立记录新判断；不能把旧候选确认到新规则';
        return;
      }
      keep(p, id, { ...draft, versions: versions(latest), ruleVersion: current?.contentVersionId });
      render();
    });
    button(panel, '放弃条件草稿', () => {
      remove(p, id);
      render();
    });
  }
  function showEvaluation(parent, entry, title) {
    if (!entry) {
      element(parent, 'p', title + '：当前规则暂无记录');
      return;
    }
    const data = entry.data;
    element(
      parent,
      'p',
      title + '：' + verdicts[data.verdict] + (data.tentative ? ' · 依据有限' : ''),
    );
    element(parent, 'p', data.reason);
    element(
      parent,
      'small',
      data.evaluatedAt + ' · ' + { human: '本人', ai: 'AI', rule: '规则计算' }[data.evaluator],
    );
    if (data.basedOn) {
      const source = getState().objects.find((e) => e.id === data.basedOn.id);
      element(
        parent,
        'p',
        '依据记录：' +
          data.basedOn.id +
          (source?.data.reason === data.reason
            ? ' · 理由沿用原评估，保留原提出者归属'
            : ' · 本人补充理由'),
      );
    }
    for (const gap of data.missing) element(parent, 'p', '缺口：' + gap);
    if (data.components)
      for (const [kind, part] of Object.entries(data.components)) {
        const details = element(parent, 'details');
        element(
          details,
          'summary',
          (kind === 'numeric' ? '确定性数值结果：' : 'AI 定性意见：') + verdicts[part.verdict],
        );
        element(details, 'p', part.reason);
        if (part.tentative) element(details, 'p', '依据有限');
        for (const gap of part.missing) element(details, 'p', '缺口：' + gap);
      }
    for (const citation of data.citations) {
      const details = element(parent, 'details');
      element(details, 'summary', citation.kind === 'image' ? '查看原图定位' : '查看依据原句');
      element(
        details,
        'blockquote',
        citation.kind === 'image'
          ? `原图第一帧 ${citation.imageWidth}×${citation.imageHeight}；区域 ${JSON.stringify(citation.region)}`
          : citation.quote,
      );
      element(
        details,
        'small',
        '材料 ' +
          citation.sourceVersionId +
          (citation.kind === 'image' ? '' : ' · 原文位置 ' + citation.start + '–' + citation.end),
      );
      button(details, '在保存材料中定位', () => readCitation(citation));
    }
  }
  function updateJobs(list = taskList) {
    taskList = list;
    const state = getState();
    for (const slot of root.querySelectorAll('[data-condition-task]')) {
      slot.replaceChildren();
      const c = state?.objects.find((e) => e.id === slot.dataset.conditionTask);
      if (!c) continue;
      const job = list
        .filter(
          (j) =>
            j.projectId === state.project.id &&
            j.condition?.id === c.id &&
            j.condition.versionId === c.contentVersionId,
        )
        .at(-1);
      if (!job) {
        element(slot, 'p', '规则已保存；当前规则暂无评估任务。');
        continue;
      }
      const names = {
        queued: '等待执行',
        running: '执行中',
        succeeded: '执行完成',
        failed: '失败，尚无本次新结果',
        interrupted: '已中断',
        cancelled: '已取消',
        partial: '部分完成',
      };
      element(
        slot,
        'p',
        '规则已保存；评估任务' + names[job.state] + (job.error ? '：' + job.error : ''),
      );
      const action = ['failed', 'interrupted'].includes(job.state)
        ? 'retry'
        : ['queued', 'running'].includes(job.state)
          ? 'cancel'
          : null;
      if (action)
        button(slot, action === 'retry' ? '重试此条件评估' : '取消此条件评估', () =>
          run(async () => {
            await api(
              '/projects/' + state.project.id + '/jobs/' + job.id + '/' + action,
              'POST',
              undefined,
              crypto.randomUUID(),
            );
            await jobs();
          }),
        );
    }
  }
  function render() {
    root.replaceChildren();
    const state = getState();
    root.hidden = !state;
    if (!state) return;
    const p = state.project.id,
      selected = getSelected();
    element(root, 'h3', '判断条件');
    button(root, '新建判断条件', () => begin('rule'));
    button(root, showAll ? '只看所选对象条件' : '查看项目全部条件', () => {
      showAll = !showAll;
      render();
    });
    const newDraft = get(p, 'new');
    if (newDraft) draftPanel(root, null, newDraft);
    const conditions = state.objects.filter((e) => e.kind === 'condition');
    const reusable = conditions.filter((c) => !c.data.targetIds.includes(selected));
    if (selected && reusable.length) {
      const picker = element(root, 'details');
      element(picker, 'summary', '引用已有条件');
      for (const c of reusable) {
        const row = element(picker, 'div');
        element(row, 'p', c.data.description);
        button(row, '在当前对象引用此条件', () =>
          run(async () => {
            const command = {
              op: 'condition.edit',
              id: c.id,
              scope: 'all',
              data: { ...c.data, targetIds: [...c.data.targetIds, selected] },
            };
            await write([command], { expected: expectedVersions(state.objects, [command]) });
            message('已引用同一条件，规则与历史评估保持');
          }),
        );
      }
    }
    const visible = conditions.filter(
      (c) => showAll || !selected || c.data.targetIds.includes(selected),
    );
    if (!visible.length) element(root, 'p', '此范围尚无判断条件。');
    for (const c of visible) {
      const box = element(root, 'article');
      box.className = 'condition';
      box.dataset.conditionId = c.id;
      element(box, 'h4', c.data.description);
      element(box, 'p', modes[c.data.mode] + ' · v' + c.version);
      if (c.data.rule) describeRule(box, c.data.rule);
      if (c.data.lineage) {
        const origin = element(box, 'details');
        element(origin, 'summary', '此条件由共享规则局部修改而来');
        button(origin, '查看派生前规则', () =>
          run(async () => {
            const ref = c.data.lineage,
              rows = await api('/projects/' + p + '/objects/' + ref.id + '/history');
            const original = rows.find((v) => v.versionId === ref.versionId);
            if (!original) throw new Error('原规则版本暂不可用，派生来历仍保留');
            let saved = origin.querySelector('.condition-origin');
            if (!saved) {
              saved = element(origin, 'div');
              saved.className = 'condition-origin';
            }
            saved.replaceChildren();
            element(saved, 'p', original.data.description);
            element(saved, 'small', '原规则 v' + original.version + ' · ' + original.updatedAt);
            if (original.data.rule) describeRule(saved, original.data.rule);
          }),
        );
      }
      element(
        box,
        'p',
        '引用位置：' +
          (c.data.targetIds
            .map((id) => labelOf(state.objects.find((e) => e.id === id)))
            .join('；') || '尚未关联对象'),
      );
      const { confirmed, candidate } = currentEvaluations(state.objects, c);
      showEvaluation(box, confirmed, '本人确认');
      showEvaluation(
        box,
        candidate,
        c.data.mode === 'numeric'
          ? '规则计算'
          : c.data.mode === 'mixed'
            ? '规则与 AI 建议'
            : 'AI 建议',
      );
      const task = element(box, 'div');
      task.dataset.conditionTask = c.id;
      button(box, '编辑条件与引用', () => begin('rule', c));
      button(box, '请求条件评估', () => begin('request', c));
      button(box, '独立记录本人判断', () => begin('assessment', c));
      if (candidate) button(box, '根据此建议记录判断', () => begin('assessment', c, candidate));
      const history = element(box, 'details');
      element(history, 'summary', '规则与评估历史');
      button(history, '读取条件历史', () =>
        run(async () => {
          const rows = await api('/projects/' + p + '/objects/' + c.id + '/history');
          const content = history.querySelector('.condition-history') ?? element(history, 'div');
          content.className = 'condition-history';
          content.replaceChildren();
          for (const version of rows) {
            const item = element(content, 'details');
            element(
              item,
              'summary',
              'v' + version.version + ' · ' + version.updatedAt + ' · ' + version.data.description,
            );
            element(item, 'p', modes[version.data.mode]);
            if (version.data.rule) describeRule(item, version.data.rule);
          }
          for (const entry of state.objects.filter(
            (e) => e.kind === 'evaluation' && e.data.condition.id === c.id,
          )) {
            const item = element(content, 'details');
            const rule = rows.find((v) => v.contentVersionId === entry.data.condition.versionId);
            element(
              item,
              'summary',
              (entry.data.condition.versionId === c.contentVersionId ? '当前规则' : '旧规则') +
                ' v' +
                (rule?.version ?? '?') +
                ' · ' +
                verdicts[entry.data.verdict],
            );
            showEvaluation(item, entry, '历史评估');
          }
        }),
      );
      const draft = get(p, c.id);
      if (draft) draftPanel(box, c, draft);
    }
    updateJobs();
  }
  return {
    render,
    updateJobs,
    hasDraft: () => {
      const state = getState();
      return Boolean(
        state &&
          (get(state.project.id, 'new') ||
            state.objects.some((e) => e.kind === 'condition' && get(state.project.id, e.id))),
      );
    },
  };
}
