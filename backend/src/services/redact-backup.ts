import type { ActionJournal } from '../contracts/action-history.js';
import { redactCanvasImages } from './redact-canvas.js';
import type Database from 'better-sqlite3';

// Portability redaction runs only on an isolated backup, never on the live history.
export function redactRestrictedBackup(db: Database.Database): void {
  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
  for (const { id } of projects) {
    const hashes = new Set(
      (
        db
          .prepare(
            "SELECT hash FROM file_assets WHERE project_id=? AND source_id IN (SELECT id FROM entities WHERE project_id=? AND kind='source' AND json_extract(data,'$.rights')='restricted')",
          )
          .all(id, id) as { hash: string }[]
      ).map((f) => f.hash),
    );
    const layout = db.prepare('SELECT data FROM layouts WHERE project_id=?').get(id) as
      | { data: string }
      | undefined;
    if (layout && hashes.size)
      db.prepare('UPDATE layouts SET data=? WHERE project_id=?').run(
        JSON.stringify(redactCanvasImages(JSON.parse(layout.data), hashes)),
        id,
      );
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='action_history'").get()) {
      const row = db.prepare('SELECT data FROM action_history WHERE project_id=?').get(id) as
        | { data: string }
        | undefined;
      if (row && hashes.size) {
        const journal = JSON.parse(row.data) as ActionJournal;
        for (const e of journal.entries)
          if (e.layout) {
            e.layout.before = redactCanvasImages(e.layout.before, hashes);
            e.layout.after = redactCanvasImages(e.layout.after, hashes);
          }
        db.prepare('UPDATE action_history SET data=? WHERE project_id=?').run(
          JSON.stringify(journal),
          id,
        );
      }
    }
    db.prepare(
      "UPDATE file_assets SET bytes=x'' WHERE project_id=? AND source_id IN (SELECT id FROM entities WHERE project_id=? AND kind='source' AND json_extract(data,'$.rights')='restricted')",
    ).run(id, id);
    const rows = db
      .prepare(
        "SELECT id,data FROM entities WHERE project_id=? AND kind='source_version' AND json_extract(data,'$.sourceId') IN (SELECT id FROM entities WHERE project_id=? AND kind='source' AND json_extract(data,'$.rights')='restricted')",
      )
      .all(id, id) as { id: string; data: string }[];
    const blocked = new Set(rows.map((r) => r.id));
    if (!blocked.size) continue;
    const sanitize = (json: string) =>
      JSON.stringify(JSON.parse(json), (_k, v: unknown) => {
        if (
          v &&
          typeof v === 'object' &&
          'sourceVersionId' in v &&
          ('quote' in v || ('kind' in v && v.kind === 'image')) &&
          blocked.has(String(v.sourceVersionId))
        )
          return { ...v, ...('quote' in v ? { quote: '' } : {}), unavailableReason: 'rights' };
        if (
          v &&
          typeof v === 'object' &&
          'sourceVersionId' in v &&
          'artifact' in v &&
          blocked.has(String(v.sourceVersionId))
        )
          return { ...v, artifact: null, omission: '来源权利限制，仅保留索引' };
        if (v && typeof v === 'object' && 'id' in v && 'text' in v && blocked.has(String(v.id)))
          return { ...v, text: null, omission: '来源权利限制，仅保留索引' };
        return v;
      });
    for (const [table, column] of [
      ['entities', 'data'],
      ['versions', 'snapshot'],
      ['jobs', 'input'],
      ['jobs', 'output'],
    ] as const) {
      const values = db
        .prepare(`SELECT rowid,${column} AS data FROM ${table} WHERE project_id=?`)
        .all(id) as { rowid: number; data: string | null }[];
      for (const value of values)
        if (value.data !== null)
          db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(
            sanitize(value.data),
            value.rowid,
          );
    }
    const unavailableIds = db
      .prepare(
        "SELECT id FROM entities WHERE project_id=? AND (kind='source_version' AND id IN (SELECT value FROM json_each(?)) OR kind='evidence' AND json_extract(data,'$.citation.sourceVersionId') IN (SELECT value FROM json_each(?)))",
      )
      .all(id, JSON.stringify([...blocked]), JSON.stringify([...blocked])) as { id: string }[];
    for (const e of unavailableIds) {
      db.prepare(
        'DELETE FROM embeddings WHERE chunk_id IN (SELECT rowid FROM search_chunks WHERE project_id=? AND entity_id=?)',
      ).run(id, e.id);
      db.prepare('DELETE FROM search_chunks WHERE project_id=? AND entity_id=?').run(id, e.id);
    }
    for (const versionId of blocked)
      db.prepare('DELETE FROM materials WHERE project_id=? AND source_version_id=?').run(
        id,
        versionId,
      );
    db.prepare(
      'DELETE FROM parsed_artifacts WHERE project_id=? AND source_version_id IN (SELECT value FROM json_each(?))',
    ).run(id, JSON.stringify([...blocked]));
  }
  db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
}
