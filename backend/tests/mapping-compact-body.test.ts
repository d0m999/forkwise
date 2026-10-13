import { openMapping } from '../src/mapping/storage.js';
import { afterEach, expect, it } from 'vitest';
import { compactFixture as fixture, closeCompactFixtures } from './compact-fixture.js';
afterEach(closeCompactFixtures);

it('局部正文明确裁剪，Unicode JSON detail 按原快照无损展开且保留 Block 身份', () => {
  const { mapping, human, agent, create } = fixture();
  const text = '中文🧠e\u0301\n"\\'.repeat(1800) + '\ud800末尾';
  create('c', text);
  const state = mapping.read({ type: 'project', projectId: 'p' }, human);
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, agent);
  const body = mapping.read(
    {
      type: 'map',
      view: 'body',
      projectId: 'p',
      cardId: 'c',
      snapshot: index.snapshot,
      budget: 4096,
    },
    agent,
  );
  expect(body.fidelity).toBe('partial_body');
  expect(body.items[0]).toMatchObject({
    id: state.cards[0]!.body.blocks[0]!.id,
    type: 'text',
    coverage: { returnedCodePoints: 128, totalCodePoints: 14403, complete: false },
  });
  expect(body.summary).toBeNull();
  mapping.execute(
    {
      commandId: 'edit',
      projectId: 'p',
      type: 'body.edit',
      expected: state.cards[0]!.body.versionId,
      payload: { id: 'c', text: '后来的正文' },
    },
    human,
  );
  const chunks = [];
  let cursor: string | undefined;
  do {
    const page = mapping.read(
      {
        type: 'map',
        view: 'detail',
        projectId: 'p',
        cardId: 'c',
        snapshot: index.snapshot,
        budget: 1800,
        ...(cursor ? { cursor } : {}),
      },
      agent,
    );
    expect(page).toMatchObject({ fidelity: 'lossless_json_chunks', revision: 2, summary: null });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1800);
    chunks.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  expect(JSON.parse(chunks.map((c) => c.jsonText).join(''))).toEqual(state.cards[0]!.body);
});

it('固定快照只保留读取索引，长正文按已固定不可变版本展开且不耗尽索引缓存', () => {
  const { mapping, directory, human, create } = fixture({ compact: { maxSnapshotBytes: 4096 } });
  create('c', '长文🧠'.repeat(40000));
  const original = mapping.read({ type: 'project', projectId: 'p' }, human).cards[0]!;
  const index = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 4096 }, human);
  const other = openMapping(directory);
  try {
    const writer = other.access.authenticate(other.access.issue('human', ['p']));
    other.execute(
      {
        commandId: 'edit-long',
        projectId: 'p',
        type: 'body.edit',
        expected: original.body.versionId,
        payload: { id: 'c', text: '另一 SQLite 连接的新正文' },
      },
      writer,
    );
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = mapping.read(
        {
          type: 'map',
          view: 'detail',
          projectId: 'p',
          cardId: 'c',
          snapshot: index.snapshot,
          budget: 131072,
          ...(cursor ? { cursor } : {}),
        },
        human,
      );
      pages.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(JSON.parse(pages.map((c) => c.jsonText).join(''))).toEqual(original.body);
    expect(
      other.read({ type: 'project', projectId: 'p' }, writer).cards[0]!.body.blocks[0]!.text,
    ).toBe('另一 SQLite 连接的新正文');
  } finally {
    other.close();
  }
});
