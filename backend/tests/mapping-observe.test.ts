import { afterEach, expect, it } from 'vitest';
import { compactFixture, closeCompactFixtures } from './compact-fixture.js';
import { DomainError } from '../src/domain/errors.js';

afterEach(closeCompactFixtures);
it('observe 连续变化给出写域、删除身份和同 revision 无损重读 token', () => {
  const f = compactFixture();
  f.create('c', '原正文');
  const original = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[0]!;
  f.mapping.execute(
    {
      commandId: 'body',
      projectId: 'p',
      type: 'body.edit',
      expected: original.body.versionId,
      payload: { id: 'c', text: '新正文' },
    },
    f.human,
  );
  const feed = f.mapping.observe({ projectId: 'p', afterRevision: 2 }, f.agent);
  expect(feed).toMatchObject({
    status: 'OK',
    revision: 3,
    afterRevision: 2,
    nextRevision: 3,
    complete: true,
    budgetUnit: 'utf8_bytes',
    changes: [{ revision: 3, domains: [{ domain: 'body', id: original.body.id }], deletedIds: [] }],
  });
  const current = f.mapping.read(
    { type: 'map', view: 'index', projectId: 'p', snapshot: feed.snapshot },
    f.human,
  );
  f.mapping.execute(
    { commandId: 'undo-edit', projectId: 'p', type: 'history.undo', expected: 3, payload: {} },
    f.human,
  );
  f.mapping.execute(
    { commandId: 'undo-create', projectId: 'p', type: 'history.undo', expected: 4, payload: {} },
    f.human,
  );
  const removed = f.mapping.observe({ projectId: 'p', afterRevision: 3 }, f.agent);
  expect(removed.changes.map((c) => c.revision)).toEqual([4, 5]);
  expect(removed.changes[1]).toMatchObject({
    deletedIds: [original.id, original.body.id, original.item.id],
    domains: [
      { domain: 'thought', id: original.id },
      { domain: 'body', id: original.body.id },
      { domain: 'pose', id: original.item.id },
    ],
  });
  expect(
    f.mapping.read(
      { type: 'map', view: 'index', projectId: 'p', snapshot: removed.snapshot },
      f.human,
    ).items,
  ).toEqual([]);
  const detail = f.mapping.read(
    { type: 'map', view: 'detail', projectId: 'p', cardId: 'c', snapshot: current.snapshot },
    f.agent,
  );
  expect(JSON.parse(detail.items.map((i) => i.jsonText).join('')).blocks[0].text).toBe('新正文');
});

it('固定缓存 token 过期明确说明重新开始路径；当前授权先于 token 读取', () => {
  let now = 0;
  const f = compactFixture({ compact: { clock: () => now, snapshotTtlMs: 10 } });
  f.create('c');
  const page = f.mapping.observe({ projectId: 'p', afterRevision: 2 }, f.agent);
  now = 10;
  let error: unknown;
  try {
    f.mapping.observe({ projectId: 'p', afterRevision: 2, baseSnapshot: page.snapshot }, f.agent);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DomainError);
  expect(error).toMatchObject({
    code: 'SNAPSHOT_EXPIRED',
    details: { recovery: { type: 'map', view: 'index', projectId: 'p' } },
  });
  f.mapping.access.revoke(f.agent.tokenHash);
  expect(() =>
    f.mapping.observe({ projectId: 'p', afterRevision: 2, baseSnapshot: page.snapshot }, f.agent),
  ).toThrow('会话');
  const fresh = f.mapping.read({ type: 'map', view: 'index', projectId: 'p' }, f.human);
  expect(fresh.snapshot).not.toBe(page.snapshot);
  expect(fresh.revision).toBe(2);
});

it('背压分页固定终点和 token，并发新写与重复消息不拼入旧批次', () => {
  const f = compactFixture();
  f.create('a');
  f.create('b');
  const first = f.mapping.observe(
    { projectId: 'p', afterRevision: 1, limit: 1, budget: 4096 },
    f.agent,
  );
  expect(first).toMatchObject({ revision: 3, nextRevision: 2, complete: false });
  expect(Buffer.byteLength(JSON.stringify(first))).toBe(first.bytes);
  expect(first.bytes).toBeLessThanOrEqual(4096);
  f.create('later');
  const repeated = f.mapping.observe(
    { projectId: 'p', afterRevision: 1, limit: 1, budget: 4096, snapshot: first.snapshot },
    f.agent,
  );
  expect(repeated).toEqual(first);
  const last = f.mapping.observe(
    {
      projectId: 'p',
      afterRevision: first.nextRevision,
      snapshot: first.snapshot,
      limit: 1,
      budget: 4096,
    },
    f.agent,
  );
  expect(last).toMatchObject({
    revision: 3,
    nextRevision: 3,
    complete: true,
    changes: [{ commandId: 'b' }],
  });
  expect(
    f.mapping
      .read({ type: 'map', view: 'index', projectId: 'p', snapshot: last.snapshot }, f.agent)
      .items.map((i) => i.id),
  ).toEqual(['a', 'b']);
  const next = f.mapping.observe(
    { projectId: 'p', afterRevision: 3, baseSnapshot: first.snapshot },
    f.agent,
  );
  expect(next.changes.map((c) => c.commandId)).toEqual(['later']);
  expect(() =>
    f.mapping.observe({ projectId: 'p', afterRevision: 2, baseSnapshot: first.snapshot }, f.agent),
  ).toThrow('缓存修订');
});

it('断线后有限窗口返回 RESET_REQUIRED 和完整重读路径，原幂等与版本仍可读取', () => {
  const f = compactFixture({ observe: { retentionRevisions: 2 } });
  const created = f.create('c');
  const original = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[0]!;
  for (let n = 0; n < 3; n++) {
    const card = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[0]!;
    f.mapping.execute(
      {
        commandId: 'move' + n,
        projectId: 'p',
        type: 'pose.move',
        expected: card.item.versionId,
        payload: { id: 'c', x: 50 + n, y: 60 },
      },
      f.human,
    );
  }
  const feed = f.mapping.observe({ projectId: 'p', afterRevision: 2 }, f.agent);
  expect(feed).toMatchObject({
    status: 'RESET_REQUIRED',
    reason: 'CURSOR_TOO_OLD',
    revision: 5,
    changes: [],
    recovery: { type: 'map', view: 'index', projectId: 'p' },
  });
  expect(
    f.mapping.read({ type: 'map', view: 'index', projectId: 'p', snapshot: feed.snapshot }, f.agent)
      .items[0]!.item.pose.x,
  ).toBe(52);
  expect(f.create('c')).toEqual(created);
  expect(
    f.mapping.read(
      {
        type: 'version',
        projectId: 'p',
        domain: 'body',
        id: original.body.id,
        versionId: original.body.versionId,
      },
      f.agent,
    ),
  ).toEqual(original.body);
  expect(
    f.mapping.observe({ projectId: 'p', afterRevision: 3 }, f.agent).changes.map((c) => c.revision),
  ).toEqual([4, 5]);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: 6 }, f.agent)).toMatchObject({
    status: 'RESET_REQUIRED',
    reason: 'CURSOR_AHEAD',
  });
});

it('响应完整字节预算不可截断超长原文，背压给固定完整重读路径', () => {
  const f = compactFixture();
  f.create('long', '完整🧠'.repeat(20000));
  let error: unknown;
  try {
    f.mapping.observe({ projectId: 'p', afterRevision: 1, budget: 4096 }, f.agent);
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({
    code: 'ITEM_EXCEEDS_BUDGET',
    details: { budgetUnit: 'utf8_bytes', recovery: { type: 'map', view: 'index', projectId: 'p' } },
  });
  const snapshot = (error as DomainError).details as { recovery: { snapshot: string } };
  const detail = f.mapping.read(
    {
      type: 'map',
      view: 'detail',
      projectId: 'p',
      cardId: 'long',
      snapshot: snapshot.recovery.snapshot,
      budget: 1_048_576,
    },
    f.agent,
  );
  expect(JSON.parse(detail.items.map((c) => c.jsonText).join('')).blocks[0].text).toBe(
    '完整🧠'.repeat(20000),
  );
  const full = f.mapping.observe({ projectId: 'p', afterRevision: 1, budget: 1_048_576 }, f.agent);
  expect(Buffer.byteLength(JSON.stringify(full))).toBe(full.bytes);
  expect(full.changes[0]!.after).toMatchObject({
    body: { blocks: [{ text: '完整🧠'.repeat(20000) }] },
  });
});

it('续页期间窗口前进时 RESET_REQUIRED 指向当前完整快照而不是过旧终点', () => {
  const f = compactFixture({ observe: { retentionRevisions: 2 } });
  f.create('a');
  f.create('b');
  const old = f.mapping.observe({ projectId: 'p', afterRevision: 1, limit: 1 }, f.agent);
  for (const id of ['c', 'd', 'e']) f.create(id);
  const reset = f.mapping.observe(
    { projectId: 'p', afterRevision: old.nextRevision, snapshot: old.snapshot },
    f.agent,
  );
  expect(reset).toMatchObject({
    status: 'RESET_REQUIRED',
    revision: 6,
    nextRevision: 6,
    reason: 'CURSOR_TOO_OLD',
  });
  expect(reset.snapshot).not.toBe(old.snapshot);
  expect(
    f.mapping
      .read({ type: 'map', view: 'index', projectId: 'p', snapshot: reset.snapshot }, f.agent)
      .items.map((i) => i.id),
  ).toEqual(['a', 'b', 'c', 'd', 'e']);
});
