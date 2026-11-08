import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Card, Change } from './contracts.js';
import type { CanvasCut, CanvasPasteCut, CutRecord, CutState, CutStateView } from './cut-contracts.js';
import { deleteSelection } from './selection-delete.js';
import { readGroupRecords, writeContainment, writeGroup, groupItems } from './group.js';
import { readFrames } from './frame.js';
import { readConnectors, saveConnector } from './connector.js';
import { endpointBounds } from './container-endpoints.js';
import { frameCandidate } from './frame-spatial.js';
import { groupOutcome } from './group-lifecycle.js';
import { readSnapshotScene } from './snapshot.js';
import { retainCardVersions } from './versions.js';
import type { GroupRecord } from './group-contracts.js';
import type { FrameRecord } from './frame-contracts.js';
import type { CanvasConnector, ConnectorEndpoint } from './connector-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';
import type { CanvasText } from './text-contracts.js';

type Restore = {
  cards: Card[];
  texts: CanvasText[];
  shapes: CanvasShape[];
  images: CanvasImage[];
  strokes: CanvasStroke[];
  groups: GroupRecord[];
  frames: FrameRecord[];
  connectors: CanvasConnector[];
  containment: NonNullable<Change['containmentChanges']>;
};
export type CutWrite = {
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
  cut: CutStateView;
};

export function initializeCuts(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_cuts(project_id TEXT NOT NULL REFERENCES mapping_projects(id),
    cut_id TEXT NOT NULL, version_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
    source_revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, cut_id));`);
}

function readCut(db: Database.Database, projectId: string, cutId: string): CutRecord | null {
  const row = db.prepare('SELECT cut_id AS cutId, version_id AS versionId, state, revision, source_revision AS sourceRevision, created_at AS createdAt FROM mapping_cuts WHERE project_id=? AND cut_id=?')
    .get(projectId, cutId) as Omit<CutRecord, 'projectId'> | undefined;
  return row ? { projectId, ...row } : null;
}
export function readCutState(db: Database.Database, projectId: string, cutId: string): CutStateView {
  const record = readCut(db, projectId, cutId);
  // 无法判定的资格不猜测：缺失时明确拒绝，由调用方保留当前画布。
  requireThat(record, 'CUT_NOT_FOUND', '剪切记录不存在，未粘贴任何内容', 404);
  return { cutId: record.cutId, state: record.state, revision: record.revision, sourceRevision: record.sourceRevision };
}
export function recordCut(db: Database.Database, projectId: string, cutId: string, sourceRevision: number): CutStateView {
  requireThat(!readCut(db, projectId, cutId), 'ID_CONFLICT', '剪切编号已使用，请重新发起剪切', 409);
  db.prepare('INSERT INTO mapping_cuts VALUES(?,?,?,?,?,?,?)')
    .run(projectId, cutId, randomUUID(), 'eligible', 0, sourceRevision, new Date().toISOString());
  return { cutId, state: 'eligible', revision: 0, sourceRevision };
}
function advanceCut(db: Database.Database, projectId: string, cutId: string, state: CutState): CutStateView {
  const record = readCut(db, projectId, cutId);
  requireThat(record, 'CUT_NOT_FOUND', '剪切记录不可用，已保留当前画布', 409);
  db.prepare('UPDATE mapping_cuts SET version_id=?, state=?, revision=? WHERE project_id=? AND cut_id=?')
    .run(randomUUID(), state, record.revision + 1, projectId, cutId);
  return { cutId, state, revision: record.revision + 1, sourceRevision: record.sourceRevision };
}

// 撤销/重做必须同时恢复对象与资格：撤销剪切回到 cut-undone，撤销首次搬动回到 eligible。
export function travelCutState(db: Database.Database, projectId: string, cutId: string, label: string, type: 'history.undo' | 'history.redo') {
  const record = readCut(db, projectId, cutId);
  requireThat(record, 'CUT_NOT_FOUND', '剪切记录不可用，历史未写入', 409);
  const next: CutState = label === 'canvas.cut'
    ? (type === 'history.undo' ? 'cut-undone' : 'eligible')
    : (type === 'history.undo' ? 'eligible' : 'consumed');
  if (record.state !== next) advanceCut(db, projectId, cutId, next);
}

// 删除只移除对象行，身份行按既有约定保留；首次搬动沿用原身份，因此先核归属再写对象行。
const RESTORE_TABLES = {
  card: ['mapping_card_ids', 'mapping_cards'],
  text: ['mapping_text_ids', 'mapping_texts'],
  shape: ['mapping_shape_ids', 'mapping_shapes'],
  image: ['mapping_image_ids', 'mapping_images'],
  stroke: ['mapping_stroke_ids', 'mapping_strokes'],
  group: ['mapping_group_ids', 'mapping_groups'],
  frame: ['mapping_frame_ids', 'mapping_frames'],
  connector: ['mapping_connector_ids', 'mapping_connectors'],
} as const;
type RestoreKind = keyof typeof RESTORE_TABLES;
function claimRestore(db: Database.Database, projectId: string, kind: RestoreKind, id: string) {
  const [identities, rows] = RESTORE_TABLES[kind];
  const owned = db.prepare(`SELECT project_id AS projectId FROM ${identities} WHERE id=?`).get(id) as { projectId: string } | undefined;
  if (owned) requireThat(owned.projectId === projectId, 'ID_CONFLICT', '剪切内容身份属于其他项目，未粘贴任何内容', 409);
  else db.prepare(`INSERT INTO ${identities} VALUES(?,?)`).run(id, projectId);
  requireThat(!db.prepare(`SELECT 1 FROM ${rows} WHERE id=?`).get(id), 'ID_CONFLICT', '剪切内容身份已被重新占用，未粘贴任何内容', 409);
}
function writeVersion(db: Database.Database, projectId: string, domain: string, id: string, versionId: string, value: unknown) {
  db.prepare('INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)')
    .run(projectId, domain, id, versionId, JSON.stringify(value));
}
// 按冻结的外端 id 读当前版本。剪切时由调用方收集外端 id，粘贴时直接复用冻结 map 的 keys；
// 两处读的是同一组 id，避免各自的 scope 计算出现偏差时静默漏检并发修改。
function outerVersions(db: Database.Database, projectId: string, ids: Set<string>): Record<string, string> {
  if (!ids.size) return {};
  const items = groupItems(db, projectId), groups = readGroupRecords(db, projectId), frames = readFrames(db, projectId);
  const versions: Record<string, string> = {};
  for (const id of ids) {
    const item = items.find(value => value.value.item.id === id);
    if (item) { versions[id] = item.value.item.versionId; continue; }
    const group = groups.find(value => value.itemId === id);
    if (group) { versions[id] = group.versionId; continue; }
    const frame = frames.find(value => value.id === id);
    if (frame) versions[id] = frame.versionId;
  }
  return versions;
}
// 只取剪切实际移除的那部分：before 有值、after 为空。
function restorePlan(change: Change): Restore {
  return {
    cards: (change.cardLifecycleChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    texts: (change.textChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    shapes: (change.shapeChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    images: (change.imageChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    strokes: (change.strokeChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    groups: (change.groupChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    frames: (change.frameChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    connectors: (change.connectorChanges ?? []).flatMap(value => !value.after && value.before ? [value.before] : []),
    containment: (change.containmentChanges ?? []).filter(value => !value.after && value.before),
  };
}
function shift<T extends { x: number; y: number }>(point: T, dx: number, dy: number): T {
  return { ...point, x: point.x + dx, y: point.y + dy };
}
export function cutCanvas(db: Database.Database, command: CanvasCut): ReturnType<typeof deleteSelection> & { cutOuterVersions: Record<string, string> } {
  const { payload, expected } = command;
  // 冻结读必须在删除之前：删除后连线行已不在库里，外端版本也无从对齐。
  const scope = new Set([...Object.keys(expected.items), ...Object.keys(expected.containment), ...Object.keys(expected.frames ?? {})]);
  const outer = new Set<string>();
  for (const line of readConnectors(db, command.projectId)) {
    if (![line.start, line.end].some(end => end.kind === 'bound' && scope.has(end.itemId))) continue;
    for (const end of [line.start, line.end]) if (end.kind === 'bound' && !scope.has(end.itemId)) outer.add(end.itemId);
  }
  const cutOuterVersions = outerVersions(db, command.projectId, outer);
  // 剪切沿用删选的完整事实校验与原子性；差别只在提交成功后写一份可恢复的剪切记录。
  const removed = deleteSelection(db, {
    ...command,
    type: 'canvas.delete-selection',
    payload: {
      groupIds: payload.groupIds,
      directItemIds: payload.itemIds,
      ...(payload.frameIds?.length ? { frameIds: payload.frameIds } : {}),
    },
  } as Parameters<typeof deleteSelection>[1]);
  return { ...removed, cutOuterVersions };
}

export function pasteCut(db: Database.Database, command: CanvasPasteCut): CutWrite {
  const { projectId } = command;
  const { cutId, translation } = command.payload;
  requireThat(command.expected.cut === cutId, 'INVALID_COMMAND', '剪切编号与请求不一致', 400);
  const record = readCut(db, projectId, cutId);
  requireThat(record, 'CUT_NOT_FOUND', '剪切记录不存在，未粘贴任何内容', 404);
  requireThat(record.state === 'eligible', 'CUT_STATE_CONFLICT', '剪切内容已不再是首次搬动状态，请重新读取', 409);
  requireThat(record.revision === command.expected.cutRevision, 'CUT_STATE_CONFLICT', '剪切资格已变化，请重新读取', 409);
  const row = db.prepare('SELECT receipt FROM mapping_changes WHERE project_id=? AND revision=?')
    .get(projectId, record.sourceRevision) as { receipt: string } | undefined;
  const change = row ? (JSON.parse(row.receipt) as Change) : null;
  requireThat(change, 'CUT_RESTORE_MISSING', '剪切恢复资料不可用，未粘贴任何内容', 409);
  const frozen = change.cutOuterVersions;
  requireThat(frozen, 'CUT_OUTER_CHANGED', '剪切外线状态不可用，已保留当前画布，未粘贴任何内容', 409);
  const plan = restorePlan(change);
  const itemIds = new Set<string>([
    ...plan.cards.map(value => value.item.id),
    ...plan.texts.map(value => value.item.id),
    ...plan.shapes.map(value => value.item.id),
    ...plan.images.map(value => value.item.id),
    ...plan.strokes.map(value => value.item.id),
  ]);
  const containerIds = new Set<string>([...plan.groups.map(value => value.itemId), ...plan.frames.map(value => value.id)]);
  requireThat(itemIds.size + containerIds.size > 0, 'CUT_RESTORE_MISSING', '剪切恢复资料不含可搬动内容，未粘贴任何内容', 409);
  const scope = new Set([...itemIds, ...containerIds]);
  // 外端仍存在但版本已变（移动、增高、改写）属 AC5 的并发修改：整体拒绝并报告，不静默按当前几何恢复。
  // 外端已删除则交给 endAvailable 跳过该线，是 AC2 的既定行为，不判为竞争。
  const current = outerVersions(db, projectId, new Set(Object.keys(frozen)));
  for (const [id, version] of Object.entries(frozen))
    if (current[id] !== undefined)
      requireThat(current[id] === version, 'CUT_OUTER_CHANGED', '剪切后外部连线端点已变化，已保留当前画布，未粘贴任何内容', 409);
  const parentOf = new Map(plan.containment.map(value => [value.before!.id, value.before!.parent]));
  const roots = [...scope].filter(id => {
    const parent = parentOf.get(id);
    return !parent || !scope.has(parent.id);
  });
  // 身份表登记的是对象 id（卡片/文字/形状/图片/笔迹），不是 CanvasItem id。
  for (const card of plan.cards) claimRestore(db, projectId, 'card', card.id);
  for (const text of plan.texts) claimRestore(db, projectId, 'text', text.id);
  for (const shape of plan.shapes) claimRestore(db, projectId, 'shape', shape.id);
  for (const image of plan.images) claimRestore(db, projectId, 'image', image.id);
  for (const stroke of plan.strokes) claimRestore(db, projectId, 'stroke', stroke.id);
  for (const group of plan.groups) claimRestore(db, projectId, 'group', group.id);
  for (const frame of plan.frames) claimRestore(db, projectId, 'frame', frame.id);

  const { x: dx, y: dy } = translation;
  const groupChanges: CutWrite['groupChanges'] = [];
  const frameChanges: CutWrite['frameChanges'] = [];
  const containmentChanges: CutWrite['containmentChanges'] = [];
  const cardLifecycleChanges: CutWrite['cardLifecycleChanges'] = [];
  const textChanges: CutWrite['textChanges'] = [];
  const shapeChanges: CutWrite['shapeChanges'] = [];
  const imageChanges: CutWrite['imageChanges'] = [];
  const strokeChanges: CutWrite['strokeChanges'] = [];
  const connectorChanges: CutWrite['connectorChanges'] = [];
  for (const group of plan.groups) {
    const after = { ...structuredClone(group), versionId: randomUUID() };
    writeGroup(db, projectId, after);
    groupChanges.push({ before: null, after });
  }
  for (const frame of plan.frames) {
    const after = { ...structuredClone(frame), versionId: randomUUID(), pose: shift(frame.pose, dx, dy) };
    db.prepare('INSERT INTO mapping_frames VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    writeVersion(db, projectId, 'frame', after.id, after.versionId, after);
    frameChanges.push({ before: null, after });
  }
  for (const card of plan.cards) {
    const after: Card = {
      ...structuredClone(card),
      versionId: randomUUID(),
      body: { ...structuredClone(card.body), versionId: randomUUID() },
      item: { ...structuredClone(card.item), versionId: randomUUID(), pose: shift(card.item.pose, dx, dy) },
    };
    if (card.appearance) after.appearance = { ...structuredClone(card.appearance), versionId: randomUUID() };
    if (card.cardTags) after.cardTags = { ...structuredClone(card.cardTags), versionId: randomUUID() };
    db.prepare('INSERT INTO mapping_cards VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    retainCardVersions(db, projectId, after);
    cardLifecycleChanges.push({ before: null, after });
  }
  for (const text of plan.texts) {
    const after: CanvasText = { ...structuredClone(text), versionId: randomUUID(),
      item: { ...structuredClone(text.item), versionId: randomUUID(), pose: shift(text.item.pose, dx, dy) } };
    db.prepare('INSERT INTO mapping_texts VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    writeVersion(db, projectId, 'text', after.id, after.versionId, { id: after.id, content: after.content, versionId: after.versionId });
    writeVersion(db, projectId, 'pose', after.item.id, after.item.versionId, after.item);
    textChanges.push({ before: null, after });
  }
  for (const shape of plan.shapes) {
    const after: CanvasShape = { ...structuredClone(shape), versionId: randomUUID(),
      item: { ...structuredClone(shape.item), versionId: randomUUID(), pose: shift(shape.item.pose, dx, dy) } };
    db.prepare('INSERT INTO mapping_shapes VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    writeVersion(db, projectId, 'shape', after.id, after.versionId, { id: after.id, versionId: after.versionId, content: after.content });
    writeVersion(db, projectId, 'pose', after.item.id, after.item.versionId, after.item);
    shapeChanges.push({ before: null, after });
  }
  for (const image of plan.images) {
    const after: CanvasImage = { ...structuredClone(image), versionId: randomUUID(),
      item: { ...structuredClone(image.item), versionId: randomUUID(), pose: shift(image.item.pose, dx, dy) } };
    db.prepare('INSERT INTO mapping_images VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    writeVersion(db, projectId, 'image', after.id, after.versionId, { id: after.id, versionId: after.versionId, content: after.content });
    writeVersion(db, projectId, 'pose', after.item.id, after.item.versionId, after.item);
    imageChanges.push({ before: null, after });
  }
  for (const stroke of plan.strokes) {
    const after: CanvasStroke = { ...structuredClone(stroke), versionId: randomUUID(),
      item: { ...structuredClone(stroke.item), versionId: randomUUID(), pose: shift(stroke.item.pose, dx, dy) } };
    db.prepare('INSERT INTO mapping_strokes VALUES(?,?,?)').run(after.id, projectId, JSON.stringify(after));
    writeVersion(db, projectId, 'stroke', after.id, after.versionId, { id: after.id, versionId: after.versionId, content: after.content });
    writeVersion(db, projectId, 'pose', after.item.id, after.item.versionId, after.item);
    strokeChanges.push({ before: null, after });
  }
  // 首次搬动只恢复实际搬运范围：子树内部归属按原样恢复，未选父组与分区不复活。
  for (const row of plan.containment) {
    const before = row.before!;
    if (!before.parent || !scope.has(before.id) || !scope.has(before.parent.id)) continue;
    const after = { id: before.id, parent: { ...before.parent }, versionId: randomUUID() };
    writeContainment(db, projectId, after);
    containmentChanges.push({ before: null, after });
  }
  const scene = readSnapshotScene(db, projectId).state;
  const boundsOf = (id: string) => endpointBounds(scene, {
    kind: 'bound', itemId: id, side: 'top',
    ...(plan.groups.some(value => value.itemId === id) ? { targetKind: 'group' as const } : plan.frames.some(value => value.id === id) ? { targetKind: 'frame' as const } : {}),
  });
  for (const id of roots) {
    const pose = boundsOf(id);
    if (!pose) continue;
    // 恢复的分区不能落进自己或自己的子分区；成员归属已在上面按原样恢复。
    const candidate = frameCandidate(scene, { x: pose.x + pose.width / 2, y: pose.y + pose.height / 2 }, [id]);
    if (!candidate) continue;
    const after = { id, parent: { kind: 'frame' as const, id: candidate.id }, versionId: randomUUID() };
    writeContainment(db, projectId, after);
    containmentChanges.push({ before: null, after });
  }
  // 外线只在另一端仍存在时恢复；另一端已删除时跳过，不复活也不生成悬空线。
  const presentItems = new Set(groupItems(db, projectId).map(value => value.value.item.id));
  const presentGroups = new Set(readGroupRecords(db, projectId).map(value => value.itemId));
  const presentFrames = new Set(readFrames(db, projectId).map(value => value.id));
  const endAvailable = (end: ConnectorEndpoint) => end.kind !== 'bound' ||
    (end.targetKind === 'group' ? presentGroups.has(end.itemId)
      : end.targetKind === 'frame' ? presentFrames.has(end.itemId) : presentItems.has(end.itemId));
  for (const line of plan.connectors) {
    if (!endAvailable(line.start) || !endAvailable(line.end)) continue;
    claimRestore(db, projectId, 'connector', line.id);
    const after: CanvasConnector = { ...structuredClone(line), versionId: randomUUID() };
    saveConnector(db, projectId, after);
    connectorChanges.push({ before: null, after });
  }
  const written = { cardLifecycleChanges, textChanges, shapeChanges, imageChanges, strokeChanges,
    connectorChanges, groupChanges, frameChanges, containmentChanges };
  return {
    ...written,
    changedIds: groupOutcome(written).changedIds,
    cut: advanceCut(db, projectId, cutId, 'consumed'),
  };
}
