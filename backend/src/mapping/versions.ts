import type Database from 'better-sqlite3';
import type { Card, Change } from './contracts.js';

// Immutable records are independent of the mutable current-card projection.
export function retainCardVersions(db: Database.Database, projectId: string, card: Card) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO mapping_versions(project_id,domain,id,version_id,value) VALUES(?,?,?,?,?)',
  );
  insert.run(projectId, 'body', card.body.id, card.body.versionId, JSON.stringify(card.body));
  insert.run(projectId, 'pose', card.item.id, card.item.versionId, JSON.stringify(card.item));
  if (card.cardTags) insert.run(projectId, 'cardTags', card.cardTags.id, card.cardTags.versionId, JSON.stringify(card.cardTags));
  if (card.appearance)
    insert.run(
      projectId,
      'appearance',
      card.appearance.id,
      card.appearance.versionId,
      JSON.stringify(card.appearance),
    );
}

export function initializeVersions(db: Database.Database) {
  db.transaction(() => {
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mapping_versions'").get()
    )
      return;
    db.exec(`CREATE TABLE mapping_versions(
      project_id TEXT NOT NULL REFERENCES mapping_projects(id), domain TEXT NOT NULL,
      id TEXT NOT NULL, version_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(project_id,domain,id,version_id));
      CREATE TRIGGER mapping_versions_no_update BEFORE UPDATE ON mapping_versions
        BEGIN SELECT RAISE(ABORT, 'Immutable version'); END;
      CREATE TRIGGER mapping_versions_no_delete BEFORE DELETE ON mapping_versions
        BEGIN SELECT RAISE(ABORT, 'Immutable version'); END;`);
    // Additive compatibility with #2: preserve its IDs, receipts, history and
    // application/user-version markers; derive records from retained snapshots.
    for (const row of db
      .prepare('SELECT project_id,receipt FROM mapping_changes ORDER BY revision')
      .all() as { project_id: string; receipt: string }[]) {
      const change = JSON.parse(row.receipt) as Change;
      for (const value of [change.before, change.after])
        if (value && 'body' in value) retainCardVersions(db, row.project_id, value);
    }
    for (const row of db.prepare('SELECT project_id,value FROM mapping_cards').all() as {
      project_id: string;
      value: string;
    }[])
      retainCardVersions(db, row.project_id, JSON.parse(row.value) as Card);
  }).immediate();
}
