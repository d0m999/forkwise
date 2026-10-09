import { it, expect } from 'vitest';
import {
  submissionHistoryFixture,
  historyName,
  historyText,
} from './fixtures/submission-history.js';
import { human } from './helpers.js';
import { createApplication } from '../src/app.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { randomUUID } from 'node:crypto';
import { readLayout } from '../src/repositories/layout.js';

it('恢复的全文历史材料也须核对固定版本来历，伪造任务元数据在调用模型前拒绝', async () => {
  const f = submissionHistoryFixture();
  const restored = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: f.model,
  });
  try {
    const parent = f.app.initialResearch.request(f.p.id, human, 'history-scope-parent', {
      sourceVersionIds: ['sv'],
    });
    const result = await f.app.initialResearch.run(f.p.id, parent.id),
      output = result.output as any;
    const check = f.app.researchTasks.request(f.p.id, human, 'history-fulltext-check', {
      kind: 'verify',
      sourceVersionIds: [output.history.acquisitions[0].sourceVersionId],
      targetIds: [output.targets[0].id],
    });
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    (
      archive.tasks.find((task) => task.id === check.id)!.input as any
    ).materials[0].version.data.provenance.indexParent.snapshotHash = '0'.repeat(64);
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-bad-history-scope',
      archive,
    );
    const calls = f.calls.verify;
    restored.jobs.retry(f.p.id, check.id);
    const stopped = await restored.researchTasks.run(f.p.id, check.id);
    expect(f.calls.verify).toBe(calls);
    expect(stopped.state).toBe('failed');
    expect(stopped.error).toContain('MATERIAL_SCOPE_MISMATCH');
  } finally {
    restored.db.close();
    f.close();
  }
});

it('根索引与历史分片重复列出同一申报时正文只取一次，字段冲突则停止自动择一', async () => {
  for (const conflict of [false, true]) {
    const f = submissionHistoryFixture();
    f.historyHooks.overlap = true;
    if (conflict) f.historyHooks.raw = historyText.replace('old.htm', 'different.htm');
    try {
      const task = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
        sourceVersionIds: ['sv'],
      });
      const result = await f.app.initialResearch.run(f.p.id, task.id);
      expect(result.state).toBe(conflict ? 'partial' : 'succeeded');
      expect(f.requests.filter((url) => url.includes('/Archives/'))).toHaveLength(conflict ? 0 : 1);
      if (conflict) expect(result.error).toContain('CONFLICTING_FILING_INDEXES');
      else expect((result.output as any).filings.acquisitions[0].indexBindings).toHaveLength(2);
    } finally {
      f.close();
    }
  }
});

it('首次研究从明确日期范围选择历史分片，保存完整来历及原文位置并取得旧申报正文', async () => {
  const f = submissionHistoryFixture();
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'history-initial-task', {
      sourceVersionIds: ['sv'],
    });
    const done = await f.app.initialResearch.run(f.p.id, task.id);
    expect(done.state, done.error ?? '').toBe('succeeded');
    expect(f.requests).toEqual([
      'https://data.sec.gov/submissions/CIK0000000001.json',
      `https://data.sec.gov/submissions/${historyName}`,
      'https://www.sec.gov/Archives/edgar/data/1/000000009920000001/old.htm',
    ]);
    const output = done.output as any,
      history = output.history.acquisitions[0];
    expect(history.state).toBe('available');
    expect(f.app.repo.material(f.p.id, history.sourceVersionId)).toBe(historyText);
    const body = output.filings.acquisitions[0];
    expect(body.request.indexSourceVersionId).toBe(history.sourceVersionId);
    expect((f.app.jobs.get(f.p.id, body.jobId).output as any).lineage.recordPointer).toBe(
      '/accessionNumber/0',
    );
    expect(
      output.checks.every(
        (check: any) =>
          check.state === 'completed' && check.sourceVersionIds.includes(body.sourceVersionId),
      ),
    ).toBe(true);
    const verification = f.app.researchTasks.request(f.p.id, human, 'verify-history-metadata', {
      kind: 'verify',
      sourceVersionIds: [history.sourceVersionId],
      targetIds: [output.targets[0].id],
      retrieval: { queries: ['10-Q'], maxCharacters: 80000 },
    });
    const first = (verification.input as any).materials[0];
    expect(first.structure.pointer).toBe('/accessionNumber/0');
    expect(historyText.slice(first.start, first.end)).toBe(first.text);
  } finally {
    f.close();
  }
});

it('历史分片 403 后导出恢复续跑，成功根索引不重取，新增分片和正文另建核对且保留旧结果', async () => {
  const f = submissionHistoryFixture();
  f.historyHooks.fail = true;
  const restored = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    publicDataClient: f.client,
    researchModel: f.model,
  });
  try {
    const task = f.app.initialResearch.request(f.p.id, human, 'failed-history-workflow', {
      sourceVersionIds: ['sv'],
    });
    const before = await f.app.initialResearch.run(f.p.id, task.id);
    expect(before.state).toBe('partial');
    expect((before.output as any).history.acquisitions[0].error).toContain('ACCESS_DENIED');
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-history-task',
      new AssetService(f.app.repo, f.app.write).export(f.p.id),
    );
    f.historyHooks.fail = false;
    restored.jobs.retry(f.p.id, task.id);
    const after = await restored.initialResearch.run(f.p.id, task.id);
    expect(after.state, after.error ?? '').toBe('succeeded');
    expect(f.requests.filter((url) => url.endsWith('/CIK0000000001.json'))).toHaveLength(1);
    expect(f.requests.filter((url) => url.endsWith(historyName))).toHaveLength(2);
    expect((after.output as any).history.acquisitions[0].jobId).toBe(
      (before.output as any).history.acquisitions[0].jobId,
    );
    for (const check of (after.output as any).checks) expect(check.previousJobIds).toHaveLength(1);
    const text = (after.output as any).history.acquisitions[0].sourceVersionId;
    expect(restored.repo.material(f.p.id, text)).toBe(historyText);
  } finally {
    restored.db.close();
    f.close();
  }
});

it('历史截止点前未取得的分片不联网补读，之后的本机快照可回查', async () => {
  const f = submissionHistoryFixture();
  try {
    const root = f.app.publicData.request(f.p.id, human, 'before-history-root', {
      sourceId: 'sec-edgar',
      cik: '1',
      dataset: 'submissions',
      refresh: true,
    });
    await f.app.publicData.run(f.p.id, root.id);
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const task = f.app.initialResearch.request(f.p.id, human, 'obtain-history-body', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, task.id)).state).toBe('succeeded');
    const after = new Date().toISOString(),
      count = f.requests.length;
    for (const [asOf, expected] of [
      [before, 'not_known'],
      [after, 'available'],
    ]) {
      const task = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
        sourceVersionIds: ['sv'],
        asOf,
      });
      const result = await f.app.initialResearch.run(f.p.id, task.id);
      expect(result.state, result.error ?? '').toBe('succeeded');
      expect((result.output as any).history.acquisitions[0].state).toBe(expected);
    }
    expect(f.requests).toHaveLength(count);
  } finally {
    f.close();
  }
});

it('活动历史下载取消或研究撤销后立即重做，迟到分片不入库也不取得正文', async () => {
  for (const mode of ['cancel', 'undo']) {
    const f = submissionHistoryFixture();
    let enter!: () => void,
      release!: () => void,
      pending: ReturnType<typeof f.app.initialResearch.run> | undefined;
    const started = new Promise<void>((r) => {
      enter = r;
    });
    f.historyHooks.duringHistory = async () => {
      enter();
      await new Promise<void>((r) => {
        release = r;
      });
    };
    try {
      const task = f.app.initialResearch.request(f.p.id, human, randomUUID(), {
        sourceVersionIds: ['sv'],
      });
      pending = f.app.initialResearch.run(f.p.id, task.id);
      await started;
      if (mode === 'cancel') f.app.initialResearch.cancel(f.p.id, task.id);
      else
        for (const direction of ['undo', 'redo'])
          f.app.write.travel(f.p.id, human, randomUUID(), {
            direction,
            expectedRevision: f.app.repo.project(f.p.id).revision,
            expectedLayoutVersion: readLayout(f.app.repo, f.p.id).version,
            expectedHistoryVersion: f.app.write.history(f.p.id).version,
          });
      release();
      await pending;
      expect(f.app.jobs.get(f.p.id, task.id).state).toBe('cancelled');
      expect(
        f.app.repo
          .snapshot(f.p.id)
          .objects.some((e) => e.kind === 'source_version' && e.data.provenance?.indexParent),
      ).toBe(false);
      expect(f.requests.some((url) => url.includes('/Archives/'))).toBe(false);
    } finally {
      release?.();
      await pending;
      f.close();
    }
  }
});

it('外部 Agent 经 MCP SDK 与同一 HTTP 接口取得固定历史分片，跨项目拒绝且原键复用', async () => {
  const f = submissionHistoryFixture();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../src/mcp-server.js');
  const token = f.app.access.issue('agent', [f.p.id]);
  const server = createMcpServer({
    async call(path, method = 'GET', body, key) {
      const r = await f.app.app.request('http://127.0.0.1:8787' + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.code + ': ' + value.message);
      return value;
    },
  });
  const client = new Client({ name: 'synthetic-sec-filing', version: '1' }),
    [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const root = f.app.publicData.request(f.p.id, human, 'mcp-history-root', {
      sourceId: 'sec-edgar',
      cik: '1',
      dataset: 'submissions',
      refresh: true,
    });
    const fetched = await f.app.publicData.run(f.p.id, root.id);
    const args = {
      projectId: f.p.id,
      idempotencyKey: 'mcp-sec-filing-request',
      request: {
        indexSourceVersionId: (fetched.output as any).sourceVersionId,
        fileName: historyName,
      },
    };
    const first = await client.callTool({ name: 'forkwise_fetch_sec_history', arguments: args });
    expect(first.isError).not.toBe(true);
    expect(await client.callTool({ name: 'forkwise_fetch_sec_history', arguments: args })).toEqual(
      first,
    );
    expect(
      JSON.stringify(
        (
          await client.callTool({
            name: 'forkwise_fetch_sec_history',
            arguments: { ...args, projectId: 'other' },
          })
        ).content,
      ),
    ).toContain('PROJECT_FORBIDDEN');
    const task = f.app.jobs.list(f.p.id).find((j) => j.kind === 'source.sec-history')!;
    expect((await f.app.publicData.run(f.p.id, task.id)).state).toBe('succeeded');
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});
