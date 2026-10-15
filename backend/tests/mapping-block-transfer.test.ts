import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';

it('同项目未知块和媒体副本保留完整原文及资源引用，经统一历史、同版本read/observe和SQLite重开恢复', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-block-transfer-'));
  let host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '复制' } });
    for (const id of ['a', 'b'])
      run({
        type: 'thought.create',
        expected: null,
        payload: { id, title: id, text: '原段', x: 0, y: 0 },
      });
    const original = read().cards.find((c) => c.id === 'a')!;
    const raw = {
      id: 'raw',
      type: 'vendor',
      parentId: 'vendor-parent',
      original: { text: '未知原文🚀', nested: [1, null, { keep: true }] },
    };
    const image = {
      id: 'image',
      type: 'image',
      assetId: 'saved-asset',
      caption: '图注',
      metadata: { width: 640 },
    };
    original.body = {
      ...original.body,
      versionId: randomUUID(),
      blocks: [...original.body.blocks, raw, image],
    };
    host.close();
    const fixture = new Database(join(directory, 'workspace.sqlite'));
    try {
      fixture
        .prepare('UPDATE mapping_cards SET value=? WHERE id=?')
        .run(JSON.stringify(original), 'a');
      fixture
        .prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)')
        .run(
          'p',
          'body',
          original.body.id,
          original.body.versionId,
          JSON.stringify(original.body),
        );
    } finally {
      fixture.close();
    }
    host = openMapping(directory);
    const before = read(),
      target = before.cards.find((c) => c.id === 'b')!;
    const copies = [
      { ...raw, id: 'raw-copy' },
      { ...image, id: 'image-copy' },
    ];
    const receipt = run({
      type: 'body.edit',
      expected: target.body.versionId,
      payload: { id: 'b', blocks: [...target.body.blocks, ...copies], copyOriginals: true },
    });
    expect(read().cards.find((c) => c.id === 'b')!.body.blocks).toEqual([
      ...target.body.blocks,
      ...copies,
    ]);
    expect(read().cards.find((c) => c.id === 'a')).toEqual(original);
    expect(
      host
        .observe({ projectId: 'p', afterRevision: before.project.revision }, human)
        .changes.map((c) => c.revision),
    ).toEqual([receipt.revision]);
    const index = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    const detail = host.read(
      { type: 'map', projectId: 'p', view: 'detail', cardId: 'b', snapshot: index.snapshot },
      human,
    );
    expect(JSON.parse(detail.items.map((i) => i.jsonText).join('')).blocks).toEqual([
      ...target.body.blocks,
      ...copies,
    ]);
    expect(() =>
      run({
        type: 'body.edit',
        expected: read().cards.find((c) => c.id === 'b')!.body.versionId,
        payload: {
          id: 'b',
          blocks: [
            ...target.body.blocks,
            { ...copies[0], original: { changed: true } },
            copies[1],
          ],
          copyOriginals: true,
        },
      }),
    ).toThrow();
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards.find((c) => c.id === 'b')!.body.blocks).toEqual(target.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    const saved = read();
    host.close();
    host = openMapping(directory);
    expect(read()).toEqual(saved);
    run({
      projectId: 'other',
      type: 'project.create',
      expected: null,
      payload: { name: '隔离项目' },
    });
    run({
      projectId: 'other',
      type: 'thought.create',
      expected: null,
      payload: { id: 'other-card', title: '隔离', text: '', x: 0, y: 0 },
    });
    const other = host.read({ type: 'project', projectId: 'other' }, human);
    expect(() =>
      run({
        projectId: 'other',
        type: 'body.edit',
        expected: other.cards[0]!.body.versionId,
        payload: {
          id: 'other-card',
          blocks: [{ ...raw, id: 'foreign-copy' }],
          copyOriginals: true,
        },
      }),
    ).toThrow();
    expect(host.read({ type: 'project', projectId: 'other' }, human)).toEqual(other);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
