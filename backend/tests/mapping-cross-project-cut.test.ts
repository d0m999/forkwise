import { afterEach, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { captureCutCommand } from '../src/mapping/cut-command.js';
import { snapshotScope } from '../src/mapping/snapshot-tree.js';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);

const YELLOW = '#f8dfc4';
const BLUE = '#d9e7f1';
type Fixture = ReturnType<typeof groupFixture>;
type State = ReturnType<Fixture['state']>;

function target(f: Fixture) {
  if (!f.mapping.read({ type: 'projects' }, f.human).some(project => project.id === 'q'))
    f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
}
function read(f: Fixture, projectId: string) {
  return f.mapping.read({ type: 'project', projectId }, f.human);
}
function run(f: Fixture, projectId: string, type: string, payload: unknown, expected: unknown = null) {
  return f.mapping.execute({ commandId: crypto.randomUUID(), projectId, type, expected, payload }, f.human);
}
function travel(f: Fixture, projectId: string, type: 'history.undo' | 'history.redo') {
  return run(f, projectId, type, {}, read(f, projectId).project.revision);
}
function seedTag(f: Fixture, projectId: string, id: string, name: string, color: string) {
  run(f, projectId, 'tag.create', { id, name });
  run(f, projectId, 'tag.update', { id, color }, read(f, projectId).tags!.find(tag => tag.id === id)!.versionId);
}
function cut(f: Fixture, cutId: string, ids: string[]) {
  const state = read(f, 'p');
  const scope = snapshotScope(state, ids);
  const itemIds = [...scope.ids].filter(id => [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []),
    ...(state.images ?? []), ...(state.strokes ?? [])].some(value => value.item.id === id));
  const groupIds = (state.groups ?? []).filter(value => scope.ids.has(value.itemId)).map(value => value.id);
  const frameIds = (state.frames ?? []).filter(value => scope.ids.has(value.id)).map(value => value.id);
  return f.mapping.execute(captureCutCommand(state, { commandId: crypto.randomUUID(), projectId: 'p', cutId, itemIds, groupIds, frameIds }), f.human);
}
function cutState(f: Fixture, cutId: string) {
  return f.mapping.read({ type: 'cut.state', projectId: 'p', cutId }, f.human);
}

// 把剪切前冻结的源状态翻译成前端 pastePlan 会提交的 canvas.paste 载荷。
// copyId 用目标前缀；归属与连线端点都经 itemId → copyId 映射，和剪贴板的口径一致。
type Frozen = { objects: Record<string, unknown>[]; connectors: Record<string, unknown>[]; containment: { copyId: string; parentCopyId: string }[]; roots: string[] };
function freeze(state: State, options: { ids: string[]; connectors?: string[]; prefix?: string; assets?: Record<string, string> }): Frozen {
  const prefix = options.prefix ?? 'dst-';
  const wanted = new Set(options.ids);
  const objects: Record<string, unknown>[] = [];
  const copyOf = new Map<string, string>();
  const stack = (order?: number) => order ?? 0;
  const remapBlock = (block: Record<string, unknown>) => block.type === 'image' && options.assets?.[String(block.assetId)]
    ? { ...block, assetId: options.assets[String(block.assetId)] } : block;
  for (const card of state.cards) if (wanted.has(card.item.id)) {
    copyOf.set(card.item.id, prefix + card.id);
    objects.push({ kind: 'card', copyId: prefix + card.id, stack: stack(card.item.createdOrder), title: card.title,
      blocks: card.body.blocks.map(remapBlock),
      tagIds: card.cardTags ? [...card.cardTags.tagIds] : null,
      appearance: card.appearance ? { titleColor: card.appearance.titleColor, showPreview: card.appearance.showPreview } : null,
      pose: card.item.pose });
  }
  for (const text of state.texts ?? []) if (wanted.has(text.item.id)) {
    copyOf.set(text.item.id, prefix + text.id);
    objects.push({ kind: 'text', copyId: prefix + text.id, stack: stack(text.item.createdOrder), content: text.content, pose: text.item.pose });
  }
  for (const shape of state.shapes ?? []) if (wanted.has(shape.item.id)) {
    copyOf.set(shape.item.id, prefix + shape.id);
    objects.push({ kind: 'shape', copyId: prefix + shape.id, stack: stack(shape.item.createdOrder), content: shape.content, pose: shape.item.pose });
  }
  for (const image of state.images ?? []) if (wanted.has(image.item.id)) {
    copyOf.set(image.item.id, prefix + image.id);
    objects.push({ kind: 'image', copyId: prefix + image.id, stack: stack(image.item.createdOrder),
      content: { ...image.content, assetId: options.assets?.[image.content.assetId] ?? image.content.assetId }, pose: image.item.pose });
  }
  for (const stroke of state.strokes ?? []) if (wanted.has(stroke.item.id)) {
    copyOf.set(stroke.item.id, prefix + stroke.id);
    objects.push({ kind: 'stroke', copyId: prefix + stroke.id, stack: stack(stroke.item.createdOrder), content: stroke.content, pose: stroke.item.pose });
  }
  for (const group of state.groups ?? []) if (wanted.has(group.itemId)) {
    copyOf.set(group.itemId, prefix + group.id);
    objects.push({ kind: 'group', copyId: prefix + group.id, stack: stack(group.createdOrder), pose: group.bounds });
  }
  for (const frame of state.frames ?? []) if (wanted.has(frame.id)) {
    copyOf.set(frame.id, prefix + frame.id);
    objects.push({ kind: 'frame', copyId: prefix + frame.id, stack: 0, name: frame.name, background: frame.background, pose: frame.pose });
  }
  const wantedConnectors = new Set(options.connectors ?? []);
  const end = (value: { kind: string; itemId?: string; side?: string; targetKind?: string; point?: unknown }) => {
    if (value.kind !== 'bound') return { kind: 'free', point: value.point };
    const copyId = copyOf.get(value.itemId!);
    // 外端不在本次子树里就应该在剪贴板阶段被冻成自由点，而不是带空 copyId。
    if (!copyId) throw new Error(`连线外端 ${value.itemId} 不在剪切子树中`);
    return { kind: 'bound', copyId, side: value.side, ...(value.targetKind ? { targetKind: value.targetKind } : {}) };
  };
  const connectors = (state.connectors ?? []).filter(line => wantedConnectors.has(line.id)).map(line => ({
    copyId: prefix + line.id, path: line.path, start: end(line.start as never), end: end(line.end as never),
    ...(line.style ? { style: line.style } : {}), ...(line.label !== undefined ? { label: line.label } : {}),
  }));
  const containment = (state.containment ?? []).flatMap(edge => {
    const child = copyOf.get(edge.id), parent = edge.parent ? copyOf.get(edge.parent.id) : undefined;
    return child && parent ? [{ copyId: child, parentCopyId: parent }] : [];
  });
  const roots = [...copyOf.entries()].filter(([itemId]) => !containment.some(edge => edge.copyId === copyOf.get(itemId))).map(([, copyId]) => copyId);
  return { objects, connectors, containment, roots };
}
function paste(f: Fixture, payload: { translation?: { x: number; y: number }; library?: unknown; objects: unknown[]; connectors: unknown[]; roots?: string[]; containment?: unknown[] }, commandId: string = crypto.randomUUID()) {
  return f.mapping.execute({
    commandId, projectId: 'q', type: 'canvas.paste', expected: null,
    payload: { translation: payload.translation ?? { x: 40, y: 60 }, ...(payload.library ? { library: payload.library } : {}),
      ...(payload.roots ? { version: 2, roots: payload.roots, containment: payload.containment } : {}),
      objects: payload.objects, connectors: payload.connectors },
  }, f.human);
}

it('AC1：跨项目剪切粘贴生成目标身份、正文与标签，资源按内容独立，源项目只多一条剪切历史', () => {
  const f = groupFixture();
  target(f);
  seedTag(f, 'p', 'src-ai', 'AI', YELLOW);
  seedTag(f, 'p', 'src-defi', 'DeFi', YELLOW);
  seedTag(f, 'q', 'dst-ai', 'ai', BLUE);
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  run(f, 'p', 'asset.save', { id: 'src-asset', name: '图.png', mime: 'image/png', base64 });
  run(f, 'p', 'thought.create', { id: 'source-card', title: '市场观察', text: '', x: 10, y: 20 });
  run(f, 'p', 'card.tags', { id: 'source-card', tagIds: ['src-defi', 'src-ai'] });
  const created = read(f, 'p').cards.find(card => card.id === 'source-card')!;
  run(f, 'p', 'body.edit', { id: 'source-card', blocks: [
    { id: 'words', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
  ] }, created.body.versionId);
  const frozen = read(f, 'p');
  const card = frozen.cards[0]!;
  const sourceRevision = frozen.project.revision;
  cut(f, 'cut-1', [card.item.id]);
  const afterCut = read(f, 'p');
  expect(afterCut.cards).toEqual([]);
  expect(afterCut.project.revision).toBe(sourceRevision + 1);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'eligible', revision: 0 });

  const plan = freeze(frozen, { ids: [card.item.id] });
  const sourceTagAi = frozen.tags!.find(tag => tag.id === 'src-ai')!;
  const sourceTagDefi = frozen.tags!.find(tag => tag.id === 'src-defi')!;
  paste(f, {
    library: { tags: [{ id: 'src-defi', name: sourceTagDefi.name, color: sourceTagDefi.color },
      { id: 'src-ai', name: sourceTagAi.name, color: sourceTagAi.color }],
      assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64 }] },
    objects: plan.objects, connectors: plan.connectors,
  });
  const result = read(f, 'q');
  const pasted = result.cards.find(value => value.id === 'dst-source-card')!;
  expect(pasted.title).toBe('市场观察');
  expect(pasted.body.id).not.toBe(card.body.id);
  expect(pasted.body.versionId).not.toBe(card.body.versionId);
  expect(pasted.item.id).not.toBe(card.item.id);
  expect(pasted.body.blocks.find(block => block.type === 'text')).toMatchObject({ text: '需求增长' });
  // 同名标签复用目标标签与颜色；缺失标签在目标新建并保留源颜色，顺序与源一致。
  const reused = result.tags!.find(tag => tag.id === 'dst-ai')!;
  const fresh = result.tags!.find(tag => tag.name === 'DeFi')!;
  expect(reused).toMatchObject({ name: 'ai', color: BLUE });
  expect(fresh).toMatchObject({ color: YELLOW, deleted: false });
  expect(fresh.id).not.toBe('src-defi');
  expect(pasted.cardTags!.tagIds).toEqual([fresh.id, 'dst-ai']);
  // 资源按内容新建：不绑定源项目 id，内容与源一致。
  const assetId = String(pasted.body.blocks.find(block => block.type === 'image')!.assetId);
  expect(assetId).not.toBe('src-asset');
  expect(f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toMatchObject({ base64, name: '图.png' });
  expect(() => f.mapping.read({ type: 'asset', projectId: 'q', id: 'src-asset' }, f.human)).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }));
  // 源项目只多了剪切这一条历史，内容仍可由撤销恢复。
  expect(read(f, 'p')).toEqual(afterCut);
  const sourceActions = f.mapping.read({ type: 'history', projectId: 'p' }, f.human).undo.map(action => action.label);
  expect(sourceActions.at(-1)).toBe('canvas.cut');
  expect(sourceActions.some(label => label === 'canvas.paste' || label === 'canvas.paste-cut')).toBe(false);
  const targetActions = f.mapping.read({ type: 'history', projectId: 'q' }, f.human).undo.map(action => action.label);
  expect(targetActions.at(-1)).toBe('canvas.paste');
  expect(targetActions.filter(label => label === 'canvas.paste')).toHaveLength(1);
  travel(f, 'p', 'history.undo');
  expect(read(f, 'p').cards.map(value => value.id)).toEqual(['source-card']);
  expect(read(f, 'q').cards.map(value => value.id)).toEqual(['dst-source-card']);
});

it('AC2：整段分区子树（组、各类对象、未知正文、媒体、内部线）进入目标项目，未选外线不进入', () => {
  const f = groupFixture();
  target(f);
  run(f, 'p', 'frame.create', { id: 'frame', itemIds: [], pose: { x: 0, y: 0, width: 1400, height: 1000 } },
    { frame: null, groups: {}, containment: {}, poses: {} });
  run(f, 'p', 'thought.create', { id: 'a', title: '甲', text: '', x: 100, y: 100 });
  run(f, 'p', 'thought.create', { id: 'b', title: '乙', text: '', x: 400, y: 100 });
  run(f, 'p', 'text.create', { id: 't', content: { runs: [{ text: '独立文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 100 }, pose: { x: 100, y: 400, width: 100, height: 27 } });
  run(f, 'p', 'shape.create', { id: 's', content: { shapeType: 'ellipse', shortText: '形状' }, pose: { x: 700, y: 100, width: 100, height: 60 } });
  run(f, 'p', 'stroke.create', { id: 'k', content: { penKind: 'pen', path: [{ x: 2, y: 2 }, { x: 18, y: 8 }], width: 4, color: '#123456', opacity: 1 }, pose: { x: 800, y: 300, width: 20, height: 10 } });
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  run(f, 'p', 'asset.save', { id: 'asset', name: '图.png', mime: 'image/png', base64 });
  run(f, 'p', 'image.create', { id: 'i', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 1000, y: 100, width: 40, height: 60, rotation: 0 } });
  const state = read(f, 'p');
  const a = state.cards.find(card => card.id === 'a')!, b = state.cards.find(card => card.id === 'b')!;
  run(f, 'p', 'body.edit', { id: 'a', blocks: [{ id: 'words', type: 'text', text: '正文' },
    { id: 'pic', type: 'image', assetId: 'asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 }] }, a.body.versionId);
  // body.edit 只接受已支持类型；未知正文只能来自旧数据，这里按 legacy 行直接落库模拟。
  {
    const db = new Database(join(f.directory, 'workspace.sqlite'));
    try {
      const row = db.prepare('SELECT value FROM mapping_cards WHERE project_id=? AND id=?').get('p', 'a') as { value: string };
      const stored = JSON.parse(row.value) as { body: { blocks: unknown[] } };
      stored.body.blocks.push({ id: 'future', type: 'unknown-block', payload: { keep: true } });
      db.prepare('UPDATE mapping_cards SET value=? WHERE project_id=? AND id=?').run(JSON.stringify(stored), 'p', 'a');
    } finally { db.close(); }
  }
  const beforeGroup = read(f, 'p');
  run(f, 'p', 'group.create', { id: 'g', itemIds: [a.item.id, b.item.id] },
    { groups: { g: null }, containment: Object.fromEntries([a.item.id, b.item.id].map(id => [id, beforeGroup.containment!.find(value => value.id === id)?.versionId ?? null])) });
  const withGroup = read(f, 'p');
  const group = withGroup.groups!.find(value => value.id === 'g')!;
  run(f, 'p', 'connector.create', { id: 'inner', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' }, path: 'straight' });
  run(f, 'p', 'thought.create', { id: 'outside', title: '外面', text: '', x: 1600, y: 1200 });
  const outside = read(f, 'p').cards.find(card => card.id === 'outside')!;
  run(f, 'p', 'connector.create', { id: 'outer', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' },
    end: { kind: 'bound', itemId: outside.item.id, side: 'left' }, path: 'straight' });
  const frozen = read(f, 'p');
  const scopeIds = [...snapshotScope(frozen, ['frame']).ids];
  const revision = frozen.project.revision;
  cut(f, 'cut-1', ['frame']);
  expect(read(f, 'p').cards.map(card => card.id)).toEqual(['outside']);
  expect(read(f, 'p').project.revision).toBe(revision + 1);
  // 外线绑在被剪切的组合上，随容器一起消失（D340）；剪贴板只冻结两端都在子树内的线。
  expect(read(f, 'p').connectors ?? []).toEqual([]);

  // 剪贴板只带两端都在子树内的线；外线不进入目标项目。
  const plan = freeze(frozen, { ids: scopeIds, connectors: ['inner'] });
  paste(f, { library: { tags: [], assets: [{ id: 'asset', name: '图.png', mime: 'image/png', base64 }] },
    objects: plan.objects, connectors: plan.connectors, roots: plan.roots, containment: plan.containment });
  const result = read(f, 'q');
  expect(result.frames!.map(frame => frame.id)).toEqual(['dst-frame']);
  expect(result.groups!.map(value => value.id)).toEqual(['dst-g']);
  expect(result.cards.map(card => card.id).sort()).toEqual(['dst-a', 'dst-b']);
  expect(result.texts!.map(value => value.id)).toEqual(['dst-t']);
  expect(result.shapes!.map(value => value.id)).toEqual(['dst-s']);
  expect(result.strokes!.map(value => value.id)).toEqual(['dst-k']);
  expect(result.images!.map(value => value.id)).toEqual(['dst-i']);
  expect(result.connectors!.map(line => line.id)).toEqual(['dst-inner']);
  // 未知正文原样保留，媒体按内容复制到目标项目。
  const pastedCard = result.cards.find(card => card.id === 'dst-a')!;
  expect(pastedCard.body.blocks.find(block => block.type === 'unknown-block')).toMatchObject({ payload: { keep: true } });
  const assetId = String(result.images![0]!.content.assetId);
  expect(assetId).not.toBe('asset');
  expect(f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toMatchObject({ base64 });
  // 分区与组的归属完整。
  expect(result.containment!.find(value => value.id === pastedCard.item.id)?.parent?.id).toBe(result.groups![0]!.itemId);
  expect(result.containment!.find(value => value.id === result.groups![0]!.itemId)?.parent).toEqual({ kind: 'frame', id: 'dst-frame' });
});

it('AC3：目标撤销/重做不改变源项目；源撤销/重做不改变目标，包括目标已有后续编辑', () => {
  const f = groupFixture();
  target(f);
  run(f, 'p', 'thought.create', { id: 'a', title: '甲', text: '甲的正文', x: 10, y: 20 });
  const frozen = read(f, 'p');
  const card = frozen.cards[0]!;
  cut(f, 'cut-1', [card.item.id]);
  const afterCut = read(f, 'p');
  const plan = freeze(frozen, { ids: [card.item.id] });
  paste(f, { objects: plan.objects, connectors: [] });
  const pasted = read(f, 'q').cards[0]!;
  expect(pasted.id).toBe('dst-a');

  travel(f, 'q', 'history.undo');
  expect(read(f, 'q').cards).toEqual([]);
  expect(read(f, 'p')).toEqual(afterCut);
  travel(f, 'q', 'history.redo');
  expect(read(f, 'q').cards.map(value => value.id)).toEqual(['dst-a']);
  expect(read(f, 'p')).toEqual(afterCut);

  travel(f, 'p', 'history.undo');
  expect(read(f, 'p').cards.map(value => value.id)).toEqual(['a']);
  expect(read(f, 'q').cards.map(value => value.id)).toEqual(['dst-a']);
  // 目标已有后续编辑时，源撤销/重做不得回灌。
  const live = read(f, 'q').cards[0]!;
  run(f, 'q', 'card.edit', { id: 'dst-a', text: '目标项目改过的正文', x: 500, y: 500 },
    { body: live.body.versionId, pose: live.item.versionId });
  const edited = read(f, 'q');
  travel(f, 'p', 'history.redo');
  expect(read(f, 'p').cards).toEqual([]);
  expect(read(f, 'q')).toEqual(edited);
  expect(JSON.stringify(read(f, 'q').cards[0]!.body.blocks)).toContain('目标项目改过的正文');
  // 目标再撤销只撤自己的编辑/粘贴，源项目保持剪切后的状态。
  travel(f, 'q', 'history.undo');
  expect(JSON.stringify(read(f, 'q').cards[0]!.body.blocks)).not.toContain('目标项目改过的正文');
  expect(read(f, 'p').cards).toEqual([]);
});

it('AC4：无目标权限与无效媒体都不产生部分写入，重开后可撤销源剪切恢复', () => {
  const f = groupFixture();
  target(f);
  seedTag(f, 'p', 'src-ai', 'AI', YELLOW);
  run(f, 'p', 'thought.create', { id: 'a', title: '甲', text: '', x: 10, y: 20 });
  run(f, 'p', 'card.tags', { id: 'a', tagIds: ['src-ai'] });
  const frozen = read(f, 'p');
  const card = frozen.cards[0]!;
  cut(f, 'cut-1', [card.item.id]);
  const plan = freeze(frozen, { ids: [card.item.id] });
  const beforeTarget = read(f, 'q');

  const agent = f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']);
  const denied = f.mapping.access.authenticate(agent);
  expect(() => f.mapping.execute({ commandId: 'denied', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: { translation: { x: 1, y: 1 }, objects: plan.objects, connectors: [] } }, denied))
    .toThrowError(expect.objectContaining({ code: 'PROJECT_FORBIDDEN' }));
  expect(read(f, 'q')).toEqual(beforeTarget);

  // 无效媒体在事务内失败：已创建的标签也必须一起回滚。
  expect(() => paste(f, {
    library: { tags: [{ id: 'src-ai', name: 'AI', color: YELLOW }], assets: [{ id: 'missing', name: '坏.png', mime: 'image/png', base64: 'not-base64' }] },
    objects: plan.objects.map(object => object.kind === 'card' ? { ...object, blocks: [{ id: 'pic', type: 'image', assetId: 'missing', name: '坏.png', mime: 'image/png', naturalWidth: 1, naturalHeight: 1 }] } : object),
    connectors: [],
  })).toThrowError();
  const afterFailure = read(f, 'q');
  expect(afterFailure).toEqual(beforeTarget);
  expect(afterFailure.tags ?? []).toEqual([]);

  // 清除目标侧缓存后重开仍能从源历史恢复：重开真实 SQLite 再撤销剪切。
  f.reopen();
  expect(read(f, 'q')).toEqual(beforeTarget);
  travel(f, 'p', 'history.undo');
  expect(read(f, 'p').cards.map(value => value.id)).toEqual(['a']);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'cut-undone' });
});

it('源记录不存在时读取明确拒绝；同一粘贴命令重放幂等，只产生一批对象与一条历史', () => {
  const f = groupFixture();
  target(f);
  expect(() => cutState(f, 'missing')).toThrowError(expect.objectContaining({ code: 'CUT_NOT_FOUND' }));
  run(f, 'p', 'thought.create', { id: 'a', title: '甲', text: '', x: 10, y: 20 });
  const frozen = read(f, 'p');
  const card = frozen.cards[0]!;
  cut(f, 'cut-1', [card.item.id]);
  const plan = freeze(frozen, { ids: [card.item.id] });
  const commandId = 'paste-once';
  const receipt = paste(f, { objects: plan.objects, connectors: [] }, commandId);
  const afterFirst = read(f, 'q');
  const replay = paste(f, { objects: plan.objects, connectors: [] }, commandId);
  expect(replay).toEqual(receipt);
  expect(read(f, 'q')).toEqual(afterFirst);
  const targetActions = f.mapping.read({ type: 'history', projectId: 'q' }, f.human).undo.map(action => action.label);
  expect(targetActions.at(-1)).toBe('canvas.paste');
  expect(targetActions.filter(label => label === 'canvas.paste')).toHaveLength(1);
  expect(read(f, 'p').cards).toEqual([]);
});
