import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { Change } from './contracts.js';
import type { GroupGeometryCommand } from './group-geometry-contracts.js';
import { selectionMembers } from './group.js';
import { writeGeometry } from './geometry.js';
import { writeText } from './text.js';
import { transformShape } from './shape.js';
import { transformImage, writeImagePose } from './image.js';

export function scaleGroup(db: Database.Database, command: Extract<GroupGeometryCommand, { type: 'group.scale' }>) {
  const { projectId, payload, expected, commandId } = command;
  const members = selectionMembers(db, projectId, payload, expected);
  requireThat(members.every(member => member.kind !== 'stroke'), 'UNSUPPORTED_GEOMETRY', '含笔迹的选择暂不支持整体缩放', 400);
  requireThat(Object.keys(expected.items).length === members.length && members.every(member => expected.items[member.value.item.id]?.kind === member.kind),
    'EXPECTED_DOMAINS', '须校验全部缩放成员的对应版本', 400);
  for (const kind of ['card', 'text'] as const) {
    const measurements = kind === 'card' ? payload.measurements.cards : payload.measurements.texts;
    const targets = members.filter(member => member.kind === kind);
    requireThat(Object.keys(measurements).length === targets.length && targets.every(member => Object.hasOwn(measurements, member.value.item.id)),
      'EXPECTED_DOMAINS', '须提供全部目标卡片及文字的测量且不可附带其他对象', 400);
  }
  const left = Math.min(...members.map(m => m.value.item.pose.x));
  const top = Math.min(...members.map(m => m.value.item.pose.y));
  const right = Math.max(...members.map(m => m.value.item.pose.x + m.value.item.pose.width));
  const bottom = Math.max(...members.map(m => m.value.item.pose.y + m.value.item.pose.height));
  const east = payload.anchorCorner.endsWith('e'), south = payload.anchorCorner.startsWith('s');
  const anchor = { x: east ? right : left, y: south ? bottom : top }, scale = payload.scale;
  const cardChanges: NonNullable<Change['cardChanges']> = [], textChanges: NonNullable<Change['textChanges']> = [];
  const shapeChanges: NonNullable<Change['shapeChanges']> = [], imageChanges: NonNullable<Change['imageChanges']> = [];
  for (const member of members) {
    const { item } = member.value, p = item.pose, e = expected.items[item.id]!;
    const pose = { x: scale === 1 ? p.x : anchor.x + scale * (p.x - anchor.x), y: scale === 1 ? p.y : anchor.y + scale * (p.y - anchor.y), width: p.width * scale, height: p.height * scale };
    requireThat(Object.values(pose).every(Number.isFinite) && pose.width > 0 && pose.height > 0,
      'INVALID_GEOMETRY', '缩放后的范围超出可表示尺寸', 400);
    if (member.kind === 'card' && e.kind === 'card') {
      requireThat(pose.width >= Math.min(p.width, 120), 'INVALID_GEOMETRY', '卡片宽度小于本次允许范围', 400);
      const measured = payload.measurements.cards[item.id]!;
      const result = writeGeometry(db, { commandId, projectId, type: 'pose.batch', expected: { [member.value.id]: e.pose },
        payload: { poses: [{ id: member.value.id, ...pose }] } }, { [member.value.id]: { expected: e, ...measured } });
      cardChanges.push(...result.cardChanges);
    } else if (member.kind === 'text' && e.kind === 'text') {
      const content = { ...member.value.content, fontSize: member.value.content.fontSize * scale, width: member.value.content.width * scale };
      requireThat(content.fontSize >= Math.min(member.value.content.fontSize, 1) && Number.isFinite(content.fontSize) && Number.isFinite(content.width),
        'INVALID_GEOMETRY', '文字字号小于本次允许范围或超出可表示尺寸', 400);
      const size = scale === 1 ? p : payload.measurements.texts[item.id]!;
      const q = { x: p.x + (east ? p.width : 0), y: p.y + (south ? p.height : 0) };
      const finalPose = scale === 1 ? member.value.item.pose : { x: anchor.x + scale * (q.x - anchor.x) - (east ? size.width : 0),
        y: anchor.y + scale * (q.y - anchor.y) - (south ? size.height : 0), width: size.width, height: size.height };
      const change = writeText(db, { commandId, projectId, type: 'text.transform', expected: { text: e.text, pose: e.pose }, payload: { id: member.value.id, content, pose: finalPose } });
      if (change) textChanges.push(change);
    } else if (member.kind === 'shape' && e.kind === 'shape') {
      const change = transformShape(db, { commandId, projectId, type: 'shape.transform', expected: e.pose, payload: { id: member.value.id, pose } });
      if (change) shapeChanges.push(change);
    } else if (member.kind === 'image' && e.kind === 'image') {
      requireThat(pose.width >= Math.min(p.width, 1) && pose.height >= Math.min(p.height, 1), 'INVALID_GEOMETRY', '图片尺寸小于本次允许范围', 400);
      const change = transformImage(db, { commandId, projectId, type: 'image.transform', expected: { image: e.image, pose: e.pose }, payload: { id: member.value.id, pose } });
      if (change) imageChanges.push(change);
    }
  }
  return { cardChanges, textChanges, shapeChanges, imageChanges, changedIds: [
    ...cardChanges.map(c => c.after.item.id),
    ...textChanges.flatMap(c => [...(c.before!.versionId !== c.after!.versionId ? [c.after!.id] : []), ...(c.before!.item.versionId !== c.after!.item.versionId ? [c.after!.item.id] : [])]),
    ...shapeChanges.map(c => c.after!.item.id), ...imageChanges.map(c => c.after!.item.id),
  ] };
}

export function rotateGroup(db: Database.Database, command: Extract<GroupGeometryCommand, { type: 'group.rotate90' }>) {
  const members = selectionMembers(db, command.projectId, command.payload, command.expected);
  requireThat(Object.keys(command.expected.items).length === members.length && members.every(m => command.expected.items[m.value.item.id]?.kind === m.kind),
    'EXPECTED_DOMAINS', '须校验全部旋转成员的对应版本', 400);
  requireThat(members.every(m => m.kind === 'image'), 'UNSUPPORTED_GEOMETRY', '仅全为图片的选择支持整体旋转', 400);
  const left = Math.min(...members.map(m => m.value.item.pose.x)), top = Math.min(...members.map(m => m.value.item.pose.y));
  const right = Math.max(...members.map(m => m.value.item.pose.x + m.value.item.pose.width));
  const bottom = Math.max(...members.map(m => m.value.item.pose.y + m.value.item.pose.height));
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 }, clockwise = command.payload.direction === 'right';
  const imageChanges: NonNullable<Change['imageChanges']> = [];
  for (const member of members) {
    if (member.kind !== 'image') continue;
    const value = member.value, expected = command.expected.items[value.item.id]!;
    requireThat(expected.kind === 'image' && expected.image === value.versionId && expected.pose === value.item.versionId,
      'VERSION_CONFLICT', '图片或布局已更新，请重新读取', 409);
    const p = value.item.pose, dx = p.x + p.width / 2 - center.x, dy = p.y + p.height / 2 - center.y;
    const pose = { x: center.x + (clockwise ? -dy : dy) - p.height / 2,
      y: center.y + (clockwise ? dx : -dx) - p.width / 2, width: p.height, height: p.width,
      rotation: ((p.rotation + (clockwise ? 90 : 270)) % 360) as typeof p.rotation };
    requireThat(Object.values(pose).every(Number.isFinite), 'INVALID_GEOMETRY', '旋转后的范围超出可表示尺寸', 400);
    const change = writeImagePose(db, command.projectId, value, pose);
    if (change) imageChanges.push(change);
  }
  return { imageChanges, changedIds: imageChanges.map(c => c.after!.item.id) };
}
