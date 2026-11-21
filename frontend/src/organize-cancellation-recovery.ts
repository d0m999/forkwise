import { OrganizeRequest } from '../../backend/src/mapping/organize-contracts';

const KEY = 'forkwise.organize-cancellation.v1';
type PendingCancellation = { projectId: string; request: OrganizeRequest };

export const organizeCancellationJournal = {
  read(): Map<string, PendingCancellation> {
    const pending = new Map<string, PendingCancellation>();
    try {
      const values: unknown = JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]');
      if (!Array.isArray(values)) return pending;
      for (const value of values) {
        if (typeof value?.projectId !== 'string' || !value.projectId) continue;
        const request = OrganizeRequest.safeParse(value.request);
        if (request.success && request.data.mode === 'real') {
          pending.set(request.data.requestId, { projectId: value.projectId, request: request.data });
        }
      }
    } catch { /* 存储不可用时，本页仍可在内存中保留待确认请求。 */ }
    return pending;
  },
  write(pending: Map<string, PendingCancellation>): boolean {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify([...pending.values()]));
      return true;
    } catch {
      return false;
    }
  },
};
