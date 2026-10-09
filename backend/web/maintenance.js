export function attachMaintenance({ api, run, message, getState, projects, jobs }) {
  const $ = (s) => document.querySelector(s);
  $('#create-backup').onclick = () =>
    run(async () => {
      const result = await api('/backups', 'POST', undefined, crypto.randomUUID());
      message(`本机一致性备份已完成：${result.id}`);
      await listBackups();
    });
  async function listBackups() {
    const rows = await api('/backups');
    const box = $('#backup-list');
    box.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('p');
      item.textContent = new Date(row.createdAt).toLocaleString() + ' ';
      const button = document.createElement('button');
      button.textContent = '隔离恢复并校验';
      button.onclick = () =>
        run(async () => {
          const result = await api(
            `/backups/${row.id}/restore-isolated`,
            'POST',
            undefined,
            crypto.randomUUID(),
          );
          $('#maintenance-result').textContent =
            `恢复校验已通过。副本目录：${result.directory}\n当前研究保持打开。使用本机恢复命令确认切换后再重启。`;
        });
      item.append(button);
      box.append(item);
    }
  }
  $('#list-backups').onclick = () => run(listBackups);
  $('#trash-project').onclick = () =>
    run(async () => {
      const state = getState();
      if (!state) throw new Error('请先选择项目');
      const settings = await api('/settings/retention');
      const name = window.prompt(
        `删除后保留 ${settings.retentionDays} 天，随后清理主库和本机受管理备份副本。请输入项目名称确认：${state.project.name}`,
      );
      if (name === null) return;
      const result = await api(
        `/projects/${state.project.id}/trash`,
        'POST',
        { expectedRevision: state.project.revision, confirmName: name },
        crypto.randomUUID(),
      );
      await projects();
      message(`项目已移入回收区，预计清理：${new Date(result.purgeAfter).toLocaleString()}`);
    });
  $('#list-trash').onclick = () =>
    run(async () => {
      const rows = await api('/trash');
      const box = $('#trash-list');
      box.replaceChildren();
      for (const row of rows) {
        const item = document.createElement('p');
        item.textContent = `${row.name} · 剩余 ${row.remainingDays} 天 `;
        if (row.remainingDays > 0) {
          const button = document.createElement('button');
          button.textContent = '恢复项目';
          button.onclick = () =>
            run(async () => {
              const p = await api(
                `/projects/${row.id}/restore`,
                'POST',
                undefined,
                crypto.randomUUID(),
              );
              await projects(p.id);
              item.remove();
              message('项目已恢复；原来取消的任务可按需重新发起');
            });
          item.append(button);
        }
        box.append(item);
      }
    });
  $('#retention').onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const days = Number(event.target.elements.days.value);
      await api('/settings/retention', 'PUT', { retentionDays: days }, crypto.randomUUID());
      message(`后续删除操作保留 ${days} 天；已有删除的恢复截止时间保持不变`);
    });
  };
  $('#purge-expired').onclick = () =>
    run(async () => {
      if (!window.confirm('清理已过恢复窗口的项目及受管理的本机副本？此操作无法恢复。')) return;
      const result = await api('/maintenance/purge-expired', 'POST', {
        confirm: 'purge-expired-projects',
      });
      $('#maintenance-result').textContent = result.length
        ? JSON.stringify(result, null, 2)
        : '没有已过恢复窗口的项目';
    });
  $('#fetch-sec').onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const state = getState();
      if (!state) throw new Error('请先选择项目');
      await api(
        `/projects/${state.project.id}/public-data`,
        'POST',
        {
          sourceId: 'sec-edgar',
          cik: event.target.elements.cik.value,
          dataset: event.target.elements.dataset.value,
          refresh: true,
        },
        crypto.randomUUID(),
      );
      message('公开材料获取任务已创建，进度与实际失败原因见任务列表');
      await jobs();
    });
  };
}
