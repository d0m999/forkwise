import { it, expect } from 'vitest';
import { CanvasRecoveryStore } from '../web/canvas-recovery.js';
function storage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i],
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
it('多次画布失败分别保存，重开页面可恢复且项目隔离；空间不足不声称持久保存', () => {
  const memory = storage(),
    store = new CanvasRecoveryStore(memory),
    entry = {
      at: new Date().toISOString(),
      action: { type: 'create', text: '尚未保存' },
      layout: { version: 2 },
    };
  store.add('a', entry);
  store.add('a', { ...entry, action: { type: 'delete', ids: ['s'] } });
  store.add('b', entry);
  expect(new CanvasRecoveryStore(memory).list('a')).toHaveLength(2);
  const failed = new CanvasRecoveryStore({
    ...memory,
    setItem: () => {
      throw new Error('quota');
    },
  });
  const result = failed.add('a', entry);
  expect(result.persisted).toBe(false);
  expect(failed.list('a').some((r) => r.id === result.record.id && !r.persisted)).toBe(true);
  failed.remove('a', result.record.id);
  expect(failed.list('a')).toHaveLength(2);
  expect(store.list('b')).toHaveLength(1);
});
