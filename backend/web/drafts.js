export class DraftStore {
  constructor(storage = localStorage, prefix = 'forkwise-editor-draft') {
    this.storage = storage;
    this.prefix = prefix;
  }
  key(projectId, id) {
    return `${this.prefix}:${projectId}:${id}`;
  }
  get(projectId, id) {
    try {
      return JSON.parse(this.storage.getItem(this.key(projectId, id)) ?? 'null');
    } catch {
      return null;
    }
  }
  put(projectId, id, draft) {
    this.storage.setItem(this.key(projectId, id), JSON.stringify(draft));
  }
  remove(projectId, id) {
    this.storage.removeItem(this.key(projectId, id));
  }
  list(projectId) {
    return Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i))
      .filter((k) => k?.startsWith(`${this.prefix}:${projectId}:`))
      .map((k) => ({ id: k.split(':').at(-1), draft: JSON.parse(this.storage.getItem(k)) }));
  }
}
