import type Database from 'better-sqlite3';
import { CompactMaps, type CompactOptions } from './compact.js';
import { observeChanges, type ObserveOptions } from './observe.js';
import type { ObserveQuery } from './observe-contracts.js';
import type {
  CompactPage,
  CompactQuery,
  CardIndex,
  BodySlice,
  DetailChunk,
} from './compact-contracts.js';
import { readHistory, recordAction, travelHistory, interruptGroup } from './history.js';
import { retainCardVersions } from './versions.js';
import { canonical } from '../domain/canonical.js';
import { randomUUID } from 'node:crypto';
import { AccessService, type Principal } from '../services/access.js';
import { requireThat } from '../domain/errors.js';
import {
  MappingCommand,
  type Card,
  type CardIdentity,
  type IdentityQuery,
  type ProjectHistory,
  type Change,
  type Project,
  type ProjectState,
  type ReadQuery,
  type VersionQuery,
  type Receipt,
} from './contracts.js';

export interface CommitOptions {
  compact?: CompactOptions;
  observe?: ObserveOptions;
  // Storage failure seam, injected only by an in-process host (never by HTTP).
  checkpoint?: (phase: 'versions' | 'history' | 'receipt', change: Change) => void;
}
export class Mapping {
  readonly access: AccessService;
  private readonly compact: CompactMaps;
  constructor(
    private readonly db: Database.Database,
    private readonly options: CommitOptions = {},
  ) {
    this.access = new AccessService(db);
    this.compact = new CompactMaps(db, options.compact);
  }
  close() {
    this.db.close();
  }

  read(query: CompactQuery & { view: 'index' }, actor: Principal): CompactPage<CardIndex>;
  read(query: CompactQuery & { view: 'body' }, actor: Principal): CompactPage<BodySlice>;
  read(query: CompactQuery & { view: 'detail' }, actor: Principal): CompactPage<DetailChunk>;
  read(query: CompactQuery, actor: Principal): CompactPage;
  read(query: IdentityQuery, actor: Principal): CardIdentity;
  read(query: { type: 'projects' }, actor: Principal): Project[];
  read(query: { type: 'history'; projectId: string }, actor: Principal): ProjectHistory;
  read(query: { type: 'project'; projectId: string }, actor: Principal): ProjectState;
  read(query: VersionQuery & { domain: 'body' }, actor: Principal): Card['body'];
  read(query: VersionQuery & { domain: 'pose' }, actor: Principal): Card['item'];
  read(query: VersionQuery, actor: Principal): Card['body'] | Card['item'];
  read(
    query: ReadQuery,
    actor: Principal,
  ):
    | Project[]
    | ProjectState
    | ProjectHistory
    | Card['body']
    | Card['item']
    | CardIdentity
    | CompactPage {
    return this.db.transaction(() => {
      this.access.validate(actor);
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
      if (query.type === 'map') return this.compact.read(query);
      if (query.type === 'card.identity') {
        this.project(query.projectId);
        const identity = this.db
          .prepare('SELECT 1 FROM mapping_card_ids WHERE id=? AND project_id=?')
          .get(query.id, query.projectId);
        if (!identity) return { availability: 'not_found' as const };
        const row = this.db
          .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
          .get(query.id, query.projectId) as { value: string } | undefined;
        return row
          ? { availability: 'available' as const, card: JSON.parse(row.value) as Card }
          : { availability: 'deleted' as const };
      }
      if (query.type === 'version') {
        const row = this.db
          .prepare(
            'SELECT value FROM mapping_versions WHERE project_id=? AND domain=? AND id=? AND version_id=?',
          )
          .get(query.projectId, query.domain, query.id, query.versionId) as
          | { value: string }
          | undefined;
        requireThat(row, 'NOT_FOUND', '版本不存在于当前项目', 404);
        return JSON.parse(row.value) as Card['body'] | Card['item'];
      }
      const project = this.project(query.projectId);
      if (query.type === 'history') return readHistory(this.db, project);
      const cards = (
        this.db
          .prepare(
            'SELECT c.value FROM mapping_cards c JOIN mapping_card_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
          )
          .all(query.projectId) as { value: string }[]
      ).map((row) => JSON.parse(row.value) as Card);
      return { project, cards };
    })();
  }

  execute(input: unknown, actor: Principal): Receipt {
    return this.db
      .transaction(() => {
        this.access.validate(actor);
        // Check project scope before parsing content or returning an old receipt.
        if (
          input &&
          typeof input === 'object' &&
          'projectId' in input &&
          typeof input.projectId === 'string'
        )
          this.access.project(actor, input.projectId);
        const command = MappingCommand.parse(input);
        this.access.mappingWrite(actor, command.projectId);
        if (
          command.type === 'project.create' ||
          command.type === 'history.undo' ||
          command.type === 'history.redo'
        )
          this.access.human(actor);
        const request = canonical(command);
        const saved = this.db
          .prepare(
            'SELECT actor_id, request, receipt FROM mapping_receipts WHERE project_id=? AND command_id=?',
          )
          .get(command.projectId, command.commandId) as
          | { actor_id: string; request: string; receipt: string }
          | undefined;
        if (saved) {
          requireThat(
            saved.actor_id === actor.actor.id && canonical(JSON.parse(saved.request)) === request,
            'IDEMPOTENCY_MISMATCH',
            '命令编号已用于不同请求',
            409,
          );
          return JSON.parse(saved.receipt) as Receipt;
        }
        // #16 will connect verified immutable assets to this gate. Until then,
        // a reference is never mistaken for a persisted resource, even on no-op.
        if (command.type === 'body.edit')
          requireThat(
            !command.payload.requiredAssetIds?.length,
            'MEDIA_NOT_PERSISTED',
            '所需媒体尚未持久保存，请完成或移除媒体后重试',
            409,
          );
        const unchanged = (revision: number): Receipt => {
          interruptGroup(this.db, command, actor.tokenHash);
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
        let after: Card | Project | null;
        let travel: ReturnType<typeof travelHistory> | undefined;
        let revision: number;
        let changedIds: string[];
        if (command.type === 'history.undo' || command.type === 'history.redo') {
          const project = this.project(command.projectId);
          requireThat(
            command.expected === project.revision,
            'VERSION_CONFLICT',
            '项目历史已更新，请重新读取',
            409,
          );
          travel = travelHistory(this.db, project, command.type);
          ({ before, after, changedIds } = travel);
          revision = project.revision + 1;
          this.db
            .prepare('UPDATE mapping_projects SET revision=? WHERE id=?')
            .run(revision, project.id);
        } else if (command.type === 'project.create') {
          requireThat(
            !this.db.prepare('SELECT 1 FROM mapping_projects WHERE id=?').get(command.projectId),
            'ID_CONFLICT',
            '身份已使用，请重新创建',
            409,
          );
          this.db
            .prepare('INSERT INTO mapping_projects VALUES(?,?,?,1)')
            .run(command.projectId, command.payload.name, randomUUID());
          revision = 1;
          changedIds = [command.projectId];
          after = this.project(command.projectId);
        } else if (command.type === 'thought.create') {
          const project = this.project(command.projectId);
          const p = command.payload;
          requireThat(
            !this.db.prepare('SELECT 1 FROM mapping_card_ids WHERE id=?').get(p.id),
            'ID_CONFLICT',
            '身份已使用，请重新创建',
            409,
          );
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
          this.db.prepare('INSERT INTO mapping_card_ids VALUES(?,?)').run(card.id, project.id);
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
              // Validate the entire read/write set before constructing any version.
              if (command.type !== 'pose.move')
                requireThat(
                  (command.type === 'card.edit' ? command.expected.body : command.expected) ===
                    card.body.versionId,
                  'VERSION_CONFLICT',
                  '正文已更新，请重新读取',
                  409,
                );
              if (command.type !== 'body.edit')
                requireThat(
                  (command.type === 'card.edit' ? command.expected.pose : command.expected) ===
                    card.item.versionId,
                  'VERSION_CONFLICT',
                  '布局已更新，请重新读取',
                  409,
                );
              changedIds = [];
              if (
                command.type !== 'pose.move' &&
                command.payload.text !== card.body.blocks[0]!.text
              ) {
                card.body.blocks[0]!.text = command.payload.text;
                card.body.versionId = randomUUID();
                changedIds.push(card.body.id);
              }
              if (
                command.type !== 'body.edit' &&
                (command.payload.x !== card.item.pose.x || command.payload.y !== card.item.pose.y)
              ) {
                card.item.pose.x = command.payload.x;
                card.item.pose.y = command.payload.y;
                card.item.versionId = randomUUID();
                changedIds.push(card.item.id);
              }
              if (!changedIds.length) return unchanged(project.revision);
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
        if (after && 'body' in after) retainCardVersions(this.db, command.projectId, after);
        const receipt = {
          commandId: command.commandId,
          projectId: command.projectId,
          revision,
          changedIds,
          ...(travel ? { deletedIds: travel.deletedIds, historyTarget: travel.target } : {}),
          ...(after && 'body' in after
            ? {
                versions: {
                  thought: after.versionId,
                  body: after.body.versionId,
                  pose: after.item.versionId,
                },
              }
            : {}),
        };
        const change: Change = {
          ...receipt,
          before,
          after,
          actor: actor.actor,
          writtenAt: new Date().toISOString(),
        };
        this.options.checkpoint?.('versions', structuredClone(change));
        if (!travel) recordAction(this.db, command, change, actor.tokenHash);
        this.db
          .prepare('INSERT INTO mapping_changes VALUES(?,?,?)')
          .run(command.projectId, revision, JSON.stringify(change));
        this.options.checkpoint?.('history', structuredClone(change));
        this.db
          .prepare('INSERT INTO mapping_receipts VALUES(?,?,?,?,?)')
          .run(
            command.projectId,
            command.commandId,
            actor.actor.id,
            request,
            JSON.stringify(receipt),
          );
        this.options.checkpoint?.('receipt', structuredClone(change));
        return receipt;
      })
      .immediate();
  }

  observe(query: ObserveQuery, actor: Principal) {
    return this.db.transaction(() => {
      this.access.validate(actor);
      this.access.project(actor, query.projectId);
      return observeChanges(this.db, this.compact, query, this.options.observe);
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
