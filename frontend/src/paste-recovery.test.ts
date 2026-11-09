import { describe, expect, it } from 'vitest';
import type { Command } from './api';
import { PasteRecovery, pasteNotCommitted } from './paste-recovery';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const command = (commandId: string, projectId = 'b'): Command => ({
  commandId, projectId, type: 'canvas.paste', expected: null,
  payload: { translation: { x: 1, y: 2 }, objects: [{ kind: 'text', copyId: 'copy', stack: 0,
    content: { runs: [{ text: '正文' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 100 },
    pose: { x: 0, y: 0, width: 100, height: 27 } }], connectors: [] },
}) as Command;

describe('目标粘贴恢复记录', () => {
  it('按项目保存并读回完整命令，其他项目读不到', () => {
    const storage = new MemoryStorage();
    const journal = new PasteRecovery(() => storage);
    journal.write('b', command('c1'));
    expect(journal.read('b')).toEqual({ projectId: 'b', command: command('c1') });
    expect(journal.read('a')).toBeNull();
  });

  it('清理只删除精确匹配的请求，别的请求保持原样', () => {
    const storage = new MemoryStorage();
    const journal = new PasteRecovery(() => storage);
    journal.write('b', command('c1'));
    journal.clear('b', 'other');
    expect(journal.read('b')?.command.commandId).toBe('c1');
    journal.clear('b', 'c1');
    expect(journal.read('b')).toBeNull();
  });

  it('与源项目 cutJournal 分开存放，互不覆盖', () => {
    const storage = new MemoryStorage();
    const journal = new PasteRecovery(() => storage);
    storage.setItem('forkwise.cut-pending.v1', JSON.stringify({ projectId: 'a', cutId: 'cut-1', phase: 'clipboard-written', command: command('cut', 'a') }));
    journal.write('b', command('paste'));
    expect(JSON.parse(storage.getItem('forkwise.cut-pending.v1')!).cutId).toBe('cut-1');
    journal.clear('b', 'paste');
    expect(JSON.parse(storage.getItem('forkwise.cut-pending.v1')!).cutId).toBe('cut-1');
  });

  it('存储不可用时写入失败，调用方据此停止提交', () => {
    const journal = new PasteRecovery(() => null);
    expect(() => journal.write('b', command('c1'))).toThrow('无法保存粘贴恢复记录');
    expect(journal.read('b')).toBeNull();
    // 读取存储本身抛错（隐私模式等）同样不能静默放过。
    expect(() => new PasteRecovery(() => { throw new Error('blocked'); }).write('b', command('c1'))).toThrow();
  });

  it('损坏或不属于该项目的记录读取为 null 且不被清理', () => {
    const storage = new MemoryStorage();
    const journal = new PasteRecovery(() => storage);
    storage.setItem('forkwise.paste-pending.v1:b', '{broken');
    expect(journal.read('b')).toBeNull();
    journal.clear('b', 'c1');
    expect(storage.getItem('forkwise.paste-pending.v1:b')).toBe('{broken');
  });

  it('首次发送的权限拒绝可确认未提交；重放时的同一拒绝只能按结果未知保留', () => {
    expect(pasteNotCommitted({ code: 'PROJECT_FORBIDDEN' }, 'first')).toBe(true);
    expect(pasteNotCommitted({ code: 'UNAUTHORIZED' }, 'first')).toBe(true);
    expect(pasteNotCommitted({ code: 'PROJECT_FORBIDDEN' }, 'replay')).toBe(false);
    expect(pasteNotCommitted({ code: 'UNAUTHORIZED' }, 'replay')).toBe(false);
    // 权限检查在幂等回执查询之前，重放被拒不能证明此前那次没提交。
    expect(pasteNotCommitted({ code: 'VERSION_CONFLICT' }, 'replay')).toBe(true);
    expect(pasteNotCommitted({ code: 'CUT_STATE_CONFLICT' }, 'replay')).toBe(true);
    expect(pasteNotCommitted({ code: 'IDEMPOTENCY_MISMATCH' }, 'replay')).toBe(true);
    // 503 与传输层故障可能发生在提交之后，两种阶段都按未知处理。
    expect(pasteNotCommitted({ code: 'UNAVAILABLE' }, 'first')).toBe(false);
    expect(pasteNotCommitted({ code: 'UNAVAILABLE' }, 'replay')).toBe(false);
    expect(pasteNotCommitted({ code: 'SAVE_FAILED' }, 'first')).toBe(false);
    expect(pasteNotCommitted({ code: 'SAVE_FAILED' }, 'replay')).toBe(false);
    expect(pasteNotCommitted(new TypeError('Failed to fetch'), 'first')).toBe(false);
    expect(pasteNotCommitted(new TypeError('Failed to fetch'), 'replay')).toBe(false);
  });
});
