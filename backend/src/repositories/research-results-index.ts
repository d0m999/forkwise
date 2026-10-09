import type Database from 'better-sqlite3';

/** These tables are disposable. Views and triggers in migrations 0006/0008 are the
 * single projection definition; no task, graph, version or judgment is changed. */
export function rebuildResearchResults(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DELETE FROM research_checks;
      DELETE FROM research_result_jobs;
      INSERT INTO research_result_jobs SELECT * FROM research_result_job_source;
      INSERT INTO research_checks SELECT * FROM research_check_source;
    `);
  }).immediate();
}
