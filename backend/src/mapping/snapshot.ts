import { endpointKey } from './connector-contracts.js';
import { endpointBounds } from './container-endpoints.js';
import { readGroups, readContainment, writeGroup, writeContainment } from './group.js';
import { readFrames } from './frame.js';
import { frameCandidate } from './frame-spatial.js';
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
import { readAsset, saveAsset } from './media.js';
import { readTags, saveTag } from './tags.js';
import type { Tag } from './contracts.js';
import { retainCardVersions } from './versions.js';
import { nextCreatedOrder } from './created-order.js';
import { bodyText } from './body-text.js';
import { groupOutcome } from './group-lifecycle.js';
import type { CanvasPasteCommand } from './snapshot-contracts.js';
import type { z } from 'zod';

type Paste = z.infer<typeof CanvasPasteCommand>;
export type SnapshotWrite = {
  cardLifecycleChanges: NonNullable<Change['cardLifecycleChanges']>;
  textChanges: NonNullable<Change['textChanges']>;
  shapeChanges: NonNullable<Change['shapeChanges']>;
  imageChanges: NonNullable<Change['imageChanges']>;
  strokeChanges: NonNullable<Change['strokeChanges']>;
  connectorChanges: NonNullable<Change['connectorChanges']>;
  groupChanges: NonNullable<Change['groupChanges']>;
  frameChanges: NonNullable<Change['frameChanges']>;
  containmentChanges: NonNullable<Change['containmentChanges']>;
  changedIds: string[];
  tagChanges?: Change['tagChanges'];
  assetChanges?: Change['assetChanges'];
};

function cards(db: Database.Database, projectId: string): Card[] {
  return (db.prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[])
    .map(row => JSON.parse(row.value) as Card);
}
function fresh(ids: string[]) {
  requireThat(new Set(ids).size === ids.length, 'INVALID_COMMAND', '同一次复制不能重复新身份', 400);
}
function claim(db: Database.Database, id: string) {
  const tables = ['mapping_card_ids', 'mapping_text_ids', 'mapping_shape_ids', 'mapping_image_ids', 'mapping_stroke_ids', 'mapping_connector_ids', 'mapping_group_ids', 'mapping_frame_ids'];
  requireThat(tables.every(table => !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)),
    'ID_CONFLICT', '身份已使用，请重新创建', 409);
}
function version(db: Database.Database, projectId: string, domain: string, id: string, versionId: string, value: unknown) {
  db.prepare('INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)')
    .run(projectId, domain, id, versionId, JSON.stringify(value));
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
function requireTags(db: Database.Database, projectId: string, cards: string[][]) {
  requireThat(cards.every(ids => new Set(ids).size === ids.length), 'INVALID_TAGS', '标签关联不能重复', 400);
  const tagIds = [...new Set(cards.flat())];
  const tags = readTags(db, projectId);
  requireThat(tagIds.every(id => tags.some(tag => tag.id === id && !tag.deleted)),
    'NOT_FOUND', '标签不存在于当前项目', 404);
}
function imageAssetIds(blocks: Block[]) {
  return blocks.flatMap(block => block.type === 'image' && typeof block.assetId === 'string' ? [block.assetId] : []);
}
export function readSnapshotScene(db: Database.Database, projectId: string) {
  const state = { cards: cards(db, projectId), texts: readTexts(db, projectId), shapes: readShapes(db, projectId), images: readImages(db, projectId),
    strokes: readStrokes(db, projectId), groups: readGroups(db, projectId), frames: readFrames(db, projectId), containment: readContainment(db, projectId) };
  return { state, values: [
    ...[...state.cards, ...state.texts, ...state.shapes, ...state.images].map(value => ({ pose: value.item.pose, versionId: value.item.versionId, key: `item:${value.item.id}` })),
    ...state.groups.map(group => ({ pose: endpointBounds(state, { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'top' })!, versionId: group.versionId, key: `group:${group.itemId}` })),
    ...state.frames.map(frame => ({ pose: frame.pose, versionId: frame.versionId, key: `frame:${frame.id}` })),
  ] };
}
function finish(changes: Omit<SnapshotWrite, 'changedIds' | 'tagChanges' | 'assetChanges'>): SnapshotWrite {
  return { ...changes, changedIds: groupOutcome(changes).changedIds };
}
function distinctEnds(start: ConnectorEndpoint, end: ConnectorEndpoint) {
  requireThat(start.kind !== 'bound' || end.kind !== 'bound' || endpointKey(start) !== endpointKey(end),
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

function adoptLibrary(db: Database.Database, projectId: string, payload: Paste['payload']) {
  const library = payload.library;
  const tagChanges: NonNullable<Change['tagChanges']> = [];
  const assetChanges: NonNullable<Change['assetChanges']> = [];
  if (!library) return { objects: payload.objects, tagChanges, assetChanges };
  const liveTags = readTags(db, projectId);
  const tagMap = new Map<string, string>();
  const referencedTagIds = [...new Set(payload.objects.flatMap(value => value.kind === 'card' && value.tagIds ? value.tagIds : []))];
  for (const id of referencedTagIds) {
    if (liveTags.some(tag => tag.id === id && !tag.deleted)) {
      tagMap.set(id, id);
      continue;
    }
    const entry = library.tags.find(tag => tag.id === id);
    if (!entry) continue;
    const same = liveTags.find(tag => !tag.deleted && tag.name.toLowerCase() === entry.name.toLowerCase());
    if (same) {
      tagMap.set(id, same.id);
      continue;
    }
    const created: Tag = { id: randomUUID(), name: entry.name, color: entry.color, deleted: false, versionId: randomUUID() };
    saveTag(db, projectId, created);
    liveTags.push(created);
    tagMap.set(id, created.id);
    tagChanges.push({ before: null, after: created });
  }
  const assetMap = new Map<string, string>();
  const referencedAssetIds = [...new Set([
    ...payload.objects.flatMap(value => value.kind === 'image' ? [value.content.assetId] : []),
    ...payload.objects.flatMap(value => value.kind === 'card' ? imageAssetIds(value.blocks as Block[]) : []),
  ])];
  for (const id of referencedAssetIds) {
    if (db.prepare('SELECT 1 FROM mapping_assets WHERE project_id=? AND id=?').get(projectId, id)) {
      assetMap.set(id, id);
      continue;
    }
    const entry = library.assets.find(asset => asset.id === id);
    if (!entry) continue;
    const nextId = randomUUID();
    saveAsset(db, { commandId: nextId, projectId, type: 'asset.save', expected: null, payload: { id: nextId, name: entry.name, mime: entry.mime, base64: entry.base64 } });
    assetMap.set(id, nextId);
    assetChanges.push({ before: null, after: readAsset(db, projectId, nextId) });
  }
  const objects = structuredClone(payload.objects);
  for (const value of objects) {
    if (value.kind === 'card') {
      if (value.tagIds) value.tagIds = value.tagIds.map(id => tagMap.get(id) ?? id);
      for (const block of value.blocks) {
        if (block.type === 'image' && typeof block.assetId === 'string' && assetMap.has(block.assetId)) block.assetId = assetMap.get(block.assetId);
      }
    } else if (value.kind === 'image') {
      const nextId = assetMap.get(value.content.assetId);
      if (nextId) value.content = { ...value.content, assetId: nextId };
    }
  }
  return { objects, tagChanges, assetChanges };
}

export function pasteCanvas(db: Database.Database, command: Paste): SnapshotWrite {
  const { projectId } = command;
  const adopted = adoptLibrary(db, projectId, command.payload);
  const payload = { ...command.payload, objects: adopted.objects };
  const { translation } = payload;
  const scene = readSnapshotScene(db, projectId).state;
  const copyIds = [...payload.objects.map(value => value.copyId), ...payload.connectors.map(value => value.copyId)];
  fresh(copyIds);
  for (const id of copyIds) claim(db, id);
  const tagIds = payload.objects.flatMap(value => value.kind === 'card' && value.tagIds ? [value.tagIds] : []);
  requireTags(db, projectId, tagIds);
  requireAssets(db, projectId, [
    ...payload.objects.flatMap(value => value.kind === 'image' ? [value.content.assetId] : []),
    ...payload.objects.flatMap(value => value.kind === 'card' ? imageAssetIds(value.blocks as Block[]) : []),
  ]);
  for (const value of payload.objects) if (value.kind === 'card')
    requireThat(bodyText({ blocks: value.blocks as Block[] }).length <= 200000, 'INVALID_COMMAND', '正文文字不能超过200000', 400);
  const ranked = payload.objects.filter(v => v.kind !== 'group' && v.kind !== 'frame').map((value, index) => ({ value, index }))
    .sort((a, b) => a.value.stack - b.value.stack || a.index - b.index);
  const created = orders(ranked.length, db, projectId);
  const itemIds = new Map<string, string>();
  const groupChanges: SnapshotWrite['groupChanges'] = [], frameChanges: SnapshotWrite['frameChanges'] = [], containmentChanges: SnapshotWrite['containmentChanges'] = [];
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
    } else if (value.kind === 'stroke') {
      const after: CanvasStroke = { id: value.copyId, kind: 'stroke', versionId: randomUUID(), content: structuredClone(value.content),
        item: { id: randomUUID(), versionId: randomUUID(), createdOrder, pose: shift(value.pose, translation.x, translation.y) } };
      itemIds.set(value.copyId, after.item.id);
      strokeChanges.push({ before: null, after });
    }
  });
  const groupOrders = orders(payload.objects.filter(v => v.kind === 'group').length, db, projectId);
  for (const value of payload.objects.filter(v => v.kind === 'group').sort((a, b) => a.stack - b.stack)) {
    const after = { id: value.copyId, itemId: randomUUID(), versionId: randomUUID(), createdOrder: groupOrders[groupChanges.length]! };
    itemIds.set(value.copyId, after.itemId); groupChanges.push({ before: null, after });
  }
  for (const value of payload.objects.filter(v => v.kind === 'frame').sort((a, b) => a.stack - b.stack)) {
    const after = { id: value.copyId, versionId: randomUUID(), name: value.name, background: value.background, pose: shift(value.pose, translation.x, translation.y) };
    itemIds.set(value.copyId, after.id); frameChanges.push({ before: null, after });
  }
  for (const edge of payload.containment ?? []) {
    const parent = payload.objects.find(v => v.copyId === edge.parentCopyId)!;
    containmentChanges.push({ before: null, after: { id: itemIds.get(edge.copyId)!, versionId: randomUUID(), parent: { kind: parent.kind as 'group' | 'frame', id: itemIds.get(edge.parentCopyId)! } } });
  }
  const roots = payload.roots ?? payload.objects.map(v => v.copyId);
  for (const id of roots) {
    const value = payload.objects.find(v => v.copyId === id)!;
    const candidate = frameCandidate(scene, { x: value.pose.x + translation.x + value.pose.width / 2, y: value.pose.y + translation.y + value.pose.height / 2 });
    if (candidate) containmentChanges.push({ before: null, after: { id: itemIds.get(id)!, versionId: randomUUID(), parent: { kind: 'frame', id: candidate.id } } });
  }
  const mapEnd = (end: Paste['payload']['connectors'][number]['start']): ConnectorEndpoint => {
    if (end.kind === 'bound') {
      const itemId = itemIds.get(end.copyId);
      requireThat(itemId, 'INVALID_ENDPOINT', '粘贴连线只能连接本次粘贴的对象', 400);
      return { kind: 'bound', itemId, side: end.side, ...(end.targetKind ? { targetKind: end.targetKind } : {}) };
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
  for (const change of groupChanges) writeGroup(db, projectId, change.after!);
  for (const change of frameChanges) {
    const frame = change.after!;
    db.prepare('INSERT INTO mapping_frame_ids VALUES(?,?)').run(frame.id, projectId);
    db.prepare('INSERT INTO mapping_frames VALUES(?,?,?)').run(frame.id, projectId, JSON.stringify(frame));
    version(db, projectId, 'frame', frame.id, frame.versionId, frame);
  }
  for (const change of containmentChanges) writeContainment(db, projectId, change.after!);
  for (const change of connectorChanges) insertConnector(db, projectId, change.after!);
  const written = finish({ cardLifecycleChanges, textChanges, shapeChanges, imageChanges, strokeChanges, connectorChanges, groupChanges, frameChanges, containmentChanges });
  return {
    ...written,
    ...(adopted.tagChanges.length ? { tagChanges: adopted.tagChanges } : {}),
    ...(adopted.assetChanges.length ? { assetChanges: adopted.assetChanges } : {}),
    changedIds: [...written.changedIds, ...adopted.tagChanges.map(change => change.after.id), ...adopted.assetChanges.map(change => change.after.id)],
  };
}
