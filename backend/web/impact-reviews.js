import { DraftStore } from './drafts.js';

const outcomes = { maintained: '维持原判断', revised: '修订判断', later: '稍后处理' };
const states = {
  pending: '需复核',
  later: '稍后处理 · 仍需复核',
  completed: '本条已复核',
  stale: '内容或判断已变化 · 需重新复核',
};
export function attachImpactReviews({
  api,
  getState,
  getSelected,
  write,
  run,
  textReader,
  showJob,
  message,
}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'impact-review-dialog';
  dialog.setAttribute('aria-label', '影响建议与复核');
  document.body.append(dialog);
  const storage = new DraftStore(localStorage, 'forkwise-review-draft'),
    memory = new Map();
  let projectId,
    query = {},
    sequence = 0,
    active = null,
    loadedTarget = null;
  const key = (item) => `${item.jobId}_${item.proposalIndex}`;
  const scope = (item) =>
    JSON.stringify([item.current?.target, item.current?.context, item.review?.versionId]);
  function keep(item, draft) {
    memory.set(`${projectId}:${key(item)}`, draft);
    try {
      storage.put(projectId, key(item), draft);
    } catch {
      message('复核草稿仅留在当前页面，请复制理由后保存', true);
    }
  }
  function node(tag, text, parent = dialog) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    parent.append(e);
    return e;
  }
  function button(text, action, parent = dialog) {
    const b = node('button', text, parent);
    b.type = 'button';
    b.onclick = action;
    return b;
  }
  function header() {
    dialog.replaceChildren();
    const head = node('header');
    node('strong', '影响建议与复核', head);
    button(
      '返回画布',
      () => {
        sequence++;
        dialog.close();
      },
      head,
    );
  }
  function readFailure(error, retry) {
    dialog.querySelector('[data-review-loading]')?.remove();
    const box = dialog.querySelector('[data-review-read-error]') ?? node('div');
    box.dataset.reviewReadError = 'true';
    box.setAttribute('role', 'alert');
    box.replaceChildren();
    node('p', `读取失败：${error.message}。已有记录和草稿保留。`, box);
    button('重试读取', () => run(retry), box);
    box.scrollIntoView({ block: 'nearest' });
  }
  async function load(cursor, append = false) {
    dialog.querySelector('[data-review-read-error]')?.remove();
    const requestId = ++sequence,
      id = projectId;
    const params = new URLSearchParams({ ...query, limit: '20', ...(cursor ? { cursor } : {}) });
    let result;
    try {
      result = await api(`/projects/${id}/impact-reviews?${params}`);
    } catch (error) {
      if (sequence === requestId && getState()?.project.id === id && dialog.open)
        readFailure(error, () => load(cursor, append));
      return;
    }
    if (sequence !== requestId || getState()?.project.id !== id || !dialog.open) return;
    active = null;
    loadedTarget = null;
    if (!append) {
      header();
      node('p', '新材料的影响由本人逐条复核。复核结果单独保存，采用建议和个人立场分别处理。');
      node('div').id = 'impact-review-list';
    }
    const list = dialog.querySelector('#impact-review-list');
    if (!result.items.length && !append) node('p', '当前范围没有已完成的影响建议任务。', list);
    for (const item of result.items) {
      const row = node('section', undefined, list);
      row.className = 'impact-review-row';
      row.dataset.proposal = key(item);
      node('strong', states[item.reviewState], row);
      node('p', item.current?.text ?? item.originalText, row);
      node('p', item.proposal.reason, row);
      if (item.proposalState !== 'current')
        node(
          'p',
          item.proposalState === 'unavailable'
            ? '原对象已删除，记录仅供回查。'
            : '建议对应旧内容或前提，采用前须重新分析。',
          row,
        );
      button('查看并复核', () => detail(item), row);
    }
    dialog.querySelector('[data-more]')?.remove();
    if (result.nextCursor) {
      const more = button('更多影响建议', () => run(() => load(result.nextCursor, true)));
      more.dataset.more = 'true';
    }
  }
  function detail(item) {
    sequence++;
    active = item;
    loadedTarget = getState()?.objects.find((e) => e.id === item.current?.target.id)?.versionId;
    header();
    button('返回建议列表', () => run(() => load()));
    node('h3', states[item.reviewState]);
    node('p', '建议形成时的内容');
    node('blockquote', item.originalText);
    for (const c of item.originalContext) node('p', `当时上下文 ${c.id}：${c.text}`);
    node('p', `AI 建议：${item.proposal.proposedText}`);
    node('p', item.proposal.reason);
    for (const citation of item.proposal.citations) {
      node('blockquote', citation.quote || '原文不可用');
      button('定位建议原文', () => textReader.open(citation));
    }
    for (const gap of item.proposal.gaps) node('p', `资料缺口：${gap}`);
    if (item.review) {
      node(
        'p',
        `已记录：${outcomes[item.review.data.disposition]} · ${new Date(item.review.data.reviewedAt).toLocaleString()}`,
      );
      node('p', item.review.data.reason || '未填写稍后处理理由');
      button('查看复核修改历史', () =>
        run(async () => {
          const id = projectId,
            requestId = sequence;
          const rows = await api(`/projects/${id}/objects/${item.review.id}/history`);
          if (projectId !== id || sequence !== requestId || active !== item || !dialog.open) return;
          const history = dialog.querySelector('[data-review-history]') ?? node('div');
          history.dataset.reviewHistory = 'true';
          history.replaceChildren();
          for (const row of rows)
            node(
              'p',
              `${new Date(row.updatedAt).toLocaleString()} · ${outcomes[row.data.disposition]} · ${row.data.reason || '无理由'}${row.deletedAt ? ' · 已撤销或随目标删除' : ''}`,
              history,
            );
        }),
      );
    }
    button('查看原影响任务', () =>
      run(async () => {
        const id = projectId,
          job = await api(`/projects/${id}/jobs/${item.jobId}`);
        if (getState()?.project.id !== id) return;
        dialog.close();
        showJob(job);
      }),
    );
    if (!item.current) return;
    node('h4', '本次复核的当前内容');
    node('blockquote', item.current.text);
    node(
      'p',
      `当前个人立场：${{ pending: '待研究', accepted: '认可', questioned: '质疑', rejected: '不认可' }[item.current.stance.value]}${item.current.stance.reason ? '；' + item.current.stance.reason : ''}`,
    );
    for (const c of item.current.contextTexts) node('p', `当前上下文 ${c.id}：${c.text}`);
    const stored = memory.get(`${projectId}:${key(item)}`) ?? storage.get(projectId, key(item));
    const draft = stored ?? {
      disposition: item.review?.data.disposition ?? 'maintained',
      reason: item.review?.data.reason ?? '',
      base: scope(item),
    };
    const needsAck =
      item.proposalState !== 'current' ||
      item.reviewState === 'stale' ||
      draft.base !== scope(item);
    const form = node('form');
    form.dataset.reviewForm = 'true';
    const label = node('label', '本次复核结果', form),
      select = node('select', undefined, label);
    select.name = 'disposition';
    for (const [value, text] of Object.entries(outcomes)) select.add(new Option(text, value));
    select.value = draft.disposition;
    const reasonLabel = node('label', '处理理由（完成复核时必填）', form),
      reason = node('textarea', undefined, reasonLabel);
    reason.name = 'reason';
    reason.maxLength = 20000;
    reason.value = draft.reason;
    let ack;
    if (needsAck) {
      const l = node('label', undefined, form);
      ack = node('input', undefined, l);
      ack.type = 'checkbox';
      ack.name = 'rechecked';
      l.append(document.createTextNode('已对照当前内容、立场与前提重新核对这条旧建议'));
    }
    const feedback = node('p', '', form);
    feedback.dataset.reviewFeedback = 'true';
    feedback.setAttribute('role', 'status');
    form.oninput = () => keep(item, { ...draft, disposition: select.value, reason: reason.value });
    button('重新读取当前内容，保留草稿', () => run(() => loadDetail(item)), form);
    button(
      '放弃本条草稿',
      () => {
        try {
          storage.remove(projectId, key(item));
          memory.delete(`${projectId}:${key(item)}`);
          detail(item);
        } catch {
          message('未能清除本机草稿，内容仍保留', true);
        }
      },
      form,
    );
    const submit = node('button', '保存本条复核', form);
    submit.type = 'submit';
    form.onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        if (getState()?.project.id !== projectId) throw new Error('项目已切换，请回到原项目复核');
        if (ack && !ack.checked) {
          feedback.textContent = '请先对照当前内容重新核对；旧草稿保持。';
          return;
        }
        if (select.value !== 'later' && !reason.value.trim()) {
          feedback.textContent = '完成复核需要填写处理理由。';
          return;
        }
        const owner = projectId;
        const submitted = { disposition: select.value, reason: reason.value, base: scope(item) };
        keep(item, submitted);
        submit.disabled = true;
        try {
          await write(
            [
              {
                op: 'impact.review',
                id: item.review?.id ?? crypto.randomUUID(),
                jobId: item.jobId,
                proposalIndex: item.proposalIndex,
                target: item.current.target,
                context: item.current.context,
                disposition: submitted.disposition,
                reason: submitted.reason,
              },
            ],
            { expected: item.current.expected },
          );
          const current = memory.get(`${owner}:${key(item)}`);
          if (JSON.stringify(current) === JSON.stringify(submitted)) {
            memory.delete(`${owner}:${key(item)}`);
            try {
              storage.remove(owner, key(item));
            } catch {
              message('复核已保存，旧草稿未能清除', true);
            }
          }
          message(
            submitted.disposition === 'later'
              ? '已记录稍后处理；本条仍需复核。'
              : '本条复核已保存；个人立场保持。',
          );
          if (projectId === owner && getState()?.project.id === owner) await loadDetail(item);
        } catch (error) {
          feedback.textContent = `${error.message}。复核草稿保留；请重新读取并核对。`;
        } finally {
          submit.disabled = false;
        }
      });
    };
  }
  async function loadDetail(item) {
    dialog.querySelector('[data-review-read-error]')?.remove();
    // Read a single task (up to 100 proposals), following pages if needed.
    let cursor;
    const id = projectId,
      requestId = ++sequence;
    do {
      const params = new URLSearchParams({
        jobId: item.jobId,
        limit: '50',
        ...(cursor ? { cursor } : {}),
      });
      let result;
      try {
        result = await api(`/projects/${id}/impact-reviews?${params}`);
      } catch (error) {
        if (sequence === requestId && getState()?.project.id === id && dialog.open)
          readFailure(error, () => loadDetail(item));
        return;
      }
      if (sequence !== requestId || getState()?.project.id !== id || !dialog.open) return;
      const found = result.items.find((r) => r.proposalIndex === item.proposalIndex);
      if (found) {
        detail(found);
        return;
      }
      cursor = result.nextCursor;
    } while (cursor);
    throw new Error('原影响建议已不可读取');
  }
  async function open(filter = {}) {
    projectId = getState()?.project.id;
    if (!projectId) throw new Error('请先选择研究项目');
    query = filter;
    active = null;
    header();
    node('p', '正在读取影响建议…').dataset.reviewLoading = 'true';
    if (!dialog.open) dialog.showModal();
    await load();
  }
  document.querySelector('#open-impact-reviews').onclick = () => run(() => open());
  document.querySelector('#review-selected').onclick = () =>
    run(() => open({ targetId: getSelected() }));
  return {
    open,
    onStateChange() {
      if (!dialog.open) return;
      if (getState()?.project.id !== projectId) {
        sequence++;
        dialog.close();
        active = null;
        return;
      }
      if (
        active?.current &&
        loadedTarget !==
          getState().objects.find((e) => e.id === active.current.target.id)?.versionId
      ) {
        const feedback = dialog.querySelector('[data-review-feedback]');
        if (feedback) feedback.textContent = '当前对象已变化，请重新读取并核对；草稿保留。';
      }
    },
  };
}
