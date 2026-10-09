export function applyChangeSet(state, change) {
  if (state.project.id !== change.projectId || state.project.revision !== change.revisionBefore)
    throw new Error('变化集合不连续，需要重新读取');
  const objects = new Map(state.objects.map((e) => [e.id, e]));
  for (const id of change.deletedIds) objects.delete(id);
  for (const entity of change.upserted) objects.set(entity.id, entity);
  return {
    project: { ...state.project, revision: change.revisionAfter },
    objects: [...objects.values()],
  };
}
// Build the entire next snapshot before publishing it to either canvas or list.
export function applySync(state, sync) {
  if (sync.needsSnapshot || sync.projectId !== state.project.id)
    throw new Error('同步需要重新读取完整状态');
  let next = state;
  for (const change of sync.changes) next = applyChangeSet(next, change);
  if (next.project.revision !== sync.revision) throw new Error('变化集合不完整，需要重新读取');
  return next;
}
export function client(token) {
  const api = async (path, method = 'GET', data, key) => {
    const response = await fetch('/api/v1' + path, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.message);
      error.code = result.code;
      throw error;
    }
    return result.data;
  };
  api.download = async (path) => {
    const response = await fetch('/api/v1' + path, {
      signal: AbortSignal.timeout(70_000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message);
    }
    return response.blob();
  };
  return api;
}
