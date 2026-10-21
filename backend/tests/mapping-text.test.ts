import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue22-'));
  let mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) =>
    mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '文字研究' } });
  return {
    get mapping() {
      return mapping;
    },
    human,
    run,
    state,
    history,
    restart() {
      mapping.close();
      mapping = openMapping(directory);
    },
  };
}
const content = {
  runs: [{ text: '' }],
  fontSize: 18,
  lineHeight: 1.5,
  align: 'left',
  widthMode: 'auto',
  width: 320,
};
const pose = { x: 10, y: 20, width: 20, height: 27 };
it('同组非空编辑后删除跨重开仍一步恢复原身份，重做receipt和delta完整报告删除两域', () => {
  const f = fixture();
  const originalContent = { ...content, runs: [{ text: '编辑前完整文字', bold: true, color: '#ad343e' }] };
  f.run({ type: 'text.create', expected: null, payload: { id: 'history-text', content: originalContent, pose } });
  const original = f.state().texts![0]!;
  f.run({ type: 'text.edit', expected: original.versionId, editGroup: 'edit-delete', payload: { id: original.id, content: { ...originalContent, runs: [{ text: '非空编辑后的文字' }] } } });
  const edited = f.state().texts![0]!;
  const removed = f.run({ type: 'text.delete', expected: { text: edited.versionId, pose: edited.item.versionId }, editGroup: 'edit-delete', payload: { id: original.id } });
  expect(f.state().texts).toEqual([]);
  expect(f.history().undo.map(action => action.label)).toEqual(['text.create', 'text.edit']);
  f.restart();
  const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  const restored = f.state().texts![0]!;
  const undoDelta = f.mapping.observe({ projectId: 'p', afterRevision: removed.revision }, f.human).changes;
  f.restart();
  const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  const redoDelta = f.mapping.observe({ projectId: 'p', afterRevision: undo.revision }, f.human).changes;
  console.log('merged-text-delete-history', JSON.stringify({ original, edited, removed, undo, restored, undoDelta, redo, redoDelta, final: f.state() }));
  const identities = [original.id, original.item.id];
  expect(f.state().texts).toEqual([]);
  expect(redo.changedIds).toEqual(identities);
  expect(redo.deletedIds).toEqual(identities);
  expect(redoDelta).toHaveLength(1);
  expect(redoDelta[0]).toMatchObject({ commandId: redo.commandId, changedIds: identities, deletedIds: identities, domains: [{ domain: 'text', id: original.id }, { domain: 'pose', id: original.item.id }] });
  expect(undo.changedIds).toEqual(identities);
  expect(undo.deletedIds).toEqual([]);
  expect(undoDelta).toHaveLength(1);
  expect(undoDelta[0]).toMatchObject({ commandId: undo.commandId, changedIds: identities, deletedIds: [], domains: [{ domain: 'text', id: original.id }, { domain: 'pose', id: original.item.id }] });
  expect(restored).toMatchObject({ id: original.id, content: originalContent, item: { id: original.item.id, pose: original.item.pose, createdOrder: original.item.createdOrder } });
  expect(restored.versionId).not.toBe(original.versionId);
  expect(restored.item.versionId).not.toBe(original.item.versionId);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  const beforeEdit = f.state().texts![0]!;
  f.run({ type: 'text.edit', expected: beforeEdit.versionId, payload: { id: original.id, content: { ...originalContent, fontSize: 24 } } });
  const plainEdited = f.state().texts![0]!;
  const plainUndo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  const plainRestored = f.state().texts![0]!;
  expect(plainRestored.content).toEqual(originalContent);
  expect(plainRestored.item).toEqual(beforeEdit.item);
  expect(plainRestored.versionId).not.toBe(plainEdited.versionId);
  expect(plainUndo.changedIds).toEqual([original.id]);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: plainUndo.revision - 1 }, f.human).changes[0]).toMatchObject({ changedIds: [original.id], deletedIds: [], domains: [{ domain: 'text', id: original.id }] });
  const plainRedo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  const plainRedone = f.state().texts![0]!;
  expect(plainRedone.content).toEqual(plainEdited.content);
  expect(plainRedone.item).toEqual(beforeEdit.item);
  expect(plainRedone.versionId).not.toBe(plainRestored.versionId);
  expect(plainRedo.changedIds).toEqual([original.id]);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: plainRedo.revision - 1 }, f.human).changes[0]).toMatchObject({ changedIds: [original.id], deletedIds: [], domains: [{ domain: 'text', id: original.id }] });
});
it('混合卡片与多个文字同一次移动原子提交、一步历史且保留独立内容，任一布局冲突整批不写', () => {
  const f = fixture();
  f.run({
    type: 'thought.create',
    expected: null,
    payload: { id: 'c', title: '卡片', text: '正文', x: 100, y: 200 },
  });
  for (const id of ['t', 'u'])
    f.run({
      type: 'text.create',
      expected: null,
      payload: {
        id,
        content: { ...content, runs: [{ text: id, bold: true, color: '#ad343e' }] },
        pose,
      },
    });
  const before = f.state(),
    card = before.cards[0]!,
    texts = before.texts!;
  const targets = [
    { kind: 'card', id: card.id, itemId: card.item.id, x: 160, y: 250 },
    ...texts.map((t) => ({ kind: 'text', id: t.id, itemId: t.item.id, x: 70, y: 70 })),
  ];
  const expected = Object.fromEntries(
    [card, ...texts].map((value) => [value.item.id, value.item.versionId]),
  );
  const command = { type: 'canvas.move', expected, payload: { targets } };
  const receipt = f.run(command);
  expect(f.state().cards[0]).toMatchObject({
    title: '卡片',
    body: card.body,
    item: { pose: { x: 160, y: 250 } },
  });
  for (const text of f.state().texts!)
    expect(text).toMatchObject({
      content: texts.find((t) => t.id === text.id)!.content,
      item: { pose: { x: 70, y: 70 } },
    });
  expect(f.history().undo.at(-1)?.label).toBe('canvas.move');
  const delta = f.mapping.observe(
    { projectId: 'p', afterRevision: before.project.revision },
    f.human,
  ).changes[0]!;
  expect(delta.domains).toEqual(
    [card, ...texts].map((value) => ({ domain: 'pose', id: value.item.id })),
  );
  expect(receipt.changedIds).toEqual([card, ...texts].map((value) => value.item.id));
  const moved = f.state();
  const oneStale = Object.fromEntries(
    [moved.cards[0]!, ...moved.texts!].map((value) => [value.item.id, value.item.versionId]),
  );
  oneStale[texts[1]!.item.id] = texts[1]!.item.versionId;
  expect(() =>
    f.run({
      ...command,
      expected: oneStale,
      payload: { targets: targets.map((target) => ({ ...target, x: target.x + 10 })) },
    }),
  ).toThrow('布局已更新');
  expect(f.state()).toEqual(moved);
  expect(() => f.run(command)).toThrow('布局已更新');
  expect(f.state()).toEqual(moved);
  f.run({ type: 'history.undo', expected: moved.project.revision, payload: {} });
  expect(f.state().cards[0]!.item.pose).toEqual(card.item.pose);
  for (const text of f.state().texts!) expect(text.item.pose).toEqual(pose);
  f.restart();
  f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  expect(f.state().texts!.map((t) => t.item.pose.x)).toEqual([70, 70]);
});
it('独立文字放置和连续首次输入只撤销一步，重做及服务重开恢复原身份和完整样式', () => {
  const f = fixture();
  f.run({
    type: 'text.create',
    expected: null,
    editGroup: 'first',
    payload: { id: 't', content, pose },
  });
  const original = (f.state() as any).texts[0];
  const rich = {
    ...content,
    runs: [{ text: '待验证', bold: true, color: '#c2410c' }, { text: '\n需要观察' }],
  };
  f.run({
    type: 'text.edit',
    expected: original.versionId,
    editGroup: 'first',
    payload: { id: 't', content: rich },
  });
  expect(f.history().undo).toHaveLength(1);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect((f.state() as any).texts).toEqual([]);
  f.restart();
  f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  const restored = (f.state() as any).texts[0];
  expect(restored).toMatchObject({ id: 't', content: rich, item: { id: original.item.id, pose } });
  expect(restored.versionId).not.toBe(original.versionId);
  expect(restored.item.versionId).not.toBe(original.item.versionId);
  expect(f.state().cards).toEqual([]);
});
it('手调宽与角点字号原子保存，后续文字撤销不倒退独立移动的姿态', () => {
  const f = fixture();
  f.run({
    type: 'text.create',
    expected: null,
    payload: { id: 't', content: { ...content, runs: [{ text: '投资观察' }] }, pose },
  });
  let t = (f.state() as any).texts[0];
  const fixed = { ...t.content, widthMode: 'fixed', width: 500, fontSize: 36 };
  f.run({
    type: 'text.transform',
    expected: { text: t.versionId, pose: t.item.versionId },
    payload: { id: 't', content: fixed, pose: { x: 10, y: 20, width: 500, height: 54 } },
  });
  t = (f.state() as any).texts[0];
  f.run({ type: 'text.move', expected: t.item.versionId, payload: { id: 't', x: 100, y: 200 } });
  t = (f.state() as any).texts[0];
  const movedVersion = t.item.versionId;
  f.run({
    type: 'text.edit',
    expected: t.versionId,
    payload: { id: 't', content: { ...fixed, runs: [{ text: '短' }] } },
  });
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  t = (f.state() as any).texts[0];
  expect(t).toMatchObject({
    content: fixed,
    item: { versionId: movedVersion, pose: { x: 100, y: 200, width: 500, height: 54 } },
  });
  const before = f.state();
  expect(() =>
    f.run({
      type: 'text.transform',
      expected: { text: t.versionId, pose: 'stale' },
      payload: { id: 't', content, pose },
    }),
  ).toThrow('布局已更新');
  expect(f.state()).toEqual(before);
  f.restart();
  expect((f.state() as any).texts[0]).toEqual(t);
});
it('清空后结束编辑一次撤销恢复清空前文字，移除通过delta完整可见且不会复用身份', () => {
  const f = fixture();
  f.run({
    type: 'text.create',
    expected: null,
    payload: { id: 't', content: { ...content, runs: [{ text: '保留理由', bold: true }] }, pose },
  });
  let t = (f.state() as any).texts[0];
  f.run({
    type: 'text.edit',
    expected: t.versionId,
    editGroup: 'clear',
    payload: { id: 't', content },
  });
  t = (f.state() as any).texts[0];
  const before = f.state().project.revision;
  f.run({
    type: 'text.delete',
    expected: { text: t.versionId, pose: t.item.versionId },
    editGroup: 'clear',
    payload: { id: 't' },
  });
  expect((f.state() as any).texts).toEqual([]);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before }, f.human).changes[0]!;
  expect(delta).toMatchObject({
    deletedIds: ['t', t.item.id],
    domains: [
      { domain: 'text', id: 't' },
      { domain: 'pose', id: t.item.id },
    ],
  });
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect((f.state() as any).texts[0].content.runs).toEqual([{ text: '保留理由', bold: true }]);
  expect(() =>
    f.run({ type: 'text.create', expected: null, payload: { id: 't', content, pose } }),
  ).toThrow('身份已使用');
});
it('独立文字索引和无损分片来自固定revision，后来编辑不污染旧快照或卡片索引', () => {
  const f = fixture();
  const rich = {
    ...content,
    runs: [{ text: '😀中文观察\n'.repeat(200), color: '#c2410c', bold: true }],
  };
  f.run({ type: 'text.create', expected: null, payload: { id: 't', content: rich, pose } });
  const t = (f.state() as any).texts[0];
  const page = f.mapping.read(
    { type: 'map', projectId: 'p', view: 'text-index', budget: 4096 } as any,
    f.human,
  ) as any;
  expect(page).toMatchObject({
    scope: { types: ['text'] },
    totalItems: 1,
    items: [
      { id: 't', type: 'text', versionId: t.versionId, content: { availability: 'not_fetched' } },
    ],
  });
  f.run({ type: 'text.edit', expected: t.versionId, payload: { id: 't', content } });
  let cursor: string | undefined;
  const chunks: any[] = [];
  do {
    const detail = f.mapping.read(
      {
        type: 'map',
        projectId: 'p',
        view: 'text-detail',
        textId: 't',
        snapshot: page.snapshot,
        ...(cursor ? { cursor } : {}),
        budget: 4096,
      } as any,
      f.human,
    ) as any;
    expect(detail.revision).toBe(page.revision);
    expect(detail.bytes).toBe(Buffer.byteLength(JSON.stringify(detail)));
    expect(detail.bytes).toBeLessThanOrEqual(4096);
    chunks.push(...detail.items);
    cursor = detail.nextCursor;
  } while (cursor);
  expect(JSON.parse(chunks.map((c) => c.jsonText).join(''))).toEqual({
    id: 't',
    versionId: t.versionId,
    content: rich,
  });
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human).items).toEqual([]);
});
it('文字索引按ID排序，删除撤销与重开保留原创建序位', () => {
  const f = fixture();
  for (const id of ['z-early', 'a-late'])
    f.run({ type: 'text.create', expected: null, payload: { id, content, pose } });
  const original = f.state().texts!.find(value => value.id === 'z-early')!;
  const index = () => f.mapping.read(
    { type: 'map', projectId: 'p', view: 'text-index', budget: 4096 },
    f.human,
  );
  const facts = () => index().items.map(value => ({ id: value.id, order: 'order' in value ? value.order : null }));
  const expected = [{ id: 'a-late', order: 1 }, { id: 'z-early', order: 0 }];
  console.log('stable-text-index-before', JSON.stringify(facts()));
  expect(index().scope.order).toBe('creation_ordinal');
  expect(facts()).toEqual(expected);
  f.run({ type: 'text.delete', expected: { text: original.versionId, pose: original.item.versionId }, payload: { id: original.id } });
  expect(facts()).toEqual([{ id: 'a-late', order: 1 }]);
  f.restart();
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  f.restart();
  console.log('stable-text-index-restored', JSON.stringify(facts()));
  expect(facts()).toEqual(expected);
  const restored = f.state().texts!.find(value => value.id === original.id)!;
  expect(restored.item).toMatchObject({ id: original.item.id, createdOrder: original.item.createdOrder });
});
it('复制文字快照建立独立身份，原件后来改样式不污染副本且undo重做保固定宽和全部runs', () => {
  const f = fixture();
  const rich = {
    ...content,
    widthMode: 'fixed',
    width: 500,
    fontSize: 36,
    align: 'right',
    runs: [
      { text: '关注', bold: true },
      { text: '风险', color: '#c2410c' },
    ],
  };
  f.run({
    type: 'text.create',
    expected: null,
    payload: { id: 't', content: rich, pose: { ...pose, width: 500, height: 54 } },
  });
  const t = (f.state() as any).texts[0];
  const command = {
    type: 'text.copy',
    commandId: 'copy',
    expected: { text: t.versionId, pose: t.item.versionId },
    payload: { id: 't', copyId: 'copy-t' },
  };
  const receipt = f.run(command);
  const copy = (f.state() as any).texts.find((value: any) => value.id === 'copy-t');
  expect(copy).toMatchObject({
    id: 'copy-t',
    content: rich,
    item: { pose: { x: 34, y: 44, width: 500, height: 54 } },
  });
  expect(copy.item.id).not.toBe(t.item.id);
  f.run({ type: 'text.edit', expected: t.versionId, payload: { id: 't', content } });
  expect((f.state() as any).texts.find((value: any) => value.id === 'copy-t')).toEqual(copy);
  f.restart();
  expect(f.run(command)).toEqual(receipt);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect((f.state() as any).texts.map((value: any) => value.id)).toEqual(['t']);
  f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  expect((f.state() as any).texts.find((value: any) => value.id === 'copy-t')).toMatchObject({
    id: copy.id,
    content: rich,
    item: { id: copy.item.id, pose: copy.item.pose },
  });
});

it('独立文字不套用正文的字数上限，长文完整保存并在服务重开后原样读取', () => {
  const f = fixture(),
    text = '长'.repeat(200001);
  f.run({
    type: 'text.create',
    expected: null,
    payload: { id: 'long', content: { ...content, runs: [{ text, bold: true }] }, pose },
  });
  expect(f.state().texts![0]!.content.runs).toEqual([{ text, bold: true }]);
  f.restart();
  expect(f.state().texts![0]!.content.runs).toEqual([{ text, bold: true }]);
});
