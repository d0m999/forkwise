import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('导入的代码与简单表格经同一正文事务完整保存、observe、同revision投影、撤销和SQLite重开', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-rich-import-'));
  let host = openMapping(directory);
  try {
    const token = host.access.issue('human', ['*']);
    const human = host.access.authenticate(token);
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '富文导入' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '原卡', text: 'before', x: 10, y: 20 },
    });
    const before = read();
    const blocks = [
      {
        ...before.cards[0]!.body.blocks[0]!,
        type: 'code',
        text: '<script>literal</script>\n  中文',
        language: 'html',
        wrap: false,
      },
      {
        id: 'table',
        type: 'table',
        header: true,
        rows: [
          [{ text: '名称' }, { text: '网址' }],
          [
            { text: '甲', marks: [{ type: 'bold', start: 0, end: 1 }] },
            {
              text: '地址',
              marks: [{ type: 'link', start: 0, end: 2, value: 'https://example.com/' }],
            },
          ],
        ],
      },
    ];
    const receipt = run({
      type: 'body.edit',
      expected: before.cards[0]!.body.versionId,
      payload: { id: 'a', blocks },
    });
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
    const changes = host.observe({ projectId: 'p', afterRevision: before.project.revision }, human);
    expect(changes.changes[0]!.revision).toBe(receipt.revision);
    const index = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    const preview = host.read(
      { type: 'map', projectId: 'p', view: 'body', cardId: 'a', snapshot: index.snapshot },
      human,
    );
    expect(preview.revision).toBe(receipt.revision);
    expect(preview.items[1]).toMatchObject({
      type: 'table',
      text: '名称\t网址\n甲\t地址',
      coverage: { complete: true },
    });
    const detail = host.read(
      { type: 'map', projectId: 'p', view: 'detail', cardId: 'a', snapshot: index.snapshot },
      human,
    );
    expect(detail.revision).toBe(receipt.revision);
    expect(JSON.parse(detail.items.map((i) => i.jsonText).join('')).blocks).toEqual(blocks);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(before.cards[0]!.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
    for (const malformed of [
      { ...blocks[0], marks: [{ type: 'bold', start: 0, end: 1 }] },
      { ...blocks[1], rows: [[{ text: 'a' }], [{ text: 'b' }, { text: 'c' }]] },
      {
        ...blocks[1],
        rows: [
          [
            {
              text: 'a',
              marks: [{ type: 'link', start: 0, end: 1, value: 'javascript:alert(1)' }],
            },
          ],
        ],
      },
    ]) {
      const stable = read();
      expect(() =>
        run({
          type: 'body.edit',
          expected: stable.cards[0]!.body.versionId,
          payload: { id: 'a', blocks: [malformed] },
        }),
      ).toThrow();
      expect(read()).toEqual(stable);
    }
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
