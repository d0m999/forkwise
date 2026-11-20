import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import type { Card } from './contracts.js';
import type { OrganizeSummary, OrganizeTask } from './organize-contracts.js';

export type StoredTask = Omit<OrganizeTask, 'freshness' | 'candidateOnCanvas' | 'addAvailable' | 'cutCopyAvailable' | 'attempts'> & {
  candidateId: string;
  cutCandidateIds?: string[];
  deadline: number;
  modelDigest?: string;
  startRequestId?: string;
  attempts: (OrganizeTask['attempts'][number] & { retryId?: string })[];
};

export function initializeOrganize(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mapping_organize_tasks(
    project_id TEXT NOT NULL REFERENCES mapping_projects(id), id TEXT NOT NULL, card_id TEXT NOT NULL,
    scope TEXT NOT NULL, task TEXT NOT NULL,
    PRIMARY KEY(project_id,id), UNIQUE(project_id,scope)
  );
  CREATE TABLE IF NOT EXISTS mapping_organize_requests(
    project_id TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY(project_id,id), FOREIGN KEY(project_id,task_id) REFERENCES mapping_organize_tasks(project_id,id)
  );
  CREATE INDEX IF NOT EXISTS mapping_organize_card ON mapping_organize_tasks(project_id,card_id);`);
}

export class OrganizeStore {
  constructor(private readonly db: Database.Database) {}

  card(projectId: string, cardId: string): Card | null {
    const row = this.db.prepare('SELECT value FROM mapping_cards WHERE project_id=? AND id=?')
      .get(projectId, cardId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Card : null;
  }

  list(projectId: string, cardId?: string): OrganizeSummary[] {
    const fields = "SELECT id,card_id AS cardId,json_extract(task,'$.mode') AS mode,json_extract(task,'$.createdAt') AS createdAt FROM mapping_organize_tasks";
    return (cardId
      ? this.db.prepare(`${fields} WHERE project_id=? AND card_id=? ORDER BY rowid DESC`).all(projectId, cardId)
      : this.db.prepare(`${fields} WHERE project_id=? ORDER BY rowid DESC`).all(projectId)) as OrganizeSummary[];
  }

  all(projectId: string): StoredTask[] {
    const rows = this.db.prepare('SELECT task FROM mapping_organize_tasks WHERE project_id=? ORDER BY rowid')
      .all(projectId) as { task: string }[];
    return rows.map(row => JSON.parse(row.task) as StoredTask);
  }

  get(projectId: string, id: string): StoredTask {
    const row = this.db.prepare('SELECT task FROM mapping_organize_tasks WHERE project_id=? AND id=?')
      .get(projectId, id) as { task: string } | undefined;
    requireThat(row, 'NOT_FOUND', '整理任务不存在', 404);
    return JSON.parse(row.task) as StoredTask;
  }

  save(projectId: string, task: StoredTask) {
    this.db.prepare('UPDATE mapping_organize_tasks SET task=? WHERE project_id=? AND id=?')
      .run(JSON.stringify(task), projectId, task.id);
  }

  request(projectId: string, requestId: string) {
    return this.db.prepare('SELECT request, task_id AS taskId FROM mapping_organize_requests WHERE project_id=? AND id=?')
      .get(projectId, requestId) as { request: string; taskId: string } | undefined;
  }

  recordRequest(projectId: string, requestId: string, request: string, taskId: string) {
    this.db.prepare('INSERT INTO mapping_organize_requests VALUES(?,?,?,?)')
      .run(projectId, requestId, request, taskId);
  }

  forScope(projectId: string, scope: string): StoredTask | undefined {
    const row = this.db.prepare('SELECT task FROM mapping_organize_tasks WHERE project_id=? AND scope=?')
      .get(projectId, scope) as { task: string } | undefined;
    return row ? JSON.parse(row.task) as StoredTask : undefined;
  }

  setScope(projectId: string, id: string, scope: string) {
    this.db.prepare('UPDATE mapping_organize_tasks SET scope=? WHERE project_id=? AND id=?').run(scope, projectId, id);
  }

  create(projectId: string, scope: string, task: StoredTask) {
    this.db.prepare('INSERT INTO mapping_organize_tasks VALUES(?,?,?,?,?)')
      .run(projectId, task.id, task.cardId, scope, JSON.stringify(task));
  }
}
