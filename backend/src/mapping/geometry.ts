import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card, Command } from './contracts.js';
import { requireThat } from '../domain/errors.js';

// Mapping owns the surrounding SQLite transaction, receipt and history.
export function writeGeometry(
  db: Database.Database,
  command: Extract<Command, { type: 'pose.batch' }>,
) {
  const ids = command.payload.poses.map((p) => p.id);
  requireThat(new Set(ids).size === ids.length, 'INVALID_COMMAND', '同一几何动作不可重复卡片', 400);
  requireThat(
    Object.keys(command.expected).length === ids.length &&
      ids.every((id) => Object.hasOwn(command.expected, id)),
    'EXPECTED_DOMAINS',
    '须校验每张卡片的布局版本且不可附带其他域',
    400,
  );
  // Validate all targets before any write. Body is read from current authority,
  // never from a client's geometry preview or the gesture's earlier snapshot.
  const cardChanges = command.payload.poses
    .map((p) => {
      const row = db
        .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
        .get(p.id, command.projectId) as { value: string } | undefined;
      requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
      const before = JSON.parse(row.value) as Card;
      requireThat(
        command.expected[p.id] === before.item.versionId,
        'VERSION_CONFLICT',
        '布局已更新，请重新读取',
        409,
      );
      const { id: _, ...pose } = p;
      const changed = Object.keys(pose).some(
        (key) => pose[key as keyof typeof pose] !== before.item.pose[key as keyof typeof pose],
      );
      const policy = before.item.heightPolicy;
      const heightPolicy =
        p.height !== before.item.pose.height
          ? {
              ...policy,
              manualHeight: Math.max(p.height, policy?.necessaryHeight ?? 0),
              necessaryHeight: policy?.necessaryHeight ?? 0,
            }
          : policy;
      return {
        before,
        after: changed
          ? {
              ...before,
              item: {
                ...before.item,
                pose: {
                  ...pose,
                  height: Math.max(pose.height, heightPolicy?.necessaryHeight ?? 0),
                },
                ...(heightPolicy ? { heightPolicy } : {}),
                versionId: randomUUID(),
              },
            }
          : before,
      };
    })
    .filter((c) => c.before.item.versionId !== c.after.item.versionId);
  for (const { after } of cardChanges)
    db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(
      JSON.stringify(after),
      after.id,
      command.projectId,
    );
  return { cardChanges, changedIds: cardChanges.map((c) => c.after.item.id) };
}

export function restoreGeometry(
  db: Database.Database,
  projectId: string,
  changes: { before: Card; after: Card }[],
  direction: 'history.undo' | 'history.redo',
) {
  return changes.map((c) => {
    const desired = direction === 'history.undo' ? c.before : c.after;
    const row = db
      .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
      .get(desired.id, projectId) as { value: string } | undefined;
    requireThat(row, 'NOT_FOUND', '几何历史目标已不可用', 409);
    const before = JSON.parse(row.value) as Card;
    const policy = desired.item.heightPolicy;
    const necessaryHeight =
      before.item.heightPolicy?.necessaryHeight ?? policy?.necessaryHeight ?? 0;
    const heightPolicy = policy
      ? {
          ...policy,
          necessaryHeight,
          previewFloor: before.body.blocks.some((b) => b.text.length > 0)
            ? (policy.previewFloor ?? 0)
            : 0,
        }
      : undefined;
    const after = {
      ...before,
      item: {
        ...desired.item,
        ...(heightPolicy ? { heightPolicy } : {}),
        pose: {
          ...desired.item.pose,
          height: Math.max(
            necessaryHeight,
            heightPolicy?.manualHeight ??
              (heightPolicy
                ? before.body.blocks.some((b) => b.text.length > 0)
                  ? (heightPolicy.previewFloor ?? 0)
                  : 0
                : desired.item.pose.height),
          ),
        },
        versionId: randomUUID(),
      },
    };
    db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(
      JSON.stringify(after),
      after.id,
      projectId,
    );
    return { before, after };
  });
}
