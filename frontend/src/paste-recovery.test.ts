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

  it('业务拒绝可确认未提交，兜底 503 与传输层故障按结果未知', () => {
    // 首次发送：命令编号从未发出，所有真实业务拒绝都发生在事务回滚之后。
    for (const [code, status] of [['INVALID_COMMAND', 400], ['NOT_FOUND', 404], ['VERSION_CONFLICT', 409],
      ['INVALID_IMAGE', 413], ['EXPECTED_DOMAINS', 422], ['SNAPSHOT_UNAVAILABLE', 503]] as const)
      expect(pasteNotCommitted({ code, status }, 'first')).toBe(true);
    // 业务性 503（创建序位读取在事务前）确定未提交，不能与兜底 503 混为一类。
    expect(pasteNotCommitted({ code: 'SNAPSHOT_UNAVAILABLE', status: 503 }, 'replay')).toBe(true);
    // 权限拒绝在首次发送同样可确认未提交；重放时权限检查先于幂等回执查询，不能证明此前没提交。
    expect(pasteNotCommitted({ code: 'PROJECT_FORBIDDEN', status: 403 }, 'first')).toBe(true);
    expect(pasteNotCommitted({ code: 'PROJECT_FORBIDDEN', status: 403 }, 'replay')).toBe(false);
    expect(pasteNotCommitted({ code: 'UNAUTHORIZED', status: 401 }, 'replay')).toBe(false);
    // 解析与事务内校验：同一份持久化载荷的判定确定，重放可确认未提交。
    expect(pasteNotCommitted({ code: 'INVALID_COMMAND', status: 400 }, 'replay')).toBe(true);
    expect(pasteNotCommitted({ code: 'VERSION_CONFLICT', status: 409 }, 'replay')).toBe(true);
    expect(pasteNotCommitted({ code: 'CUT_STATE_CONFLICT', status: 409 }, 'replay')).toBe(true);
    expect(pasteNotCommitted({ code: 'IDEMPOTENCY_MISMATCH', status: 409 }, 'replay')).toBe(true);
    // execute 的兜底 503 可能发生在事务提交之后，两种阶段都按未知处理。
    expect(pasteNotCommitted({ code: 'SAVE_FAILED', status: 503 }, 'first')).toBe(false);
    expect(pasteNotCommitted({ code: 'SAVE_FAILED', status: 503 }, 'replay')).toBe(false);
    expect(pasteNotCommitted({ code: 'UNAVAILABLE', status: 503 }, 'first')).toBe(false);
    // 传输层故障没有响应状态。
    expect(pasteNotCommitted(new TypeError('Failed to fetch'), 'first')).toBe(false);
    expect(pasteNotCommitted(new TypeError('Failed to fetch'), 'replay')).toBe(false);
  });
});
