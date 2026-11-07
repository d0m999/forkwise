import type { Command } from './api';

// 窄范围剪切恢复：只记原请求与阶段。剪贴板写入成功后提交；确认回执或明确拒绝后清除。
// 未知 ACK 保留原 commandId 与 expected，下次加载重试；粘贴路径绝不补做剪切。
const KEY = 'forkwise.cut-pending.v1';
export type PendingCut = { projectId: string; cutId: string; phase: 'clipboard-written'; command: Command };

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
export const cutJournal = {
  read(): PendingCut | null {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as PendingCut;
      return value?.phase === 'clipboard-written' && typeof value.cutId === 'string' && typeof value.projectId === 'string' && value.command
        ? value : null;
    } catch { return null; }
  },
  write(value: PendingCut) {
    try { storage()?.setItem(KEY, JSON.stringify(value)); } catch { /* 存储不可用时由内存中的待处理请求负责重试 */ }
  },
  clear() {
    try { storage()?.removeItem(KEY); } catch { /* 同上 */ }
  },
};
