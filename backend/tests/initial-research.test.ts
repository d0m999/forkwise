import { initialResearchFixture as fixture } from './fixtures/initial-research.js';
import { randomUUID } from 'node:crypto';
import { readLayout } from '../src/repositories/layout.js';
import { it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { human, statement } from './helpers.js';
import { readJournal } from '../src/repositories/action-history.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';
import { eraseProject } from '../src/services/project-lifecycle.js';
import Database from 'better-sqlite3';
import { ArchiveSchema } from '../src/contracts/assets.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

it('首次研究经 API 原子排队并自动串联目录取材和逐项查证，个人立场不变', async () => {
  const f = fixture();
  try {
    const token = f.app.access.issue('agent', [f.p.id]);
    const request = () =>
      f.app.app.request(`http://127.0.0.1:8787/api/v1/projects/${f.p.id}/initial-research`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'initial-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sourceVersionIds: ['sv'] }),
      });
    const response = await request();
    expect(response.status, await response.clone().text()).toBe(200);
    const { data: job } = await response.json();
    expect((await (await request()).json()).data.id).toBe(job.id);
    const final = await f.app.initialResearch.run(f.p.id, job.id);
    expect(final.state).toBe('succeeded');
    expect(f.calls).toEqual({ reconstruct: 1, plan: 1, verify: 3, fetch: 1 });
    const output = final.output as any;
    expect(output.checks).toHaveLength(3);
    expect(output.checks.every((c: any) => c.state === 'completed')).toBe(true);
    const objects = f.app.repo.snapshot(f.p.id).objects;
    expect(
      objects
        .filter((e) => e.kind === 'statement' || e.kind === 'inference')
        .every((e) => (e.data as any).stance.value === 'pending'),
    ).toBe(true);
    expect(objects.filter((e) => e.kind === 'evidence_link')).toHaveLength(3);
    expect(objects.filter((e) => e.kind === 'verification_node')).toHaveLength(1);
    expect(objects.find((e) => e.kind === 'verification_node')?.data).toMatchObject({
      status: 'candidate',
      event: '下一财年年度报告',
      goal: '核对全年利润是否翻倍',
      sourceTask: job.id,
    });
    const prediction = output.plan.targets.find((t: any) => t.classification === 'prediction');
    const check = output.checks.find((c: any) => c.target.id === prediction.target.id);
    expect(f.app.jobs.get(f.p.id, check.jobId).output).toMatchObject({
      result: { checks: [{ aspect: 'current_basis' }] },
    });
    const stranger = f.app.access.issue('agent', []);
    const denied = await f.app.app.request(
      `http://127.0.0.1:8787/api/v1/projects/${f.p.id}/initial-research`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stranger}`,
          'Idempotency-Key': 'denied-initial',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sourceVersionIds: ['sv'] }),
      },
    );
    expect(denied.status).toBe(403);
  } finally {
    f.close();
  }
});

it('首次研究对百万字符 SEC 快照自动检索，保存原文而不把全文塞入模型或任务副本', async () => {
  const f = fixture();
  f.hooks.largeSource = true;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'large-source-initial', {
      sourceVersionIds: ['sv'],
    });
    const result = await f.app.initialResearch.run(f.p.id, job.id);
    expect(result.state).toBe('succeeded');
    expect(f.calls.verify).toBe(3);
    for (const check of (result.output as any).checks) {
      const task = f.app.jobs.get(f.p.id, check.jobId),
        scope = task.input as any;
      expect(scope.retrieval.selectedCharacters).toBeLessThanOrEqual(80_000);
      expect(JSON.stringify(scope).length).toBeLessThan(100_000);
      expect((task.output as any).coverage.mode).toBe('retrieved_passages');
      const citation = (task.output as any).result.checks[0].citations[0];
      expect(citation.start).toBeGreaterThan(1_000_000);
      expect(
        f.app.repo.material(f.p.id, citation.sourceVersionId).slice(citation.start, citation.end),
      ).toBe(citation.quote);
    }
  } finally {
    f.close();
  }
});

it('子任务已被并行调度领取时父任务让出执行，不重复调用模型；后续调度继续完成', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.hooks.duringReconstruct = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'parallel-initial', {
      sourceVersionIds: ['sv'],
    });
    const child = f.app.researchTasks.drain();
    await started;
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('queued');
    expect((await f.app.initialResearch.run(f.p.id, job.id)).attempt).toBe(0);
    expect(f.calls.reconstruct).toBe(1);
    release();
    await child;
    await f.app.initialResearch.drain();
    expect(f.app.jobs.get(f.p.id, job.id).state).toBe('succeeded');
    expect(f.calls.reconstruct).toBe(1);
  } finally {
    f.close();
  }
});

it('不同首次研究拥有独立子任务；取消一个不会取消另一个，队列满时父子排队整体回滚', async () => {
  const f = fixture();
  try {
    const first = f.app.initialResearch.request(f.p.id, human, 'independent-first', {
      sourceVersionIds: ['sv'],
    });
    const second = f.app.initialResearch.request(f.p.id, human, 'independent-second', {
      sourceVersionIds: ['sv'],
    });
    expect((first.input as any).reconstructionJobId).not.toBe(
      (second.input as any).reconstructionJobId,
    );
    f.app.initialResearch.cancel(f.p.id, first.id);
    expect((await f.app.initialResearch.run(f.p.id, second.id)).state).toBe('succeeded');
    for (let n = 0; n < 99; n++) f.app.jobs.enqueue(f.p.id, 'fixture.pending', {}, `pending_${n}`);
    const before = f.app.jobs.list(f.p.id).length;
    expect(() =>
      f.app.initialResearch.request(f.p.id, human, 'backpressure-initial', {
        sourceVersionIds: ['sv'],
      }),
    ).toThrow('待处理任务过多');
    expect(f.app.jobs.list(f.p.id)).toHaveLength(before);
  } finally {
    f.close();
  }
});

it('部分来源失败后仍保留图谱与已有核查；显式重试只补失败阶段，并用新增材料另存查证', async () => {
  const f = fixture();
  f.hooks.failFetch = true;
  f.hooks.twoSources = true;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'partial-initial', {
      sourceVersionIds: ['sv'],
    });
    const partial = await f.app.initialResearch.run(f.p.id, job.id);
    expect(partial.state).toBe('partial');
    expect((partial.output as any).checks.every((c: any) => c.state === 'completed')).toBe(true);
    expect(f.calls.reconstruct).toBe(1);
    expect(f.calls.verify).toBe(3);
    f.hooks.failFetch = false;
    f.app.jobs.retry(f.p.id, job.id);
    const done = await f.app.initialResearch.run(f.p.id, job.id);
    expect(done.state, JSON.stringify((done.output as any).acquisitions)).toBe('succeeded');
    expect(f.calls).toEqual({ reconstruct: 1, plan: 1, verify: 6, fetch: 3 });
    expect(
      (done.output as any).checks.every(
        (c: any) => c.previousJobIds.length === 1 && c.sourceVersionIds.length === 2,
      ),
    ).toBe(true);
    expect(f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'statement')).toHaveLength(
      2,
    );
  } finally {
    f.close();
  }
});

it('取消父任务会停止正在取材的子任务，晚到数据不得入库且已完成重建保留', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.hooks.duringFetch = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'cancel-initial', {
      sourceVersionIds: ['sv'],
    });
    const pending = f.app.initialResearch.run(f.p.id, job.id);
    await started;
    f.app.initialResearch.cancel(f.p.id, job.id);
    release();
    expect((await pending).state).toBe('cancelled');
    expect(
      f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'source_version'),
    ).toHaveLength(1);
    expect(f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'statement')).toHaveLength(
      2,
    );
    expect(f.calls.verify).toBe(0);
    expect(f.app.jobs.list(f.p.id).some((j) => j.state === 'queued' || j.state === 'running')).toBe(
      false,
    );
  } finally {
    f.close();
  }
});

it('取材期间修改目标不会自动查证新内容，其他目标继续', async () => {
  const f = fixture();
  f.hooks.duringFetch = async () => {
    const state = f.app.repo.snapshot(f.p.id),
      target = state.objects.find((e) => e.kind === 'statement')!;
    f.app.write.execute(f.p.id, human, 'change-during-initial', {
      expected: Object.fromEntries(state.objects.map((e) => [e.id, e.version])),
      commands: [{ op: 'statement.edit', id: target.id, scope: 'all', text: '本人修改的新观点' }],
    });
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'changed-initial', {
      sourceVersionIds: ['sv'],
    });
    const result = await f.app.initialResearch.run(f.p.id, job.id);
    expect(result.state).toBe('partial');
    expect((result.output as any).checks.filter((c: any) => c.state === 'stale')).toHaveLength(2);
    const target = f.app.repo
      .snapshot(f.p.id)
      .objects.find((e) => e.kind === 'statement' && e.data.text === '本人修改的新观点')!;
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.filter((e) => e.kind === 'evidence_link' && e.data.target.id === target.id),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('来源计划缺失目标时停止取材；预测被当作已披露事实的模型结果整项拒绝', async () => {
  const f = fixture();
  f.hooks.malformedPlan = true;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'invalid-plan', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).error).toContain('INVALID_PLAN_SCOPE');
    expect(f.calls.fetch).toBe(0);
    f.hooks.malformedPlan = false;
    f.hooks.wrongAspect = true;
    f.app.jobs.retry(f.p.id, job.id);
    const result = await f.app.initialResearch.run(f.p.id, job.id);
    expect(result.state).toBe('partial');
    expect((result.output as any).checks.filter((c: any) => c.state === 'failed')).toHaveLength(2);
    expect(
      f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'evidence_link'),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('历史查证缺少当时快照时不联网倒灌；首次材料晚于时点整批拒绝不遗留任务', async () => {
  const f = fixture();
  try {
    expect(() =>
      f.app.initialResearch.request(f.p.id, human, 'too-early-initial', {
        sourceVersionIds: ['sv'],
        asOf: '2019-01-01T00:00:00Z',
      }),
    ).toThrow('尚未取得');
    expect(f.app.jobs.list(f.p.id)).toHaveLength(0);
    const job = f.app.initialResearch.request(f.p.id, human, 'historical-initial', {
      sourceVersionIds: ['sv'],
      asOf: new Date().toISOString(),
    });
    const result = await f.app.initialResearch.run(f.p.id, job.id);
    expect(result.state).toBe('succeeded');
    expect((result.output as any).acquisitions[0].state).toBe('not_known');
    expect((result.output as any).checks.every((c: any) => c.state === 'uncovered')).toBe(true);
    expect(f.calls.fetch).toBe(0);
    expect(f.calls.verify).toBe(0);
  } finally {
    f.close();
  }
});

it('来源规划中断后重开数据库可续跑，重建不重复；任务和证据随资产往返', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.hooks.duringPlan = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  let resumed: ReturnType<typeof createApplication> | undefined;
  const imported = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'restart-initial', {
      sourceVersionIds: ['sv'],
    });
    const pending = f.app.initialResearch.run(f.p.id, job.id);
    await started;
    f.app.jobs.recover();
    f.app.initialResearch.stop();
    release();
    expect((await pending).state).toBe('interrupted');
    f.app.db.close();
    delete f.hooks.duringPlan;
    resumed = createApplication({
      database: join(f.directory, 'test.sqlite'),
      origin: 'http://127.0.0.1:8787',
      researchModel: f.model,
      publicDataClient: f.client,
    });
    resumed.jobs.retry(f.p.id, job.id);
    expect((await resumed.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    expect(f.calls.reconstruct).toBe(1);
    expect((resumed.jobs.get(f.p.id, job.id).output as any).usage.planningAttempts).toHaveLength(2);
    const asset = new AssetService(resumed.repo, resumed.write).export(f.p.id);
    new ArchiveService(imported.write, imported.search).import(
      human,
      'import-initial-research',
      asset,
    );
    expect(imported.jobs.get(f.p.id, job.id).output).toEqual(
      resumed.jobs.get(f.p.id, job.id).output,
    );
    expect(imported.repo.snapshot(f.p.id)).toEqual(resumed.repo.snapshot(f.p.id));
  } finally {
    resumed?.db.close();
    imported.db.close();
    if (f.app.db.open) f.app.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

function travel(f: ReturnType<typeof fixture>, direction: 'undo' | 'redo') {
  return f.app.write.travel(f.p.id, human, randomUUID(), {
    direction,
    expectedRevision: f.app.repo.project(f.p.id).revision,
    expectedHistoryVersion: f.app.write.history(f.p.id).version,
    expectedLayoutVersion: readLayout(f.app.repo, f.p.id).version,
  });
}
it('首次研究全部阶段作为一步撤销重做，已取材料与任务审计保留且不重复调用模型', async () => {
  const f = fixture();
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'grouped-initial', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    const before = f.app.repo.snapshot(f.p.id).objects;
    expect(f.app.write.history(f.p.id).undo?.label).toBe('梳理并查证');
    const changes = travel(f, 'undo');
    expect(changes.deletedIds).toHaveLength(10);
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.every((e) => ['source', 'source_version'].includes(e.kind)),
    ).toBe(true);
    expect(f.app.repo.material(f.p.id, 'sv')).toContain('营收增长');
    const calls = { ...f.calls };
    travel(f, 'redo');
    expect(
      f.app.repo.snapshot(f.p.id).objects.map((e) => [e.id, e.data, e.contentVersionId]),
    ).toEqual(before.map((e) => [e.id, e.data, e.contentVersionId]));
    await f.app.initialResearch.drain();
    await f.app.researchTasks.drain();
    await f.app.publicData.drain();
    expect(f.calls).toEqual(calls);
    expect(f.app.jobs.get(f.p.id, job.id).state).toBe('succeeded');
  } finally {
    f.close();
  }
});

it('取材中撤销先停父子任务；立即重做也不会应用旧运行的晚到结果', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  f.hooks.duringFetch = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'undo-running', {
      sourceVersionIds: ['sv'],
    });
    const pending = f.app.initialResearch.run(f.p.id, job.id);
    await started;
    const completed = f.app.repo.snapshot(f.p.id).objects;
    travel(f, 'undo');
    expect(f.app.jobs.get(f.p.id, job.id)).toMatchObject({
      state: 'cancelled',
      historyState: 'undone',
    });
    expect(f.app.jobs.list(f.p.id).every((j) => !['running', 'queued'].includes(j.state))).toBe(
      true,
    );
    travel(f, 'redo');
    release();
    await pending;
    expect(f.app.repo.snapshot(f.p.id).objects.map((e) => [e.id, e.data])).toEqual(
      completed.map((e) => [e.id, e.data]),
    );
    expect(f.calls.verify).toBe(0);
    expect(f.app.jobs.get(f.p.id, job.id).historyState).toBe('stopped');
    expect(() => f.app.jobs.retry(f.p.id, job.id)).toThrow('重做只恢复');
  } finally {
    f.close();
  }
});

it('研究阶段交错的个人编辑保持独立；先撤销本人编辑，再整组撤销研究', async () => {
  const f = fixture();
  f.hooks.duringFetch = async () => {
    const objects = f.app.repo.snapshot(f.p.id).objects;
    const target = objects.find((e) => e.kind === 'statement')!;
    f.app.write.execute(f.p.id, human, 'interleaved-edit', {
      expected: Object.fromEntries(objects.map((e) => [e.id, e.version])),
      commands: [{ op: 'statement.edit', id: target.id, text: '本人新的观点', scope: 'all' }],
    });
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'interleaved-initial', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('partial');
    expect(f.app.write.history(f.p.id).undo?.label).toBe('改写主张');
    travel(f, 'undo');
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.some((e) => e.kind === 'statement' && e.data.text === '本季营收增长'),
    ).toBe(true);
    expect(f.app.write.history(f.p.id).undo?.label).toBe('梳理并查证');
    travel(f, 'undo');
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.every((e) => ['source', 'source_version'].includes(e.kind)),
    ).toBe(true);
    travel(f, 'redo');
    travel(f, 'redo');
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.some((e) => e.kind === 'statement' && e.data.text === '本人新的观点'),
    ).toBe(true);
  } finally {
    f.close();
  }
});

it('已撤销研究的 JSON 往返保留分组和停止状态，可重做但不能重新执行失败子任务', async () => {
  const f = fixture(),
    imported = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  f.hooks.failFetch = true;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'portable-history', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('partial');
    travel(f, 'undo');
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    new ArchiveService(imported.write, imported.search).import(
      human,
      'import-group-history',
      archive,
    );
    expect(imported.jobs.get(f.p.id, job.id).historyState).toBe('undone');
    imported.write.travel(f.p.id, human, 'restore-group-history', {
      direction: 'redo',
      expectedRevision: imported.repo.project(f.p.id).revision,
      expectedHistoryVersion: imported.write.history(f.p.id).version,
      expectedLayoutVersion: readLayout(imported.repo, f.p.id).version,
    });
    expect(imported.jobs.get(f.p.id, job.id).historyState).toBe('stopped');
    expect(() => imported.jobs.retry(f.p.id, job.id)).toThrow('重做只恢复');
    expect(
      imported.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'statement'),
    ).toHaveLength(2);
  } finally {
    imported.db.close();
    f.close();
  }
});

it('排队时即可整组撤销，分支被新编辑覆盖后也不能由调度或重试复活', async () => {
  const f = fixture();
  try {
    const first = f.app.initialResearch.request(f.p.id, human, 'queued-first', {
      sourceVersionIds: ['sv'],
    });
    const second = f.app.initialResearch.request(f.p.id, human, 'queued-second', {
      sourceVersionIds: ['sv'],
    });
    travel(f, 'undo');
    expect(f.app.jobs.get(f.p.id, first.id).state).toBe('queued');
    expect(f.app.jobs.get(f.p.id, second.id).historyState).toBe('undone');
    travel(f, 'redo');
    await f.app.initialResearch.run(f.p.id, second.id);
    expect(f.calls).toEqual({ reconstruct: 0, plan: 0, verify: 0, fetch: 0 });
    travel(f, 'undo');
    f.app.write.execute(f.p.id, human, 'new-branch', {
      expected: {},
      commands: [statement('manual')],
    });
    expect(f.app.write.history(f.p.id).redo).toBeNull();
    await f.app.researchTasks.drain();
    await f.app.initialResearch.drain();
    expect(f.app.jobs.get(f.p.id, first.id).state).toBe('succeeded');
    expect(f.app.jobs.get(f.p.id, second.id).state).toBe('cancelled');
    expect(f.calls.reconstruct).toBe(1);
    for (const job of f.app.jobs.list(f.p.id).filter((j) => j.historyState === 'undone'))
      expect(() => f.app.jobs.retry(f.p.id, job.id)).toThrow('重做只恢复');
    travel(f, 'undo'); // separate manual card
    travel(f, 'undo'); // first research
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.every((e) => ['source', 'source_version'].includes(e.kind)),
    ).toBe(true);
  } finally {
    f.close();
  }
});

it.each(['duringReconstruct', 'duringVerify'] as const)(
  '%s 模型忽略取消时，撤销后立即重做仍丢弃原响应并保留实际用量',
  async (phase) => {
    const f = fixture();
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      enter = r;
    });
    f.hooks[phase] = () => {
      enter();
      return new Promise<void>((r) => {
        release = r;
      });
    };
    try {
      const job = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
        sourceVersionIds: ['sv'],
      });
      const pending = f.app.initialResearch.run(f.p.id, job.id);
      await started;
      const before = f.app.repo.snapshot(f.p.id).objects.map((e) => [e.id, e.data]);
      const active = f.app.jobs
        .list(f.p.id)
        .find((j) => j.state === 'running' && j.kind.startsWith('research.'))!;
      travel(f, 'undo');
      travel(f, 'redo');
      release();
      await pending;
      expect(f.app.repo.snapshot(f.p.id).objects.map((e) => [e.id, e.data])).toEqual(before);
      expect(f.app.jobs.get(f.p.id, active.id)).toMatchObject({
        state: 'cancelled',
        historyState: 'stopped',
        usage: { resultDiscarded: true },
      });
      expect(f.calls.verify).toBe(phase === 'duringVerify' ? 1 : 0);
    } finally {
      f.close();
    }
  },
);

it('异步追加清除已撤销的个人编辑分支，组内新增对象仍能完整恢复', async () => {
  const f = fixture();
  f.hooks.duringFetch = async () => {
    const objects = f.app.repo.snapshot(f.p.id).objects;
    const target = objects.find((e) => e.kind === 'statement')!;
    f.app.write.execute(f.p.id, human, randomUUID(), {
      expected: Object.fromEntries(objects.map((e) => [e.id, e.version])),
      commands: [{ op: 'statement.edit', id: target.id, scope: 'all', text: '临时改写' }],
    });
    travel(f, 'undo');
    expect(f.app.write.history(f.p.id).redo?.label).toBe('改写主张');
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    expect(f.app.write.history(f.p.id).redo).toBeNull();
    expect(f.app.write.history(f.p.id).undo?.label).toBe('梳理并查证');
    expect(travel(f, 'undo').deletedIds).toHaveLength(10);
    expect(travel(f, 'redo').upserted).toHaveLength(10);
  } finally {
    f.close();
  }
});

it('分组退出 40 步窗口后，晚完成的阶段不挤入新步骤也不丢失持久归属', async () => {
  const f = fixture();
  try {
    const job = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
      sourceVersionIds: ['sv'],
    });
    for (let n = 0; n < 40; n++)
      f.app.write.execute(f.p.id, human, randomUUID(), {
        expected: {},
        commands: [statement(`manual_${n}`)],
      });
    const before = readJournal(f.app.repo, f.p.id);
    expect(before.entries).toHaveLength(40);
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    expect(readJournal(f.app.repo, f.p.id).entries).toEqual(before.entries);
    for (let n = 0; n < 40; n++) travel(f, 'undo');
    expect(f.app.write.history(f.p.id).undo).toBeNull();
    expect(f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'statement')).toHaveLength(
      2,
    );
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    expect(archive.workflowGroups).toHaveLength(1);
    new ArchiveService(f.app.write, f.app.search).validate(ArchiveSchema.parse(archive));
  } finally {
    f.close();
  }
});

it('研究撤销的持久停止更新失败时，图谱、历史及执行状态一起回滚，原运行继续完成', async () => {
  const f = fixture();
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    enter = r;
  });
  f.hooks.duringFetch = () => {
    enter();
    return new Promise<void>((r) => {
      release = r;
    });
  };
  try {
    const job = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
      sourceVersionIds: ['sv'],
    });
    const pending = f.app.initialResearch.run(f.p.id, job.id);
    await started;
    const before = researchFingerprint(f.app.db);
    f.app.db.exec(
      "CREATE TRIGGER fail_workflow_travel BEFORE UPDATE ON workflow_groups BEGIN SELECT RAISE(ABORT,'synthetic history persistence failure'); END",
    );
    expect(() => travel(f, 'undo')).toThrow('synthetic history persistence failure');
    expect(researchFingerprint(f.app.db)).toBe(before);
    expect(f.app.jobs.get(f.p.id, job.id)).toMatchObject({
      state: 'running',
      historyState: 'applied',
    });
    f.app.db.exec('DROP TRIGGER fail_workflow_travel');
    release();
    expect((await pending).state).toBe('succeeded');
  } finally {
    f.close();
  }
});

it('损坏的分组父子身份、游标与任务运行状态拒绝导入，目标数据库无部分项目', () => {
  const f = fixture(),
    imported = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    f.app.initialResearch.request(f.p.id, human, randomUUID(), { sourceVersionIds: ['sv'] });
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    const invalid = [
      (a: any) => {
        const root = a.tasks.find((t: any) => t.kind === 'workflow.initial');
        a.tasks.find((t: any) => t.id === root.input.reconstructionJobId).kind = 'source.sec';
      },
      (a: any) => {
        a.workflowGroups[0].taskIds.push(a.workflowGroups[0].rootJobId);
      },
      (a: any) => {
        a.workflowGroups[0].applied = false;
      },
      (a: any) => {
        a.workflowGroups[0].stopped = true;
      },
      (a: any) => {
        a.actionHistory.cursor = 0;
      },
      (a: any) => {
        a.workflowGroups = [];
      },
    ];
    for (const corrupt of invalid) {
      const damaged = structuredClone(archive);
      corrupt(damaged);
      expect(() =>
        new ArchiveService(imported.write, imported.search).import(human, randomUUID(), damaged),
      ).toThrow();
      expect(imported.repo.listProjects()).toHaveLength(0);
    }
  } finally {
    imported.db.close();
    f.close();
  }
});

it('SQLite 备份恢复分组停止状态与重做；篡改归属被指纹检出，清理不遗留任务关联', async () => {
  const f = fixture();
  let restored: ReturnType<typeof createApplication> | undefined;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
      sourceVersionIds: ['sv'],
    });
    await f.app.initialResearch.run(f.p.id, job.id);
    travel(f, 'undo');
    const backups = new BackupService(f.app.repo, join(f.directory, 'backups'));
    const backup = await backups.create();
    expect(backup.fingerprintVersion).toBe(4);
    const record = await backups.restoreIsolated(backup.id, join(f.directory, 'restored'));
    restored = createApplication({
      database: join(record.directory, 'research.sqlite'),
      origin: 'http://127.0.0.1:8787',
    });
    expect(restored.jobs.get(f.p.id, job.id).historyState).toBe('undone');
    restored.write.travel(f.p.id, human, randomUUID(), {
      direction: 'redo',
      expectedRevision: restored.repo.project(f.p.id).revision,
      expectedHistoryVersion: restored.write.history(f.p.id).version,
      expectedLayoutVersion: readLayout(restored.repo, f.p.id).version,
    });
    expect(restored.jobs.get(f.p.id, job.id).historyState).toBe('stopped');
    restored.db.close();
    restored = undefined;
    const copy = new Database(join(f.directory, 'backups', backup.id + '.sqlite'));
    try {
      copy.prepare('UPDATE workflow_groups SET applied=1').run();
      expect(researchFingerprint(copy)).not.toBe(backup.fingerprint);
    } finally {
      copy.close();
    }
    await expect(backups.restoreIsolated(backup.id, join(f.directory, 'tampered'))).rejects.toThrow(
      '备份校验不匹配',
    );
    backups.purgeCopies(f.p.id);
    eraseProject(f.app.db, f.p.id);
    for (const path of [
      join(f.directory, 'backups', backup.id + '.sqlite'),
      join(record.directory, 'research.sqlite'),
      join(f.directory, 'test.sqlite'),
    ]) {
      const db = new Database(path, { readonly: true });
      try {
        for (const table of ['workflow_groups', 'workflow_group_tasks', 'action_history', 'jobs'])
          expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    }
  } finally {
    restored?.db.close();
    f.close();
  }
});
