import type { CanvasConnector } from './connector-contracts.js';
import { createConnector, reconnectConnector, changeConnectorPath, moveConnector, deleteConnector, prepareIncidentConnectorDeletion, applyIncidentConnectorDeletion, readConnectors } from './connector.js';
import { cropImage, createImage, readImages, transformImage, rotateImage, deleteImage } from './image.js';
import type { ImageVersion } from './image-contracts.js';
import { moveCanvas } from './canvas-move.js';
import { createStroke, deleteStroke, readStrokes } from './stroke.js';
import { createShape, deleteShape, editShape, moveShape, readShapes, transformShape } from './shape.js';
import type { ShapeVersion } from './shape-contracts.js';
import type { StrokeVersion } from './stroke-contracts.js';
import { readTexts, writeText } from './text.js';
import { reconcileMediaTasks, completeMediaTask } from './media-tasks.js';
import { completeMediaHistory } from './history.js';
import { readAsset, saveAsset, validateImageAssets, type MediaAsset } from './media.js';
import { DEFAULT_APPEARANCE, DEFAULT_PREVIEW_HEIGHT } from './presentation-values.js';
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
import { writeGeometry } from './geometry.js';
import { canonical } from '../domain/canonical.js';
import { editedBlocks, requireBlockOwnership, bodyContentUnchanged, originalCopySources } from './body.js';
import { deleteCard } from './lifecycle.js';
import { createTagSelection, readTags, updateTag, writeCardTags, deleteTag } from './tags.js';
import { randomUUID } from 'node:crypto';
import { searchProject } from './search.js';
import { SearchLibraries, type SearchAssetReader } from './search-language.js';
import { contentEditTimes } from './search-edits.js';
import { readSearchState, saveSearchState, isSearchStateCommand } from './search-state.js';
import type { SearchStateView, SearchStateQuery } from './search-contracts.js';
import { SearchQuerySchema, type SearchQuery, type SearchResult } from './search-contracts.js';
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
  type Tag,
} from './contracts.js';

export interface CommitOptions {
  // Local asset I/O seam for hosts and fault tests; never accepted from HTTP.
  searchAssetReader?: SearchAssetReader;
  compact?: CompactOptions;
  observe?: ObserveOptions;
  // Storage failure seam, injected only by an in-process host (never by HTTP).
  checkpoint?: (phase: 'versions' | 'history' | 'receipt', change: Change) => void;
}
export class Mapping {
  readonly access: AccessService;
  private readonly compact: CompactMaps;
  private readonly searchLibraries: SearchLibraries;
  constructor(
    private readonly db: Database.Database,
    private readonly options: CommitOptions = {},
  ) {
    this.access = new AccessService(db);
    this.compact = new CompactMaps(db, options.compact);
    this.searchLibraries = new SearchLibraries(options.searchAssetReader);
  }
  close() {
    this.db.close();
  }

  read(query: SearchQuery, actor: Principal): Promise<SearchResult>;
  read(query: SearchStateQuery, actor: Principal): SearchStateView;
  read(query: CompactQuery & { view: 'index' }, actor: Principal): CompactPage<CardIndex>;
  read(query: CompactQuery & { view: 'body' }, actor: Principal): CompactPage<BodySlice>;
  read(query: CompactQuery & { view: 'detail' }, actor: Principal): CompactPage<DetailChunk>;
  read(query: CompactQuery, actor: Principal): CompactPage;
  read(query: {type:'asset';projectId:string;id:string}, actor: Principal): MediaAsset;
  read(query: IdentityQuery, actor: Principal): CardIdentity;
  read(query: { type: 'projects' }, actor: Principal): Project[];
  read(query: { type: 'history'; projectId: string }, actor: Principal): ProjectHistory;
  read(query: { type: 'project'; projectId: string }, actor: Principal): ProjectState;
  read(query: VersionQuery & { domain: 'body' }, actor: Principal): Card['body'];
  read(query: VersionQuery & { domain: 'pose' }, actor: Principal): Card['item'];
  read(query: VersionQuery & { domain: 'appearance' }, actor: Principal): Card['appearance'];
  read(query: VersionQuery & { domain: 'tag' }, actor: Principal): Tag;
  read(query: VersionQuery & { domain: 'cardTags' }, actor: Principal): NonNullable<Card['cardTags']>;
  read(query: VersionQuery & { domain: 'shape' }, actor: Principal): ShapeVersion;
  read(query: VersionQuery & { domain: 'stroke' }, actor: Principal): StrokeVersion;
  read(query: VersionQuery & { domain: 'image' }, actor: Principal): ImageVersion;
  read(query: VersionQuery & { domain: 'connector' }, actor: Principal): CanvasConnector;
  read(query: VersionQuery, actor: Principal): Card['body'] | Card['item'] | Card['appearance'] | Tag | NonNullable<Card['cardTags']> | ShapeVersion | StrokeVersion | ImageVersion | CanvasConnector;
  read(
    query: ReadQuery,
    actor: Principal,
  ):
    | Project[]
    | ProjectState
    | ProjectHistory
    | Card['body']
    | Card['item']
    | Card['appearance']
    | CardIdentity
    | CompactPage
    | Tag
    | NonNullable<Card['cardTags']>
    | ShapeVersion
    | StrokeVersion
    | ImageVersion
    | CanvasConnector
    | MediaAsset
    | SearchStateView
    | Promise<SearchResult> {
    if (query.type === 'search')
      return this.readSearch(SearchQuerySchema.parse(query), actor);
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
      if (query.type === 'search.state') {
        const project = this.project(query.projectId);
        return { ...readSearchState(this.db, query.projectId), projectRevision: project.revision, tags: readTags(this.db, project.id) };
      }
      if (query.type === 'asset') return readAsset(this.db, query.projectId, query.id);
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
        return JSON.parse(row.value) as Card['body'] | Card['item'] | ShapeVersion | StrokeVersion | ImageVersion | CanvasConnector;
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
      return { project, cards, connectors: readConnectors(this.db, project.id), images: readImages(this.db, project.id), tags: readTags(this.db, project.id), texts: readTexts(this.db, project.id), shapes: readShapes(this.db, project.id), strokes: readStrokes(this.db, project.id) };
    })();
  }

  private async readSearch(query: SearchQuery, actor: Principal): Promise<SearchResult> {
    this.access.validate(actor);
    this.access.project(actor, query.projectId);
    const loaded = await this.searchLibraries.load(query.retry);
    return this.db.transaction(() => {
      // Reauthorize after the asynchronous boundary, then read all current facts
      // and edit times within this one SQLite snapshot.
      const state = this.read({ type: 'project', projectId: query.projectId }, actor);
      const capabilities: SearchResult['capabilities'] = {
        normalization: loaded.normalization ? 'ready' : 'failed',
        segmentation: loaded.segmentation ? 'ready' : 'failed',
      };
      if (!loaded.language || (!loaded.segmentation && !query.literal))
        return { state: 'failed', projectId: query.projectId, revision: state.project.revision,
          capabilities, query: { input: query.text, units: [], unclosedQuote: false }, invalidTagIds: [], results: [],
          message: '搜索库加载失败 · 重试' } as SearchResult;
      const result = searchProject(state, query, loaded.language, contentEditTimes(this.db, query.projectId));
      return { ...result, capabilities,
        ...(query.literal && result.state === 'ready' ? { state: 'degraded' as const, message: '当前按完整片段搜索，未自动识别中文词组' } : {}) };
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
          isSearchStateCommand(command) ||
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
        if (isSearchStateCommand(command)) {
          const project = this.project(command.projectId);
          let expected = command.expected;
          if (command.type === 'search.record' && command.payload.pending) {
            requireThat(command.payload.intent === 'exit', 'INVALID_SEARCH_EXIT', '只有退出搜索可收拢在途请求', 400);
            for (const pending of command.payload.pending) {
              const preceding = MappingCommand.parse({ ...pending, expected: 'expected' in pending ? pending.expected : expected });
              requireThat(isSearchStateCommand(preceding) && preceding.projectId === project.id && preceding.commandId !== command.commandId &&
                !(preceding.type === 'search.record' && preceding.payload.pending),
                'INVALID_SEARCH_EXIT', '退出搜索只能重放当前项目的搜索请求', 400);
              requireThat(preceding.expected === expected, 'VERSION_CONFLICT', '在途搜索请求不属于当前版本链', 409);
              // The outer expected is the start of this exact request chain.
              // Replayed receipts advance it; the final CAS still rejects a peer
              // write after that chain. This transaction rolls back every new
              // child write if any request or the final CAS fails.
              expected = this.execute(preceding, actor).searchState!.versionId;
            }
          }
          const searchState = { ...saveSearchState(this.db, { ...command, expected }), projectRevision: project.revision, tags: readTags(this.db, project.id) };
          const receipt: Receipt = { commandId: command.commandId, projectId: project.id, revision: project.revision, changedIds: [], searchState };
          this.db.prepare('INSERT INTO mapping_receipts VALUES(?,?,?,?,?)').run(project.id, command.commandId, actor.actor.id, request, JSON.stringify(receipt));
          return receipt;
        }
        if (command.type === 'asset.save') {
          const project=this.project(command.projectId);
          saveAsset(this.db,command);
          const receipt={commandId:command.commandId,projectId:command.projectId,revision:project.revision,changedIds:[]};
          this.db.prepare('INSERT INTO mapping_receipts VALUES(?,?,?,?,?)').run(command.projectId,command.commandId,actor.actor.id,request,JSON.stringify(receipt));
          return receipt;
        }
        if (command.type === 'body.edit')
          for (const id of command.payload.requiredAssetIds ?? []) readAsset(this.db, command.projectId, id);
        const unchanged = (revision: number): Receipt => {
          if (command.type !== 'card.layout' && command.type !== 'text.layout') interruptGroup(this.db, command, actor.tokenHash);
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
        let connectorChanges: Change['connectorChanges'];
        let cardChanges: Change['cardChanges'];
        let tagChange: Change['tagChange'];
        let textChange: Change['textChange'];
        let shapeChange: Change['shapeChange'];
        let strokeChange: Change['strokeChange'];
        let imageChange: Change['imageChange'];
        let imageChanges: Change['imageChanges'];
        let shapeChanges: Change['shapeChanges'];
        let textChanges: Change['textChanges'];
        let travel: ReturnType<typeof travelHistory> | undefined;
        let revision: number;
        let changedIds: string[];
        if (command.type === 'connector.create' || command.type === 'connector.reconnect' || command.type === 'connector.path' || command.type === 'connector.move' || command.type === 'connector.delete') {
          const project = this.project(command.projectId);
          const result = command.type === 'connector.create' ? { before: null, after: createConnector(this.db, command) } : command.type === 'connector.reconnect' ? reconnectConnector(this.db, command) : command.type === 'connector.path' ? changeConnectorPath(this.db, command) : command.type === 'connector.move' ? moveConnector(this.db, command) : deleteConnector(this.db, command);
          if (!result) return unchanged(project.revision);
          connectorChanges = [result];
          after = null; changedIds = [(result.after ?? result.before!).id]; revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'image.create' || command.type === 'image.crop' || command.type === 'image.transform' || command.type === 'image.rotate' || command.type === 'image.delete') {
          const project = this.project(command.projectId);
          let incident: NonNullable<Change['connectorChanges']> = [];
          if (command.type === 'image.delete') {
            const host = readImages(this.db, project.id).find(value => value.id === command.payload.id);
            requireThat(host, 'NOT_FOUND', '图片不存在于当前项目', 404);
            incident = prepareIncidentConnectorDeletion(this.db, project.id, host.item.id, command.expected.connectors ?? {});
          }
          imageChange = command.type === 'image.create' ? { before: null, after: createImage(this.db, command) } : command.type === 'image.crop' ? cropImage(this.db, command) ?? undefined : command.type === 'image.delete' ? deleteImage(this.db, command) : command.type === 'image.rotate' ? rotateImage(this.db, command) : transformImage(this.db, command) ?? undefined;
          if (!imageChange) return unchanged(project.revision);
          applyIncidentConnectorDeletion(this.db, project.id, incident);
          if (incident.length) connectorChanges = incident;
          const image = imageChange.after ?? imageChange.before!;
          after = null; changedIds = [...new Set([...(imageChange.before?.versionId !== imageChange.after?.versionId ? [image.id] : []), ...(imageChange.before?.item.versionId !== imageChange.after?.item.versionId ? [image.item.id] : []), ...incident.map(change => change.before!.id)])]; revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'stroke.create' || command.type === 'stroke.delete') {
          const project = this.project(command.projectId);
          strokeChange = command.type === 'stroke.create' ? { before: null, after: createStroke(this.db, command) } : deleteStroke(this.db, command);
          const stroke = strokeChange.after ?? strokeChange.before!;
          after = null;
          changedIds = [stroke.id, stroke.item.id];
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'canvas.move') {
          const project = this.project(command.projectId);
          ({ cardChanges, textChanges, shapeChanges, imageChanges, changedIds } = moveCanvas(this.db, command));
          if (!changedIds.length) return unchanged(project.revision);
          after = null; revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'shape.create' || command.type === 'shape.edit' || command.type === 'shape.move' || command.type === 'shape.delete' || command.type === 'shape.transform') {
          const project = this.project(command.projectId);
          let incident: NonNullable<Change['connectorChanges']> = [];
          if (command.type === 'shape.delete') {
            const host = readShapes(this.db, project.id).find(value => value.id === command.payload.id);
            requireThat(host, 'NOT_FOUND', '形状不存在于当前项目', 404);
            incident = prepareIncidentConnectorDeletion(this.db, project.id, host.item.id, command.expected.connectors ?? {});
          }
          const result = command.type === 'shape.create'
            ? { before: null, after: createShape(this.db, command) }
            : command.type === 'shape.edit' ? editShape(this.db, command)
            : command.type === 'shape.move' ? moveShape(this.db, command)
            : command.type === 'shape.transform' ? transformShape(this.db, command) : deleteShape(this.db, command);
          if (!result) return unchanged(project.revision);
          shapeChange = result;
          applyIncidentConnectorDeletion(this.db, project.id, incident);
          if (incident.length) connectorChanges = incident;
          const shape = result.after ?? result.before!;
          after = null;
          changedIds = [
            ...(result.before?.versionId !== result.after?.versionId ? [shape.id] : []),
            ...(result.before?.item.versionId !== result.after?.item.versionId ? [shape.item.id] : []),
            ...incident.map(change => change.before!.id),
          ];
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'text.create' || command.type === 'text.edit' || command.type === 'text.transform' || command.type === 'text.move' || command.type === 'text.delete' || command.type === 'text.copy' || command.type === 'text.layout') {
          const project = this.project(command.projectId);
          let incident: NonNullable<Change['connectorChanges']> = [];
          if (command.type === 'text.delete') {
            const host = readTexts(this.db, project.id).find(value => value.id === command.payload.id);
            requireThat(host, 'NOT_FOUND', '文字不存在于当前项目', 404);
            incident = prepareIncidentConnectorDeletion(this.db, project.id, host.item.id, command.expected.connectors ?? {});
          }
          const result = writeText(this.db, command);
          if (!result) return unchanged(project.revision);
          textChange = result;
          applyIncidentConnectorDeletion(this.db, project.id, incident);
          if (incident.length) connectorChanges = incident;
          after = null;
          changedIds = [...new Set([...(result.before?.versionId !== result.after?.versionId ? [(result.after ?? result.before)!.id] : []), ...(result.before?.item.versionId !== result.after?.item.versionId ? [(result.after ?? result.before)!.item.id] : []), ...incident.map(change => change.before!.id)])];
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'history.undo' || command.type === 'history.redo') {
          const project = this.project(command.projectId);
          requireThat(
            command.expected === project.revision,
            'VERSION_CONFLICT',
            '项目历史已更新，请重新读取',
            409,
          );
          travel = travelHistory(this.db, project, command.type, command.payload.actionId);
          ({ before, after, changedIds } = travel);
          connectorChanges = travel.connectorChanges;
          cardChanges = travel.cardChanges;
          tagChange = travel.tagChange;
          textChange = travel.textChange;
          textChanges = travel.textChanges;
          shapeChange = travel.shapeChange;
          strokeChange = travel.strokeChange;
          imageChange = travel.imageChange;
          imageChanges = travel.imageChanges;
          shapeChanges = travel.shapeChanges;
          revision = project.revision + 1;
          this.db
            .prepare('UPDATE mapping_projects SET revision=? WHERE id=?')
            .run(revision, project.id);
        } else if (command.type === 'tag.delete') {
          const project = this.project(command.projectId);
          ({ tagChange, cardChanges, changedIds } = deleteTag(this.db, command));
          after = null;
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'tag.create') {
          const project = this.project(command.projectId);
          const result = createTagSelection(this.db, command);
          if (!result.changedIds.length) return unchanged(project.revision);
          tagChange = result.tagChange ?? undefined;
          if (tagChange) {
            after = null;
            if (result.cardChange) cardChanges = [{ before: result.cardChange.before, after: result.cardChange.after }];
          } else {
            before = result.cardChange!.before;
            after = result.cardChange!.after;
          }
          changedIds = result.changedIds;
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'tag.update') {
          const project = this.project(command.projectId);
          const created = updateTag(this.db, command);
          if (!created) return unchanged(project.revision);
          tagChange = created;
          after = null;
          changedIds = [created.after.id];
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'card.tags') {
          const project = this.project(command.projectId);
          const result = writeCardTags(this.db, command);
          if (!result) return unchanged(project.revision);
          ({ before, after, changedIds } = result);
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'media.finish' || command.type === 'media.fail' || command.type === 'media.retry') {
          const project=this.project(command.projectId);
          const row=this.db.prepare('SELECT value FROM mapping_cards WHERE project_id=? AND id=?').get(command.projectId,command.payload.id) as {value:string}|undefined;
          requireThat(row,'MEDIA_TASK_STALE','原卡片已删除，晚到结果未写入',409);
          before=JSON.parse(row.value) as Card;
          const card=structuredClone(before);
          const replacement=completeMediaTask(this.db,project.id,card,command);
          card.body.blocks=card.body.blocks.map(b=>b.id===command.payload.blockId?replacement:b);
          card.body.versionId=randomUUID();after=card;changedIds=[card.body.id];revision=project.revision+1;
          this.db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(card),card.id,project.id);
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision,project.id);
          completeMediaHistory(this.db,project.id,card.id,command.expected,replacement,revision);
        } else if (command.type === 'thought.delete') {
          const project = this.project(command.projectId);
          const row = this.db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(command.payload.id, project.id) as { value: string } | undefined;
          requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
          const card = JSON.parse(row.value) as Card;
          const incident = prepareIncidentConnectorDeletion(this.db, project.id, card.item.id, command.expected.connectors ?? {});
          ({ before, after, changedIds } = deleteCard(this.db, command));
          applyIncidentConnectorDeletion(this.db, project.id, incident);
          if (incident.length) connectorChanges = incident;
          changedIds = [...new Set([...changedIds, ...incident.map(change => change.before!.id)])];
          revision = project.revision + 1;
          this.db.prepare('UPDATE mapping_projects SET revision=? WHERE id=?').run(revision, project.id);
        } else if (command.type === 'pose.batch') {
          const project = this.project(command.projectId);
          ({ cardChanges, changedIds } = writeGeometry(this.db, command));
          if (!changedIds.length) return unchanged(project.revision);
          before = cardChanges[0]!.before;
          after = cardChanges[0]!.after;
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
              createdOrder: project.revision + 1,
              id: randomUUID(),
              versionId: randomUUID(),
              pose: { x: p.x, y: p.y, width: 280, height: 160 },
              heightPolicy: {
                manualHeight: null,
                necessaryHeight: 0,
                previewFloor: p.text.length ? DEFAULT_PREVIEW_HEIGHT : 0,
              },
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
            if (command.type === 'card.layout') {
              requireThat(
                command.expected.thought === card.versionId &&
                  command.expected.body === card.body.versionId &&
                  command.expected.pose === card.item.versionId &&
                  command.expected.appearance === (card.appearance?.versionId ?? null) &&
                  (command.expected.cardTags ?? null) === (card.cardTags?.versionId ?? null),
                'VERSION_CONFLICT',
                '卡面测量依据已更新，请重新读取',
                409,
              );
              const policy = card.item.heightPolicy ?? {
                manualHeight: card.item.pose.height,
                necessaryHeight: 0,
              };
              const previewFloor = card.body.blocks.some((b) => typeof b.text === 'string' && b.text.length > 0)
                ? (policy.previewFloor ?? 0)
                : 0;
              const height = Math.max(
                command.payload.necessaryHeight,
                policy.manualHeight ?? previewFloor,
              );
              // Old records have no manual-height provenance. A fitting
              // measurement must not stamp them merely because they were read.
              if (!card.item.heightPolicy && height === card.item.pose.height)
                return unchanged(project.revision);
              if (
                policy.necessaryHeight === command.payload.necessaryHeight &&
                card.item.pose.height === height
              )
                return unchanged(project.revision);
              card.item = {
                ...card.item,
                versionId: randomUUID(),
                heightPolicy: {
                  ...policy,
                  necessaryHeight: command.payload.necessaryHeight,
                  previewFloor,
                },
                pose: { ...card.item.pose, height },
              };
              changedIds = [card.item.id];
            } else if (command.type === 'card.appearance') {
              requireThat(
                command.expected === (card.appearance?.versionId ?? null),
                'VERSION_CONFLICT',
                '外观已更新，请重新读取',
                409,
              );
              const current = card.appearance ?? DEFAULT_APPEARANCE;
              if (
                current.titleColor === command.payload.titleColor &&
                current.showPreview === command.payload.showPreview
              )
                return unchanged(project.revision);
              card.appearance = {
                id: card.appearance?.id ?? `appearance:${card.id}`,
                versionId: randomUUID(),
                titleColor: command.payload.titleColor,
                showPreview: command.payload.showPreview,
              };
              changedIds = [card.appearance.id];
            } else if (command.type === 'thought.title') {
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
              if (command.type !== 'pose.move') {
                const blocks = editedBlocks(
                  card.body,
                  command.payload,
                  command.type === 'body.edit' && command.payload.copyOriginals
                    ? originalCopySources(this.db, command.projectId, card.body, command.payload.blocks)
                    : [],
                );
                requireBlockOwnership(this.db, card.body, blocks);
                validateImageAssets(this.db, command.projectId, blocks);
                if (!bodyContentUnchanged(card.body.blocks, blocks)) {
                  card.body.blocks = blocks;
                  card.body.versionId = randomUUID();
                  changedIds.push(card.body.id);
                }
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
        if (before && 'body' in before || after && 'body' in after) {
          reconcileMediaTasks(this.db,command.projectId,before&&'body' in before?before:null,after&&'body' in after?after:null);
          if(after&&'body' in after)this.db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after),after.id,command.projectId);
        }
        if (after && 'body' in after) retainCardVersions(this.db, command.projectId, after);
        for (const c of cardChanges ?? []) retainCardVersions(this.db, command.projectId, c.after);
        const receipt = {
          commandId: command.commandId,
          projectId: command.projectId,
          revision,
          changedIds,
          ...(command.type === 'pose.batch' && cardChanges ? { cardPoseVersions: Object.fromEntries(cardChanges.map(({ after }) => [after.item.id, after.item.versionId])) } : {}),
          ...(connectorChanges?.some(change => !change.after) ? { deletedIds: connectorChanges.filter(change => !change.after).map(change => change.before!.id) } : {}),
          ...(connectorChanges ? { connectorVersions: Object.fromEntries(connectorChanges.filter(change => change.after).map(change => [change.after!.id, change.after!.versionId])) } : {}),
          ...(imageChange?.after ? { imageVersions: { image: imageChange.after.versionId, pose: imageChange.after.item.versionId } } : {}),
          ...(strokeChange?.after ? { strokeVersions: { stroke: strokeChange.after.versionId, pose: strokeChange.after.item.versionId } } : {}),
          ...(shapeChange?.after ? { shapeVersions: { shape: shapeChange.after.versionId, pose: shapeChange.after.item.versionId } } : {}),
          ...(textChange?.after ? { textVersions: { text: textChange.after.versionId, pose: textChange.after.item.versionId } } : {}),
          ...(imageChange && !imageChange.after ? { deletedIds: changedIds } : {}),
          ...(textChange && !textChange.after ? { deletedIds: changedIds } : {}),
          ...(shapeChange && !shapeChange.after ? { deletedIds: changedIds } : {}),
          ...(strokeChange && !strokeChange.after ? { deletedIds: changedIds } : {}),
          ...(tagChange?.after.deleted ? { deletedIds: [tagChange.after.id] } : {}),
          ...(command.type === 'thought.delete' ? { deletedIds: changedIds, historyTarget: { id: command.payload.id, title: before && 'body' in before ? before.title : '', label: command.type } } : {}),
          ...(travel ? { deletedIds: travel.deletedIds, historyTarget: travel.target } : {}),
          ...(after && 'body' in after
            ? {
                versions: {
                  thought: after.versionId,
                  body: after.body.versionId,
                  pose: after.item.versionId,
                  ...(after.appearance ? { appearance: after.appearance.versionId } : {}),
                },
              }
            : {}),
        };
        const change: Change = {
          ...receipt,
          before,
          after,
          ...(connectorChanges ? { connectorChanges } : {}),
          ...(imageChange ? { imageChange } : {}),
          ...(imageChanges ? { imageChanges } : {}),
          ...(tagChange ? { tagChange } : {}),
          ...(shapeChange ? { shapeChange } : {}),
          ...(strokeChange ? { strokeChange } : {}),
          ...(shapeChanges ? { shapeChanges } : {}),
          ...(textChange ? { textChange } : {}),
          ...(textChanges ? { textChanges } : {}),
          ...(cardChanges ? { cardChanges } : {}),
          actor: actor.actor,
          writtenAt: new Date().toISOString(),
        };
        this.options.checkpoint?.('versions', structuredClone(change));
        if (!travel && command.type!=='media.finish' && command.type!=='media.fail' && command.type!=='media.retry') recordAction(this.db, command, change, actor.tokenHash);
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
