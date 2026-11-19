import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type {
  LayoutField,
  Principal,
  SessionCapabilities,
} from '../services/access.js';

// Every command that can change where an existing object sits. Agents may only
// use the ones listed in SUPPORTED; the rest are rejected instead of silently
// inheriting the older blanket delegation.
const LAYOUT_COMMANDS = new Set([
  'pose.move',
  'pose.batch',
  'canvas.move',
  'canvas.move-selection',
  'canvas.layer',
  'group.move',
  'group.rotate90',
  'group.scale',
  'frame.move',
  'frame.resize',
  'text.move',
  'text.transform',
  'text.layout',
  'shape.move',
  'shape.transform',
  'image.transform',
  'image.crop',
  'image.rotate',
  'card.layout',
  'card.edit',
  'connector.move',
  'connector.path',
  'connector.reconnect',
]);

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
  // Only the pose is needed here; extracting it in SQLite avoids parsing the
  // whole card body and tags for every target of a 200-card batch.
  const row = db
    .prepare("SELECT project_id, json_extract(value, '$.item.pose') AS pose FROM mapping_cards WHERE id=?")
    .get(id) as { project_id: string; pose: string } | undefined;
  if (!row) return undefined;
  return { projectId: row.project_id, pose: JSON.parse(row.pose) as Record<LayoutField, number> };
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
  if (principal.actor.type === 'human') return;
  if (!LAYOUT_COMMANDS.has(command.type)) return;
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
  // Older sessions keep their previous reach for unsupported geometry commands,
  // but pose.move / pose.batch always need a grant; undefined is deny, not full.
  if (delegations === undefined && !SUPPORTED[command.type]) return;
  const scope = delegations?.find((candidate) => candidate.projectId === command.projectId);
  requireThat(scope, 'LAYOUT_DELEGATION_REQUIRED', '此会话没有该项目的布局写入授权', 403);
  const supported = SUPPORTED[command.type];
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
