import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { human, agent, statement, inference, expectedOf } from './helpers.js';

import { impactReviewFixture as fixture } from './fixtures/impact-review.js';

it('本人可维持原判断、稍后处理和修订复核结果；立场与内容保持，重复保存无新版本', async () => {
  const f = await fixture();
  try {
    const before = f.get('i');
    const result = f.write([f.command()]);
    expect(result.upserted.map((e) => e.kind)).toEqual(['review']);
    expect(f.get('i')).toEqual(before);
    expect(f.get('review').data).toMatchObject({
      disposition: 'maintained',
      jobId: f.task.id,
      proposalIndex: 0,
    });
    expect(f.write([f.command()]).upserted).toEqual([]);
    expect(f.app.repo.history(f.project.id, 'review')).toHaveLength(1);
    f.write([f.command('later', '')]);
    f.write([f.command('revised', '已另行核对，记录本次处理结果')]);
    expect(f.app.repo.history(f.project.id, 'review')).toHaveLength(3);
    expect(f.get('i')).toEqual(before);
    expect(() => f.write([f.command()], agent)).toThrow(/本人确认/);
  } finally {
    f.app.db.close();
  }
});

it('读取逐条复核状态，维持仅关闭本条；立场或前提变化后重新提示并拒绝过时保存', async () => {
  const f = await fixture();
  try {
    const token = f.app.access.issue('human', ['*']);
    const read = async (query = '') => {
      const r = await f.app.app.request(
        `http://127.0.0.1:8787/api/v1/projects/${f.project.id}/impact-reviews${query}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(r.status).toBe(200);
      return (await r.json()).data;
    };
    const initial = await read();
    expect(initial.items).toHaveLength(2);
    expect(initial.items.every((i: any) => i.reviewState === 'pending')).toBe(true);
    f.write([f.command()]);
    const maintained = (await read()).items.find((i: any) => i.proposalIndex === 0);
    expect(maintained.reviewState).toBe('completed');
    expect((await read()).items.find((i: any) => i.proposalIndex === 1).reviewState).toBe(
      'pending',
    );
    const old = f.command();
    f.write([{ op: 'statement.edit', id: 'a', text: '改变前提范围', scope: 'all' }]);
    expect((await read()).items.find((i: any) => i.proposalIndex === 0)).toMatchObject({
      proposalState: 'stale',
      reviewState: 'stale',
    });
    const before = f.state();
    expect(() => f.write([old])).toThrow(/内容、个人立场或前提已变化/);
    expect(f.state()).toEqual(before);
    f.write([f.command('maintained', '已按照改后的前提重新核对')]);
    expect((await read()).items.find((i: any) => i.proposalIndex === 0).reviewState).toBe(
      'completed',
    );
    f.write([{ op: 'stance.set', id: 'i', stance: { value: 'questioned', reason: '新疑问' } }]);
    expect((await read()).items.find((i: any) => i.proposalIndex === 0).reviewState).toBe('stale');
    const page = await read('?limit=1');
    expect(page.nextCursor).toBeTruthy();
    const next = await read(`?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect(next.items[0].proposalIndex).not.toBe(page.items[0].proposalIndex);
  } finally {
    f.app.db.close();
  }
});

it('完整 JSON 保留复核和历史；伪造建议归属、内容或固定上下文不能导入', async () => {
  const f = await fixture();
  const { AssetService } = await import('../src/services/assets.js');
  const { ArchiveService } = await import('../src/services/archive.js');
  const { readImpactReviews } = await import('../src/services/impact-reviews.js');
  const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    f.write([f.command('later', '')]);
    f.write([f.command()]);
    const archive = new AssetService(f.app.repo, f.app.write).export(f.project.id);
    new ArchiveService(restored.write, restored.search).import(human, randomUUID(), archive);
    expect(
      readImpactReviews(restored.repo, f.project.id, {}).items.find((i) => i.proposalIndex === 0)
        ?.reviewState,
    ).toBe('completed');
    expect(restored.repo.history(f.project.id, 'review')).toHaveLength(2);
    for (const corrupt of [
      (copy: any) => {
        copy.tasks.find((t: any) => t.id === f.task.id).output.result.proposals[0].reason =
          '被改写的建议';
      },
      (copy: any) => {
        copy.tasks = copy.tasks.filter((t: any) => t.id !== f.task.id);
      },
      (copy: any) => {
        for (const e of [...copy.objects, ...copy.versions.map((v: any) => v.snapshot)])
          if (e.kind === 'review') e.data.context = [];
      },
    ]) {
      const broken = structuredClone(archive);
      corrupt(broken);
      const other = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
      try {
        expect(() =>
          new ArchiveService(other.write, other.search).import(human, randomUUID(), broken),
        ).toThrow();
        expect(other.repo.listProjects()).toHaveLength(0);
      } finally {
        other.db.close();
      }
    }
  } finally {
    restored.db.close();
    f.app.db.close();
  }
});

it('旧推导前提变化后不能直接采用原建议；相关版本、理由和复核身份须一致', async () => {
  const f = await fixture();
  try {
    expect(() => f.write([f.command('maintained', '  ')])).toThrow(/处理理由/);
    expect(() => f.write([f.command()], human, { [f.get('i').id]: f.get('i').version })).toThrow(
      /相关对象/,
    );
    f.write([f.command()]);
    expect(() => f.write([{ ...f.command(), id: 'other-review' }])).toThrow(/已有复核/);
    const state = f.state();
    expect(() =>
      f.write([
        statement('rollback'),
        { ...f.command(), target: { id: 'a', versionId: f.get('a').versionId }, context: [] },
      ]),
    ).toThrow(/复核目标/);
    expect(f.state()).toEqual(state);
    f.write([{ op: 'statement.edit', id: 'a', scope: 'all', text: '前提发生实质变化' }]);
    expect(() =>
      f.write([
        {
          op: 'impact.adopt',
          id: 'i',
          jobId: f.task.id,
          proposalIndex: 0,
          text: '旧建议',
          scope: 'all',
          inferenceIds: [],
        },
      ]),
    ).toThrow(/前提|旧内容/);
  } finally {
    f.app.db.close();
  }
});

it('复核随操作撤销重做与目标删除恢复；HTTP/MCP 读取受项目权限控制且 Agent 不可确认', async () => {
  const f = await fixture();
  const { readLayout } = await import('../src/repositories/layout.js');
  const { expectedVersions } = await import('../web/operation-versions.js');
  const { readImpactReviews } = await import('../src/services/impact-reviews.js');
  const { createMcpServer } = await import('../src/mcp-server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const token = f.app.access.issue('agent', [f.project.id]);
  const server = createMcpServer({
    async call(path, method = 'GET', body, key) {
      const r = await f.app.app.request('http://127.0.0.1:8787' + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.code + ': ' + json.message);
      return json;
    },
  });
  const client = new Client({ name: 'review-test', version: '1' });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const response = await client.callTool({
      name: 'forkwise_read_impact_reviews',
      arguments: { projectId: f.project.id, targetId: 'i', limit: 1 },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      response: { data: { items: [{ reviewState: 'pending' }] } },
    });
    expect(
      (
        await client.callTool({
          name: 'forkwise_read_impact_reviews',
          arguments: { projectId: 'unrelated' },
        })
      ).isError,
    ).toBe(true);
    const denied = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: {
        projectId: f.project.id,
        idempotencyKey: 'review-agent-denied',
        request: { commands: [f.command()], expected: expectedOf(f.state().objects) },
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('HUMAN_REQUIRED');
    const command = f.command();
    f.write([command], human, expectedVersions(f.state().objects, [command]));
    const travel = (direction: 'undo' | 'redo') =>
      f.app.write.travel(f.project.id, human, randomUUID(), {
        direction,
        expectedRevision: f.state().project.revision,
        expectedHistoryVersion: f.app.write.history(f.project.id).version,
        expectedLayoutVersion: readLayout(f.app.repo, f.project.id).version,
      });
    travel('undo');
    expect(
      readImpactReviews(f.app.repo, f.project.id, {}).items.find((i) => i.proposalIndex === 0)
        ?.reviewState,
    ).toBe('pending');
    travel('redo');
    expect(
      readImpactReviews(f.app.repo, f.project.id, {}).items.find((i) => i.proposalIndex === 0)
        ?.reviewState,
    ).toBe('completed');
    expect(() => f.write([{ op: 'object.delete', id: 'review' }])).toThrow(/历史保留/);
    const deletion: any = { op: 'object.delete', id: 'i' };
    expect(
      f.write([deletion], human, expectedVersions(f.state().objects, [deletion])).deletedIds.sort(),
    ).toEqual(['i', 'review']);
    travel('undo');
    expect(
      readImpactReviews(f.app.repo, f.project.id, {}).items.find((i) => i.proposalIndex === 0)
        ?.reviewState,
    ).toBe('completed');
  } finally {
    await client.close();
    await server.close();
    f.app.db.close();
  }
});

it('HTTP 同键恢复只有一条复核，权利过滤后 JSON 和固定历史摘要仍保留当次处理', async () => {
  const f = await fixture('http://127.0.0.1:8787', ':memory:', 'restricted');
  const { AssetService } = await import('../src/services/assets.js');
  const { ArchiveService } = await import('../src/services/archive.js');
  const { readImpactReviews } = await import('../src/services/impact-reviews.js');
  const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const token = f.app.access.issue('human', ['*']);
    const input = { commands: [f.command()], expected: expectedOf(f.state().objects) };
    const send = () =>
      f.app.app.request(`http://127.0.0.1:8787/api/v1/projects/${f.project.id}/operations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'same-review-operation',
        },
        body: JSON.stringify(input),
      });
    const first = await send(),
      second = await send();
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(f.app.repo.history(f.project.id, 'review')).toHaveLength(1);
    const assets = new AssetService(f.app.repo, f.app.write);
    const summary = assets.summary(f.project.id);
    expect(summary).toContain('维持原判断');
    expect(summary).toContain('已核对新材料，原判断仍适用');
    const historical = assets.recordJudgment(f.project.id, human, randomUUID(), '复核后的历史判断');
    const archive = assets.export(f.project.id);
    expect(
      (archive.tasks.find((t) => t.id === f.task.id)!.output as any).result.proposals[0]
        .citations[0],
    ).toMatchObject({ quote: '', unavailableReason: 'rights' });
    new ArchiveService(restored.write, restored.search).import(human, randomUUID(), archive);
    expect(
      readImpactReviews(restored.repo, f.project.id, {}).items.find((i) => i.proposalIndex === 0)
        ?.reviewState,
    ).toBe('completed');
    f.write([f.command('later', '后来的暂缓处理')]);
    expect(assets.summary(f.project.id)).toContain('后来的暂缓处理');
    const original = assets.summary(f.project.id, historical.id);
    expect(original).toContain('维持原判断');
    expect(original).not.toContain('后来的暂缓处理');
  } finally {
    restored.db.close();
    f.app.db.close();
  }
});
