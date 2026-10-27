import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card } from './contracts.js';
import { DEFAULT_APPEARANCE } from './presentation-values.js';
import { reconcileMediaTasks } from './media-tasks.js';
import { retainCardVersions } from './versions.js';

export function restoreCard(db: Database.Database, projectId: string, change: { before: Card | null; after: Card | null }, type: 'history.undo' | 'history.redo', changedIds: string[]) {
  const identity = change.after ?? change.before!, desired = type === 'history.undo' ? change.before : change.after;
  const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(identity.id, projectId) as { value: string } | undefined;
  const before = row ? JSON.parse(row.value) as Card : null;
  const after = desired ? structuredClone(desired) : null;
  if (after) {
    if (before) {
      if (!changedIds.includes(after.id)) {
        after.title = before.title;
        after.versionId = before.versionId;
      }
      if (!changedIds.includes(after.body.id)) after.body = before.body;
      if (!changedIds.includes(after.item.id)) after.item = before.item;
      if (!changedIds.includes(`cardTags:${after.id}`)) {
        if (before.cardTags) after.cardTags = before.cardTags;
        else delete after.cardTags;
      }
      if (!changedIds.includes(`appearance:${after.id}`)) {
        if (before.appearance) after.appearance = before.appearance;
        else delete after.appearance;
      }
    }
    if (changedIds.includes(after.id)) after.versionId = randomUUID();
    if (changedIds.includes(after.body.id)) after.body.versionId = randomUUID();
    if (changedIds.includes(after.item.id)) after.item.versionId = randomUUID();
    const restoringIdentity = !before && changedIds.includes(after.id);
    if (changedIds.includes(`cardTags:${after.id}`) || (restoringIdentity && (after.cardTags || db.prepare("SELECT 1 FROM mapping_versions WHERE project_id=? AND domain='cardTags' AND id=? LIMIT 1").get(projectId, `cardTags:${after.id}`))))
      after.cardTags = { id: `cardTags:${after.id}`, tagIds: after.cardTags?.tagIds ?? [], versionId: randomUUID() };
    const appearanceId = `appearance:${after.id}`;
    if (
      changedIds.includes(appearanceId) ||
      (restoringIdentity &&
        db
          .prepare(
            "SELECT 1 FROM mapping_versions WHERE project_id=? AND domain='appearance' AND id=? LIMIT 1",
          )
          .get(projectId, appearanceId))
    ) {
      after.appearance = {
        ...(after.appearance ?? { id: appearanceId, ...DEFAULT_APPEARANCE }),
        versionId: randomUUID(),
      };
    }
    reconcileMediaTasks(db, projectId, before, after);
    db.prepare(
      'INSERT INTO mapping_cards VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
    ).run(after.id, projectId, JSON.stringify(after));
    retainCardVersions(db, projectId, after);
  }
  else {
    reconcileMediaTasks(db, projectId, before, null);
    db.prepare('DELETE FROM mapping_cards WHERE id=? AND project_id=?').run(identity.id, projectId);
  }
  return { before, after };
}
