// All endpoints are project-scoped business operations with receipt lookup.
export async function draftFingerprint(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export class RequestJournal {
  constructor(api, store) {
    this.api = api;
    this.store = store;
  }
  get(projectId) {
    return this.store.get(projectId);
  }
  lock(projectId, work) {
    return globalThis.navigator?.locks
      ? navigator.locks.request(`forkwise-research:${projectId}`, work)
      : work();
  }
  async start(projectId, plan) {
    const meta = structuredClone(plan.meta ?? {});
    if (meta.draft) {
      meta.draftHash = await draftFingerprint(JSON.stringify(meta.draft));
      delete meta.draft;
    }
    return this.lock(projectId, () =>
      this.store.change(projectId, (previous) => {
        if (previous && previous.state !== 'completed')
          throw new Error('本项目有未完成请求，请先恢复或处理该请求');
        if (
          !plan.steps?.length ||
          plan.steps.some(
            (s) =>
              ![
                '/operations',
                '/files',
                '/files/import',
                '/initial-research',
                '/research-tasks',
                '/manual-updates',
                '/public-data/filing',
                '/public-data/history-index',
              ].includes(s.endpoint),
          )
        )
          throw new Error('研究请求步骤无效');
        return structuredClone({
          id: crypto.randomUUID(),
          projectId,
          label: plan.label,
          meta,
          state: 'pending',
          cursor: 0,
          results: [],
          error: null,
          steps: plan.steps.map((step) => ({ ...step, key: crypto.randomUUID() })),
        });
      }),
    );
  }
  async resume(projectId, expectedId) {
    return this.lock(projectId, async () => {
      let record = await this.get(projectId);
      if (!record) throw new Error('没有待恢复的研究请求');
      if (expectedId && record.id !== expectedId) throw new Error('研究请求已改变，请重新读取');
      while (record.state !== 'completed') {
        const { id, cursor } = record,
          step = record.steps[cursor];
        record = await this.store.change(projectId, (current) => {
          if (current?.id !== id) throw new Error('研究请求已改变，请重新读取');
          if (current.cursor > cursor || current.state === 'completed') return current;
          return { ...current, state: 'pending', error: null };
        });
        if (record.cursor > cursor || record.state === 'completed') continue;
        let rejected = false;
        try {
          let result;
          try {
            result = await this.api(`/projects/${projectId}/operations/${step.key}`);
          } catch (error) {
            if (error.code !== 'OPERATION_NOT_FOUND') throw error;
            try {
              result = await this.api(
                `/projects/${projectId}${step.endpoint}`,
                'POST',
                step.body,
                step.key,
              );
            } catch (failure) {
              rejected =
                typeof failure.code === 'string' &&
                !['INTERNAL_ERROR', 'UNAUTHORIZED', 'PROJECT_FORBIDDEN'].includes(failure.code);
              throw failure;
            }
          }
          record = await this.store.change(projectId, (current) => {
            if (current?.id !== id) throw new Error('研究请求已改变，请重新读取');
            if (current.cursor > cursor) return current;
            const completed = cursor + 1 === current.steps.length;
            return {
              ...current,
              cursor: cursor + 1,
              results: [...current.results, result],
              state: completed ? 'completed' : 'pending',
              error: null,
              // Remove source text/file bytes after every server result is confirmed.
              steps: completed ? [] : current.steps,
            };
          });
        } catch (error) {
          await this.store.change(projectId, (current) => {
            if (current?.id !== id || current.cursor > cursor) return current;
            return {
              ...current,
              state: rejected ? 'rejected' : 'pending',
              error: error.message,
            };
          });
          throw error;
        }
      }
      return record;
    });
  }
  discard(projectId) {
    return this.lock(projectId, () =>
      this.store.change(projectId, (record) => {
        if (record?.state === 'pending')
          throw new Error('结果未确认，须先恢复原请求，不能重新发送');
        return null;
      }),
    );
  }
}
