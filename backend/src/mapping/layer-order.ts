import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Card, Command } from './contracts.js';
import type { CanvasText } from './text-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';
import { readTexts } from './text.js';
import { readShapes } from './shape.js';
import { readImages } from './image.js';
import { readStrokes } from './stroke.js';
import { retainCardVersions } from './versions.js';
import { nextLayerOrder } from './layer-algorithm.js';

type StackValue = Card | CanvasText | CanvasShape | CanvasImage | CanvasStroke;
type Pose = { x: number; y: number; width: number; height: number };

function readStack(db: Database.Database, projectId: string): StackValue[] {
  const cards = (
    db
      .prepare(
        'SELECT c.value FROM mapping_cards c JOIN mapping_card_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
      )
      .all(projectId) as { value: string }[]
  ).map(row => JSON.parse(row.value) as Card);
  const values: StackValue[] = [
    ...cards,
    ...readTexts(db, projectId),
    ...readShapes(db, projectId),
    ...readImages(db, projectId),
    ...readStrokes(db, projectId),
  ];
  return values.sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0));
}

function kindOf(value: StackValue) {
  return 'body' in value ? 'card' : value.kind;
}

export function layerCanvas(
  db: Database.Database,
  command: Extract<Command, { type: 'canvas.layer' }>,
) {
  const values = readStack(db, command.projectId),
    contentValues = values.filter(value => kindOf(value) !== 'stroke'),
    byId = new Map(values.map(value => [value.item.id, value])),
    itemIds = command.payload.itemIds;
  requireThat(new Set(itemIds).size === itemIds.length, 'INVALID_COMMAND', '同一层级操作不可重复对象', 400);
  const selected = new Set<string>();
  for (const id of itemIds) {
    const value = byId.get(id);
    requireThat(value, 'NOT_FOUND', '层级对象不存在于当前项目', 404);
    requireThat(kindOf(value) !== 'stroke', 'INVALID_COMMAND', '层级调整仅支持卡片、形状、独立文字和图片', 400);
    selected.add(id);
  }
  requireThat(
    Object.keys(command.expected).length === contentValues.length &&
      contentValues.every(value => Object.hasOwn(command.expected, value.item.id)),
    'EXPECTED_DOMAINS',
    '须校验全部层级对象的布局版本',
    400,
  );
  for (const value of contentValues)
    requireThat(
      value.item.versionId === command.expected[value.item.id],
      'VERSION_CONFLICT',
      '层级已更新，请重新读取',
      409,
    );
  const contentOrder = nextLayerOrder(
    contentValues.map(value => ({ id: value.item.id, pose: value.item.pose })),
    selected,
    command.payload.operation,
  );
  if (contentOrder.every((id, index) => id === contentValues[index]!.item.id))
    return { cardChanges: [], textChanges: [], shapeChanges: [], imageChanges: [], changedIds: [] };
  const ids = contentOrder;
  const ordinals = new Map(ids.map((id, index) => [id, index + 1])),
    cardChanges: { before: Card; after: Card }[] = [],
    textChanges: { before: CanvasText; after: CanvasText }[] = [],
    shapeChanges: { before: CanvasShape; after: CanvasShape }[] = [],
    imageChanges: { before: CanvasImage; after: CanvasImage }[] = [],
    changedIds: string[] = [];
  for (const id of ids) {
    const before = byId.get(id)!,
      createdOrder = ordinals.get(id)!;
    if ((before.item.createdOrder ?? 0) === createdOrder) continue;
    const after = {
      ...before,
      item: { ...before.item, createdOrder, versionId: randomUUID() },
    } as StackValue;
    const table =
      'body' in before
        ? 'mapping_cards'
        : before.kind === 'text'
          ? 'mapping_texts'
          : before.kind === 'shape'
            ? 'mapping_shapes'
            : 'mapping_images';
    db.prepare(`UPDATE ${table} SET value=? WHERE id=? AND project_id=?`).run(
      JSON.stringify(after),
      after.id,
      command.projectId,
    );
    if ('body' in after) retainCardVersions(db, command.projectId, after);
    else
      db.prepare(
        'INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)',
      ).run(command.projectId, 'pose', after.item.id, after.item.versionId, JSON.stringify(after.item));
    if ('body' in after) cardChanges.push({ before: before as Card, after });
    else if (after.kind === 'text')
      textChanges.push({ before: before as CanvasText, after });
    else if (after.kind === 'shape')
      shapeChanges.push({ before: before as CanvasShape, after });
    else if (after.kind === 'image')
      imageChanges.push({ before: before as CanvasImage, after });
    else continue;
    changedIds.push(after.item.id);
  }
  return { cardChanges, textChanges, shapeChanges, imageChanges, changedIds };
}
