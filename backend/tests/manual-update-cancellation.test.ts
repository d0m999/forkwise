import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { human } from './helpers.js';
import { manualUpdateFixture } from './fixtures/manual-update.js';
// Control only external randomness and wall time: later jobs sort before older
// jobs with the same timestamp, so a chronological tie cannot hide this case.
const sequence = vi.hoisted(() => ({ value: 999999999999 }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => `00000000-0000-4000-8000-${sequence.value--}`,
}));
it('同毫秒、逆序 ID 的连续取消每次都能明确重新排队，仍属于同一更新事件', () => {
  const f = manualUpdateFixture();
  try {
    vi.spyOn(f.app.jobs, 'clock').mockReturnValue(new Date().toISOString());
    const submit = () =>
      f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
        ...f.input,
        previewHash: f.app.manualUpdates.preview(f.project.id, f.input).previewHash,
      });
    const first = submit();
    f.app.researchTasks.cancel(f.project.id, first.createdJobId!);
    const second = submit();
    expect(second.createdJobId! < first.createdJobId!).toBe(true);
    f.app.researchTasks.cancel(f.project.id, second.createdJobId!);
    const third = submit();
    expect(third.createdJobId).not.toBe(second.createdJobId);
    expect(f.app.jobs.get(f.project.id, third.createdJobId!).state).toBe('queued');
    expect(third.eventKey).toBe(first.eventKey);
    expect(f.app.jobs.list(f.project.id)).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
    f.app.db.close();
  }
});
