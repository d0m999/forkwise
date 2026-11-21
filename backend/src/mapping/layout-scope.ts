import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { Card } from './contracts.js';
import type {
  LayoutField,
  Principal,
  SessionCapabilities,
} from '../services/access.js';

const SUPPORTED: Record<string, { fields: readonly LayoutField[] }> = {
  'pose.move': { fields: ['x', 'y'] },
  'pose.batch': { fields: ['x', 'y', 'width', 'height'] },
};

interface Target {
  id: string;
  /** Values the command asks this object to take for the supported fields. */
  values: Partial<Record<LayoutField, number>>;
}

function targetsOf(command: { type: string; payload: unknown }): Target[] {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  if (command.type === 'pose.move') {
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return [];
    return [{ id, values: { x: payload.x as number, y: payload.y as number } }];
  }
  if (command.type === 'pose.batch' && Array.isArray(payload.poses)) {
    return (payload.poses as Record<string, unknown>[])
      .filter((pose) => typeof pose?.id === 'string')
      .map((pose) => ({
        id: pose.id as string,
        values: {
          x: pose.x as number,
          y: pose.y as number,
          width: pose.width as number,
          height: pose.height as number,
        },
      }));
  }
  return [];
}

function readPose(
  db: Database.Database,
  id: string,
): { projectId: string; pose: Record<LayoutField, number> } | undefined {
  // SQLite JSON functions reject deeply nested opaque content that a card can
  // legally contain after package import. Use the same parser as card reads.
  const row = db
    .prepare('SELECT project_id, value FROM mapping_cards WHERE id=?')
    .get(id) as { project_id: string; value: string } | undefined;
  if (!row) return undefined;
  const card = JSON.parse(row.value) as Card;
  return { projectId: row.project_id, pose: card.item.pose };
}

// Object identity is checked for every Agent layout write, including sessions
// issued before layout scopes existed. A missing layoutDelegations list is
// treated as deny for the supported pose writes, never as a blanket grant;
// geometry commands outside this ticket's matrix keep their older reach.
export function requireLayoutWrite(
  db: Database.Database,
  principal: Principal,
  command: { type: string; projectId: string; payload: unknown },
  capabilities: SessionCapabilities,
): void {
  // 正文补丁已由独立的正文范围校验。旧的一般委托继续沿用项目编辑权限。
  if (principal.actor.type === 'human' || command.type === 'body.patch') return;
  const supported = SUPPORTED[command.type];
  if (!supported && capabilities.layoutDelegations === undefined) return;
  const targets = targetsOf(command);

  // Read each target once: existence, project ownership and the changed-field
  // comparison share the same pose snapshot inside this transaction.
  const current = targets.map((target) => {
    const found = readPose(db, target.id);
    requireThat(found, 'LAYOUT_TARGET_NOT_FOUND', '目标对象不存在或已删除', 404);
    requireThat(
      found.projectId === command.projectId,
      'LAYOUT_TARGET_FORBIDDEN',
      '目标对象不属于当前项目',
      403,
    );
    return found;
  });

  // Undefined means the session row predates layout scopes; an explicit list
  // (including []) is authoritative.
  const delegations = Array.isArray(capabilities.layoutDelegations)
    ? capabilities.layoutDelegations
    : undefined;
  const scope = delegations?.find((candidate) => candidate.projectId === command.projectId);
  requireThat(scope, 'LAYOUT_DELEGATION_REQUIRED', '此会话没有该项目的布局写入授权', 403);
  requireThat(
    supported,
    'LAYOUT_OPERATION_UNSUPPORTED',
    '当前布局授权不支持此操作类型',
    403,
  );
  requireThat(
    Array.isArray(scope.operations) && scope.operations.includes(command.type as never),
    'LAYOUT_OPERATION_FORBIDDEN',
    '布局授权未包含此操作',
    403,
  );
  requireThat(
    Array.isArray(scope.objectKinds) && scope.objectKinds.includes('card'),
    'LAYOUT_OBJECT_FORBIDDEN',
    '布局授权未包含该对象类型',
    403,
  );
  if (scope.objectIds !== '*')
    requireThat(
      Array.isArray(scope.objectIds) && targets.every((target) => scope.objectIds.includes(target.id)),
      'LAYOUT_OBJECT_FORBIDDEN',
      '布局授权未包含该对象',
      403,
    );

  targets.forEach((target, index) => {
    const changed = supported.fields.filter(
      (field) =>
        target.values[field] !== undefined && target.values[field] !== current[index]!.pose[field],
    );
    for (const field of changed)
      requireThat(
        Array.isArray(scope.fields) && scope.fields.includes(field),
        'LAYOUT_FIELD_FORBIDDEN',
        '布局授权未包含该字段',
        403,
      );
  });
}
