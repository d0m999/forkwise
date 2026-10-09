import { it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { human, statement } from './helpers.js';
import { filingFixture, html } from './fixtures/sec-filings.js';

it('索引选定主文件经持久任务成为独立可引用正文，保留原始字节和来历，同键与重复取材不重复版本', async () => {
  const f = await filingFixture();
  try {
    const queued = f.app.filings.request(f.project.id, human, 'filing-request', f.request);
    const done = await f.app.filings.run(f.project.id, queued.id);
    expect(done.state).toBe('succeeded');
    const out = done.output as any;
    expect(f.calls).toHaveLength(2);
    expect(out.lineage.indexSourceVersionId).toBe(f.request.indexSourceVersionId);
    expect(f.app.repo.material(f.project.id, out.sourceVersionId)).toBe('Synthetic revenue: 12.');
    expect(f.app.files.file(f.project.id, out.fileId).bytes.toString('utf8')).toBe(html);
    expect(f.app.files.artifact(f.project.id, out.sourceVersionId).blocks[0]).toMatchObject({
      start: 0,
      end: 22,
    });
    const state = f.app.repo.snapshot(f.project.id);
    expect(state.objects.find((e) => e.id === out.sourceVersionId)?.data).toMatchObject({
      publishedAt: null,
      textOrigin: 'html_body',
      provenance: {
        provider: 'sec-edgar',
        requestUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000009925000001/report.htm',
      },
    });
    expect(
      state.objects.filter((e) => e.kind === 'evidence_link' || e.kind === 'statement'),
    ).toEqual([]);
    expect(f.app.filings.request(f.project.id, human, 'filing-request', f.request).id).toBe(
      queued.id,
    );
    const another = f.app.filings.request(f.project.id, human, 'filing-again', f.request);
    expect((await f.app.filings.run(f.project.id, another.id)).state).toBe('succeeded');
    expect(f.app.repo.snapshot(f.project.id)).toEqual(state);
  } finally {
    f.close();
  }
});

it('项目授权、原索引身份和任务绑定在网络前校验，HTTP 同键恢复返回同一任务', async () => {
  const f = await filingFixture();
  try {
    const other = f.app.write.createProject(human, 'filing-other', { name: '其他项目' });
    expect(() => f.app.filings.request(other.id, human, 'cross-project', f.request)).toThrow(
      '索引',
    );
    expect(() =>
      f.app.filings.request(f.project.id, human, 'unlisted-filing', {
        ...f.request,
        accessionNumber: '0000000099-25-000002',
      }),
    ).toThrow('恰好');
    const token = f.app.access.issue('agent', [f.project.id]);
    const call = (projectId: string) =>
      f.app.app.request(`http://127.0.0.1:8787/api/v1/projects/${projectId}/public-data/filing`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'Idempotency-Key': 'http-filing-request',
        },
        body: JSON.stringify(f.request),
      });
    expect((await call(other.id)).status).toBe(403);
    const first = await call(f.project.id);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect((await (await call(f.project.id)).json()).data.id).toBe(body.data.id);
    const job = f.app.jobs.get(f.project.id, body.data.id),
      input = structuredClone(job.input) as any;
    input.binding.url = 'https://outside.invalid/secret';
    f.app.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(input), job.id);
    expect((await f.app.filings.run(f.project.id, job.id)).error).toContain(
      'INVALID_FILING_BINDING',
    );
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('取消拒绝晚到正文；访问失败保留索引，显式重试后才再次请求', async () => {
  const f = await filingFixture();
  try {
    let release!: (r: Response) => void, started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    f.hooks.fetch = () => {
      started();
      return new Promise<Response>((r) => (release = r));
    };
    const task = f.app.filings.request(f.project.id, human, 'cancel-filing', f.request),
      before = f.app.repo.snapshot(f.project.id);
    const running = f.app.filings.run(f.project.id, task.id);
    await ready;
    f.app.filings.cancel(f.project.id, task.id);
    release(new Response(html, { headers: { 'content-type': 'text/html' } }));
    expect((await running).state).toBe('cancelled');
    expect(f.app.repo.snapshot(f.project.id)).toEqual(before);
    f.hooks.fetch = async () => new Response('denied', { status: 403 });
    const failed = f.app.filings.request(f.project.id, human, 'denied-filing', f.request);
    expect((await f.app.filings.run(f.project.id, failed.id)).error).toContain('ACCESS_DENIED');
    expect(f.app.repo.snapshot(f.project.id)).toEqual(before);
    const calls = f.calls.length;
    await f.app.filings.run(f.project.id, failed.id);
    expect(f.calls).toHaveLength(calls);
    delete f.hooks.fetch;
    f.app.jobs.retry(f.project.id, failed.id);
    expect((await f.app.filings.run(f.project.id, failed.id)).state).toBe('succeeded');
  } finally {
    f.close();
  }
});

it('正文保存后解析落盘失败保留原文件；资产恢复后重试使用原字节且变更集合不跨过交错编辑', async () => {
  const f = await filingFixture();
  let restored: ReturnType<typeof createApplication> | undefined;
  try {
    f.app.db.exec(
      "CREATE TRIGGER fail_filing_artifact BEFORE INSERT ON parsed_artifacts BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    const task = f.app.filings.request(f.project.id, human, 'parse-filing-failure', f.request);
    const failed = await f.app.filings.run(f.project.id, task.id);
    expect(failed.state).toBe('failed');
    const stored = failed.output as any;
    expect(stored.fileId).toBeTruthy();
    expect(stored.sourceVersionId).toBeUndefined();
    expect(f.app.files.file(f.project.id, stored.fileId).bytes.toString()).toBe(html);
    const { AssetService } = await import('../src/services/assets.js'),
      { ArchiveService } = await import('../src/services/archive.js');
    restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-filing-archive',
      new AssetService(f.app.repo, f.app.write).export(f.project.id),
    );
    restored.write.execute(f.project.id, human, 'interleaved-filing-edit', {
      expected: {},
      commands: [statement('unrelated', '另一项研究')],
    });
    const revision = restored.repo.project(f.project.id).revision;
    restored.jobs.retry(f.project.id, task.id);
    const done = await restored.filings.run(f.project.id, task.id);
    expect(done.state).toBe('succeeded');
    expect((done.output as any).changes.revisionBefore).toBe(revision);
    expect(restored.repo.material(f.project.id, (done.output as any).sourceVersionId)).toBe(
      'Synthetic revenue: 12.',
    );
    expect(f.calls).toHaveLength(2);
  } finally {
    restored?.db.close();
    f.close();
  }
});

it('外部 Agent 经 MCP SDK 与同一 HTTP 接口取得申报正文，跨项目拒绝且原键复用', async () => {
  const f = await filingFixture();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../src/mcp-server.js');
  const token = f.app.access.issue('agent', [f.project.id]);
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
    const args = {
      projectId: f.project.id,
      idempotencyKey: 'mcp-sec-filing-request',
      request: f.request,
    };
    const first = await client.callTool({ name: 'forkwise_fetch_sec_filing', arguments: args });
    expect(first.isError).not.toBe(true);
    expect(await client.callTool({ name: 'forkwise_fetch_sec_filing', arguments: args })).toEqual(
      first,
    );
    expect(
      JSON.stringify(
        (
          await client.callTool({
            name: 'forkwise_fetch_sec_filing',
            arguments: { ...args, projectId: 'other' },
          })
        ).content,
      ),
    ).toContain('PROJECT_FORBIDDEN');
    const task = f.app.jobs.list(f.project.id).find((j) => j.kind === 'source.sec-filing')!;
    expect((await f.app.filings.run(f.project.id, task.id)).state).toBe('succeeded');
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

it('部分解析重试只处理已有原件，保存每阶段独立回执并保留未读范围', async () => {
  const f = await filingFixture();
  try {
    f.hooks.fetch = async () =>
      new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } });
    const job = f.app.filings.request(f.project.id, human, 'empty-filing-body', f.request);
    const partial = await f.app.filings.run(f.project.id, job.id);
    expect(partial.state).toBe('partial');
    const first = partial.output as any;
    expect(first.gaps.join('')).toContain('未获取附件');
    f.app.jobs.retry(f.project.id, job.id);
    const again = await f.app.filings.run(f.project.id, job.id);
    expect(again.state).toBe('partial');
    expect(f.calls).toHaveLength(2);
    expect((again.output as any).acquisitionChanges).toEqual(first.acquisitionChanges);
    expect((again.output as any).changes.revisionBefore).toBe(
      (again.output as any).changes.revisionAfter,
    );
  } finally {
    f.close();
  }
});
