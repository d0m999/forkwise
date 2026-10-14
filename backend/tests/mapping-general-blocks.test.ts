import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import Database from 'better-sqlite3';

it('文字块转为标题保留原块与行内身份，真实SQLite撤销和重启仍可读回', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-general-blocks-'));
  let host = openMapping(directory);
  try {
    const token = host.access.issue('human', ['*']);
    const human = host.access.authenticate(token);
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '通用块' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '原卡', text: '中文标题', x: 10, y: 20 },
    });
    const original = read().cards[0]!;
    const blocks = [
      { ...original.body.blocks[0]!, type: 'heading', level: 2, inlineId: 'original-inline' },
    ];
    run({ type: 'body.edit', expected: original.body.versionId, payload: { id: 'a', blocks } });
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(original.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('有限文字类型转换保留八类行内格式并通过同快照完整JSON与observe读回', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-general-formats-'));
  const host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '格式' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '原卡', text: '格式保留', x: 10, y: 20 },
    });
    const original = read().cards[0]!.body.blocks[0]!;
    const marks = [
      ...['bold', 'italic', 'underline', 'strikethrough', 'code'].map((type) => ({
        type,
        start: 0,
        end: 2,
      })),
      { type: 'link', start: 0, end: 2, value: 'https://example.com/path' },
      { type: 'textColor', start: 0, end: 2, value: 'red' },
      { type: 'highlight', start: 0, end: 2, value: 'yellow' },
    ];
    for (const shape of [
      { type: 'text' },
      { type: 'heading', level: 1 },
      { type: 'heading', level: 3 },
      { type: 'listItem', listType: 'bullet' },
      { type: 'listItem', listType: 'ordered' },
      { type: 'listItem', listType: 'todo', checked: false },
      { type: 'quote' },
    ]) {
      const before = read();
      const blocks = [{ ...original, ...shape, inlineId: 'stable-inline', marks }];
      const receipt = run({
        type: 'body.edit',
        expected: before.cards[0]!.body.versionId,
        payload: { id: 'a', blocks },
      });
      expect(read().cards[0]!.body.blocks).toEqual(blocks);
      const delta = host.observe({ projectId: 'p', afterRevision: before.project.revision }, human);
      expect(delta.changes[0]!.revision).toBe(receipt.revision);
      const snapshot = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
      const detail = host.read(
        { type: 'map', projectId: 'p', view: 'detail', cardId: 'a', snapshot: snapshot.snapshot },
        human,
      );
      expect(JSON.parse(detail.items.map((item) => item.jsonText).join('')).blocks).toEqual(blocks);
      run({ type: 'history.undo', expected: read().project.revision, payload: {} });
      expect(read().cards[0]!.body.blocks).toEqual(before.cards[0]!.body.blocks);
      run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    }
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('空段插入分隔线保留身份并可一次撤销，分隔线不接受伪文字转换', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-divider-'));
  const host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '分隔线' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '原卡', text: '', x: 10, y: 20 },
    });
    let body = read().cards[0]!.body;
    const original = { ...body.blocks[0]!, inlineId: 'stable-empty-inline' };
    run({ type: 'body.edit', expected: body.versionId, payload: { id: 'a', blocks: [original] } });
    body = read().cards[0]!.body;
    const blocks = [
      { id: original.id, type: 'divider', inlineId: original.inlineId },
      { id: 'after-divider', type: 'text', text: '' },
    ];
    run({ type: 'body.edit', expected: body.versionId, payload: { id: 'a', blocks } });
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
    expect(() =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks: [original, blocks[1]] },
      }),
    ).toThrow();
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(body.blocks);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('编辑已知格式时保全旧扩展JSON及未知块相对顺序，拒绝伪支持与静默重排', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-opaque-formats-'));
  let host = openMapping(directory);
  try {
    const token = host.access.issue('human', ['*']);
    const human = host.access.authenticate(token);
    const run = (c: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '格式与旧原件' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '原卡', text: '已知文字', x: 10, y: 20 },
    });
    const legacy = read().cards[0]!;
    const originals = [
      {
        id: 'old-inline',
        type: 'text',
        text: '旧文字',
        marks: [{ vendor: 'unchanged', payload: [null, '🚀'] }],
      },
      { id: 'old-block', type: 'container', data: { nested: ['原始JSON'] } },
    ];
    legacy.body = {
      ...legacy.body,
      versionId: randomUUID(),
      blocks: [...legacy.body.blocks, ...originals],
    };
    host.close();
    const fixture = new Database(join(directory, 'workspace.sqlite'));
    try {
      fixture
        .prepare('UPDATE mapping_cards SET value=? WHERE id=?')
        .run(JSON.stringify(legacy), 'a');
      fixture
        .prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)')
        .run('p', 'body', legacy.body.id, legacy.body.versionId, JSON.stringify(legacy.body));
    } finally {
      fixture.close();
    }
    host = openMapping(directory);
    const edit = (blocks: unknown[]) =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks },
      });
    expect(() => edit([legacy.body.blocks[0], ...originals.toReversed()])).toThrow();
    expect(read().cards[0]!.body).toEqual(legacy.body);
    for (const marks of [
      [{ type: 'bold', start: 0, end: 200 }],
      [{ type: 'link', start: 0, end: 1, value: 'javascript:alert(1)' }],
      [{ type: 'highlight', start: 0, end: 1, value: '#ffffff' }],
      [{ type: 'bold', start: 0, end: 1, extra: 'unknown' }],
    ]) {
      expect(() => edit([{ ...legacy.body.blocks[0]!, marks }, ...originals])).toThrow();
      expect(read().cards[0]!.body).toEqual(legacy.body);
    }
    const next = [
      {
        ...legacy.body.blocks[0]!,
        type: 'heading',
        level: 1,
        marks: [{ type: 'bold', start: 0, end: 2 }],
      },
      ...originals,
    ];
    edit(next);
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual(next);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(legacy.body.blocks);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
