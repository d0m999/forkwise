import type { Command } from './api';
import { UNKNOWN_RESULT_CODES } from '../../backend/src/mapping/recovery-contract';

// 跨项目剪切的目标粘贴请求的持久恢复：提交前保存最终完整命令（含 action 补入的 placement、
// 冻结资源、落点与全部目标 ID），刷新后按原 commandId 重放。与源项目的 cutJournal 分开存放。
// 这是本机临时恢复记录，不是项目领域数据：不进导出／备份／投影，也不做跨设备同步（D467）。
// 工程口径与边界见 docs/adr/0028-cross-project-paste-recovery.md。
const PREFIX = 'forkwise.paste-pending.v1:';
const SCHEMA = 1;
export type PendingPaste = { projectId: string; command: Command };

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
  // 注入存储只为让写入失败与损坏记录可在单测中构造；默认源就是当前窗口的 localStorage。
  constructor(private readonly source: () => Storage | null = () => {
    try { return window.localStorage; } catch { return null; }
  }) {}

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

// 分类不手抄业务错误码清单：execute 只有两个「结果未知」出口——未知异常的兜底
// 503 SAVE_FAILED，以及无响应码的传输层故障（API 层补 UNAVAILABLE）。其余响应都是
// DomainError 业务拒绝，事务已回滚、确定未提交；其中包括 SNAPSHOT_UNAVAILABLE 这类
// 503（创建序位读取发生在事务持久化之前），不能与兜底 503 混为一类。
// 服务端新增或改名业务拒绝码自动落进正确分支，无需两端同步清单。
export type PasteAttempt = 'first' | 'replay';

export function pasteNotCommitted(error: unknown, attempt: PasteAttempt): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  // 传输层故障没有响应状态，兜底 503 可能发生在提交之后，两者都只能按结果未知处理。
  if (typeof status !== 'number' || status < 400) return false;
  if (typeof code === 'string' && UNKNOWN_RESULT_CODES.includes(code)) return false;
  // 第一次发送：命令编号此前从未发出，业务拒绝都发生在事务回滚之后。
  if (attempt === 'first') return true;
  // 重放：解析类拒绝在回执查询之前，但对同一份本机持久化载荷结果确定，能证明从未进入事务；
  // 事务内校验发生在回执查询之后，同样能证明。只有权限类（401/403）在查询之前且不确定。
  return status !== 401 && status !== 403;
}
