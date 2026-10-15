import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { Block } from '../src/mapping/contracts.js';

it('已有未知块、媒体及额外文字元数据在真实SQLite重开、完整快照、保存和历史旅行中原样保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-original-body-'));
  let host: ReturnType<typeof openMapping> | undefined;
  let fixture: Database.Database | undefined;
  try {
    host = openMapping(directory);
    const token = host.access.issue('human', ['*']);
    let human = host.access.authenticate(token);
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '原件' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '原卡', text: '原文字段', x: 10, y: 20 } });
    const legacy = read().cards[0]!;
    const originals: Block[] = [
      { id: 'old-unknown', type: 'opaque', original: { vendor: 'legacy', bytes: '完整未知内容\u0000中文🚀', nested: [null, { keep: true }] } },
      { id: 'old-media', type: 'image', assetId: 'existing-media', originalWidth: 123, caption: '原图引用原文' },
      { id: 'old-marked', type: 'text', text: '带未知行内格式的完整文字', marks: [{ legacyStyle: 'keep' }] },
      { id: 'old-table', type: 'table', header: false, columnWidths: [144], rows: [[{ text: '旧表格原件' }]], vendor: { formula: '=keep-original' } },
    ];
    legacy.body.blocks.push(...originals);
    legacy.body.versionId = randomUUID();
    host.close(); host = undefined;
    // Fixture input only: represent an existing on-disk document. Assertions
    // below use Mapping, never internal tables as an alternate test seam.
    fixture = new Database(join(directory, 'workspace.sqlite'));
    fixture.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(legacy), 'a');
    fixture.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run('p', 'body', legacy.body.id, legacy.body.versionId, JSON.stringify(legacy.body));
    fixture.close(); fixture = undefined;
    host = openMapping(directory); human = host.access.authenticate(token);
    expect(read().cards[0]!.body).toEqual(legacy.body);
    const snapshot = host.read({ type: 'map', view: 'index', projectId: 'p' }, human);
    const detail = host.read({ type: 'map', view: 'detail', projectId: 'p', cardId: 'a', snapshot: snapshot.snapshot }, human);
    expect(JSON.parse(detail.items.map(c => c.jsonText).join(''))).toEqual(legacy.body);
    expect(host.read({ type: 'map', view: 'body', projectId: 'p', cardId: 'a', snapshot: snapshot.snapshot }, human).items.map(b => b.type)).toEqual(['text', 'opaque', 'image', 'text', 'table']);
    expect(() => run({ type: 'body.edit', expected: legacy.body.versionId, payload: { id: 'a', text: '只写首块会丢原件' } })).toThrow('完整块');
    expect(() => run({ type: 'body.edit', expected: legacy.body.versionId, payload: { id: 'a', blocks: [legacy.body.blocks[0]] } })).toThrow('原件');
    expect(read().cards[0]!.body).toEqual(legacy.body);
    run({ type: 'body.edit', expected: legacy.body.versionId, payload: { id: 'a', blocks: [{ ...legacy.body.blocks[0]!, text: '明确修改的普通段落' }, ...originals] } });
    expect(read().cards[0]!.body.blocks.slice(1)).toEqual(originals);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(legacy.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    host.close(); host = openMapping(directory); human = host.access.authenticate(token);
    expect(read().cards[0]!.body.blocks.slice(1)).toEqual(originals);
  } finally { fixture?.close(); host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
