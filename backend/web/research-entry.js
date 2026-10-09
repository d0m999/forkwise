import { RequestStore } from './request-store.js';
import { RequestJournal, draftFingerprint } from './request-journal.js';
import { textResearchPlan, fileImportPlan } from './research-entry-plans.js';

export function attachResearchEntry({
  api,
  run,
  getState,
  refresh,
  showJob,
  message,
  openMaterials,
}) {
  const $ = (s) => document.querySelector(s),
    dialog = $('#research-entry'),
    form = $('#entry-form');
  const journal = new RequestJournal(api, new RequestStore());
  const names = [
    'title',
    'text',
    'publisher',
    'url',
    'publishedAt',
    'rights',
    'coverage',
    'queries',
    'asOf',
  ];
  const key = (id) => `forkwise-research-entry:${id}`;
  let projectId = null,
    request = null,
    list = [];
  const feedback = (text, error = false) => {
    $('#entry-feedback').textContent = text;
    $('#entry-feedback').dataset.error = String(error);
  };
  const selected = () =>
    [...$('#entry-materials').querySelectorAll('input:checked')].map((x) => x.value);
  const read = () => ({
    ...Object.fromEntries(names.map((name) => [name, form.elements[name].value])),
    selected: selected(),
  });
  function save() {
    if (projectId) localStorage.setItem(key(projectId), JSON.stringify(read()));
  }
  function load() {
    form.reset();
    let draft = null;
    try {
      draft = JSON.parse(localStorage.getItem(key(projectId)) ?? 'null');
    } catch {
      feedback('本地输入草稿无法读取，原记录未删除。', true);
    }
    for (const name of names)
      if (typeof draft?.[name] === 'string') form.elements[name].value = draft[name];
    return draft?.selected ?? [];
  }
  function materials(ids = selected()) {
    const state = getState(),
      box = $('#entry-materials');
    box.replaceChildren();
    for (const version of state?.objects.filter((e) => e.kind === 'source_version') ?? []) {
      const source = state.objects.find((e) => e.id === version.data.sourceId);
      const label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.value = version.id;
      input.disabled = !version.data.textLength || version.data.parseStatus === 'failed';
      input.checked = !input.disabled && ids.includes(version.id);
      label.append(
        input,
        `${source?.data.title ?? '材料'} · ${version.data.textLength ? (version.data.coverage === 'full' ? '全文' : '局部或范围未确认') : '暂无可读文字，需转写'}${version.data.parseMessage ? ' · ' + version.data.parseMessage : ''}`,
      );
      // A fieldset remains disabled when the app releases its global operation lock.
      const row = document.createElement('fieldset');
      row.disabled = input.disabled;
      row.append(label);
      box.append(row);
    }
    if (!box.childElementCount) box.textContent = '本项目还没有材料。可粘贴原文或导入文件。';
  }
  async function update(jobs = list) {
    list = jobs;
    const id = getState()?.project.id;
    $('#open-research-entry').hidden = !id;
    $('#canvas-research-entry').hidden =
      !id || getState().objects.some((e) => ['statement', 'inference'].includes(e.kind));
    if (!id) {
      if (dialog.open) dialog.close();
      projectId = null;
      return;
    }
    if (projectId !== id) {
      if (dialog.open) dialog.close();
      projectId = id;
      request = null;
      materials(load());
      feedback('输入仅保存在本机草稿中；开始研究后使用已配置模型处理选定材料。');
    }
    let record;
    try {
      record = await journal.get(id);
    } catch {
      if (projectId !== id || getState()?.project.id !== id) return;
      $('#entry-inputs').disabled = true;
      $('#entry-recover').hidden = $('#entry-discard-request').hidden = true;
      $('#open-research-entry').textContent = '研究入口恢复存储不可用';
      $('#entry-request-status').textContent =
        '本机恢复存储不可用，尚未发送新研究请求。请重新打开页面后重试；已保存的研究仍可继续使用。';
      return;
    }
    if (projectId !== id || getState()?.project.id !== id) return;
    request = record;
    const pending = record && record.state !== 'completed';
    $('#entry-inputs').disabled = Boolean(pending);
    $('#entry-recover').hidden = !pending;
    $('#entry-discard-request').hidden = record?.state !== 'rejected';
    $('#open-research-entry').textContent = pending ? '恢复研究请求' : '输入观点 / 材料';
    $('#entry-request-status').textContent = pending
      ? `${record.label}：已完成 ${record.cursor} / ${record.steps.length} 步。${record.state === 'rejected' ? '服务端明确拒绝本步骤；已完成步骤保留。' + (record.error ?? '') : '结果尚未确认；恢复时先查询原结果，再沿用原请求。'}`
      : record
        ? `${record.label}：已确认保存。后台任务进度见下方。`
        : '';
    materials();
    const box = $('#entry-jobs');
    box.replaceChildren();
    const states = {
      queued: '等待处理',
      running: '处理中',
      succeeded: '处理完成',
      partial: '部分完成',
      failed: '执行失败',
      interrupted: '已中断',
      canceled: '已取消',
    };
    for (const job of list
      .filter((j) =>
        ['workflow.initial', 'material.parse', 'material.vision', 'source.sec-filing'].includes(
          j.kind,
        ),
      )
      .slice(-5)
      .reverse()) {
      const row = document.createElement('p'),
        button = document.createElement('button');
      row.textContent = `${job.kind === 'workflow.initial' ? '梳理与公开查证' : job.kind === 'source.sec-filing' ? '取得 SEC 申报正文' : '材料解析 / 转写'}：${states[job.state] ?? job.state}${job.error ? ' · ' + job.error : ''}${job.historyState === 'undone' ? ' · 研究结果已撤销' : job.historyState === 'stopped' ? ' · 已停止执行' : ''}`;
      button.textContent = '查看进度与结果';
      button.onclick = () =>
        run(async () => {
          const detail = await api(`/projects/${id}/jobs/${job.id}`);
          if (getState()?.project.id !== id) return;
          dialog.close();
          if (['workflow.initial', 'source.sec-filing'].includes(job.kind)) showJob(detail);
          else await openMaterials();
          $('#jobs').scrollIntoView({ block: 'start' });
        });
      row.append(button);
      box.append(row);
    }
  }
  async function finished(record) {
    if (getState()?.project.id !== record.projectId) return;
    if (record.meta.kind === 'research') {
      const saved = localStorage.getItem(key(record.projectId));
      if (
        saved &&
        (await draftFingerprint(saved)) === record.meta.draftHash &&
        localStorage.getItem(key(record.projectId)) === saved
      ) {
        localStorage.removeItem(key(record.projectId));
        form.reset();
        $('#entry-materials')
          .querySelectorAll('input')
          .forEach((x) => {
            x.checked = false;
          });
      } else if (localStorage.getItem(key(record.projectId)) !== saved) {
        materials(load());
      }
    }
    if (record.meta.kind === 'file') form.elements.file.value = '';
    await refresh(true);
    feedback(
      record.meta.kind === 'filing'
        ? '申报正文获取请求已恢复，可在任务结果查看保存正文和实际缺口；研究判断保持。'
        : record.meta.kind === 'file'
          ? '原文件已保存并进入解析。解析完成后，明确选择下面的可读材料版本，再开始研究；图片须先转写。'
          : '研究已排队，候选与查证结果会出现在同一画布；任务完成不表示观点成立。',
    );
    message($('#entry-feedback').textContent);
    await update();
  }
  async function execute(work) {
    const id = getState()?.project.id;
    if (!id) throw new Error('请先新建或选择研究项目');
    try {
      const started = await work(id);
      await finished(await journal.resume(id, started?.id));
    } catch (error) {
      await update();
      if (request?.state === 'pending' && error instanceof TypeError)
        error.message = '连接中断或返回内容无法读取；输入已保留，请恢复原研究请求。';
      feedback(error.message, true);
      throw error;
    }
  }
  const open = async () => {
    await update();
    if (!getState()) return;
    if (!dialog.open) dialog.showModal();
    if (!request || request.state === 'completed') form.elements.text.focus();
  };
  $('#open-research-entry').onclick = $('#canvas-research-entry button').onclick = () => run(open);
  $('#entry-close').onclick = () => {
    dialog.close();
  };
  form.oninput = form.onchange = () => {
    try {
      save();
    } catch {
      feedback('本机草稿空间不足，文字尚在窗口中；请缩短内容或导入文件。', true);
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    run(() =>
      execute(async (id) => {
        save();
        return journal.start(id, textResearchPlan(read(), selected()));
      }),
    );
  };
  $('#entry-upload').onclick = () =>
    run(() =>
      execute(async (id) => {
        save();
        return journal.start(id, await fileImportPlan(read(), form.elements.file.files[0]));
      }),
    );
  $('#entry-recover').onclick = () => run(() => execute(async () => {}));
  $('#entry-discard-request').onclick = () =>
    run(async () => {
      const record = await journal.get(projectId);
      await journal.discard(projectId);
      await refresh(true);
      const imported =
        record?.results
          .flatMap((r) => r.upserted ?? [])
          .filter((e) => e.kind === 'source_version')
          .map((e) => e.id) ?? [];
      if (imported.length) {
        form.elements.text.value = '';
        materials(imported);
        save();
      }
      feedback('已回到输入；已保存的材料仍可选择，不会重复导入已完成的文字。');
      await update();
    });
  $('#entry-clear').onclick = () => {
    if (request && request.state !== 'completed') return;
    localStorage.removeItem(key(projectId));
    form.reset();
    materials([]);
    feedback('已清空本次输入草稿，保存的材料与研究保持。');
  };
  return {
    update,
    open,
    async submitTask(id, endpoint, body, label = '创建研究任务') {
      const started = await journal.start(id, {
        label,
        meta: {
          kind:
            endpoint === '/files/import'
              ? 'file'
              : endpoint === '/public-data/filing'
                ? 'filing'
                : 'task',
        },
        steps: [{ endpoint, body }],
      });
      try {
        return (await journal.resume(id, started.id)).results[0];
      } catch (error) {
        await update();
        throw error;
      }
    },
  };
}
