import { OrganizeRequest } from '../../backend/src/mapping/organize-contracts';

const KEY = 'forkwise.organize-cancellation.v1';
type PendingCancellation = { projectId: string; request: OrganizeRequest };

function readPending(): Map<string, PendingCancellation> | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }

  const pending = new Map<string, PendingCancellation>();
  if (raw === null) return pending;
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return pending;
  }
  if (!Array.isArray(values)) return pending;
  for (const value of values) {
    if (typeof value?.projectId !== 'string' || !value.projectId) continue;
    const request = OrganizeRequest.safeParse(value.request);
    if (request.success && request.data.mode === 'real') {
      pending.set(request.data.requestId, { projectId: value.projectId, request: request.data });
    }
  }
  return pending;
}

export function createOrganizeCancellationJournal() {
  let saved = readPending();
  let pending = saved ?? new Map<string, PendingCancellation>();
  const unsaved = new Map<string, PendingCancellation | null>();

  return {
    get snapshot() { return { pending, saved }; },
    update(projectId: string, request: OrganizeRequest, status: 'pending' | 'settled'): boolean {
      unsaved.set(request.requestId, status === 'pending' ? { projectId, request } : null);
      // 读回旧记录后才能整表写入。存储暂不可用时，本页先保留增加和清除操作。
      saved ??= readPending();
      pending = new Map(saved);
      for (const [id, value] of unsaved) {
        if (value) pending.set(id, value);
        else pending.delete(id);
      }
      if (!saved) return false;
      try {
        window.sessionStorage.setItem(KEY, JSON.stringify([...pending.values()]));
      } catch {
        return false;
      }
      saved = pending;
      unsaved.clear();
      return true;
    },
  };
}
