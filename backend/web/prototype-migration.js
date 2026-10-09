const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const save = (value, name) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = element('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const download = (text, value, name) => {
  const button = element('button', text);
  button.type = 'button';
  button.onclick = () => save(value, name);
  return button;
};

// Split before sending, so each project keeps only its own private recovery data.
export function isolatePrototypeProject(workspace, projectId) {
  if (
    workspace?.format !== 'forkwise-prototype-workspace' ||
    workspace.version !== 1 ||
    !Array.isArray(workspace.projects)
  )
    throw new Error('请选择从旧版原型导出的研究副本。');
  const ids = workspace.projects.map((entry) => entry?.[0]);
  if (
    new Set(ids).size !== ids.length ||
    workspace.projects.some((entry) => !Array.isArray(entry) || entry.length !== 2)
  )
    throw new Error('副本中的项目身份重复或结构不完整。');
  const selected = workspace.projects.find(([id]) => id === projectId);
  if (!selected) throw new Error('所选旧版项目不存在。');
  return {
    format: workspace.format,
    version: workspace.version,
    activeProjectId: projectId,
    projectSerial: workspace.projectSerial,
    openProjectIds: [projectId],
    ...(typeof workspace.navPinned === 'boolean' ? { navPinned: workspace.navPinned } : {}),
    projects: [selected],
    aiThreads: (workspace.aiThreads ?? []).filter(
      ([key]) => typeof key === 'string' && key.startsWith(`${projectId}:`),
    ),
  };
}

function showReport(root, report, imported = false) {
  root.append(
    element('h3', report.name),
    element(
      'p',
      `${imported ? '已迁入独立项目' : '将创建独立项目'}：${report.counts.statement ?? 0} 项主张、${report.counts.inference ?? 0} 步推导、${report.counts.source_version ?? 0} 份材料、${report.counts.evidence_link ?? 0} 条有效证据关联。`,
    ),
  );
  root.append(
    element('p', '当前个人立场和内容归属保留。新版本历史从导入时开始；旧版模拟查证保留在旧档。'),
  );
  if (report.converter === 'prototype-v1-to-project-v2')
    root.append(
      element(
        'p',
        `对象材料：${report.counts.includedMaterials ?? 0} 项可见归属、${report.counts.excludedMaterials ?? 0} 项隐藏记录；${report.counts.imageEvidence ?? 0} 处原图区域证据。隐藏材料保留其原有证据。`,
      ),
    );
  const retained = element('ul');
  report.retained.forEach((text) => retained.append(element('li', text)));
  root.append(element('h4', '保留为只读旧档'), retained);
  const issues = element('details');
  issues.append(element('summary', `${report.issues.length} 项转换说明与待处理内容`));
  const rows = element('ul');
  report.issues.forEach((i) => rows.append(element('li', `${i.path}：${i.message}`)));
  issues.append(rows);
  root.append(issues);
  root.append(download('下载迁移说明', report, 'forkwise-migration-report.json'));
}

function showGraph(root, graph, title) {
  const entries = [...Object.values(graph?.nodes ?? {}), ...Object.values(graph?.edges ?? {})];
  const details = element('details');
  details.append(element('summary', `${title}（${entries.length} 项）`));
  let loaded = false;
  details.ontoggle = () => {
    if (!details.open || loaded) return;
    loaded = true;
    for (const n of entries) {
      const row = element('details');
      row.append(
        element('summary', `${n.type === 'inference' ? '推导' : '主张'} · ${n.text ?? ''}`),
      );
      row.append(
        element(
          'p',
          `${n.id} · 旧版 v${n.version} · ${n.origin ?? '归属未记录'} · ${n.stance ?? '未记录立场'}`,
        ),
      );
      if (n.type === 'inference')
        row.append(
          element(
            'p',
            `前提：${(n.premises ?? []).join('、')} → ${n.conclusion}；${n.combination ?? ''}`,
          ),
        );
      if (n.reason) row.append(element('p', `立场理由：${n.reason}`));
      if (n.sourceRef?.quote) row.append(element('blockquote', n.sourceRef.quote));
      for (const version of n.history ?? [])
        row.append(element('p', `旧版 v${version.version}：${version.text ?? ''}`));
      for (const stance of n.stanceHistory ?? [])
        row.append(
          element(
            'p',
            `立场变化（${stance.at ?? '时间未记录'}）：${stance.before?.value ?? ''} → ${stance.after?.value ?? ''}；${stance.after?.reason ?? ''}`,
          ),
        );
      for (const correction of n.correctionHistory ?? [])
        row.append(
          element(
            'p',
            `整理校正：${correction.before ?? ''} → ${correction.after ?? ''}；${correction.reason ?? ''}`,
          ),
        );
      for (const note of n.notes ?? [])
        if (note.text) row.append(element('p', `待查问题：${note.text}`));
      for (const evidence of n.evidence ?? [])
        row.append(
          element(
            'p',
            `旧引用（${evidence.effect ?? '作用未记录'}）：${evidence.ref?.quote ?? '图像区域，请从完整副本恢复查看'}；${evidence.reason ?? ''}`,
          ),
        );
      if (n.verification)
        row.append(
          element(
            'p',
            `旧查证（含原型模拟，未作为当前结果）：${n.verification.explanation ?? n.verification.status ?? ''}`,
          ),
        );
      if (n.verificationNode)
        row.append(
          element(
            'p',
            `旧验证节点：${n.verificationNode.event ?? ''}；${n.verificationNode.goal ?? ''}；${n.verificationNode.period ?? ''}；${n.verificationNode.date || '日期未知'}`,
          ),
        );
      details.append(row);
    }
  };
  root.append(details);
}

function showLegacy(root, workspace, report) {
  const project = workspace.projects[0][1],
    study = project.study;
  root.append(
    element('h3', '只读旧版记录'),
    element(
      'p',
      '这些记录保留导入时的旧版状态。可复制草稿继续研究；完整画布、附件和撤销栈可通过恢复副本在旧原型查看。',
    ),
  );
  if (report?.issues.some((i) => i.code === 'RESTRICTED_RECOVERY'))
    root.append(element('p', '旧档含受限来源，此处不提供完整副本导出；请保留原先持有的本机文件。'));
  else root.append(download('下载旧原型恢复副本', workspace, 'forkwise-prototype-recovery.json'));
  showGraph(root, study.mine, '导入时的研究画布');
  showGraph(root, study.author, '作者整理原版');
  showGraph(root, study.baseline, '初始对照');
  const drafts = element('details');
  drafts.append(element('summary', '查看与复制旧草稿'));
  for (const [label, value] of [
    ['输入材料', project.composer?.text],
    ['未导入材料', project.readerDraft?.text],
    ...Object.entries(project.formCache ?? {}).flatMap(([key, value]) =>
      Object.entries(value ?? {})
        .filter(([, v]) => typeof v === 'string')
        .map(([field, v]) => [`${key} / ${field}`, v]),
    ),
    ...Object.entries(project.canvasState?.drafts ?? {}).flatMap(([key, d]) => [
      [`${key} 正文`, d.text],
      [`${key} 理由`, d.reason],
    ]),
    ...(workspace.aiThreads ?? []).map(([key, thread]) => [`${key} AI 讨论问题`, thread.question]),
  ]) {
    if (typeof value === 'string' && value) {
      const field = element('label', label),
        area = element('textarea');
      area.value = value;
      area.readOnly = true;
      field.append(area);
      drafts.append(field);
    }
  }
  root.append(drafts);
  for (const [key, label] of [
    ['past', '旧撤销记录'],
    ['future', '旧重做记录'],
  ]) {
    const history = element('details'),
      entries = project.timeline?.[key] ?? [];
    history.append(element('summary', `${label}（${entries.length} 步）`));
    for (const entry of entries) {
      const row = element('details');
      row.append(element('summary', entry.label));
      showGraph(row, entry.before?.study?.mine ?? entry.before?.study?.author, '操作前');
      showGraph(row, entry.after?.study?.mine ?? entry.after?.study?.author, '操作后');
      history.append(row);
    }
    root.append(history);
  }
}

export function attachPrototypeMigration({ api, run, message, projects, getState }) {
  const fileInput = document.querySelector('#import-prototype'),
    dialog = document.querySelector('#prototype-migration-dialog'),
    root = dialog.querySelector('.migration-content');
  const open = () => {
    root.replaceChildren();
    dialog.querySelector('.migration-feedback').textContent = '';
    dialog.scrollTop = 0;
    if (!dialog.open) dialog.showModal();
  };
  const inDialog = (fn) =>
    run(async () => {
      const feedback = dialog.querySelector('.migration-feedback');
      feedback.textContent = '';
      try {
        await fn();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.scrollIntoView({ block: 'nearest' });
        throw error;
      }
    });
  dialog.querySelector('[data-migration-close]').onclick = () => dialog.close();
  fileInput.onchange = () =>
    run(async () => {
      const file = fileInput.files[0];
      if (!file) return;
      if (file.size > 80 * 1024 * 1024)
        throw new Error('旧版副本超过 80 MB，请保留原文件并拆分后迁移。');
      const workspace = JSON.parse(await file.text());
      if (!Array.isArray(workspace.projects) || !workspace.projects.length)
        throw new Error('旧版研究副本没有项目。');
      isolatePrototypeProject(workspace, workspace.projects[0][0]);
      open();
      root.append(
        element('h2', '预览旧版研究迁移'),
        element(
          'p',
          '每次选择一个项目，新建后端项目并保留该项目完整旧档。原文件保持在本机，其他项目不会一同上传。',
        ),
      );
      const label = element('label', '选择旧版项目'),
        select = element('select');
      select.setAttribute('aria-label', '选择旧版项目');
      workspace.projects.forEach(([id, p]) => {
        const option = element('option', p.name || p.study?.question || id);
        option.value = id;
        select.append(option);
      });
      label.append(select);
      root.append(label);
      const inspect = element('button', '预览转换结果'),
        result = element('div');
      root.append(inspect, result);
      let generation = 0;
      select.onchange = () => {
        generation++;
        result.replaceChildren();
      };
      inspect.onclick = () =>
        inDialog(async () => {
          const current = ++generation,
            scoped = isolatePrototypeProject(workspace, select.value);
          const preview = await api('/prototype-migrations/preview', 'POST', { workspace: scoped });
          if (current !== generation) return;
          result.replaceChildren();
          showReport(result, preview.report);
          showLegacy(result, scoped, preview.report);
          const confirm = element('button', '确认迁移为新项目', 'primary');
          result.prepend(confirm);
          const key = crypto.randomUUID();
          let committed = false;
          confirm.onclick = () =>
            inDialog(async () => {
              if (committed || current !== generation) return;
              let imported;
              try {
                imported = await api(
                  '/prototype-migrations',
                  'POST',
                  { workspace: scoped, previewHash: preview.previewHash },
                  key,
                );
              } catch (error) {
                if (!error.code)
                  throw new Error(
                    '迁移结果暂未确认。请保留此窗口，再次点击确认将用同一操作键安全重试。',
                  );
                throw error;
              }
              committed = true;
              confirm.remove();
              dialog.close();
              await projects(imported.project.id);
              message(
                '旧版研究已迁入新项目；可从“查看旧版迁移记录”查阅原版、草稿、历史和恢复副本。',
              );
            });
        });
      fileInput.value = '';
    });
  document.querySelector('#show-prototype-migration').onclick = () =>
    run(async () => {
      const projectId = getState()?.project.id;
      if (!projectId) throw new Error('先选择研究项目。');
      const saved = await api(`/projects/${projectId}/prototype-migration`);
      if (getState()?.project.id !== projectId) return;
      open();
      root.append(element('h2', '旧版迁移记录'));
      showReport(root, saved.report, true);
      showLegacy(root, saved.workspace, saved.report);
    });
}
