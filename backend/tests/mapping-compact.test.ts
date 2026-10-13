import { afterEach, expect, it } from 'vitest';
import { compactFixture as fixture, closeCompactFixtures } from './compact-fixture.js';
afterEach(closeCompactFixtures);

it('完整 JSON 响应包含元数据仍在字节预算内，分页固定排序且并发写入不污染旧页', () => {
  const { mapping, human, agent, create } = fixture();
  for (const id of ['d', 'c', 'b', 'a', 'e']) create(id);
  const first = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 1800 }, agent);
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(5);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.bytes).toBe(Buffer.byteLength(JSON.stringify(first), 'utf8'));
  expect(first.bytes).toBeLessThanOrEqual(1800);
  expect(first.coverage.complete).toBe(false);
  create('aa', '新写入');
  const pages = [first];
  while (pages.at(-1)!.nextCursor)
    pages.push(
      mapping.read(
        {
          type: 'map',
          view: 'index',
          projectId: 'p',
          snapshot: first.snapshot,
          cursor: pages.at(-1)!.nextCursor!,
          budget: 1800,
        },
        human,
      ),
    );
  expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(
    pages.every(
      (p) =>
        p.revision === 6 &&
        p.totalItems === 5 &&
        p.snapshot === first.snapshot &&
        Buffer.byteLength(JSON.stringify(p)) <= 1800,
    ),
  ).toBe(true);
  expect(pages.at(-1)!.coverage).toMatchObject({ end: 5, complete: true });
  expect(() =>
    mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 8 }, agent),
  ).toThrow('预算不足');
});

it('人和 Agent 的身份页来自同 revision，保留类型与独立版本且不泄露未读正文', () => {
  const { mapping, human, agent, create } = fixture();
  create('b');
  create('a');
  const page = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 8192 }, human);
  expect(page).toMatchObject({
    revision: 3,
    project: { id: 'p', name: '地图' },
    budgetUnit: 'utf8_bytes',
    totalItems: 2,
    coverage: { start: 0, end: 2, complete: true },
    fidelity: 'index',
    summary: null,
    nextCursor: null,
    items: [
      { id: 'a', type: 'thought', body: { availability: 'not_fetched' } },
      { id: 'b', type: 'thought' },
    ],
  });
  expect(JSON.stringify(page)).not.toContain('未展开的秘密正文');
  const state = mapping.read({ type: 'project', projectId: 'p' }, human);
  expect(page.items[0]).toMatchObject({
    id: state.cards[1]!.id,
    versionId: state.cards[1]!.versionId,
    body: { id: state.cards[1]!.body.id, versionId: state.cards[1]!.body.versionId },
    item: state.cards[1]!.item,
    order: 1,
  });
  expect(
    mapping.read(
      { type: 'map', view: 'index', projectId: 'p', snapshot: page.snapshot, budget: 8192 },
      agent,
    ),
  ).toEqual(page);
});

it('完整末页能容纳时不因中间游标元数据更大而错误拒绝', () => {
  const { mapping, human, create } = fixture();
  create('c', '');
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  const query = {
    type: 'map' as const,
    view: 'detail' as const,
    projectId: 'p',
    cardId: 'c',
    snapshot: index.snapshot,
  };
  const full = mapping.read(query, human);
  expect(full.items).toHaveLength(2);
  expect(mapping.read({ ...query, budget: full.bytes }, human)).toEqual(full);
});

it('投影明确只覆盖当前卡片类型，不把未实施对象或空间邻近当作完整拓扑', () => {
  const { mapping, human, create } = fixture();
  create('a');
  create('b');
  const page = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  expect(page.scope).toEqual({
    types: ['thought'],
    relations: 'not_implemented',
    order: 'creation_ordinal',
  });
  expect(page.totalItems).toBe(2);
  expect(page.items.every((i) => i.type === 'thought')).toBe(true);
  expect(JSON.stringify(page)).not.toContain('adjacent');
});

it('游标不可伪造或改换目标，返回值修改不能变成第二份可写权威', () => {
  const { mapping, human, create } = fixture();
  create('a', '长文'.repeat(500));
  create('b');
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  const query = {
    type: 'map' as const,
    view: 'detail' as const,
    projectId: 'p',
    cardId: 'a',
    snapshot: index.snapshot,
    budget: 1800,
  };
  const detail = mapping.read(query, human);
  expect(detail.nextCursor).toEqual(expect.any(String));
  expect(() => mapping.read({ ...query, cursor: 'forged' }, human)).toThrow(
    expect.objectContaining({ code: 'INVALID_CURSOR' }),
  );
  expect(() => mapping.read({ ...query, cardId: 'b', cursor: detail.nextCursor! }, human)).toThrow(
    expect.objectContaining({ code: 'INVALID_CURSOR' }),
  );
  expect(() => mapping.read({ ...query, view: 'body', cursor: detail.nextCursor! }, human)).toThrow(
    expect.objectContaining({ code: 'INVALID_CURSOR' }),
  );
  index.items[0]!.title = '客户端改写';
  index.items[0]!.item.pose.x = 999;
  expect(
    mapping.read({ type: 'map', view: 'index', projectId: 'p', snapshot: index.snapshot }, human)
      .items[0],
  ).toMatchObject({ title: '标题 a', item: { pose: { x: 10 } } });
  expect(mapping.read({ type: 'project', projectId: 'p' }, human).cards[0]!.title).toBe('标题 a');
});

it('100 张持久卡片以小预算完整遍历，空间重叠不产生连线，新增卡不进入旧快照', () => {
  const { mapping, human, create } = fixture();
  for (let i = 99; i >= 0; i--) create('c' + String(i).padStart(3, '0'));
  const first = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 4096 }, human);
  create('new');
  const pages = [first];
  while (pages.at(-1)!.nextCursor)
    pages.push(
      mapping.read(
        {
          type: 'map',
          view: 'index',
          projectId: 'p',
          snapshot: first.snapshot,
          cursor: pages.at(-1)!.nextCursor!,
          budget: 4096,
        },
        human,
      ),
    );
  const items = pages.flatMap((p) => p.items);
  expect(items).toHaveLength(100);
  expect(items[0]!.id).toBe('c000');
  expect(items[99]!.id).toBe('c099');
  expect(new Set(items.map((i) => i.id)).size).toBe(100);
  expect(
    pages.every(
      (p) => p.revision === 101 && p.bytes <= 4096 && p.summary === null && p.totalItems === 100,
    ),
  ).toBe(true);
  expect(mapping.read({ type: 'project', projectId: 'p' }, human).cards).toHaveLength(101);
});

it('Unicode 签名和额外游标片段明确拒绝，不泄露底层密码错误', () => {
  const { mapping, human, create } = fixture();
  create('a', '正文'.repeat(500));
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  const query = {
    type: 'map' as const,
    view: 'detail' as const,
    projectId: 'p',
    cardId: 'a',
    snapshot: index.snapshot,
    budget: 1800,
  };
  const cursor = mapping.read(query, human).nextCursor!;
  for (const invalid of [cursor.split('.')[0] + '.' + '中'.repeat(43), cursor + '.'])
    expect(() => mapping.read({ ...query, cursor: invalid }, human)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
});
