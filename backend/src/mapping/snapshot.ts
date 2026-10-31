import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Block, Card, Change } from './contracts.js';
import type { CanvasConnector, ConnectorEndpoint } from './connector-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';
import type { CanvasText } from './text-contracts.js';
import { readImages } from './image.js';
import { readShapes } from './shape.js';
import { readStrokes } from './stroke.js';
import { readTexts } from './text.js';
import { readConnectors } from './connector.js';
import { readAsset } from './media.js';
import { readTags } from './tags.js';
import { retainCardVersions } from './versions.js';
import { nextCreatedOrder } from './created-order.js';
import { bodyText } from './body-text.js';
import { groupOutcome } from './group-lifecycle.js';
import type { CanvasDuplicateCommand, CanvasPasteCommand } from './snapshot-contracts.js';
import type { z } from 'zod';

const OFFSET = 24;
type Duplicate = z.infer<typeof CanvasDuplicateCommand>;
type Paste = z.infer<typeof CanvasPasteCommand>;
type Pose = { x: number; y: number; width: number; height: number };
type Side = 'top' | 'right' | 'bottom' | 'left';
type Content = Card | CanvasText | CanvasShape | CanvasImage | CanvasStroke;
type SnapshotWrite = {
  cardLifecycleChanges: NonNullable<Change['cardLifecycleChanges']>;
  textChanges: NonNullable<Change['textChanges']>;
  shapeChanges: NonNullable<Change['shapeChanges']>;
  imageChanges: NonNullable<Change['imageChanges']>;
  strokeChanges: NonNullable<Change['strokeChanges']>;
  connectorChanges: NonNullable<Change['connectorChanges']>;
  changedIds: string[];
};

function cards(db: Database.Database, projectId: string): Card[] {
  return (db.prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[])
    .map(row => JSON.parse(row.value) as Card);
}
function exact(ids: string[], record: Record<string, unknown>) {
  const keys = Object.keys(record).sort(), wanted = [...ids].sort();
  requireThat(keys.length === wanted.length && keys.every((key, index) => key === wanted[index]),
    'EXPECTED_DOMAINS', '须校验本次复制的全部对象与连线版本', 400);
}
function fresh(ids: string[]) {
  requireThat(new Set(ids).size === ids.length, 'INVALID_COMMAND', '同一次复制不能重复新身份', 400);
}
function claim(db: Database.Database, id: string) {
  const tables = ['mapping_card_ids', 'mapping_text_ids', 'mapping_shape_ids', 'mapping_image_ids', 'mapping_stroke_ids', 'mapping_connector_ids', 'mapping_group_ids'];
  requireThat(tables.every(table => !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)),
    'ID_CONFLICT', '身份已使用，请重新创建', 409);
}
function version(db: Database.Database, projectId: string, domain: string, id: string, versionId: string, value: unknown) {
  db.prepare('INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)')
    .run(projectId, domain, id, versionId, JSON.stringify(value));
}
function sidePoint(pose: Pose, side: Side) {
  if (side === 'top') return { x: pose.x + pose.width / 2, y: pose.y };
  if (side === 'right') return { x: pose.x + pose.width, y: pose.y + pose.height / 2 };
  if (side === 'bottom') return { x: pose.x + pose.width / 2, y: pose.y + pose.height };
  return { x: pose.x, y: pose.y + pose.height / 2 };
}
function shift<T extends { x: number; y: number }>(point: T, dx: number, dy: number): T {
  return { ...point, x: point.x + dx, y: point.y + dy };
}
function remapBlocks(blocks: Block[]): Block[] {
  const ids = new Map(blocks.map(block => [block.id, randomUUID()]));
  return blocks.map(block => {
    const next: Block = { ...structuredClone(block), id: ids.get(block.id)! };
    if (typeof next.inlineId === 'string') next.inlineId = randomUUID();
    if (typeof next.parentId === 'string' && ids.has(next.parentId)) next.parentId = ids.get(next.parentId)!;
    if (typeof next.ticket === 'string') next.ticket = randomUUID();
    if (next.request && typeof next.request === 'object') {
      const request = next.request as Block;
      if (typeof request.ticket === 'string') next.request = { ...request, ticket: randomUUID() };
    }
    return next;
  });
}
function requireAssets(db: Database.Database, projectId: string, assetIds: string[]) {
  for (const id of new Set(assetIds)) readAsset(db, projectId, id);
}
function requireTags(db: Database.Database, projectId: string, tagIds: string[]) {
  requireThat(new Set(tagIds).size === tagIds.length, 'INVALID_TAGS', '标签关联不能重复', 400);
  const tags = readTags(db, projectId);
  requireThat(tagIds.every(id => tags.some(tag => tag.id === id && !tag.deleted)),
    'NOT_FOUND', '标签不存在于当前项目', 404);
}
function imageAssetIds(blocks: Block[]) {
  return blocks.flatMap(block => block.type === 'image' && typeof block.assetId === 'string' ? [block.assetId] : []);
}
function hosts(db: Database.Database, projectId: string) {
  return [
    ...cards(db, projectId).map(value => ({ pose: value.item.pose, versionId: value.item.versionId, itemId: value.item.id })),
    ...readTexts(db, projectId).map(value => ({ pose: value.item.pose, versionId: value.item.versionId, itemId: value.item.id })),
    ...readShapes(db, projectId).map(value => ({ pose: value.item.pose, versionId: value.item.versionId, itemId: value.item.id })),
    ...readImages(db, projectId).map(value => ({ pose: value.item.pose, versionId: value.item.versionId, itemId: value.item.id })),
  ];
}
function finish(changes: Omit<SnapshotWrite, 'changedIds'>): SnapshotWrite {
  return { ...changes, changedIds: groupOutcome(changes).changedIds };
}
function distinctEnds(start: ConnectorEndpoint, end: ConnectorEndpoint) {
  requireThat(start.kind !== 'bound' || end.kind !== 'bound' || start.itemId !== end.itemId,
    'INVALID_ENDPOINT', '普通连线不能将两端绑定到同一个对象', 400);
  requireThat(start.kind !== 'free' || end.kind !== 'free' || start.point.x !== end.point.x || start.point.y !== end.point.y,
    'INVALID_ENDPOINT', '普通连线不能创建零长度连线', 400);
}
function insertConnector(db: Database.Database, projectId: string, value: CanvasConnector) {
  db.prepare('INSERT INTO mapping_connector_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_connectors VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  version(db, projectId, 'connector', value.id, value.versionId, value);
}
function orders(count: number, db: Database.Database, projectId: string) {
  const revision = (db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number }).revision;
  const first = nextCreatedOrder(db, projectId, revision);
  return Array.from({ length: count }, (_, index) => first + index);
}

function copyCard(source: Card, copyId: string, pose: Pose, createdOrder: number): Card {
  const blocks = remapBlocks(source.body.blocks);
  const after: Card = {
    id: copyId,
    title: source.title,
    versionId: randomUUID(),
    body: { id: randomUUID(), versionId: randomUUID(), blocks },
    item: {
      id: randomUUID(), versionId: randomUUID(), createdOrder, pose,
      ...(source.item.heightPolicy ? { heightPolicy: structuredClone(source.item.heightPolicy) } : {}),
    },
  };
  if (source.appearance) after.appearance = {
    id: `appearance:${copyId}`, versionId: randomUUID(),
    titleColor: source.appearance.titleColor, showPreview: source.appearance.showPreview,
  };
  if (source.cardTags) after.cardTags = {
    id: `cardTags:${copyId}`, versionId: randomUUID(), tagIds: [...source.cardTags.tagIds],
  };
  return after;
}
function insertCard(db: Database.Database, projectId: string, card: Card) {
  db.prepare('INSERT INTO mapping_card_ids VALUES(?,?)').run(card.id, projectId);
  db.prepare('INSERT INTO mapping_cards VALUES(?,?,?)').run(card.id, projectId, JSON.stringify(card));
  retainCardVersions(db, projectId, card);
}
function insertText(db: Database.Database, projectId: string, value: CanvasText) {
  db.prepare('INSERT INTO mapping_text_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_texts VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  version(db, projectId, 'text', value.id, value.versionId, { id: value.id, content: value.content, versionId: value.versionId });
  version(db, projectId, 'pose', value.item.id, value.item.versionId, value.item);
}
function insertShape(db: Database.Database, projectId: string, value: CanvasShape) {
  db.prepare('INSERT INTO mapping_shape_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_shapes VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  version(db, projectId, 'shape', value.id, value.versionId, { id: value.id, versionId: value.versionId, content: value.content });
  version(db, projectId, 'pose', value.item.id, value.item.versionId, value.item);
}
function insertImage(db: Database.Database, projectId: string, value: CanvasImage) {
  db.prepare('INSERT INTO mapping_image_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_images VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  version(db, projectId, 'image', value.id, value.versionId, { id: value.id, versionId: value.versionId, content: value.content });
  version(db, projectId, 'pose', value.item.id, value.item.versionId, value.item);
}
function insertStroke(db: Database.Database, projectId: string, value: CanvasStroke) {
  db.prepare('INSERT INTO mapping_stroke_ids VALUES(?,?)').run(value.id, projectId);
  db.prepare('INSERT INTO mapping_strokes VALUES(?,?,?)').run(value.id, projectId, JSON.stringify(value));
  version(db, projectId, 'stroke', value.id, value.versionId, { id: value.id, versionId: value.versionId, content: value.content });
  version(db, projectId, 'pose', value.item.id, value.item.versionId, value.item);
}

export function duplicateCanvas(db: Database.Database, command: Duplicate): SnapshotWrite {
  const { projectId, expected, payload } = command;
  const objectIds = payload.objects.map(value => value.id);
  const copyIds = [...payload.objects.map(value => value.copyId), ...payload.connectors.map(value => value.copyId)];
  requireThat(new Set(objectIds).size === objectIds.length && new Set(payload.connectors.map(value => value.id)).size === payload.connectors.length,
    'INVALID_COMMAND', '同一次复制不能重复对象', 400);
  fresh(copyIds);
  const found = {
    card: new Map(cards(db, projectId).map(value => [value.id, value])),
    text: new Map(readTexts(db, projectId).map(value => [value.id, value])),
    shape: new Map(readShapes(db, projectId).map(value => [value.id, value])),
    image: new Map(readImages(db, projectId).map(value => [value.id, value])),
    stroke: new Map(readStrokes(db, projectId).map(value => [value.id, value])),
  };
  const selected = payload.objects.map(value => {
    const source = found[value.kind].get(value.id);
    requireThat(source, 'NOT_FOUND', '对象不存在于当前项目', 404);
    return { ...value, source: source! };
  });
  const selectedItems = new Set(selected.map(value => value.source.item.id));
  const lines = readConnectors(db, projectId);
  const included = lines.filter(line => {
    const inside = (end: ConnectorEndpoint) => end.kind === 'bound' && selectedItems.has(end.itemId);
    return payload.connectors.some(value => value.id === line.id) || (inside(line.start) && inside(line.end));
  });
  exact(selected.filter(value => value.kind === 'card').map(value => value.id), expected.cards);
  exact(selected.filter(value => value.kind === 'text').map(value => value.id), expected.texts);
  exact(selected.filter(value => value.kind === 'shape').map(value => value.id), expected.shapes);
  exact(selected.filter(value => value.kind === 'image').map(value => value.id), expected.images);
  exact(selected.filter(value => value.kind === 'stroke').map(value => value.id), expected.strokes);
  exact(included.map(line => line.id), expected.connectors);
  exact(included.map(line => line.id), Object.fromEntries(payload.connectors.map(value => [value.id, value.copyId])));
  for (const value of selected) {
    if (value.kind === 'card') {
      const card = value.source as Card, versions = expected.cards[card.id]!;
      requireThat(versions.thought === card.versionId && versions.body === card.body.versionId && versions.pose === card.item.versionId &&
        versions.appearance === (card.appearance?.versionId ?? null) && versions.cardTags === (card.cardTags?.versionId ?? null),
      'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
    } else {
      const source = value.source as Exclude<Content, Card>;
      const versions = expected[`${value.kind}s` as 'texts'][source.id]!;
      requireThat(versions.content === source.versionId && versions.pose === source.item.versionId,
        'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
    }
  }
  for (const line of included) requireThat(expected.connectors[line.id] === line.versionId, 'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
  const poses = hosts(db, projectId);
  const anchorIds = [...new Set(included.flatMap(line => [line.start, line.end].flatMap(end =>
    end.kind === 'bound' && !selectedItems.has(end.itemId) ? [end.itemId] : [])))];
  exact(anchorIds, expected.anchors);
  for (const itemId of anchorIds) {
    const host = poses.find(value => value.itemId === itemId);
    requireThat(host, 'NOT_FOUND', '连线端点不存在于当前项目', 404);
    requireThat(expected.anchors[itemId] === host!.versionId, 'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
  }
  for (const id of copyIds) claim(db, id);
  const tagIds = selected.flatMap(value => value.kind === 'card' ? ((value.source as Card).cardTags?.tagIds ?? []) : []);
  requireTags(db, projectId, tagIds);
  requireAssets(db, projectId, [
    ...selected.flatMap(value => value.kind === 'image' ? [(value.source as CanvasImage).content.assetId] : []),
    ...selected.flatMap(value => value.kind === 'card' ? imageAssetIds((value.source as Card).body.blocks) : []),
  ]);
  const ranked = [...selected].sort((a, b) => (a.source.item.createdOrder ?? 0) - (b.source.item.createdOrder ?? 0) || a.id.localeCompare(b.id));
  const created = orders(ranked.length, db, projectId);
  const copies = new Map<string, Content>();
  ranked.forEach((value, index) => {
    const pose = shift(value.source.item.pose, OFFSET, OFFSET);
    const createdOrder = created[index]!;
    if (value.kind === 'card') copies.set(value.source.item.id, copyCard(value.source as Card, value.copyId, pose, createdOrder));
    else if (value.kind === 'text') {
      const source = value.source as CanvasText;
      copies.set(source.item.id, { ...structuredClone(source), id: value.copyId, versionId: randomUUID(),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose } });
    } else if (value.kind === 'shape') {
      const source = value.source as CanvasShape;
      copies.set(source.item.id, { ...structuredClone(source), id: value.copyId, versionId: randomUUID(),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose } });
    } else if (value.kind === 'image') {
      const source = value.source as CanvasImage;
      copies.set(source.item.id, { ...structuredClone(source), id: value.copyId, versionId: randomUUID(),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(source.item.pose, OFFSET, OFFSET) } });
    } else {
      const source = value.source as CanvasStroke;
      copies.set(source.item.id, { ...structuredClone(source), id: value.copyId, versionId: randomUUID(),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose } });
    }
  });
  const mapEnd = (end: ConnectorEndpoint): ConnectorEndpoint => {
    if (end.kind === 'bound' && copies.has(end.itemId)) return { kind: 'bound', itemId: copies.get(end.itemId)!.item.id, side: end.side };
    if (end.kind === 'bound') {
      const host = poses.find(value => value.itemId === end.itemId)!;
      return { kind: 'free', point: shift(sidePoint(host.pose, end.side), OFFSET, OFFSET) };
    }
    return { kind: 'free', point: shift(end.point, OFFSET, OFFSET) };
  };
  const connectorCopies = included.map(line => {
    const copyId = payload.connectors.find(value => value.id === line.id)!.copyId;
    const after: CanvasConnector = {
      id: copyId, kind: 'connector', versionId: randomUUID(), path: line.path,
      start: mapEnd(line.start), end: mapEnd(line.end),
      ...(line.style ? { style: structuredClone(line.style) } : {}),
      ...(line.label !== undefined ? { label: line.label ? structuredClone(line.label) : null } : {}),
    };
    distinctEnds(after.start, after.end);
    return { before: null, after };
  });
  const cardLifecycleChanges = [...copies.values()].flatMap(value => 'body' in value ? [{ before: null, after: value }] : []);
  const textChanges = [...copies.values()].flatMap(value => !('body' in value) && value.kind === 'text' ? [{ before: null, after: value }] : []);
  const shapeChanges = [...copies.values()].flatMap(value => !('body' in value) && value.kind === 'shape' ? [{ before: null, after: value }] : []);
  const imageChanges = [...copies.values()].flatMap(value => !('body' in value) && value.kind === 'image' ? [{ before: null, after: value }] : []);
  const strokeChanges = [...copies.values()].flatMap(value => !('body' in value) && value.kind === 'stroke' ? [{ before: null, after: value }] : []);
  for (const change of cardLifecycleChanges) insertCard(db, projectId, change.after!);
  for (const change of textChanges) insertText(db, projectId, change.after!);
  for (const change of shapeChanges) insertShape(db, projectId, change.after!);
  for (const change of imageChanges) insertImage(db, projectId, change.after!);
  for (const change of strokeChanges) insertStroke(db, projectId, change.after!);
  for (const change of connectorCopies) insertConnector(db, projectId, change.after!);
  return finish({ cardLifecycleChanges, textChanges, shapeChanges, imageChanges, strokeChanges, connectorChanges: connectorCopies });
}

export function pasteCanvas(db: Database.Database, command: Paste): SnapshotWrite {
  const { projectId, payload } = command;
  const { translation } = payload;
  const copyIds = [...payload.objects.map(value => value.copyId), ...payload.connectors.map(value => value.copyId)];
  fresh(copyIds);
  for (const id of copyIds) claim(db, id);
  const tagIds = payload.objects.flatMap(value => value.kind === 'card' && value.tagIds ? value.tagIds : []);
  requireTags(db, projectId, tagIds);
  requireAssets(db, projectId, [
    ...payload.objects.flatMap(value => value.kind === 'image' ? [value.content.assetId] : []),
    ...payload.objects.flatMap(value => value.kind === 'card' ? imageAssetIds(value.blocks as Block[]) : []),
  ]);
  for (const value of payload.objects) if (value.kind === 'card')
    requireThat(bodyText({ blocks: value.blocks as Block[] }).length <= 200000, 'INVALID_COMMAND', '正文文字不能超过200000', 400);
  const ranked = payload.objects.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value.stack - b.value.stack || a.index - b.index);
  const created = orders(ranked.length, db, projectId);
  const itemIds = new Map<string, string>();
  const cardLifecycleChanges: SnapshotWrite['cardLifecycleChanges'] = [];
  const textChanges: SnapshotWrite['textChanges'] = [];
  const shapeChanges: SnapshotWrite['shapeChanges'] = [];
  const imageChanges: SnapshotWrite['imageChanges'] = [];
  const strokeChanges: SnapshotWrite['strokeChanges'] = [];
  ranked.forEach(({ value }, index) => {
    const createdOrder = created[index]!;
    if (value.kind === 'card') {
      const pose = shift(value.pose, translation.x, translation.y);
      const after: Card = {
        id: value.copyId, title: value.title, versionId: randomUUID(),
        body: { id: randomUUID(), versionId: randomUUID(), blocks: remapBlocks(value.blocks as Block[]) },
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose, ...(value.heightPolicy ? { heightPolicy: { manualHeight: value.heightPolicy.manualHeight, necessaryHeight: value.heightPolicy.necessaryHeight, ...(value.heightPolicy.previewFloor !== undefined ? { previewFloor: value.heightPolicy.previewFloor } : {}) } } : {}) },
      };
      if (value.appearance) after.appearance = { id: `appearance:${value.copyId}`, versionId: randomUUID(), ...value.appearance };
      if (value.tagIds) after.cardTags = { id: `cardTags:${value.copyId}`, versionId: randomUUID(), tagIds: [...value.tagIds] };
      itemIds.set(value.copyId, after.item.id);
      cardLifecycleChanges.push({ before: null, after });
    } else if (value.kind === 'text') {
      const after: CanvasText = { id: value.copyId, kind: 'text', versionId: randomUUID(), content: structuredClone(value.content),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(value.pose, translation.x, translation.y) } };
      itemIds.set(value.copyId, after.item.id);
      textChanges.push({ before: null, after });
    } else if (value.kind === 'shape') {
      const after: CanvasShape = { id: value.copyId, kind: 'shape', versionId: randomUUID(), content: structuredClone(value.content),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(value.pose, translation.x, translation.y) } };
      itemIds.set(value.copyId, after.item.id);
      shapeChanges.push({ before: null, after });
    } else if (value.kind === 'image') {
      const after: CanvasImage = { id: value.copyId, kind: 'image', versionId: randomUUID(), content: structuredClone(value.content),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(value.pose, translation.x, translation.y) } };
      itemIds.set(value.copyId, after.item.id);
      imageChanges.push({ before: null, after });
    } else {
      const after: CanvasStroke = { id: value.copyId, kind: 'stroke', versionId: randomUUID(), content: structuredClone(value.content),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(value.pose, translation.x, translation.y) } };
      itemIds.set(value.copyId, after.item.id);
      strokeChanges.push({ before: null, after });
    }
  });
  const mapEnd = (end: Paste['payload']['connectors'][number]['start']): ConnectorEndpoint => {
    if (end.kind === 'bound') {
      const itemId = itemIds.get(end.copyId);
      requireThat(itemId, 'INVALID_ENDPOINT', '粘贴连线只能连接本次粘贴的对象', 400);
      return { kind: 'bound', itemId, side: end.side };
    }
    return { kind: 'free', point: shift(end.point, translation.x, translation.y) };
  };
  const connectorChanges = payload.connectors.map(line => {
    const after: CanvasConnector = {
      id: line.copyId, kind: 'connector', versionId: randomUUID(), path: line.path,
      start: mapEnd(line.start), end: mapEnd(line.end),
      ...(line.style ? { style: structuredClone(line.style) } : {}),
      ...(line.label !== undefined ? { label: line.label ? structuredClone(line.label) : null } : {}),
    };
    distinctEnds(after.start, after.end);
    return { before: null, after };
  });
  for (const change of cardLifecycleChanges) insertCard(db, projectId, change.after!);
  for (const change of textChanges) insertText(db, projectId, change.after!);
  for (const change of shapeChanges) insertShape(db, projectId, change.after!);
  for (const change of imageChanges) insertImage(db, projectId, change.after!);
  for (const change of strokeChanges) insertStroke(db, projectId, change.after!);
  for (const change of connectorChanges) insertConnector(db, projectId, change.after!);
  return finish({ cardLifecycleChanges, textChanges, shapeChanges, imageChanges, strokeChanges, connectorChanges });
}
