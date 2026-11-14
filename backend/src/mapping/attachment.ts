import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Card } from './contracts.js';
import type { Attachment, AttachmentChange, AttachmentCommand, FollowerPose } from './attachment-contracts.js';
import { readTexts, writeText } from './text.js';
import { readShapes, moveShape } from './shape.js';
import { readImages, writeImagePose } from './image.js';
import { readStrokes, moveStroke } from './stroke.js';
import type { Containment } from './group-contracts.js';
import type { CanvasText } from './text-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';

export function initializeAttachments(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_attachments(project_id TEXT NOT NULL REFERENCES mapping_projects(id), item_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id,item_id));`);
}

export function readAttachments(db: Database.Database, projectId: string): Attachment[] {
  return (db.prepare('SELECT value FROM mapping_attachments WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[]).map(row => JSON.parse(row.value) as Attachment);
}

export function writeAttachment(db: Database.Database, projectId: string, value: Attachment) {
  requireThat(value.target, 'INVALID_COMMAND', '附着目标不能为空', 400);
  db.prepare('INSERT INTO mapping_attachments VALUES(?,?,?) ON CONFLICT(project_id,item_id) DO UPDATE SET value=excluded.value').run(projectId, value.id, JSON.stringify(value));
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)').run(projectId, 'attachment', value.id, value.versionId, JSON.stringify(value));
}

function deleteAttachment(db: Database.Database, projectId: string, itemId: string) {
  db.prepare('DELETE FROM mapping_attachments WHERE project_id=? AND item_id=?').run(projectId, itemId);
}

type AnnotationKind = 'text' | 'shape' | 'image' | 'stroke';
type Annotation = { kind: AnnotationKind; value: CanvasText | CanvasShape | CanvasImage | CanvasStroke };

function readAnnotation(db: Database.Database, projectId: string, itemId: string): Annotation | null {
  const text = readTexts(db, projectId).find(value => value.item.id === itemId);
  if (text) return { kind: 'text', value: text };
  const shape = readShapes(db, projectId).find(value => value.item.id === itemId);
  if (shape) return { kind: 'shape', value: shape };
  const image = readImages(db, projectId).find(value => value.item.id === itemId);
  if (image) return { kind: 'image', value: image };
  const stroke = readStrokes(db, projectId).find(value => value.item.id === itemId);
  if (stroke) return { kind: 'stroke', value: stroke };
  return null;
}

function cardByItem(db: Database.Database, projectId: string, itemId: string) {
  const cards = (db.prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[]).map(row => JSON.parse(row.value) as Card);
  return cards.find(card => card.item.id === itemId) ?? null;
}

export function attachAnnotation(db: Database.Database, command: Extract<AttachmentCommand, { type: 'attachment.attach' }>) {
  const { projectId, payload, expected } = command;
  const annotation = readAnnotation(db, projectId, payload.itemId);
  requireThat(annotation, 'INVALID_COMMAND', '只有绘图内容可以附着', 400);
  const card = cardByItem(db, projectId, payload.targetItemId);
  requireThat(card, 'INVALID_COMMAND', '附着目标只支持卡片', 400);
  requireThat(expected.target.itemId === payload.targetItemId, 'INVALID_COMMAND', '附着目标与预期不一致', 400);
  const membership = (db.prepare('SELECT value FROM mapping_containment WHERE project_id=? ORDER BY rowid').all(projectId) as { value: string }[])
    .map(row => JSON.parse(row.value) as Containment).find(value => value.id === payload.itemId) ?? null;
  requireThat(expected.containment === (membership?.versionId ?? null), 'VERSION_CONFLICT', '批注归属已更新，请重新读取', 409);
  requireThat(!membership?.parent, 'INVALID_COMMAND', '该批注在框架或组合内，需先移出', 400);
  const current = readAttachments(db, projectId).find(value => value.id === payload.itemId) ?? null;
  requireThat(expected.attachment === (current?.versionId ?? null), 'VERSION_CONFLICT', '附着已更新，请重新读取', 409);
  requireThat(card.item.versionId === expected.target.versionId, 'VERSION_CONFLICT', '附着目标已更新，请重新读取', 409);
  const after: Attachment = { id: payload.itemId, versionId: randomUUID(), target: { itemId: payload.targetItemId } };
  writeAttachment(db, projectId, after);
  return { attachmentChanges: [{ before: current, after }] as AttachmentChange[], changedIds: [payload.itemId] };
}

export function detachAnnotation(db: Database.Database, command: Extract<AttachmentCommand, { type: 'attachment.detach' }>) {
  const { projectId, payload, expected } = command;
  const current = readAttachments(db, projectId).find(value => value.id === payload.itemId) ?? null;
  requireThat(current?.target, 'NOT_FOUND', '批注尚未附着', 404);
  requireThat(expected.attachment === current.versionId, 'VERSION_CONFLICT', '附着已更新，请重新读取', 409);
  requireThat(expected.target.itemId === current.target.itemId, 'VERSION_CONFLICT', '附着目标已更新，请重新读取', 409);
  const card = cardByItem(db, projectId, current.target.itemId);
  requireThat(card && card.item.versionId === expected.target.versionId, 'VERSION_CONFLICT', '附着目标已更新，请重新读取', 409);
  deleteAttachment(db, projectId, current.id);
  return { attachmentChanges: [{ before: current, after: null }] as AttachmentChange[], changedIds: [payload.itemId] };
}

export function rejectAttachedPoseMove(db: Database.Database, projectId: string, cardItemId: string) {
  requireThat(!readAttachments(db, projectId).some(value => value.target?.itemId === cardItemId), 'ATTACHMENT_NOT_MOVED', '有附着的卡片须改用 pose.batch', 400);
}

export function rejectAttachedMembers(db: Database.Database, projectId: string, itemIds: Iterable<string>) {
  const attached = new Set(readAttachments(db, projectId).map(value => value.id));
  for (const id of itemIds) requireThat(!attached.has(id), 'INVALID_COMMAND', '该批注已附着，需先解除附着', 400);
}

export interface CardMotion { itemId: string; dx: number; dy: number }

export interface MovingMember { kind: AnnotationKind | 'card'; value: { item: { id: string } } }

// 整体平移的成员集合：卡片进 motions，其余进 moving（不能再作为随动）。
export function followMemberMotions(
  db: Database.Database,
  projectId: string,
  commandId: string,
  members: readonly MovingMember[],
  dx: number,
  dy: number,
  followers: readonly FollowerPose[] | undefined,
  expectedFollowers: Record<string, string> | undefined,
) {
  const still = dx === 0 && dy === 0;
  const motions = still ? [] : members.flatMap(member => member.kind === 'card' ? [{ itemId: member.value.item.id, dx, dy }] : []);
  const moving = new Map(still ? [] : members.flatMap(member => member.kind === 'card' ? [] : [[member.value.item.id, { dx, dy }] as const]));
  return followCardMotions(db, projectId, commandId, motions, moving, followers, expectedFollowers);
}

export function followCardMotions(
  db: Database.Database,
  projectId: string,
  commandId: string,
  motions: readonly CardMotion[],
  moving: ReadonlyMap<string, { dx: number; dy: number }>,
  followers: readonly FollowerPose[] | undefined,
  expectedFollowers: Record<string, string> | undefined,
) {
  requireThat((followers === undefined) === (expectedFollowers === undefined), 'ATTACHMENT_NOT_MOVED', '随动批注须同时给出 followers 与 expectedFollowers', 400);
  const list = followers ?? [];
  const expected = expectedFollowers ?? {};
  requireThat(new Set(list.map(value => value.itemId)).size === list.length, 'INVALID_COMMAND', '同一随动不可重复批注', 400);
  requireThat(Object.keys(expected).length === list.length && list.every(value => Object.hasOwn(expected, value.itemId)), 'ATTACHMENT_NOT_MOVED', 'expectedFollowers 须恰好覆盖随动批注', 400);
  const changed = new Map(motions.filter(value => value.dx !== 0 || value.dy !== 0).map(value => [value.itemId, value]));
  for (const follower of list) requireThat(!moving.has(follower.itemId), 'INVALID_COMMAND', '同一批注不可既作为移动目标又作为随动', 400);
  const attachments = readAttachments(db, projectId);
  const required = attachments.filter(value => value.target && changed.has(value.target.itemId) && !moving.has(value.id));
  const requiredIds = new Set(required.map(value => value.id));
  const given = new Set(list.map(value => value.itemId));
  const missing = [...requiredIds].filter(id => !given.has(id));
  const extra = [...given].filter(id => !requiredIds.has(id));
  requireThat(missing.length === 0 && extra.length === 0, 'ATTACHMENT_NOT_MOVED', missing.length ? `随动批注未移动：${missing.join(',')}` : `随动批注超出本次范围：${extra.join(',')}`, 400);
  for (const row of attachments) {
    if (!row.target || !moving.has(row.id) || !changed.has(row.target.itemId)) continue;
    const motion = changed.get(row.target.itemId)!;
    const delta = moving.get(row.id)!;
    requireThat(delta.dx === motion.dx && delta.dy === motion.dy, 'INVALID_COMMAND', '已选批注的位移须等于目标卡片中心位移', 400);
  }
  const textChanges: { before: CanvasText; after: CanvasText }[] = [];
  const shapeChanges: { before: CanvasShape; after: CanvasShape }[] = [];
  const imageChanges: { before: CanvasImage; after: CanvasImage }[] = [];
  const strokeChanges: { before: CanvasStroke; after: CanvasStroke }[] = [];
  for (const follower of list) {
    const row = required.find(value => value.id === follower.itemId)!;
    const annotation = readAnnotation(db, projectId, follower.itemId);
    requireThat(annotation && annotation.kind === follower.kind && annotation.value.id === follower.id, 'INVALID_COMMAND', '随动批注与当前对象不一致', 400);
    requireThat(expected[follower.itemId] === annotation.value.item.versionId, 'VERSION_CONFLICT', '批注布局已更新，请重新读取', 409);
    const motion = changed.get(row.target!.itemId)!;
    const pose = annotation.value.item.pose;
    requireThat(follower.x === pose.x + motion.dx && follower.y === pose.y + motion.dy, 'INVALID_COMMAND', '随动批注位移须等于目标卡片中心位移', 400);
    if (annotation.kind === 'text') {
      const change = writeText(db, { commandId, projectId, type: 'text.move', expected: annotation.value.item.versionId, payload: { id: annotation.value.id, x: follower.x, y: follower.y } });
      if (change?.before && change.after) textChanges.push({ before: change.before, after: change.after });
    } else if (annotation.kind === 'shape') {
      const change = moveShape(db, { commandId, projectId, type: 'shape.move', expected: annotation.value.item.versionId, payload: { id: annotation.value.id, x: follower.x, y: follower.y } });
      if (change?.before && change.after) shapeChanges.push({ before: change.before, after: change.after });
    } else if (annotation.kind === 'image') {
      const image = annotation.value as CanvasImage;
      const change = writeImagePose(db, projectId, image, { ...image.item.pose, x: follower.x, y: follower.y });
      if (change?.before && change.after) imageChanges.push({ before: change.before, after: change.after });
    } else {
      const stroke = annotation.value as CanvasStroke;
      if (stroke.item.pose.x !== follower.x || stroke.item.pose.y !== follower.y) {
        const change = moveStroke(db, projectId, stroke, { x: follower.x, y: follower.y });
        if (change.before && change.after) strokeChanges.push({ before: change.before, after: change.after });
      }
    }
  }
  const changedIds = [...textChanges, ...shapeChanges, ...imageChanges, ...strokeChanges].map(change => change.after.item.id);
  return { textChanges, shapeChanges, imageChanges, strokeChanges, changedIds };
}

export function releaseAttachments(db: Database.Database, projectId: string, removedItemIds: ReadonlySet<string>): AttachmentChange[] {
  const changes: AttachmentChange[] = [];
  for (const row of readAttachments(db, projectId)) {
    if (removedItemIds.has(row.id) || (row.target && removedItemIds.has(row.target.itemId))) {
      deleteAttachment(db, projectId, row.id);
      changes.push({ before: row, after: null });
    }
  }
  return changes;
}

export function restoreAttachments(db: Database.Database, projectId: string, changes: readonly AttachmentChange[], type: 'history.undo' | 'history.redo'): AttachmentChange[] {
  return changes.map(change => {
    const desired = type === 'history.undo' ? change.before : change.after;
    const identity = change.after ?? change.before!;
    const current = readAttachments(db, projectId).find(value => value.id === identity.id) ?? null;
    if (desired?.target) {
      const after: Attachment = { ...desired, versionId: randomUUID() };
      writeAttachment(db, projectId, after);
      return { before: current, after };
    }
    if (current) deleteAttachment(db, projectId, identity.id);
    return { before: current, after: null };
  });
}

export function restorePastedAttachments(db: Database.Database, projectId: string, changes: readonly AttachmentChange[] | undefined, restoredItemIds: ReadonlySet<string>, restoredCardItemIds: ReadonlySet<string>): AttachmentChange[] {
  if (!changes?.length) return [];
  const written: AttachmentChange[] = [];
  const present = readAttachments(db, projectId);
  for (const change of changes) {
    const before = change.before;
    if (!before?.target || change.after) continue;
    const annotationPresent = restoredItemIds.has(before.id) || readAnnotation(db, projectId, before.id) !== null;
    const targetPresent = restoredCardItemIds.has(before.target.itemId) || cardByItem(db, projectId, before.target.itemId) !== null;
    if (!annotationPresent || !targetPresent || present.some(value => value.id === before.id) || written.some(value => value.after?.id === before.id)) continue;
    const after: Attachment = { id: before.id, versionId: randomUUID(), target: { itemId: before.target.itemId } };
    writeAttachment(db, projectId, after);
    written.push({ before: null, after });
  }
  return written;
}
