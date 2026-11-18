import type Database from 'better-sqlite3';
import type { Card, Change } from './contracts.js';
import { canonical } from '../domain/canonical.js';

// Derive from the persisted write ledger, including pre-search versions. Reading
// never stamps old data with "now", and pose/tag-only writes never count as edits.
// Imported projects seed the source's edit times first so sorting survives a roundtrip.
export function contentEditTimes(db: Database.Database, projectId: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const row of db
    .prepare('SELECT card_id AS cardId, edited_at AS editedAt FROM mapping_import_edit_times WHERE project_id=?')
    .all(projectId) as { cardId: string; editedAt: string }[])
    times.set(row.cardId, row.editedAt);
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
