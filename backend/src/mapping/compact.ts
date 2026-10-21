import { textIndex, textDetail } from './text-projection.js';
import { shapeIndex, shapeDetail } from './shape-projection.js';
import { strokeIndex, strokeDetail } from './stroke-projection.js';
import type { TextIndex, ShapeIndex, StrokeIndex } from './compact-contracts.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import type { Card, Project, Tag } from './contracts.js';
import { readTags } from './tags.js';
import {
  CompactQuerySchema,
  type CompactQuery,
  type CompactPage,
  type CompactItem,
  type BodySlice,
  type DetailChunk,
} from './compact-contracts.js';
import { CompactPages } from './compact-pages.js';
import { blockPlainText } from './body-text.js';

// Read-only copies of one SQLite read transaction. No projection accepts writes.
export interface CompactOptions {
  clock?: () => number;
  snapshotTtlMs?: number;
  maxSnapshots?: number;
  maxSnapshotBytes?: number;
}
type PinnedCard = Omit<Card, 'body'> & {
  body: { id: string; versionId: string; blockCount: number };
};
type Snapshot = {
  strokes: StrokeIndex[];
  knownStrokeIds: Set<string>;
  shapes: ShapeIndex[];
  knownShapeIds: Set<string>;
  texts: TextIndex[];
  knownTextIds: Set<string>;
  tags: Tag[];
  project: Project;
  cards: PinnedCard[];
  expiresAt: number;
  knownIds: Set<string>;
  bytes: number;
};
export class CompactMaps {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pages = new CompactPages();
  constructor(
    private readonly db: Database.Database,
    private readonly options: CompactOptions = {},
  ) {}

  read(input: CompactQuery): CompactPage {
    const query = CompactQuerySchema.parse(input);
    const now = (this.options.clock ?? Date.now)();
    for (const [token, state] of this.snapshots)
      if (state.expiresAt <= now) this.snapshots.delete(token);
    requireThat(!query.cursor || query.snapshot, 'INVALID_CURSOR', '续页必须携带固定快照', 409);
    let token = query.snapshot ?? randomUUID();
    let state = this.snapshots.get(token);
    if (!state) {
      requireThat(!query.snapshot, 'SNAPSHOT_EXPIRED', '读取快照已失效，请重新开始', 409);
      const project = this.db
        .prepare('SELECT id,name,version_id AS versionId,revision FROM mapping_projects WHERE id=?')
        .get(query.projectId) as Project | undefined;
      requireThat(project, 'NOT_FOUND', '项目不存在', 404);
      const cached = [...this.snapshots].find(
        ([, value]) =>
          value.project.id === project.id && value.project.revision === project.revision,
      );
      if (cached) {
        token = cached[0];
        state = cached[1];
      } else {
        requireThat(
          this.snapshots.size < (this.options.maxSnapshots ?? 1024),
          'SNAPSHOT_CAPACITY',
          '读取快照容量已满，请等待过期后重新开始',
          503,
        );
        const rows = this.db
          .prepare(
            'SELECT c.value FROM mapping_cards c JOIN mapping_card_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
          )
          .all(query.projectId) as { value: string }[];
        const identities = this.db
          .prepare('SELECT id FROM mapping_card_ids WHERE project_id=?')
          .all(query.projectId) as { id: string }[];
        const cards: PinnedCard[] = rows.map((r) => {
          const card = JSON.parse(r.value) as Card;
          return {
            id: card.id,
            title: card.title,
            versionId: card.versionId,
            item: card.item,
            ...(card.cardTags ? { cardTags: card.cardTags } : {}),
            ...(card.appearance ? { appearance: card.appearance } : {}),
            body: {
              id: card.body.id,
              versionId: card.body.versionId,
              blockCount: card.body.blocks.length,
            },
          };
        });
        const tags = readTags(this.db, query.projectId);
        const texts = textIndex(this.db, query.projectId);
        const textIds = this.db.prepare('SELECT id FROM mapping_text_ids WHERE project_id=?').all(query.projectId) as { id: string }[];
        const { items: shapes, knownIds: shapeIds } = shapeIndex(this.db, query.projectId);
        const { items: strokes, knownIds: strokeIds } = strokeIndex(this.db, query.projectId);
        const bytes = Buffer.byteLength(JSON.stringify({ project, cards, identities, tags, texts, textIds, shapes, shapeIds, strokes, strokeIds }), 'utf8');
        const retainedBytes = [...this.snapshots.values()].reduce(
          (sum, value) => sum + value.bytes,
          0,
        );
        requireThat(
          bytes + retainedBytes <= (this.options.maxSnapshotBytes ?? 67_108_864),
          'SNAPSHOT_CAPACITY',
          '读取索引容量不足，请等待快照过期后重试',
          503,
        );
        state = {
          strokes, knownStrokeIds: new Set(strokeIds),
          shapes, knownShapeIds: new Set(shapeIds),
          texts, knownTextIds: new Set(textIds.map(value => value.id)),
          tags,
          project,
          cards,
          bytes,
          knownIds: new Set(identities.map((i) => i.id)),
          expiresAt: now + (this.options.snapshotTtlMs ?? 300_000),
        };
        this.snapshots.set(token, state);
      }
    }
    requireThat(state.project.id === query.projectId, 'INVALID_SNAPSHOT', '快照不属于此项目', 409);
    let items: CompactItem[] = state.cards
      .map((card, order) => ({
        id: card.id,
        type: 'thought' as const,
        title: card.title,
        versionId: card.versionId,
        order,
        body: {
          id: card.body.id,
          versionId: card.body.versionId,
          blockCount: card.body.blockCount,
          availability: 'not_fetched' as const,
        },
        item: card.item,
        ...(card.cardTags ? { cardTags: card.cardTags } : {}),
        ...(card.appearance ? { appearance: card.appearance } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let fidelity: CompactPage['fidelity'] = 'index';
    let availability: CompactPage['availability'] = 'available';
    let target: CompactPage['target'];
    const view = JSON.stringify([query.view, query.view === 'stroke-detail' ? query.strokeId : query.view === 'shape-detail' ? query.shapeId : query.view === 'text-detail' ? query.textId : query.view === 'body' || query.view === 'detail' ? query.cardId : null]);
    if (query.view === 'stroke-index') { items = state.strokes; fidelity = 'stroke-index'; }
    else if (query.view === 'stroke-detail') {
      const value = state.strokes.find(item => item.id === query.strokeId);
      fidelity = 'lossless_json_chunks';
      target = { strokeId: query.strokeId, ...(value ? { versionId: value.versionId } : {}) };
      items = value ? strokeDetail(this.db, query.projectId, value) : [];
      if (!value) availability = state.knownStrokeIds.has(query.strokeId) ? 'deleted' : 'not_found';
    }
    else if (query.view === 'shape-index') { items = state.shapes; fidelity = 'shape-index'; }
    else if (query.view === 'shape-detail') {
      const value = state.shapes.find(item => item.id === query.shapeId);
      fidelity = 'lossless_json_chunks';
      target = { shapeId: query.shapeId, ...(value ? { versionId: value.versionId } : {}) };
      items = value ? shapeDetail(this.db, query.projectId, value) : [];
      if (!value) availability = state.knownShapeIds.has(query.shapeId) ? 'deleted' : 'not_found';
    }
    else if (query.view === 'text-index') { items = state.texts; fidelity = 'text-index'; }
    else if (query.view === 'text-detail') {
      const value = state.texts.find(item => item.id === query.textId);
      fidelity = 'lossless_json_chunks';
      target = { cardId: query.textId };
      items = value ? textDetail(this.db, query.projectId, value) : [];
      if (!value) availability = state.knownTextIds.has(query.textId) ? 'deleted' : 'not_found';
    }
    else if (query.view === 'tags') { items = state.tags; fidelity = 'tags'; }
    else if (query.view !== 'index') {
      const card = state.cards.find((c) => c.id === query.cardId);
      if (!card) {
        availability = state.knownIds.has(query.cardId) ? 'deleted' : 'not_found';
        target = { cardId: query.cardId };
        fidelity = query.view === 'body' ? 'partial_body' : 'lossless_json_chunks';
        items = [];
      } else {
        const retained = this.db
          .prepare(
            "SELECT value FROM mapping_versions WHERE project_id=? AND domain='body' AND id=? AND version_id=?",
          )
          .get(query.projectId, card.body.id, card.body.versionId) as { value: string } | undefined;
        requireThat(
          retained,
          'SNAPSHOT_UNAVAILABLE',
          '固定正文版本不可读取，请保留缺口并重新开始',
          503,
        );
        const body = JSON.parse(retained.value) as Card['body'];
        target = { cardId: card.id, bodyId: card.body.id, versionId: card.body.versionId };
        if (query.view === 'body') {
          fidelity = 'partial_body';
          items = body.blocks.map((block): BodySlice => {
            const points = Array.from(blockPlainText(block));
            return {
              id: block.id,
              type: block.type,
              text: points.slice(0, 128).join(''),
              coverage: {
                returnedCodePoints: Math.min(128, points.length),
                totalCodePoints: points.length,
                complete: points.length <= 128,
              },
            };
          });
        } else {
          fidelity = 'lossless_json_chunks';
          const points = Array.from(JSON.stringify(body));
          items = [];
          for (let at = 0; at < points.length; at += 128) {
            const chunk: DetailChunk = {
              id: card.body.id,
              chunkIndex: at / 128,
              chunkCount: Math.ceil(points.length / 128),
              jsonText: points.slice(at, at + 128).join(''),
            };
            items.push(chunk);
          }
        }
      }
    }
    const start = this.pages.offset(query.cursor, token, view);
    return this.pages.page(
      {
        scope: { types: query.view === 'stroke-index' || query.view === 'stroke-detail' ? ['stroke'] : query.view === 'shape-index' || query.view === 'shape-detail' ? ['shape'] : query.view === 'text-index' || query.view === 'text-detail' ? ['text'] : ['thought'], relations: 'not_implemented', order: 'creation_ordinal' },
        project: state.project,
        snapshot: token,
        revision: state.project.revision,
        expiresAt: state.expiresAt,
        availability,
        budgetUnit: 'utf8_bytes',
        totalItems: items.length,
        fidelity,
        ...(target ? { target } : {}),
        summary: null,
      },
      items,
      start,
      query.budget,
      view,
    );
  }
}
