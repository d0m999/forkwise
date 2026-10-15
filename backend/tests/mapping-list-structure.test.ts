import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import Database from 'better-sqlite3';

it('多层列表整组重排删除后一次撤销恢复稳定身份、层级和完整SQLite正文', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-list-structure-'));
  let host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    const edit = (blocks: unknown[]) =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks },
      });
    run({ type: 'project.create', expected: null, payload: { name: '层级正文' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '列表', text: '', x: 0, y: 0 },
    });
    const blocks = [
      { id: 'parent', inlineId: 'ip', type: 'listItem', listType: 'bullet', text: '父' },
      {
        id: 'child',
        inlineId: 'ic',
        type: 'listItem',
        listType: 'ordered',
        text: '子',
        parentId: 'parent',
      },
      {
        id: 'grandchild',
        inlineId: 'ig',
        type: 'listItem',
        listType: 'todo',
        checked: false,
        text: '孙',
        parentId: 'child',
      },
      { id: 'sibling', type: 'listItem', listType: 'bullet', text: '同级' },
      { id: 'tail', type: 'text', text: '尾部' },
    ];
    edit(blocks);
    const moved = [blocks[3]!, ...blocks.slice(0, 3), blocks[4]!];
    edit(moved);
    expect(read().cards[0]!.body.blocks).toEqual(moved);
    edit([blocks[3]!, blocks[4]!]);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(moved);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([blocks[3]!, blocks[4]!]);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    const saved = read();
    const change = host.observe(
      { projectId: 'p', afterRevision: saved.project.revision - 1 },
      human,
    );
    expect(change.changes[0]!.revision).toBe(saved.project.revision);
    const snapshot = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    const detail = host.read(
      { type: 'map', projectId: 'p', view: 'detail', cardId: 'a', snapshot: snapshot.snapshot },
      human,
    );
    expect(JSON.parse(detail.items.map((x) => x.jsonText).join('')).blocks).toEqual(moved);
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body).toEqual(saved.cards[0]!.body);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('旧未知块的parentId扩展原样保全，不把旧JSON当新列表结构重新解释', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-list-legacy-'));
  let host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '旧原件' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '正文', text: '可改文字', x: 0, y: 0 },
    });
    const card = read().cards[0]!,
      original = {
        id: 'legacy',
        type: 'vendor-block',
        parentId: 'vendor-owner',
        data: { nested: ['旧数据'] },
      };
    card.body = { ...card.body, versionId: randomUUID(), blocks: [...card.body.blocks, original] };
    host.close();
    const fixture = new Database(join(directory, 'workspace.sqlite'));
    try {
      fixture
        .prepare('UPDATE mapping_cards SET value=? WHERE id=?')
        .run(JSON.stringify(card), card.id);
      fixture
        .prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)')
        .run('p', 'body', card.body.id, card.body.versionId, JSON.stringify(card.body));
    } finally {
      fixture.close();
    }
    host = openMapping(directory);
    const next = [{ ...card.body.blocks[0]!, text: '已改文字' }, original];
    run({ type: 'body.edit', expected: card.body.versionId, payload: { id: 'a', blocks: next } });
    expect(read().cards[0]!.body.blocks).toEqual(next);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(card.body.blocks);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('拒绝自身后代、缺失父项和跨组层级且不产生版本或历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-list-invalid-'));
  const host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '列表边界' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '列表', text: '', x: 0, y: 0 },
    });
    const a = { id: 'a1', type: 'listItem', listType: 'bullet', text: '父' };
    const b = { id: 'b1', type: 'listItem', listType: 'bullet', text: '子', parentId: 'a1' };
    const c = { id: 'c1', type: 'listItem', listType: 'bullet', text: '另组' };
    const before = read();
    for (const blocks of [
      [{ ...a, parentId: 'b1' }, b],
      [{ ...a, parentId: 'missing' }],
      [a, c, b],
      [{ ...a, type: 'text', listType: undefined }, b],
      [a, { ...b, type: 'quote' }],
    ]) {
      expect(() =>
        run({
          type: 'body.edit',
          expected: before.cards[0]!.body.versionId,
          payload: { id: 'a', blocks },
        }),
      ).toThrow();
      expect(read()).toEqual(before);
    }
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('旧列表parent扩展及vendor控制保全完整JSON，旁段保存经同版本读取、observe、历史和重开恢复', () => {
  const originals = [
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'bullet',
      text: '旧列表原文',
      parentId: 'vendor-owner',
    },
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'vendor',
      text: '旧列表原文',
      parentId: 'vendor-owner',
    },
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'bullet',
      text: '旧列表原文',
      parentId: 'vendor-owner',
      vendorJSON: { all: [null, '保留中文🚀', { keep: true }] },
    },
  ];
  for (const original of originals) {
    const directory = mkdtempSync(join(tmpdir(), 'forkwise-legacy-list-roundtrip-'));
    let host = openMapping(directory);
    try {
      const token = host.access.issue('human', ['*']);
      const human = host.access.authenticate(token);
      const run = (command: Record<string, unknown>) =>
        host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
      const read = () => host.read({ type: 'project', projectId: 'p' }, human);
      run({ type: 'project.create', expected: null, payload: { name: '旧原件兼容' } });
      run({
        type: 'thought.create',
        expected: null,
        payload: { id: 'a', title: '原卡', text: '旁段原文', x: 0, y: 0 },
      });
      const card = read().cards[0]!;
      card.body = {
        ...card.body,
        versionId: randomUUID(),
        blocks: [{ id: 'editable', type: 'text', text: '旁段原文', inlineId: 'inline' }, original],
      };
      host.close();
      const fixture = new Database(join(directory, 'workspace.sqlite'));
      try {
        fixture
          .prepare('UPDATE mapping_cards SET value=? WHERE id=?')
          .run(JSON.stringify(card), card.id);
        fixture
          .prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)')
          .run('p', 'body', card.body.id, card.body.versionId, JSON.stringify(card.body));
      } finally {
        fixture.close();
      }
      host = openMapping(directory);
      const agent = host.access.authenticate(host.access.issue('agent', ['p']));
      const full = () => {
        const state = read();
        const snapshot = host.read({ type: 'map', view: 'index', projectId: 'p' }, agent);
        let cursor: string | undefined,
          json = '';
        do {
          const page = host.read(
            {
              type: 'map',
              view: 'detail',
              projectId: 'p',
              cardId: 'a',
              snapshot: snapshot.snapshot,
              ...(cursor ? { cursor } : {}),
            },
            agent,
          );
          expect(page.revision).toBe(state.project.revision);
          json += page.items.map((chunk) => chunk.jsonText).join('');
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(JSON.parse(json)).toEqual(state.cards[0]!.body);
        return state;
      };
      expect(full().cards[0]!.body).toEqual(card.body);
      const before = read();
      const next = [{ ...card.body.blocks[0]!, text: '旁段明确修改' }, original];
      run({ type: 'body.edit', expected: card.body.versionId, payload: { id: 'a', blocks: next } });
      const saved = full();
      expect(saved.cards[0]!.body.blocks).toEqual(next);
      expect(
        host
          .observe({ projectId: 'p', afterRevision: before.project.revision }, agent)
          .changes.at(-1)!.revision,
      ).toBe(saved.project.revision);
      for (const invalid of [
        [next[0]!],
        [next[0]!, { ...original, text: '不许改写原件' }],
        [next[0]!, { ...original, id: 'new-invalid' }, original],
        ...(original === originals[0]
          ? [
              [
                next[0]!,
                {
                  id: 'vendor-owner',
                  type: 'listItem',
                  listType: 'bullet',
                  text: '不能自动解释旧parent',
                },
                original,
              ],
            ]
          : []),
      ]) {
        expect(() =>
          run({
            type: 'body.edit',
            expected: saved.cards[0]!.body.versionId,
            payload: { id: 'a', blocks: invalid },
          }),
        ).toThrow();
        expect(read()).toEqual(saved);
      }
      run({ type: 'history.undo', expected: read().project.revision, payload: {} });
      expect(full().cards[0]!.body.blocks).toEqual(card.body.blocks);
      run({ type: 'history.redo', expected: read().project.revision, payload: {} });
      expect(full().cards[0]!.body.blocks).toEqual(next);
      const withLists = [
        ...next,
        { id: 'new-parent', type: 'listItem', listType: 'bullet', text: '新父项' },
        {
          id: 'new-child',
          type: 'listItem',
          listType: 'ordered',
          text: '新子项',
          parentId: 'new-parent',
        },
      ];
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks: withLists },
      });
      const persisted = full();
      expect(persisted.cards[0]!.body.blocks).toEqual(withLists);
      host.close();
      host = openMapping(directory);
      expect(full().cards[0]!.body).toEqual(persisted.cards[0]!.body);
    } finally {
      host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
