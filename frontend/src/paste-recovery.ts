import type { Command } from './api';

// 目标粘贴请求的持久恢复：提交前保存最终完整命令（含 action 补入的 placement、冻结资源、
// 落点与全部目标 ID），刷新后按原 commandId 重放。与源项目的 cutJournal 分开存放，
// 两者按各自的键定位，互不覆盖。
const PREFIX = 'forkwise.paste-pending.v1:';
const SCHEMA = 1;
export type PendingPaste = { projectId: string; command: Command };

function defaultStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
function key(projectId: string) {
  return PREFIX + projectId;
}
function parse(raw: string, projectId: string): PendingPaste | null {
  try {
    const record = JSON.parse(raw) as { schema?: unknown; projectId?: unknown; command?: unknown };
    const command = record.command as Partial<Command> | null | undefined;
    if (record.schema !== SCHEMA || record.projectId !== projectId || !command) return null;
    if (typeof command.commandId !== 'string' || !command.commandId) return null;
    if (typeof command.type !== 'string' || !command.type) return null;
    if (command.projectId !== projectId) return null;
    return { projectId, command: command as Command };
  } catch { return null; }
}

export class PasteRecovery {
  constructor(private readonly source: () => Storage | null = defaultStorage) {}

  read(projectId: string): PendingPaste | null {
    const storage = this.source();
    if (!storage) return null;
    const raw = storage.getItem(key(projectId));
    return raw === null ? null : parse(raw, projectId);
  }

  // 写不进去就不提交目标请求：调用方据此中止，源内容仍可由源项目历史恢复。
  write(projectId: string, command: Command) {
    const storage = this.source();
    if (!storage) throw new Error('无法保存粘贴恢复记录，未提交本次粘贴');
    try {
      storage.setItem(key(projectId), JSON.stringify({ schema: SCHEMA, projectId, command }));
    } catch {
      throw new Error('无法保存粘贴恢复记录，未提交本次粘贴');
    }
  }

  // 只清理精确匹配的请求：同项目已有别的请求时保持原记录，不误删可恢复的载荷。
  clear(projectId: string, commandId: string) {
    const storage = this.source();
    if (!storage) return;
    try {
      const raw = storage.getItem(key(projectId));
      if (raw === null) return;
      const pending = parse(raw, projectId);
      if (pending?.command.commandId === commandId) storage.removeItem(key(projectId));
    } catch { /* 清理失败时保留记录，下次按原 commandId 幂等重放 */ }
  }
}

export const pasteJournal = new PasteRecovery();

// 服务端在幂等回执查询之后抛出的拒绝才证明“重放没有命中已提交的回执”。
// INVALID_COMMAND 虽然发生在查询之前，但持久化的是本机刚发送过的同一份对象，
// 解析结果确定：首次发送若解析失败就从未进入事务，重放同样不会。
// IDEMPOTENCY_MISMATCH 表示该 commandId 已存有“另一份请求”的回执：本载荷确实没有写入，
// 与本次内容重复粘贴无关，按可确认未提交处理。
const AFTER_RECEIPT_LOOKUP = new Set([
  'VERSION_CONFLICT', 'NOT_FOUND', 'ID_CONFLICT', 'IDEMPOTENCY_MISMATCH',
  'INVALID_COMMAND', 'INVALID_ENDPOINT', 'INVALID_TAGS', 'INVALID_IMAGE', 'INVALID_GROUP_MEMBER',
  'EXPECTED_DOMAINS', 'MEDIA_NOT_PERSISTED', 'TAG_NAME_CONFLICT',
  'CUT_NOT_FOUND', 'CUT_STATE_CONFLICT', 'CUT_RESTORE_MISSING', 'CUT_OUTER_CHANGED', 'CUT_OUTER_UNKNOWN',
]);
// 503/传输层故障可能发生在服务端提交之后：无论第几次尝试都只能按结果未知处理。
// SAVE_FAILED 是 execute 未知异常的兜底 503，可能发生在事务提交之后，同样按未知处理。
const POSSIBLY_COMMITTED = new Set(['UNAVAILABLE', 'SAVE_FAILED', 'INTERNAL']);
export type PasteAttempt = 'first' | 'replay';

export function pasteNotCommitted(error: unknown, attempt: PasteAttempt): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || POSSIBLY_COMMITTED.has(code)) return false;
  // 第一次发送：命令编号此前从未发出，服务端拒绝（含权限类）发生在提交之前，事务已回滚。
  if (attempt === 'first') return true;
  // 重放：权限检查在幂等回执查询之前，不能证明此前一次没提交；只有查询之后的拒绝才算。
  return AFTER_RECEIPT_LOOKUP.has(code);
}
