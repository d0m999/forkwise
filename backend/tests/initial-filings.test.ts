import { it, expect } from 'vitest';
import { initialFilingsFixture } from './fixtures/initial-filings.js';
import { human } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { createApplication } from '../src/app.js';
import { readLayout } from '../src/repositories/layout.js';
import { randomUUID } from 'node:crypto';
import { ArchiveSchema } from '../src/contracts/assets.js';

function travel(f: ReturnType<typeof initialFilingsFixture>, direction: 'undo' | 'redo') {
  const state = f.app.repo.snapshot(f.p.id),
    history = f.app.write.history(f.p.id);
  return f.app.write.travel(f.p.id, human, randomUUID(), {
    direction,
    expectedRevision: state.project.revision,
    expectedLayoutVersion: readLayout(f.app.repo, f.p.id).version,
    expectedHistoryVersion: history.version,
  });
}

it('首次研究依固定索引自动取得正文，多个观点复用一次获取并回查正文，不改变个人立场', async () => {
  const f = initialFilingsFixture();
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'initial-filings', {
      sourceVersionIds: ['sv'],
    });
    const result = await f.app.initialResearch.run(f.p.id, task.id);
    expect(result.state, result.error ?? '').toBe('succeeded');
    expect(f.network).toEqual([
      'https://data.sec.gov/submissions/CIK0000000001.json',
      'https://www.sec.gov/Archives/edgar/data/1/000000009925000001/report1.htm',
    ]);
    const output = result.output as any;
    expect(output.filings.selections).toHaveLength(3);
    expect(output.filings.acquisitions).toHaveLength(1);
    const body = output.filings.acquisitions[0];
    expect(body.state).toBe('available');
    expect(output.filings.selections[0].gaps.join('')).toContain('历史');
    for (const check of output.checks) {
      expect(check.state).toBe('completed');
      expect(check.sourceVersionIds).toContain(body.sourceVersionId);
      const citation = (f.app.jobs.get(f.p.id, check.jobId).output as any).result.checks[0]
        .citations[0];
      expect(citation.sourceVersionId).toBe(body.sourceVersionId);
      expect(
        f.app.repo.material(f.p.id, citation.sourceVersionId).slice(citation.start, citation.end),
      ).toBe('Synthetic');
    }
    expect(
      f.app.repo
        .snapshot(f.p.id)
        .objects.filter((e) => ['statement', 'inference'].includes(e.kind))
        .every((e) => (e.data as any).stance.value === 'pending'),
    ).toBe(true);
  } finally {
    f.close();
  }
});

it('正文权限失败保留索引核对；JSON 恢复后显式续跑只补正文，旧核对记录和材料都保留', async () => {
  const f = initialFilingsFixture();
  const restored = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: f.model,
    publicDataClient: f.client,
  });
  f.filingHooks.failBody = true;
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'filing-retry-workflow', {
      sourceVersionIds: ['sv'],
    });
    const first = await f.app.initialResearch.run(f.p.id, task.id);
    expect(first.state).toBe('partial');
    const before = first.output as any;
    expect(before.filings.acquisitions[0].error).toContain('ACCESS_DENIED');
    expect(before.checks.every((c: any) => c.state === 'completed')).toBe(true);
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-filing-workflow',
      archive,
    );
    f.filingHooks.failBody = false;
    restored.jobs.retry(f.p.id, task.id);
    const final = await restored.initialResearch.run(f.p.id, task.id);
    expect(final.state, final.error ?? '').toBe('succeeded');
    expect(f.calls.reconstruct).toBe(1);
    expect(f.calls.plan).toBe(1);
    expect(f.network.filter((url) => url.includes('/submissions/'))).toHaveLength(1);
    expect(f.network.filter((url) => url.includes('/Archives/'))).toHaveLength(2);
    const after = final.output as any;
    expect(after.filings.acquisitions[0].jobId).toBe(before.filings.acquisitions[0].jobId);
    for (let i = 0; i < after.checks.length; i++) {
      expect(after.checks[i].previousJobIds).toEqual([before.checks[i].jobId]);
      expect(restored.jobs.get(f.p.id, before.checks[i].jobId).state).toBe('succeeded');
    }
    const assets = new AssetService(restored.repo, restored.write).export(f.p.id);
    new ArchiveService(restored.write, restored.search).validate(ArchiveSchema.parse(assets));
    expect(assets.files).toHaveLength(1);
  } finally {
    restored.db.close();
    f.close();
  }
});

it('父研究取消或撤销后立即重做，正文晚到响应不能落库或开始查证', async () => {
  for (const action of ['cancel', 'undo'] as const) {
    const f = initialFilingsFixture();
    let pending: ReturnType<typeof f.app.initialResearch.run> | undefined;
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      enter = r;
    });
    f.filingHooks.duringBody = async () => {
      enter();
      await new Promise<void>((r) => {
        release = r;
      });
    };
    try {
      const task = f.app.initialResearch.request(f.p.id, human, `filing-${action}-workflow`, {
        sourceVersionIds: ['sv'],
      });
      pending = f.app.initialResearch.run(f.p.id, task.id);
      await started;
      if (action === 'cancel') f.app.initialResearch.cancel(f.p.id, task.id);
      else {
        travel(f, 'undo');
        travel(f, 'redo');
      }
      release();
      await pending;
      expect(f.app.jobs.get(f.p.id, task.id).state).toBe('cancelled');
      expect(f.app.jobs.list(f.p.id).find((job) => job.kind === 'source.sec-filing')?.state).toBe(
        'cancelled',
      );
      expect(f.calls.verify).toBe(0);
      expect(new AssetService(f.app.repo, f.app.write).export(f.p.id).files).toHaveLength(0);
    } finally {
      release?.();
      await pending;
      f.close();
    }
  }
});

it('历史研究只使用当时已取得的正文，早期截止点不联网补报，也不以旧披露日期放行后来材料', async () => {
  const f = initialFilingsFixture();
  try {
    const index = f.app.publicData.request(f.p.id, human, 'history-index-first', {
      sourceId: 'sec-edgar',
      cik: '1',
      dataset: 'submissions',
      refresh: true,
    });
    await f.app.publicData.run(f.p.id, index.id);
    const beforeBody = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const task = f.app.initialResearch.request(f.p.id, human, 'get-body-workflow', {
      sourceVersionIds: ['sv'],
    });
    const present = await f.app.initialResearch.run(f.p.id, task.id);
    expect(present.state).toBe('succeeded');
    const bodyId = (present.output as any).filings.acquisitions[0].sourceVersionId;
    const afterBody = new Date().toISOString(),
      count = f.network.length;
    for (const [asOf, expected] of [
      [beforeBody, 'not_known'],
      [afterBody, 'available'],
    ]) {
      const historical = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
        sourceVersionIds: ['sv'],
        asOf,
      });
      const result = await f.app.initialResearch.run(f.p.id, historical.id);
      expect(result.state, result.error ?? '').toBe('succeeded');
      const output = result.output as any;
      expect(output.filings.acquisitions[0].state).toBe(expected);
      for (const check of output.checks)
        expect(check.sourceVersionIds.includes(bodyId)).toBe(expected === 'available');
    }
    expect(f.network).toHaveLength(count);
  } finally {
    f.close();
  }
});

it('范围超限或日期不明不猜报告，不产生隐含的前十条样本', async () => {
  const f = initialFilingsFixture();
  f.filingHooks.rows = 11;
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'too-many-filings-workflow', {
      sourceVersionIds: ['sv'],
    });
    const result = await f.app.initialResearch.run(f.p.id, task.id);
    expect(result.state).toBe('partial');
    expect((result.output as any).filings.selections[0].gaps.join('')).toContain(
      'TOO_MANY_FILINGS',
    );
    expect(f.network.filter((url) => url.includes('/Archives/'))).toHaveLength(0);
    expect((result.output as any).filings.acquisitions).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('恢复的已取得正文必须匹配原获取任务结果，不能把原始观点冒充公开正文', async () => {
  const f = initialFilingsFixture();
  f.filingHooks.rows = 2;
  let bodies = 0;
  f.filingHooks.duringBody = async () => {
    f.filingHooks.failBody = ++bodies === 2;
  };
  const restored = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: f.model,
    publicDataClient: f.client,
  });
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'tamper-body-workflow', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, task.id)).state).toBe('partial');
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    const parent = archive.tasks.find((j) => j.id === task.id)!;
    (parent.output as any).filings.acquisitions[0].sourceVersionId = 'sv';
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-tampered-body',
      archive,
    );
    restored.jobs.retry(f.p.id, task.id);
    const result = await restored.initialResearch.run(f.p.id, task.id);
    expect(result.state).toBe('partial');
    const output = result.output as any;
    expect(output.filings.acquisitions[0].error).toContain('INVALID_FILING_PROGRESS');
    for (const check of output.checks) expect(check.sourceVersionIds).not.toContain('sv');
  } finally {
    restored.db.close();
    f.close();
  }
});
