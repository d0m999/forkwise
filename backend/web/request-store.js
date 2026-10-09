// One transaction owns each update, including competing browser tabs.
export class RequestStore {
  constructor(name = 'forkwise-research-requests') {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('requests');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('本地恢复存储被其他页面占用，请关闭旧页面后重试'));
    });
    // Opening storage may fail before the first caller awaits it.
    this.database.catch(() => {});
  }
  async get(key) {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('requests', 'readonly');
      const request = tx.objectStore('requests').get(key);
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = () => reject(tx.error ?? new Error('无法读取本地研究请求'));
    });
  }
  async change(key, update) {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('requests', 'readwrite');
      const store = tx.objectStore('requests'),
        request = store.get(key);
      let result, failure;
      request.onsuccess = () => {
        try {
          result = update(request.result ?? null);
          if (result === null) store.delete(key);
          else store.put(result, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('无法保存恢复请求；未发送新操作'));
    });
  }
}
