import type Database from 'better-sqlite3';
import type { Card, Change } from './contracts.js';
import { canonical } from '../domain/canonical.js';

// Derive from the persisted write ledger, including pre-search versions. Reading
// never stamps old data with "now", and pose/tag-only writes never count as edits.
export function contentEditTimes(db: Database.Database, projectId: string): Map<string, string> {
  const times = new Map<string, string>();
  const record = (before: Card | null, after: Card | null, at: string) => {
    if (!after) return;
    if (
      !before
        ? !times.has(after.id)
        : before.title !== after.title ||
          canonical(before.body.blocks) !== canonical(after.body.blocks)
    )
      times.set(after.id, at);
  };
  for (const row of db
    .prepare('SELECT receipt FROM mapping_changes WHERE project_id=? ORDER BY revision')
    .all(projectId) as { receipt: string }[]) {
    const change = JSON.parse(row.receipt) as Change;
    record(
      change.before && 'body' in change.before ? change.before : null,
      change.after && 'body' in change.after ? change.after : null,
      change.writtenAt,
    );
    for (const cards of change.cardChanges ?? [])
      record(cards.before, cards.after, change.writtenAt);
  }
  return times;
}
