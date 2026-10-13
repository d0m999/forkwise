import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AccessService, type Principal } from '../services/access.js';
import { requireThat } from '../domain/errors.js';
import {
  MappingCommand,
  type Card,
  type Change,
  type Project,
  type ProjectState,
  type ReadQuery,
  type Receipt,
} from './contracts.js';

export class Mapping {
  readonly access: AccessService;
  constructor(private readonly db: Database.Database) {
    this.access = new AccessService(db);
  }
  close() {
    this.db.close();
  }

  read(query: { type: 'projects' }, actor: Principal): Project[];
  read(query: { type: 'project'; projectId: string }, actor: Principal): ProjectState;
  read(query: ReadQuery, actor: Principal): Project[] | ProjectState {
    return this.db.transaction(() => {
      if (query.type === 'projects') {
        const rows = this.db
          .prepare(
            'SELECT id, name, version_id AS versionId, revision FROM mapping_projects ORDER BY rowid',
          )
          .all() as Project[];
        return rows.filter(
          (p) =>
            actor.projects.includes(p.id) ||
            (actor.actor.type === 'human' && actor.projects.includes('*')),
        );
      }
      this.access.project(actor, query.projectId);
      const project = this.project(query.projectId);
      const cards = (
        this.db
          .prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid')
          .all(query.projectId) as { value: string }[]
      ).map((row) => JSON.parse(row.value) as Card);
      return { project, cards };
    })();
  }

  execute(input: unknown, actor: Principal): Receipt {
    this.access.human(actor);
    const command = MappingCommand.parse(input);
    this.access.project(actor, command.projectId);
    return this.db
      .transaction(() => {
        const request = JSON.stringify(command);
        const saved = this.db
          .prepare(
            'SELECT actor_id, request, receipt FROM mapping_receipts WHERE project_id=? AND command_id=?',
          )
          .get(command.projectId, command.commandId) as
          | { actor_id: string; request: string; receipt: string }
          | undefined;
        if (saved) {
          requireThat(
            saved.actor_id === actor.actor.id && saved.request === request,
            'IDEMPOTENCY_MISMATCH',
            '命令编号已用于不同请求',
            409,
          );
          return JSON.parse(saved.receipt) as Receipt;
        }
        const unchanged = (revision: number): Receipt => {
          const receipt = {
            commandId: command.commandId,
            projectId: command.projectId,
            revision,
            changedIds: [],
          };
          this.db
            .prepare('INSERT INTO mapping_receipts VALUES(?,?,?,?,?)')
            .run(
              command.projectId,
              command.commandId,
              actor.actor.id,
              request,
              JSON.stringify(receipt),
            );
          return receipt;
        };
        let before: Card | Project | null = null;
        let after: Card | Project;
        let revision: number;
        let changedIds: string[];
        if (command.type === 'project.create') {
          this.db
            .prepare('INSERT INTO mapping_projects VALUES(?,?,?,1)')
            .run(command.projectId, command.payload.name, randomUUID());
          revision = 1;
          changedIds = [command.projectId];
          after = this.project(command.projectId);
        } else if (command.type === 'thought.create') {
          const project = this.project(command.projectId);
          const p = command.payload;
          const card: Card = {
            id: p.id,
            title: p.title,
            versionId: randomUUID(),
            body: {
              id: randomUUID(),
              versionId: randomUUID(),
              blocks: [{ id: randomUUID(), type: 'text', text: p.text }],
            },
            item: {
              id: randomUUID(),
              versionId: randomUUID(),
              pose: { x: p.x, y: p.y, width: 280, height: 160 },
            },
          };
          this.db
            .prepare('INSERT INTO mapping_cards VALUES(?,?,?)')
            .run(card.id, project.id, JSON.stringify(card));
          revision = project.revision + 1;
          this.db
            .prepare('UPDATE mapping_projects SET revision=? WHERE id=?')
            .run(revision, project.id);
          changedIds = [card.id, card.body.id, card.item.id];
          after = card;
        } else {
          const project = this.project(command.projectId);
          if (command.type === 'project.rename') {
            before = project;
            requireThat(
              command.expected === project.versionId,
              'VERSION_CONFLICT',
              '项目已更新，请重新读取',
              409,
            );
            if (command.payload.name === project.name) return unchanged(project.revision);
            this.db
              .prepare('UPDATE mapping_projects SET name=?, version_id=? WHERE id=?')
              .run(command.payload.name, randomUUID(), project.id);
            changedIds = [project.id];
            after = { ...this.project(project.id), revision: project.revision + 1 };
          } else {
            const row = this.db
              .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
              .get(command.payload.id, project.id) as { value: string } | undefined;
            requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
            const card = JSON.parse(row.value) as Card;
            before = JSON.parse(row.value) as Card;
            if (command.type === 'thought.title') {
              requireThat(
                command.expected === card.versionId,
                'VERSION_CONFLICT',
                '标题已更新，请重新读取',
                409,
              );
              if (command.payload.title === card.title) return unchanged(project.revision);
              card.title = command.payload.title;
              card.versionId = randomUUID();
              changedIds = [card.id];
            } else {
              requireThat(
                command.expected === card.body.versionId,
                'VERSION_CONFLICT',
                '正文已更新，请重新读取',
                409,
              );
              if (command.payload.text === card.body.blocks[0]!.text)
                return unchanged(project.revision);
              card.body.blocks[0]!.text = command.payload.text;
              card.body.versionId = randomUUID();
              changedIds = [card.body.id];
            }
            after = card;
            this.db
              .prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?')
              .run(JSON.stringify(card), card.id, project.id);
          }
          revision = project.revision + 1;
          this.db
            .prepare('UPDATE mapping_projects SET revision=? WHERE id=?')
            .run(revision, project.id);
        }
        const receipt = {
          commandId: command.commandId,
          projectId: command.projectId,
          revision,
          changedIds,
        };
        this.db
          .prepare('INSERT INTO mapping_changes VALUES(?,?,?)')
          .run(
            command.projectId,
            revision,
            JSON.stringify({
              ...receipt,
              before,
              after,
              actor: actor.actor,
              writtenAt: new Date().toISOString(),
            } satisfies Change),
          );
        this.db
          .prepare('INSERT INTO mapping_receipts VALUES(?,?,?,?,?)')
          .run(
            command.projectId,
            command.commandId,
            actor.actor.id,
            request,
            JSON.stringify(receipt),
          );
        return receipt;
      })
      .immediate();
  }

  observe(query: { projectId: string; afterRevision: number }, actor: Principal) {
    this.access.project(actor, query.projectId);
    return this.db.transaction(() => {
      const project = this.project(query.projectId);
      requireThat(
        Number.isSafeInteger(query.afterRevision) &&
          query.afterRevision >= 0 &&
          query.afterRevision <= project.revision,
        'INVALID_CURSOR',
        '变化游标无效',
      );
      const changes = (
        this.db
          .prepare(
            'SELECT receipt FROM mapping_changes WHERE project_id=? AND revision>? ORDER BY revision',
          )
          .all(project.id, query.afterRevision) as { receipt: string }[]
      ).map((row) => JSON.parse(row.receipt) as Change);
      return { revision: project.revision, changes };
    })();
  }

  private project(id: string): Project {
    const project = this.db
      .prepare(
        'SELECT id, name, version_id AS versionId, revision FROM mapping_projects WHERE id=?',
      )
      .get(id) as Project | undefined;
    requireThat(project, 'NOT_FOUND', '项目不存在', 404);
    return project;
  }
}
