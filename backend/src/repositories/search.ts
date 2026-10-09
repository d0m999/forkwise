import { isImageCitation } from '../contracts/entities.js';
import type { AnyEntity } from '../contracts/entities.js';
import type { ResearchRepository } from './research.js';
import { requireThat } from '../domain/errors.js';

interface Chunk {
  rowid: number;
  projectId: string;
  entityId: string;
  versionId: string;
  kind: string;
  offset: number;
  text: string;
}
function* chunks(text: string) {
  for (let offset = 0; offset < text.length; offset += 900) {
    let start = offset,
      end = Math.min(offset + 1000, text.length);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end++;
    yield { offset: start, text: text.slice(start, end) };
  }
}
export class SearchRepository {
  constructor(readonly repo: ResearchRepository) {}
  index(changed: AnyEntity[], texts: Map<string, string>): void {
    const insert = this.repo.db.prepare(
      'INSERT OR IGNORE INTO search_chunks(project_id,entity_id,version_id,kind,offset,text) VALUES(?,?,?,?,?,?)',
    );
    for (const entity of changed) {
      if (entity.deletedAt) continue;
      let text = '';
      switch (entity.kind) {
        case 'statement':
          text = entity.data.text;
          break;
        case 'inference':
          text = entity.data.reason;
          break;
        case 'evidence':
          text = isImageCitation(entity.data.citation) ? '' : entity.data.citation.quote;
          break;
        case 'note':
          text = entity.data.text;
          break;
        case 'verification_node':
          text = [entity.data.event, entity.data.goal, entity.data.period]
            .filter(Boolean)
            .join('\n');
          break;
        case 'source_version':
          text = texts.get(entity.id) ?? this.repo.material(entity.projectId, entity.id);
          break;
      }
      for (const chunk of chunks(text))
        insert.run(
          entity.projectId,
          entity.id,
          entity.versionId,
          entity.kind,
          chunk.offset,
          chunk.text,
        );
    }
  }
  ensureMaterialIndex(entity: AnyEntity, text: string) {
    requireThat(entity.kind === 'source_version', 'INVALID_MATERIAL', '仅可重建材料版本的派生索引');
    const expected = [...chunks(text)];
    const saved = this.repo.db
      .prepare(
        'SELECT offset,text FROM search_chunks WHERE project_id=? AND version_id=? ORDER BY offset',
      )
      .all(entity.projectId, entity.versionId) as { offset: number; text: string }[];
    if (
      saved.length === expected.length &&
      saved.every(
        (chunk, i) => chunk.offset === expected[i]!.offset && chunk.text === expected[i]!.text,
      )
    )
      return;
    this.repo.db
      .transaction(() => {
        this.repo.db
          .prepare(
            'DELETE FROM embeddings WHERE chunk_id IN (SELECT rowid FROM search_chunks WHERE project_id=? AND version_id=?)',
          )
          .run(entity.projectId, entity.versionId);
        this.repo.db
          .prepare('DELETE FROM search_chunks WHERE project_id=? AND version_id=?')
          .run(entity.projectId, entity.versionId);
        this.index([entity], new Map([[entity.id, text]]));
      })
      .immediate();
  }
  search(
    projectId: string,
    query: string,
    asOf?: string,
    vector?: { model: string; values: number[] },
  ) {
    const objects = this.repo.snapshot(projectId, asOf).objects;
    const restrictedSources = new Set(
      objects.filter((e) => e.kind === 'source' && e.data.rights === 'restricted').map((e) => e.id),
    );
    const restrictedMaterials = new Set(
      objects
        .filter((e) => e.kind === 'source_version' && restrictedSources.has(e.data.sourceId))
        .map((e) => e.id),
    );
    const allowed = new Set(
      objects
        .filter(
          (e) =>
            !(e.kind === 'source_version' && restrictedMaterials.has(e.id)) &&
            !(e.kind === 'evidence' && restrictedMaterials.has(e.data.citation.sourceVersionId)),
        )
        .map((e) => e.versionId),
    );
    const term = query.trim();
    requireThat(term.length > 0 && term.length <= 2000, 'INVALID_QUERY', '请输入有效查询');
    const columns =
      'c.rowid,c.project_id AS projectId,c.entity_id AS entityId,c.version_id AS versionId,c.kind,c.offset,c.text';
    let rows: Chunk[];
    if ([...term].length >= 3)
      rows = this.repo.db
        .prepare(
          `SELECT ${columns} FROM search_chunks c JOIN search_fts f ON f.rowid=c.rowid
      WHERE c.project_id=? AND c.version_id IN (SELECT value FROM json_each(?)) AND search_fts MATCH ? ORDER BY rank LIMIT 500`,
        )
        .all(
          projectId,
          JSON.stringify([...allowed]),
          '"' + term.replaceAll('"', '""') + '"',
        ) as Chunk[];
    else
      rows = this.repo.db
        .prepare(
          `SELECT ${columns} FROM search_chunks c WHERE c.project_id=? AND c.version_id IN (SELECT value FROM json_each(?))
      AND instr(c.text,?)>0 ORDER BY c.rowid DESC LIMIT 500`,
        )
        .all(projectId, JSON.stringify([...allowed]), term) as Chunk[];
    const scores = new Map<number, { chunk: Chunk; score: number }>();
    rows
      .filter((c) => allowed.has(c.versionId))
      .forEach((chunk, i) => scores.set(chunk.rowid, { chunk, score: 1 / (60 + i + 1) }));
    let mode: 'full_text' | 'hybrid' = 'full_text';
    if (vector) {
      this.validateVector(vector.values);
      const candidates = this.repo.db
        .prepare(
          `SELECT ${columns},e.vector FROM search_chunks c JOIN embeddings e ON e.chunk_id=c.rowid
        WHERE c.project_id=? AND e.model=? AND e.dimension=?`,
        )
        .all(projectId, vector.model, vector.values.length) as (Chunk & { vector: string })[];
      const ranked = candidates
        .filter((c) => allowed.has(c.versionId))
        .map((c) => ({ c, similarity: cosine(vector.values, JSON.parse(c.vector) as number[]) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 100);
      if (ranked.length) mode = 'hybrid';
      ranked.forEach(({ c }, i) => {
        const old = scores.get(c.rowid);
        scores.set(c.rowid, { chunk: c, score: (old?.score ?? 0) + 1 / (60 + i + 1) });
      });
    }
    return {
      mode,
      results: [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map(({ chunk, score }) => ({
          chunkId: chunk.rowid,
          entityId: chunk.entityId,
          versionId: chunk.versionId,
          kind: chunk.kind,
          start: chunk.offset,
          end: chunk.offset + chunk.text.length,
          text: chunk.text,
          retrievalScore: score,
        })),
    };
  }
  embed(projectId: string, chunkId: number, model: string, values: number[]): void {
    this.repo.project(projectId);
    this.validateVector(values);
    requireThat(
      model.trim().length > 0 && model.length <= 200,
      'INVALID_MODEL',
      '需要具体 embedding 模型标识',
    );
    const chunk = this.repo.db
      .prepare('SELECT rowid FROM search_chunks WHERE project_id=? AND rowid=?')
      .get(projectId, chunkId);
    requireThat(chunk, 'CHUNK_NOT_FOUND', '检索片段不属于此项目', 404);
    this.repo.db
      .prepare(
        'INSERT INTO embeddings(chunk_id,model,dimension,vector) VALUES(?,?,?,?) ON CONFLICT(chunk_id,model) DO UPDATE SET dimension=excluded.dimension,vector=excluded.vector',
      )
      .run(chunkId, model, values.length, JSON.stringify(values));
  }
  materialChunks(projectId: string, versionId: string, queries: string[]) {
    const selected = new Map<number, { chunk: Chunk; score: number }>();
    let candidateLimitReached = false;
    const columns =
      'c.rowid,c.project_id AS projectId,c.entity_id AS entityId,c.version_id AS versionId,c.kind,c.offset,c.text';
    for (const term of new Set(queries)) {
      const rows = (
        [...term].length >= 3
          ? this.repo.db
              .prepare(
                `SELECT ${columns} FROM search_chunks c JOIN search_fts f ON f.rowid=c.rowid
            WHERE c.project_id=? AND c.version_id=? AND c.kind='source_version' AND search_fts MATCH ? ORDER BY rank,c.offset LIMIT 201`,
              )
              .all(projectId, versionId, '"' + term.replaceAll('"', '""') + '"')
          : this.repo.db
              .prepare(
                `SELECT ${columns} FROM search_chunks c
            WHERE c.project_id=? AND c.version_id=? AND c.kind='source_version' AND instr(c.text,?)>0 ORDER BY c.offset LIMIT 201`,
              )
              .all(projectId, versionId, term)
      ) as Chunk[];
      candidateLimitReached ||= rows.length > 200;
      rows.slice(0, 200).forEach((chunk, rank) => {
        const prior = selected.get(chunk.rowid);
        selected.set(chunk.rowid, { chunk, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) });
      });
    }
    return {
      candidateLimitReached,
      chunks: [...selected.values()]
        .sort((a, b) => b.score - a.score || a.chunk.offset - b.chunk.offset)
        .map(({ chunk }) => chunk),
    };
  }
  private validateVector(values: number[]) {
    const norm = Math.hypot(...values);
    requireThat(
      values.length > 0 &&
        values.length <= 8192 &&
        values.every(Number.isFinite) &&
        Number.isFinite(norm) &&
        norm > 0,
      'INVALID_VECTOR',
      '向量须为有限、非零且维数有效的数值数组',
    );
  }
}
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const x = Math.hypot(...a),
    y = Math.hypot(...b);
  for (let i = 0; i < a.length; i++) dot += (a[i]! / x) * (b[i]! / y);
  return dot;
}
