// Failed canvas operations remain separate from saved graph state. In particular,
// an unknown HTTP result must be resolved with its original operation key first.
export class CanvasRecoveryStore {
  constructor(storage = localStorage, legacyStorage = globalThis.sessionStorage) {
    this.storage = storage;
    this.unsaved = new Map();
    this.legacyStorage = legacyStorage;
    this.legacySeen = new Set();
  }
  prefix(projectId) {
    return `forkwise-canvas-recovery:${projectId}:`;
  }
  add(projectId, entry) {
    const id = crypto.randomUUID(),
      record = { ...entry, id, projectId };
    try {
      this.storage.setItem(this.prefix(projectId) + id, JSON.stringify(record));
      return { record, persisted: true };
    } catch {
      this.unsaved.set(id, record);
      return { record, persisted: false };
    }
  }
  list(projectId) {
    const legacyKey = `forkwise-canvas-recovery:${projectId}`;
    if (!this.legacySeen.has(projectId)) {
      this.legacySeen.add(projectId);
      try {
        const legacy = JSON.parse(this.legacyStorage?.getItem(legacyKey) ?? 'null');
        if (legacy?.action && legacy?.at) {
          const saved = this.add(projectId, legacy);
          if (saved.persisted) this.legacyStorage.removeItem(legacyKey);
        }
      } catch {}
    }
    const records = [];
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(this.prefix(projectId))) continue;
        try {
          records.push({ ...JSON.parse(this.storage.getItem(key)), persisted: true });
        } catch {}
      }
    } catch {}
    records.push(
      ...[...this.unsaved.values()]
        .filter((r) => r.projectId === projectId)
        .map((r) => ({ ...r, persisted: false })),
    );
    return records.sort((a, b) => b.at.localeCompare(a.at));
  }
  remove(projectId, id) {
    this.storage.removeItem(this.prefix(projectId) + id);
    this.unsaved.delete(id);
  }
}

export function attachCanvasRecovery({ store, getProjectId, message }) {
  const button = document.querySelector('#show-canvas-recovery'),
    box = document.querySelector('#canvas-recovery-list');
  function render() {
    const projectId = getProjectId();
    box.replaceChildren();
    if (!projectId) return;
    const records = store.list(projectId);
    button.textContent = `查看画布恢复草稿（${records.length}）`;
    for (const record of records) {
      const row = document.createElement('div'),
        label = document.createElement('p');
      label.textContent = `${new Date(record.at).toLocaleString()} · ${record.action.type} · ${record.error ?? '操作尚未确认'}${record.persisted ? '' : ' · 仅留在当前页面，请立即导出'}`;
      const download = document.createElement('button');
      download.textContent = '导出完整恢复副本';
      download.onclick = () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `forkwise-canvas-recovery-${record.id}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const remove = document.createElement('button');
      remove.textContent = '放弃此恢复草稿';
      remove.onclick = () => {
        if (!confirm('放弃此未完成操作的恢复副本？已保存研究保持。')) return;
        store.remove(projectId, record.id);
        render();
      };
      const preview = document.createElement('details'),
        title = document.createElement('summary'),
        text = document.createElement('pre');
      title.textContent = '查看操作内容';
      const serialized = JSON.stringify(record.action, null, 2);
      text.textContent =
        serialized.length > 20000
          ? serialized.slice(0, 20000) + '\n预览已截短，完整内容请导出副本。'
          : serialized;
      preview.append(title, text);
      row.append(label, download, remove, preview);
      box.append(row);
    }
    if (!records.length) box.textContent = '当前项目没有未完成的画布恢复草稿。';
  }
  button.onclick = render;
  return () => {
    render();
    box.closest('details').open = true;
    message('画布保存失败，已更新恢复草稿列表。结果未知时先恢复原操作，再依据副本核对。', true);
  };
}
