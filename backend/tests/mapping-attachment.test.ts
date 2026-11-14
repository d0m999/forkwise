import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';
import { captureCutCommand } from '../src/mapping/cut-command.js';
import { snapshotScope } from '../src/mapping/snapshot-tree.js';
import { MappingCommand } from '../src/mapping/contracts.js';
import { CompactQuerySchema } from '../src/mapping/compact-contracts.js';
import { readFileSync } from 'node:fs';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-attachment-'));
  let mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const fail = (command: Record<string, unknown>) => {
    try { run(command); }
    catch (error) { return error as { code: string; status: number; message: string }; }
    throw new Error('命令应当失败');
  };
  run({ type: 'project.create', expected: null, payload: { name: '附着' } });
  run({ type: 'thought.create', expected: null, payload: { id: 'card', title: '卡片', text: '正文', x: 0, y: 0 } });
  const textContent = { runs: [{ text: '批注' }], fontSize: 16, lineHeight: 1.5 as const, align: 'left' as const, widthMode: 'fixed' as const, width: 80 };
  run({ type: 'text.create', expected: null, payload: { id: 'note', content: textContent, pose: { x: 40, y: 30, width: 80, height: 24 } } });
  run({ type: 'shape.create', expected: null, payload: { id: 'mark', content: { shapeType: 'ellipse', shortText: '形', fill: '#ffffff', stroke: '#111111', strokeWidth: 1 }, pose: { x: 10, y: 10, width: 40, height: 20 } } });
  run({ type: 'stroke.create', expected: null, payload: { id: 'pen', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 8, y: 3 }], color: '#123456', width: 2, opacity: 1 }, pose: { x: 12, y: 14, width: 20, height: 8 } } });
  run({ type: 'stroke.create', expected: null, payload: { id: 'ink', content: { penKind: 'highlighter', path: [{ x: 2, y: 2 }, { x: 12, y: 4 }], color: '#ffe08a', width: 8, opacity: 0.4 }, pose: { x: 16, y: 18, width: 24, height: 10 } } });
  return { directory, get mapping() { return mapping; }, human, run, state, history, fail, restart() { mapping.close(); mapping = openMapping(directory); } };
}

function attach(f: ReturnType<typeof fixture>, itemId: string, card = f.state().cards[0]!) {
  const note = [...(f.state().texts ?? []), ...(f.state().shapes ?? []), ...(f.state().strokes ?? [])].find(value => value.item.id === itemId)!;
  const current = f.state().attachments?.find(row => row.id === itemId);
  return f.run({ type: 'attachment.attach', expected: { attachment: current?.versionId ?? null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: f.state().containment?.find(row => row.id === itemId)?.versionId ?? null }, payload: { itemId, targetItemId: card.item.id } });
}

function followersFor(f: ReturnType<typeof fixture>, cardItemId: string, dx: number, dy: number) {
  const rows = (f.state().attachments ?? []).filter(row => row.target?.itemId === cardItemId);
  const followers = rows.map(row => {
    const text = f.state().texts?.find(value => value.item.id === row.id);
    const shape = f.state().shapes?.find(value => value.item.id === row.id);
    const image = f.state().images?.find(value => value.item.id === row.id);
    const stroke = f.state().strokes?.find(value => value.item.id === row.id);
    const value = text ?? shape ?? image ?? stroke!;
    const kind = text ? 'text' as const : shape ? 'shape' as const : image ? 'image' as const : 'stroke' as const;
    return { kind, id: value.id, itemId: value.item.id, x: value.item.pose.x + dx, y: value.item.pose.y + dy, versionId: value.item.versionId };
  });
  return { followers: followers.map(({ versionId: _version, ...value }) => value), expectedFollowers: Object.fromEntries(followers.map(value => [value.itemId, value.versionId])) };
}

it('五类里的文字、形状和两种笔迹可附着，移动卡片时跟随，未附着的不动', () => {
  const f = fixture();
  const card = f.state().cards[0]!;
  const loose = f.state().texts![0]!;
  attach(f, f.state().shapes![0]!.item.id);
  attach(f, f.state().strokes!.find(stroke => stroke.content.penKind === 'pen')!.item.id);
  attach(f, f.state().strokes!.find(stroke => stroke.content.penKind === 'highlighter')!.item.id);
  const before = f.state();
  const dx = 30, dy = 12;
  const followed = followersFor(f, card.item.id, dx, dy);
  f.run({ type: 'pose.batch', expected: { [card.id]: before.cards[0]!.item.versionId }, ...followed, payload: { poses: [{ id: card.id, x: dx, y: dy, width: card.item.pose.width, height: card.item.pose.height }] } });
  const after = f.state();
  expect(after.shapes![0]!.item.pose).toMatchObject({ x: before.shapes![0]!.item.pose.x + dx, y: before.shapes![0]!.item.pose.y + dy });
  expect(after.strokes!.every(stroke => stroke.item.pose.x === before.strokes!.find(value => value.id === stroke.id)!.item.pose.x + dx)).toBe(true);
  expect(after.texts![0]!.item.pose).toEqual(loose.item.pose);
  expect(after.attachments).toEqual(before.attachments);
});

it('漏带随动是 400 且 revision 不变，过期版本是 409', () => {
  const f = fixture();
  const card = f.state().cards[0]!;
  attach(f, f.state().texts![0]!.item.id);
  const ready = f.state();
  const revision = ready.project.revision;
  const missing = f.fail({ type: 'pose.batch', expected: { [card.id]: ready.cards[0]!.item.versionId }, payload: { poses: [{ id: card.id, x: 8, y: 0, width: card.item.pose.width, height: card.item.pose.height }] } });
  expect(missing).toMatchObject({ code: 'ATTACHMENT_NOT_MOVED', status: 400 });
  expect(missing.message).toContain(ready.texts![0]!.item.id);
  expect(f.state().project.revision).toBe(revision);
  const half = f.fail({ type: 'pose.batch', expected: { [card.id]: ready.cards[0]!.item.versionId }, followers: [], payload: { poses: [{ id: card.id, x: 8, y: 0, width: card.item.pose.width, height: card.item.pose.height }] } });
  expect(half).toMatchObject({ code: 'ATTACHMENT_NOT_MOVED', status: 400 });
  const stale = followersFor(f, card.item.id, 8, 0);
  stale.expectedFollowers[ready.texts![0]!.item.id] = 'stale-version';
  const conflict = f.fail({ type: 'pose.batch', expected: { [card.id]: ready.cards[0]!.item.versionId }, ...stale, payload: { poses: [{ id: card.id, x: 8, y: 0, width: card.item.pose.width, height: card.item.pose.height }] } });
  expect(conflict).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
  expect(f.state().project.revision).toBe(revision);
});

it('有附着的卡片拒绝 pose.move，拖批注只改 pose，解除后位置不跳且可撤销', () => {
  const f = fixture();
  const card = f.state().cards[0]!;
  const text = f.state().texts![0]!;
  attach(f, text.item.id);
  const blocked = f.fail({ type: 'pose.move', expected: f.state().cards[0]!.item.versionId, payload: { id: card.id, x: 20, y: 0 } });
  expect(blocked).toMatchObject({ code: 'ATTACHMENT_NOT_MOVED', status: 400 });
  const moved = f.state();
  f.run({ type: 'canvas.move', expected: { [text.item.id]: moved.texts![0]!.item.versionId }, payload: { targets: [{ kind: 'text', id: text.id, itemId: text.item.id, x: 90, y: 70 }] } });
  expect(f.state().texts![0]!.item.pose).toMatchObject({ x: 90, y: 70 });
  expect(f.state().attachments).toEqual(moved.attachments);
  const row = f.state().attachments![0]!;
  const placed = f.state().texts![0]!;
  f.run({ type: 'attachment.detach', expected: { attachment: row.versionId, target: { itemId: card.item.id, versionId: f.state().cards[0]!.item.versionId } }, payload: { itemId: row.id } });
  expect(f.state().attachments).toEqual([]);
  expect(f.state().texts![0]!.item.pose).toMatchObject({ x: 90, y: 70 });
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect(f.state().attachments?.[0]?.target).toEqual({ itemId: card.item.id });
  expect(f.state().texts![0]!.item).toMatchObject({ id: placed.item.id, pose: placed.item.pose });
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect(f.state().attachments?.[0]?.target).toEqual({ itemId: card.item.id });
  expect(f.state().texts![0]!.item.pose).toEqual(text.item.pose);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect(f.state().attachments).toEqual([]);
});

it('删除卡片保留批注并解绑，撤销后附着回来；删除批注只删自己的行', () => {
  const f = fixture();
  const text = f.state().texts![0]!;
  attach(f, text.item.id);
  const card = f.state().cards[0]!;
  const pose = f.state().texts![0]!.item.pose;
  f.run({ type: 'thought.delete', expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null }, payload: { id: card.id } });
  expect(f.state().cards).toEqual([]);
  expect(f.state().texts![0]!.item.pose).toEqual(pose);
  expect(f.state().attachments).toEqual([]);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect(f.state().cards[0]!.id).toBe(card.id);
  expect(f.state().attachments?.[0]?.target?.itemId).toBe(card.item.id);
  const restored = f.state().texts![0]!;
  f.run({ type: 'text.delete', expected: { text: restored.versionId, pose: restored.item.versionId }, payload: { id: restored.id } });
  expect(f.state().texts).toEqual([]);
  expect(f.state().attachments).toEqual([]);
  expect(f.state().cards).toHaveLength(1);
});

it('附着索引与契约、工具描述中的视图名一致', () => {
  const contractViews = CompactQuerySchema.options.map(option => option.shape.view.value);
  const mcp = readFileSync(new URL('../src/mapping/compact-mcp.ts', import.meta.url), 'utf8');
  const described = [...mcp.matchAll(/view: z\.enum\(\[([^\]]+)\]\)/g)].map(match => [...match[1]!.matchAll(/'([^']+)'/g)].map(item => item[1]));
  expect(new Set(contractViews)).toEqual(new Set(described[0]));
  const indexNames = ['index', 'tags', 'text-index', 'shape-index', 'stroke-index', 'image-index', 'connector-index', 'group-index', 'frame-index', 'containment', 'attachment-index'];
  const descriptions = [...mcp.matchAll(/description:\s*\n?\s*'([^']+)'/g)].map(match => match[1]!).filter(text => text.includes('十一个视图'));
  expect(descriptions).toHaveLength(2);
  expect(descriptions.every(text => indexNames.every(name => text.includes(name)))).toBe(true);
  const f = fixture();
  attach(f, f.state().texts![0]!.item.id);
  const map = f.mapping.read({ type: 'map', projectId: 'p', view: 'attachment-index' }, f.human);
  expect(map.fidelity).toBe('attachment-index');
  expect(map.items).toEqual([{ id: f.state().texts![0]!.item.id, versionId: f.state().attachments![0]!.versionId, targetItemId: f.state().cards[0]!.item.id }]);
  expect(MappingCommand.safeParse({ commandId: 'c', projectId: 'p', type: 'pose.batch', expected: { a: 'v' }, followers: [{ kind: 'card', id: 'a', itemId: 'b', x: 1, y: 1 }], payload: { poses: [{ id: 'a', x: 1, y: 1, width: 1, height: 1 }] } }).success).toBe(false);
});

function assertNoOrphans(directory: string) {
  const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
  const rows = db.prepare('SELECT item_id, value FROM mapping_attachments').all() as { item_id: string; value: string }[];
  const ids = (table: string) => new Set((db.prepare(`SELECT value FROM ${table}`).all() as { value: string }[]).map(row => (JSON.parse(row.value) as { item: { id: string } }).item.id));
  const texts = ids('mapping_texts'), shapes = ids('mapping_shapes'), images = ids('mapping_images'), strokes = ids('mapping_strokes');
  const cards = ids('mapping_cards');
  db.close();
  expect(rows.filter(row => !texts.has(row.item_id) && !shapes.has(row.item_id) && !images.has(row.item_id) && !strokes.has(row.item_id))).toEqual([]);
  expect(rows.filter(row => !cards.has((JSON.parse(row.value) as { target: { itemId: string } }).target.itemId))).toEqual([]);
}

it('删除入口不留下孤儿附着行', () => {
  const f = fixture();
  const card = f.state().cards[0]!;
  for (const value of [...f.state().texts!, ...f.state().shapes!, ...f.state().strokes!]) attach(f, value.item.id);
  const text = f.state().texts![0]!;
  f.run({ type: 'text.delete', expected: { text: text.versionId, pose: text.item.versionId }, payload: { id: text.id } });
  const shape = f.state().shapes![0]!;
  f.run({ type: 'shape.delete', expected: { shape: shape.versionId, pose: shape.item.versionId }, payload: { id: shape.id } });
  for (const stroke of f.state().strokes!) f.run({ type: 'stroke.delete', expected: { stroke: stroke.versionId, pose: stroke.item.versionId }, payload: { id: stroke.id } });
  f.run({ type: 'thought.delete', expected: { thought: f.state().cards[0]!.versionId, body: f.state().cards[0]!.body.versionId, pose: f.state().cards[0]!.item.versionId, appearance: null }, payload: { id: card.id } });
  assertNoOrphans(f.directory);
});

it('图片批注裁剪不改附着，分区、组合、选区和删图后没有孤儿行', () => {
  const f = fixture();
  const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString('base64');
  f.run({ type: 'asset.save', expected: null, payload: { id: 'asset', name: 'a.svg', mime: 'image/svg+xml', base64 } });
  f.run({ type: 'image.create', expected: null, payload: { id: 'pic', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 20, y: 20, width: 40, height: 40, rotation: 0 } } });
  const image = f.state().images![0]!;
  attach(f, image.item.id);
  const host = f.state().cards[0]!;
  const placed = f.state().images![0]!;
  f.run({ type: 'pose.batch', expected: { [host.id]: host.item.versionId }, ...followersFor(f, host.item.id, 12, 0), payload: { poses: [{ id: host.id, x: host.item.pose.x + 12, y: host.item.pose.y, width: host.item.pose.width, height: host.item.pose.height }] } });
  expect(f.state().images![0]!.item.pose).toMatchObject({ x: placed.item.pose.x + 12, y: placed.item.pose.y, width: placed.item.pose.width, height: placed.item.pose.height, rotation: placed.item.pose.rotation });
  const row = f.state().attachments![0]!;
  const current = f.state().images![0]!;
  f.run({ type: 'image.crop', expected: { image: current.versionId, pose: current.item.versionId }, payload: { id: 'pic', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
  expect(f.state().attachments![0]).toMatchObject({ id: row.id, versionId: row.versionId, target: row.target });
  expect(f.state().images![0]!.item.pose).not.toEqual(image.item.pose);
  f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  expect(f.state().images![0]!.item.pose).toEqual(current.item.pose);
  f.run({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 4000, y: 4000, width: 80, height: 80 } } });
  f.run({ type: 'frame.delete', expected: { frame: f.state().frames![0]!.versionId, containment: {} }, payload: { id: 'frame' } });
  f.run({ type: 'shape.create', expected: null, payload: { id: 'extra', content: { shapeType: 'rectangle', shortText: '另', fill: '#ffffff', stroke: '#111111', strokeWidth: 1 }, pose: { x: 200, y: 10, width: 40, height: 20 } } });
  const grouped = f.state().shapes!;
  f.run({ type: 'group.create', expected: { groups: { g: null }, containment: Object.fromEntries(grouped.map(value => [value.item.id, null])) }, payload: { id: 'g', itemIds: grouped.map(value => value.item.id) } });
  const group = f.state().groups![0]!;
  const membership = Object.fromEntries(f.state().containment!.filter(value => group.memberItemIds.includes(value.id)).map(value => [value.id, value.versionId]));
  const items = Object.fromEntries(f.state().shapes!.filter(value => group.memberItemIds.includes(value.item.id)).map(value => [value.item.id, { kind: 'shape', shape: value.versionId, pose: value.item.versionId }]));
  f.run({ type: 'group.delete', expected: { group: group.versionId, containment: membership, items, connectors: {} }, payload: { id: group.id } });
  const stroke = f.state().strokes![0]!;
  f.run({ type: 'canvas.delete-selection', expected: { groups: {}, containment: { [stroke.item.id]: f.state().containment?.find(value => value.id === stroke.item.id)?.versionId ?? null }, items: { [stroke.item.id]: { kind: 'stroke', stroke: stroke.versionId, pose: stroke.item.versionId } }, connectors: {} }, payload: { groupIds: [], directItemIds: [stroke.item.id] } });
  const picture = f.state().images![0]!;
  f.run({ type: 'image.delete', expected: { image: picture.versionId, pose: picture.item.versionId }, payload: { id: picture.id } });
  assertNoOrphans(f.directory);
});

it('改高度时批注只按一半高度平移，复制不带附着，回源剪切恢复附着', () => {
  const f = fixture();
  const text = f.state().texts![0]!;
  attach(f, text.item.id);
  const card = f.state().cards[0]!;
  const before = f.state().texts![0]!.item.pose;
  const necessaryHeight = card.item.pose.height + 40;
  const followed = followersFor(f, card.item.id, 0, 20);
  f.run({ type: 'card.layout', expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null }, ...followed, payload: { id: card.id, necessaryHeight } });
  expect(f.state().texts![0]!.item.pose).toMatchObject({ x: before.x, y: before.y + 20 });
  expect(f.state().attachments).toHaveLength(1);
  const source = f.state();
  f.run({ type: 'canvas.duplicate', expected: {
    cards: { [card.id]: { thought: source.cards[0]!.versionId, body: source.cards[0]!.body.versionId, pose: source.cards[0]!.item.versionId, appearance: source.cards[0]!.appearance?.versionId ?? null, cardTags: null } },
    texts: { [text.id]: { content: source.texts![0]!.versionId, pose: source.texts![0]!.item.versionId } },
    shapes: {}, images: {}, strokes: {}, connectors: {}, anchors: {},
  }, payload: { objects: [{ kind: 'card', id: card.id, copyId: 'card-copy' }, { kind: 'text', id: text.id, copyId: 'text-copy' }], connectors: [] } });
  const copied = f.state();
  expect(copied.attachments).toHaveLength(1);
  expect(copied.attachments![0]!.id).toBe(source.texts![0]!.item.id);
  const scope = snapshotScope(copied, [copied.cards[0]!.item.id, copied.texts![0]!.item.id]);
  const itemIds = [...scope.ids].filter(id => copied.cards.some(value => value.item.id === id) || copied.texts!.some(value => value.item.id === id));
  f.run(captureCutCommand(copied, { commandId: randomUUID(), projectId: 'p', cutId: 'cut-note', itemIds, groupIds: [], frameIds: [] }) as unknown as Record<string, unknown>);
  expect(f.state().attachments).toEqual([]);
  f.run({ type: 'canvas.paste-cut', expected: { cut: 'cut-note', cutRevision: 0 }, payload: { cutId: 'cut-note', translation: { x: 0, y: 0 } } });
  expect(f.state().attachments).toHaveLength(1);
  expect(f.state().attachments![0]!.target?.itemId).toBe(card.item.id);
  expect(f.state().texts!.some(value => value.id === text.id && value.item.id === text.item.id)).toBe(true);
  assertNoOrphans(f.directory);
});

it('分区移动和组合缩放都只按卡片中心平移批注一次', () => {
  const f = fixture();
  const text = f.state().texts![0]!;
  const origin = f.state().cards[0]!;
  f.run({ type: 'pose.batch', expected: { [origin.id]: origin.item.versionId }, payload: { poses: [{ id: origin.id, x: 2000, y: 2000, width: origin.item.pose.width, height: origin.item.pose.height }] } });
  const card = f.state().cards[0]!;
  attach(f, text.item.id);
  f.run({ type: 'frame.create', expected: { frame: null, groups: {}, containment: { [card.item.id]: null }, poses: { [card.item.id]: card.item.versionId } }, payload: { id: 'frame', itemIds: [card.item.id], pose: { x: 1960, y: 1960, width: card.item.pose.width + 80, height: card.item.pose.height + 80 } } });
  const framed = f.state();
  const frame = framed.frames![0]!;
  const framedCard = framed.cards[0]!;
  const framedText = framed.texts![0]!;
  const followed = followersFor(f, framedCard.item.id, 15, 0);
  f.run({ type: 'frame.move', expected: { frame: frame.versionId, groups: {}, containment: Object.fromEntries(framed.containment!.map(value => [value.id, value.versionId])), poses: { [framedCard.item.id]: framedCard.item.versionId } }, ...followed, payload: { id: frame.id, dx: 15, dy: 0 } });
  expect(f.state().cards[0]!.item.pose.x).toBe(framedCard.item.pose.x + 15);
  expect(f.state().texts![0]!.item.pose).toMatchObject({ x: framedText.item.pose.x + 15, y: framedText.item.pose.y, width: framedText.item.pose.width, height: framedText.item.pose.height });
  f.run({ type: 'thought.create', expected: null, payload: { id: 'card-2', title: '缩放卡', text: '正文', x: 3000, y: 0 } });
  f.run({ type: 'text.create', expected: null, payload: { id: 'note-2', content: { runs: [{ text: '随缩放' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 80 }, pose: { x: 3040, y: 40, width: 80, height: 24 } } });
  attach(f, f.state().texts!.find(value => value.id === 'note-2')!.item.id, f.state().cards.find(value => value.id === 'card-2')!);
  const shape = f.state().shapes![0]!;
  const scalingCard = f.state().cards.find(value => value.id === 'card-2')!;
  f.run({ type: 'group.create', expected: { groups: { g: null }, containment: { [scalingCard.item.id]: null, [shape.item.id]: null } }, payload: { id: 'g', itemIds: [scalingCard.item.id, shape.item.id] } });
  const grouped = f.state();
  const group = grouped.groups![0]!;
  const memberCard = grouped.cards.find(value => value.id === 'card-2')!;
  const memberShape = grouped.shapes!.find(value => group.memberItemIds.includes(value.item.id))!;
  const left = Math.min(memberCard.item.pose.x, memberShape.item.pose.x);
  const top = Math.min(memberCard.item.pose.y, memberShape.item.pose.y);
  const anchor = { x: left, y: top };
  const p = memberCard.item.pose;
  const scale = 2;
  const dx = anchor.x + scale * (p.x - anchor.x) + p.width * scale / 2 - (p.x + p.width / 2);
  const dy = anchor.y + scale * (p.y - anchor.y) + p.height * scale / 2 - (p.y + p.height / 2);
  const note = grouped.texts!.find(value => value.id === 'note-2')!;
  f.run({ type: 'group.scale', expected: {
    groups: { [group.id]: group.versionId },
    containment: Object.fromEntries(grouped.containment!.filter(value => group.memberItemIds.includes(value.id) || value.id === group.itemId).map(value => [value.id, value.versionId])),
    items: {
      [memberCard.item.id]: { kind: 'card', thought: memberCard.versionId, body: memberCard.body.versionId, pose: memberCard.item.versionId, appearance: memberCard.appearance?.versionId ?? null, cardTags: memberCard.cardTags?.versionId ?? null },
      [memberShape.item.id]: { kind: 'shape', pose: memberShape.item.versionId },
    },
  }, followers: [{ kind: 'text', id: note.id, itemId: note.item.id, x: note.item.pose.x + dx, y: note.item.pose.y + dy }], expectedFollowers: { [note.item.id]: note.item.versionId }, payload: { groupIds: [group.id], directItemIds: [], anchorCorner: 'nw', scale, measurements: { cards: { [memberCard.item.id]: { forWidth: p.width * scale, necessaryHeight: 40 } }, texts: {} } } });
  const scaled = f.state();
  expect(scaled.texts!.find(value => value.id === 'note-2')!.item.pose).toMatchObject({ x: note.item.pose.x + dx, y: note.item.pose.y + dy, width: note.item.pose.width, height: note.item.pose.height });
  expect(scaled.cards.find(value => value.id === 'card-2')!.item.pose.width).toBe(p.width * scale);
  expect(scaled.attachments).toHaveLength(2);
});

it('相邻正文后的高度随动在撤销和重做时与卡片高度一起对齐', () => {
  const f = fixture();
  const text = f.state().texts![0]!;
  attach(f, text.item.id);
  const card = f.state().cards[0]!;
  const note = f.state().texts![0]!;
  f.run({ type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, text: '改过的正文' } });
  const edited = f.state().cards[0]!;
  const necessaryHeight = edited.item.pose.height + 40;
  f.run({ type: 'card.layout', expected: { thought: edited.versionId, body: edited.body.versionId, pose: edited.item.versionId, appearance: edited.appearance?.versionId ?? null }, ...followersFor(f, edited.item.id, 0, 20), payload: { id: edited.id, necessaryHeight } });
  const laid = f.state();
  expect(laid.texts![0]!.item.pose.y).toBe(note.item.pose.y + 20);
  f.run({ type: 'history.undo', expected: laid.project.revision, payload: {} });
  const undone = f.state();
  expect(undone.cards[0]!.item.pose.height).toBe(card.item.pose.height);
  expect(undone.texts![0]!.item.pose).toEqual(note.item.pose);
  f.run({ type: 'history.redo', expected: undone.project.revision, payload: {} });
  const redone = f.state();
  expect(redone.cards[0]!.item.pose.height).toBe(laid.cards[0]!.item.pose.height);
  expect(redone.texts![0]!.item.pose).toEqual(laid.texts![0]!.item.pose);
});

it('已附着批注移入分区范围后不会再获得分区归属', () => {
  const f = fixture();
  f.run({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 4000, y: 4000, width: 200, height: 200 } } });
  const text = f.state().texts![0]!;
  attach(f, text.item.id);
  const moved = f.state().texts![0]!;
  f.run({ type: 'canvas.move', expected: { [moved.item.id]: moved.item.versionId }, payload: { targets: [{ kind: 'text', id: moved.id, itemId: moved.item.id, x: 4040, y: 4060 }] } });
  expect(f.state().texts![0]!.item.pose).toMatchObject({ x: 4040, y: 4060 });
  expect(f.state().containment?.find(value => value.id === moved.item.id)?.parent ?? null).toBeNull();
  expect(f.state().attachments).toHaveLength(1);
});

it('已附着批注不能再放进组合', () => {
  const f = fixture();
  const text = f.state().texts![0]!;
  const shape = f.state().shapes![0]!;
  attach(f, text.item.id);
  const rejected = f.fail({ type: 'group.create', expected: { groups: { g: null }, containment: { [text.item.id]: null, [shape.item.id]: null } }, payload: { id: 'g', itemIds: [text.item.id, shape.item.id] } });
  expect(rejected).toMatchObject({ status: 400 });
  expect(f.state().groups ?? []).toEqual([]);
});
