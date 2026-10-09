import type Database from 'better-sqlite3';
import type { Actor, AnyEntity, Project, State } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';
import { references } from '../domain/graph.js';

export class ResearchRepository {
  constructor(public readonly db: Database.Database) {}
  project(id: string): Project {
    const row = this.db
      .prepare(
        'SELECT id,name,question,revision,created_at AS createdAt,deleted_at AS deletedAt FROM projects WHERE id=? AND deleted_at IS NULL',
      )
      .get(id) as Project | undefined;
    requireThat(row, 'PROJECT_NOT_FOUND', '研究项目不存在', 404);
    return row;
  }
  listProjects(): Project[] {
    return this.db
      .prepare(
        'SELECT id,name,question,revision,created_at AS createdAt,deleted_at AS deletedAt FROM projects WHERE deleted_at IS NULL ORDER BY created_at,id',
      )
      .all() as Project[];
  }
  objects(projectId: string): AnyEntity[] {
    return this.db
      .prepare(
        `SELECT id,project_id AS projectId,kind,version,version_id AS versionId,
      content_version_id AS contentVersionId,data,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt
      FROM entities WHERE project_id=? ORDER BY created_at,rowid`,
      )
      .all(projectId)
      .map((row) => {
        const r = row as AnyEntity & { data: string };
        return { ...r, data: JSON.parse(r.data) } as AnyEntity;
      });
  }
  snapshot(projectId: string, asOf?: string): State {
    return this.db
      .transaction(() => {
        const project = this.project(projectId);
        let objects = this.objects(projectId);
        if (asOf) {
          requireThat(Number.isFinite(Date.parse(asOf)), 'INVALID_TIME', '回看时点无效');
          const rows = this.db
            .prepare(
              `SELECT snapshot FROM (SELECT snapshot,created_at,rowid AS sequence,
          ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY version DESC) AS n
          FROM versions WHERE project_id=? AND created_at<=?) WHERE n=1 ORDER BY created_at,sequence`,
            )
            .all(projectId, new Date(asOf).toISOString()) as { snapshot: string }[];
          objects = rows.map((r) => JSON.parse(r.snapshot) as AnyEntity);
        }
        return { project, objects: objects.filter((e) => !e.deletedAt) };
      })
      .deferred();
  }
  version(projectId: string, id: string, versionId: string): AnyEntity | undefined {
    const row = this.db
      .prepare(
        'SELECT snapshot FROM versions WHERE project_id=? AND entity_id=? AND (id=? OR content_version_id=?) ORDER BY version ASC LIMIT 1',
      )
      .get(projectId, id, versionId, versionId) as { snapshot: string } | undefined;
    return row ? (JSON.parse(row.snapshot) as AnyEntity) : undefined;
  }
  history(projectId: string, id: string): AnyEntity[] {
    this.project(projectId);
    return (
      this.db
        .prepare(
          'SELECT snapshot FROM versions WHERE project_id=? AND entity_id=? ORDER BY version',
        )
        .all(projectId, id) as { snapshot: string }[]
    ).map((r) => JSON.parse(r.snapshot) as AnyEntity);
  }
  material(projectId: string, id: string): string {
    this.project(projectId);
    const row = this.db
      .prepare(
        `SELECT m.text FROM materials m JOIN entities e ON e.project_id=m.project_id AND e.id=m.source_version_id
      WHERE m.project_id=? AND m.source_version_id=? AND e.deleted_at IS NULL`,
      )
      .get(projectId, id) as { text: string } | undefined;
    requireThat(row, 'MATERIAL_NOT_FOUND', '材料版本不存在', 404);
    return row.text;
  }
  persist(changed: AnyEntity[], actor: Actor, texts: Map<string, string>): void {
    const save = this.db
      .prepare(`INSERT INTO entities(id,project_id,kind,version,version_id,content_version_id,data,created_at,updated_at,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET version=excluded.version,version_id=excluded.version_id,
      content_version_id=excluded.content_version_id,data=excluded.data,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`);
    const version = this.db.prepare(
      'INSERT INTO versions(id,project_id,entity_id,version,content_version_id,snapshot,actor,created_at) VALUES(?,?,?,?,?,?,?,?)',
    );
    for (const e of changed) {
      save.run(
        e.id,
        e.projectId,
        e.kind,
        e.version,
        e.versionId,
        e.contentVersionId,
        JSON.stringify(e.data),
        e.createdAt,
        e.updatedAt,
        e.deletedAt,
      );
      version.run(
        e.versionId,
        e.projectId,
        e.id,
        e.version,
        e.contentVersionId,
        JSON.stringify(e),
        JSON.stringify(actor),
        e.updatedAt,
      );
    }
    const del = this.db.prepare('DELETE FROM links WHERE project_id=? AND from_id=?');
    const link = this.db.prepare(
      'INSERT OR IGNORE INTO links(project_id,from_id,to_id,role) VALUES(?,?,?,?)',
    );
    for (const e of changed) {
      del.run(e.projectId, e.id);
      if (!e.deletedAt)
        for (const ref of references(e)) link.run(e.projectId, e.id, ref.id, ref.role);
      if (texts.has(e.id))
        this.db
          .prepare('INSERT INTO materials(project_id,source_version_id,text) VALUES(?,?,?)')
          .run(e.projectId, e.id, texts.get(e.id)!);
    }
  }
}
