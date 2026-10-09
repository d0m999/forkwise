import { DraftStore } from './drafts.js';

export function verificationScope(objects, target) {
  const map = new Map(objects.map((e) => [e.id, e]));
  return {
    target: { id: target.id, versionId: target.contentVersionId },
    context: (target.kind === 'inference'
      ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
      : []
    ).map((id) => ({ id, versionId: map.get(id)?.contentVersionId ?? '' })),
  };
}
export function currentVerification(objects, target) {
  const scope = verificationScope(objects, target);
  const rows = objects.filter(
    (e) => e.kind === 'verification_node' && !e.deletedAt && e.data.target.id === target.id,
  );
  const matches = (node) =>
    JSON.stringify({ target: node.data.target, context: node.data.context }) ===
    JSON.stringify(scope);
  return {
    confirmed: rows.find((e) => e.data.status === 'confirmed'),
    candidates: rows.filter((e) => e.data.status === 'candidate'),
    matches,
    scope,
  };
}

export function attachVerification({ getState, getSelected, write, run, refresh, api, message }) {
  const box = document.querySelector('#verification-node');
  const storage = new DraftStore(localStorage, 'forkwise-verification-draft'),
    memory = new Map();
  const key = (p, id) => `${p}:${id}`;
  const getDraft = (p, id) => memory.get(key(p, id)) ?? storage.get(p, id);
  function keep(p, id, draft) {
    memory.set(key(p, id), draft);
    try {
      storage.put(p, id, draft);
    } catch {
      message('验证节点草稿仅保留在当前页面，请复制内容后保存', true);
    }
  }
  function remove(p, id) {
    memory.delete(key(p, id));
    try {
      storage.remove(p, id);
    } catch {
      message('节点已保存，但浏览器中的旧草稿未能清除', true);
    }
  }
  function render() {
    const state = getState(),
      target = state?.objects.find((e) => e.id === getSelected());
    box.replaceChildren();
    box.hidden = !target || !['statement', 'inference'].includes(target.kind);
    if (box.hidden) return;
    const p = state.project.id,
      { confirmed, candidates, matches, scope } = currentVerification(state.objects, target);
    const draft = getDraft(p, target.id),
      value = confirmed ?? candidates.filter(matches).at(-1) ?? candidates.at(-1);
    const text = (content, tag = 'p') => {
      const el = document.createElement(tag);
      el.textContent = content;
      box.append(el);
      return el;
    };
    const button = (label, action, id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (id) b.id = id;
      b.onclick = action;
      box.append(b);
      return b;
    };
    function begin(node = value) {
      keep(p, target.id, {
        ...(node ? { target: node.data.target, context: node.data.context } : scope),
        nodeId: confirmed?.id ?? null,
        nodeVersion: confirmed?.version ?? null,
        basedOn:
          node?.data.status === 'candidate'
            ? { id: node.id, versionId: node.versionId }
            : node?.data.basedOn,
        fields: Object.fromEntries(
          ['event', 'goal', 'period', 'date'].map((name) => [name, node?.data[name] ?? '']),
        ),
      });
      render();
    }
    async function save(saved) {
      const current = getState(),
        selected = current?.objects.find((e) => e.id === target.id);
      if (current?.project.id !== p || !selected)
        throw new Error('研究对象已切换或删除，节点草稿保留');
      const now = currentVerification(current.objects, selected);
      if (
        JSON.stringify({ target: saved.target, context: saved.context }) !==
          JSON.stringify(now.scope) ||
        saved.nodeId !== (now.confirmed?.id ?? null) ||
        saved.nodeVersion !== (now.confirmed?.version ?? null)
      )
        throw new Error('内容、前提或本人节点已变化，请先复核当前版本；节点草稿保留');
      try {
        await write([
          {
            op: 'verification.confirm',
            id: saved.nodeId ?? crypto.randomUUID(),
            target: saved.target,
            context: saved.context,
            details: Object.fromEntries(
              Object.entries(saved.fields).map(([k, v]) => [k, v.trim() || null]),
            ),
            ...(saved.basedOn ? { basedOn: saved.basedOn } : {}),
          },
        ]);
      } catch (error) {
        await refresh(true);
        throw error;
      }
      remove(p, target.id);
      render();
      message('已确认验证节点；预测结果与个人立场分别记录');
    }
    const perform = (saved) =>
      run(async () => {
        try {
          await save(saved);
        } catch (error) {
          if (getState()?.project.id === p && getSelected() === target.id) {
            box.querySelector('#verification-error')?.remove();
            const notice = text(error.message);
            notice.id = 'verification-error';
            notice.setAttribute('role', 'alert');
          }
          throw error;
        }
      });
    text('验证节点', 'h3');
    if (draft) {
      const stale =
        JSON.stringify({ target: draft.target, context: draft.context }) !==
          JSON.stringify(scope) ||
        draft.nodeId !== (confirmed?.id ?? null) ||
        draft.nodeVersion !== (confirmed?.version ?? null);
      text(
        stale ? '内容、前提或节点有变化，旧草稿需复核。' : '正在编辑验证节点；草稿保留在此浏览器。',
      );
      const form = document.createElement('form');
      form.id = 'verification-form';
      const labels = {
        event: '等待什么事件',
        goal: '到时核对什么',
        period: '内容对应期间（未知可留空）',
        date: '披露日期（未知可留空）',
      };
      for (const [name, labelText] of Object.entries(labels)) {
        const label = document.createElement('label'),
          field = document.createElement('input');
        label.textContent = labelText;
        field.name = name;
        field.setAttribute('aria-label', labelText);
        field.type = name === 'date' ? 'date' : 'text';
        field.value = draft.fields[name];
        field.required = name === 'event' || name === 'goal';
        field.maxLength = name === 'period' ? 500 : 2000;
        field.oninput = () => {
          draft.fields[name] = field.value;
          keep(p, target.id, draft);
        };
        label.append(field);
        form.append(label);
      }
      const submit = document.createElement('button');
      submit.textContent = '保存并确认节点';
      submit.type = 'submit';
      form.append(submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        void perform(draft);
      };
      box.append(form);
      if (stale) {
        text(`当前内容：${target.kind === 'statement' ? target.data.text : target.data.reason}`);
        for (const ref of scope.context)
          text(
            `当前关联内容：${state.objects.find((e) => e.id === ref.id)?.data.text ?? '已缺失'}`,
          );
        button(
          '已复核，以当前版本继续',
          () => {
            keep(p, target.id, {
              ...draft,
              ...scope,
              nodeId: confirmed?.id ?? null,
              nodeVersion: confirmed?.version ?? null,
            });
            render();
          },
          'verification-rebase',
        );
      }
      button('放弃节点草稿', () => {
        remove(p, target.id);
        render();
      });
    } else {
      text(
        confirmed
          ? matches(confirmed)
            ? '已确认节点'
            : '原节点对应旧内容或前提，需复核'
          : value
            ? matches(value)
              ? 'AI 建议 · 待你确认'
              : 'AI 建议对应旧内容或前提，需复核'
            : '尚无验证节点，按需设置即可',
      );
      if (value) {
        text(value.data.event ?? '验证事件待明确', 'strong');
        text(value.data.goal ?? '核对目标待明确');
        text(`${value.data.period ?? '期间待明确'} · ${value.data.date ?? '披露日期未知'}`);
        for (const gap of value.data.gaps) text(gap);
      }
      if (!confirmed && value && matches(value) && value.data.event && value.data.goal)
        button(
          '确认节点',
          () => {
            begin(value);
            void perform(getDraft(p, target.id));
          },
          'verification-confirm',
        );
      button(
        confirmed ? '修改节点' : value ? '补明／修改节点' : '设置验证节点',
        () => begin(),
        'verification-edit',
      );
    }
    if (candidates.length > 1 || (confirmed && candidates.length)) {
      const list = document.createElement('details'),
        summary = document.createElement('summary');
      summary.textContent = `查看 ${candidates.length} 项 AI 节点建议`;
      list.append(summary);
      for (const candidate of candidates) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${candidate.data.event ?? '事件待明确'}${matches(candidate) ? '' : '（旧版本）'} · 填入节点草稿`;
        b.onclick = () => {
          if (getDraft(p, target.id)) {
            message('已有节点草稿，请先保存或放弃后再选另一建议', true);
            return;
          }
          begin(candidate);
        };
        list.append(b);
      }
      box.append(list);
    }
    if (confirmed)
      button('查看节点历史', () =>
        run(async () => {
          const history = await api(`/projects/${p}/objects/${confirmed.id}/history`);
          if (getState()?.project.id !== p || getSelected() !== target.id) return;
          const pre = text(
            history
              .map(
                (e) =>
                  `v${e.version} · ${e.updatedAt}\n${e.data.event}\n${e.data.goal}\n${e.data.period ?? '期间待明确'} · ${e.data.date ?? '披露日期未知'}`,
              )
              .join('\n\n'),
            'pre',
          );
          pre.id = 'verification-history';
        }),
      );
    text('节点确认只记录观察安排；预测结果、个人立场及条件确认分别处理，不会开启定时任务。');
  }
  return {
    render,
    hasDraft: () => {
      const s = getState();
      return Boolean(s && getDraft(s.project.id, getSelected()));
    },
  };
}
