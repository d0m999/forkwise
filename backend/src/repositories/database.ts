import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rebuildResearchResults } from './research-results-index.js';

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(drizzle(db), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
    // Portable SQLite copies may contain stale/tampered derived rows. Rebuild
    // once on open; steady-state writes are maintained transactionally by SQL.
    rebuildResearchResults(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
