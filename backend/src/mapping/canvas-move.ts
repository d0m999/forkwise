import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Card, Command } from './contracts.js';
import type { CanvasText } from './text-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import { requireThat } from '../domain/errors.js';
import { writeText } from './text.js';
import { moveShape } from './shape.js';

export function moveCanvas(
  db: Database.Database,
  command: Extract<Command, { type: 'canvas.move' }>,
) {
  const { targets } = command.payload;
  requireThat(
    new Set(targets.map((target) => target.itemId)).size === targets.length &&
      new Set(targets.map((target) => `${target.kind}:${target.id}`)).size === targets.length,
    'INVALID_COMMAND',
    '同一移动不可重复对象',
    400,
  );
  requireThat(
    Object.keys(command.expected).length === targets.length &&
      targets.every((target) => Object.hasOwn(command.expected, target.itemId)),
    'EXPECTED_DOMAINS',
    '须校验全部移动对象的布局版本',
    400,
  );
  const validated = targets.map((target) => {
    const row = db
      .prepare(
        target.kind === 'card'
          ? 'SELECT value FROM mapping_cards WHERE id=? AND project_id=?'
          : target.kind === 'text'
            ? 'SELECT value FROM mapping_texts WHERE id=? AND project_id=?'
            : 'SELECT value FROM mapping_shapes WHERE id=? AND project_id=?',
      )
      .get(target.id, command.projectId) as { value: string } | undefined;
    requireThat(row, 'NOT_FOUND', '移动对象不存在于当前项目', 404);
    const value = JSON.parse(row.value) as Card | CanvasText | CanvasShape;
    requireThat(
      value.item.id === target.itemId && value.item.versionId === command.expected[target.itemId],
      'VERSION_CONFLICT',
      '布局已更新，请重新读取',
      409,
    );
    return { target, value };
  });
  const cardChanges: { before: Card; after: Card }[] = [];
  const textChanges: { before: CanvasText; after: CanvasText }[] = [];
  const shapeChanges: { before: CanvasShape; after: CanvasShape }[] = [];
  for (const { target, value } of validated) {
    if (target.x === value.item.pose.x && target.y === value.item.pose.y) continue;
    if (target.kind === 'text') {
      const change = writeText(db, {
        commandId: command.commandId,
        projectId: command.projectId,
        type: 'text.move',
        expected: value.item.versionId,
        payload: { id: target.id, x: target.x, y: target.y },
      })!;
      textChanges.push({ before: change.before!, after: change.after! });
    } else if (target.kind === 'shape') {
      const change = moveShape(db, {
        commandId: command.commandId,
        projectId: command.projectId,
        type: 'shape.move',
        expected: value.item.versionId,
        payload: { id: target.id, x: target.x, y: target.y },
      })!;
      shapeChanges.push({ before: change.before!, after: change.after! });
    } else {
      const before = value as Card;
      const after = {
        ...before,
        item: {
          ...before.item,
          versionId: randomUUID(),
          pose: { ...before.item.pose, x: target.x, y: target.y },
        },
      };
      db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(
        JSON.stringify(after),
        target.id,
        command.projectId,
      );
      cardChanges.push({ before, after });
    }
  }
  return {
    cardChanges,
    textChanges,
    shapeChanges,
    changedIds: [...cardChanges, ...textChanges, ...shapeChanges].map((change) => change.after.item.id),
  };
}
