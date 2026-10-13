import { afterEach, expect, it } from 'vitest';
import { compactFixture as fixture, closeCompactFixtures } from './compact-fixture.js';
afterEach(closeCompactFixtures);

it('每次续读重新验证授权，快照过期与未读、拒绝、删除、从未存在分别表达', () => {
  let clock = 1000;
  const { mapping, human, agent, create } = fixture({
    compact: { clock: () => clock, snapshotTtlMs: 50 },
  });
  create('c');
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  expect(index.items[0]!.body.availability).toBe('not_fetched');
  const denied = mapping.access.authenticate(mapping.access.issue('agent', ['other']));
  const query = {
    type: 'map' as const,
    view: 'detail' as const,
    projectId: 'p',
    cardId: 'c',
    snapshot: index.snapshot,
  };
  expect(() => mapping.read(query, denied)).toThrow(
    expect.objectContaining({ code: 'PROJECT_FORBIDDEN' }),
  );
  expect(() => mapping.read({ ...query, projectId: 'other' }, human)).toThrow(
    expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
  );
  mapping.execute(
    { commandId: 'undo', projectId: 'p', type: 'history.undo', expected: 2, payload: {} },
    human,
  );
  const deleted = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  expect(mapping.read({ ...query, snapshot: deleted.snapshot }, agent)).toMatchObject({
    availability: 'deleted',
    items: [],
  });
  expect(
    mapping.read({ ...query, cardId: 'never', snapshot: deleted.snapshot }, agent),
  ).toMatchObject({ availability: 'not_found', items: [] });
  expect(mapping.read(query, agent)).toMatchObject({ availability: 'available' });
  mapping.access.revoke(agent.tokenHash);
  expect(() => mapping.read(query, agent)).toThrow(
    expect.objectContaining({ code: 'UNAUTHORIZED' }),
  );
  clock = 1050;
  expect(() => mapping.read(query, human)).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }),
  );
});

it('读取缓存有明确容量边界，重复同 revision 不消耗新快照，超长标题不被偷偷截断', () => {
  const { mapping, human, create } = fixture({ compact: { maxSnapshots: 1 } });
  create('c');
  const first = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  expect(mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human).snapshot).toBe(
    first.snapshot,
  );
  const card = mapping.read({ type: 'project', projectId: 'p' }, human).cards[0]!;
  mapping.execute(
    {
      commandId: 'title',
      projectId: 'p',
      type: 'thought.title',
      expected: card.versionId,
      payload: { id: 'c', title: '长🧠标题'.repeat(1000) },
    },
    human,
  );
  expect(() => mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human)).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }),
  );
  const f = fixture();
  f.create('huge');
  const huge = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[0]!;
  f.mapping.execute(
    {
      commandId: 'title',
      projectId: 'p',
      type: 'thought.title',
      expected: huge.versionId,
      payload: { id: 'huge', title: '长🧠标题'.repeat(1000) },
    },
    f.human,
  );
  expect(() =>
    f.mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 1800 }, f.human),
  ).toThrow(expect.objectContaining({ code: 'ITEM_EXCEEDS_BUDGET' }));
  expect(
    f.mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 32000 }, f.human).items[0]!
      .title,
  ).toBe('长🧠标题'.repeat(1000));
});

it('固定索引快照容量单独有界，失败不影响持久正文与历史读取', () => {
  const { mapping, human, create } = fixture({ compact: { maxSnapshotBytes: 128 } });
  create('c', '内容'.repeat(1000));
  expect(() => mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human)).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }),
  );
  expect(
    mapping.read({ type: 'project', projectId: 'p' }, human).cards[0]!.body.blocks[0]!.text,
  ).toBe('内容'.repeat(1000));
  expect(mapping.read({ type: 'history', projectId: 'p' }, human).undo).toHaveLength(1);
});
