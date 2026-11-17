import type Database from 'better-sqlite3';
import { DomainError } from '../domain/errors.js';
import { assetHash } from './media.js';
import { SECRET_KEYS } from './secret-keys.js';
import { writeZip } from './zip-store.js';

const RECORD_QUERIES = {
  cards: 'SELECT c.value AS value FROM mapping_cards c JOIN mapping_card_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
  texts: 'SELECT value FROM mapping_texts WHERE project_id=? ORDER BY rowid',
  shapes: 'SELECT value FROM mapping_shapes WHERE project_id=? ORDER BY rowid',
  strokes: 'SELECT value FROM mapping_strokes WHERE project_id=? ORDER BY rowid',
  images: 'SELECT value FROM mapping_images WHERE project_id=? ORDER BY rowid',
  connectors: 'SELECT c.value AS value FROM mapping_connectors c JOIN mapping_connector_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
  frames: 'SELECT f.value AS value FROM mapping_frames f JOIN mapping_frame_ids i ON i.id=f.id WHERE f.project_id=? ORDER BY i.rowid',
  groups: 'SELECT g.value AS value FROM mapping_groups g JOIN mapping_group_ids i ON i.id=g.id WHERE g.project_id=? ORDER BY i.rowid',
  containment: 'SELECT value FROM mapping_containment WHERE project_id=? ORDER BY rowid',
  attachments: 'SELECT value FROM mapping_attachments WHERE project_id=? ORDER BY rowid',
  tags: 'SELECT value FROM mapping_tags WHERE project_id=? ORDER BY id',
} as const;

type RecordName = keyof typeof RECORD_QUERIES;
type JsonRecord = Record<string, unknown>;

function records(db: Database.Database, projectId: string, name: RecordName): { parsed: unknown[]; stored: { json: string }[] } {
  const rows = db.prepare(RECORD_QUERIES[name]).all(projectId) as { value: string }[];
  return {
    parsed: rows.map((row) => JSON.parse(row.value) as unknown),
    stored: rows.map((row) => ({ json: row.value })),
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;
  const copy: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (SECRET_KEYS.has(key)) continue;
    copy[key] = redactSecrets(child);
  }
  return copy;
}

function stackOf(mapping: {
  cards?: unknown[];
  texts?: unknown[];
  shapes?: unknown[];
  strokes?: unknown[];
  images?: unknown[];
}): { kind: string; id: string; createdOrder: number | null }[] {
  const rows: { kind: string; id: string; createdOrder: number | null }[] = [];
  const take = (kind: string, values: unknown[] | undefined) => {
    for (const value of values ?? []) {
      if (!value || typeof value !== 'object') continue;
      const record = value as JsonRecord;
      const item = record.item;
      if (!item || typeof item !== 'object' || typeof (item as JsonRecord).id !== 'string') continue;
      const order = (item as JsonRecord).createdOrder;
      rows.push({
        kind,
        id: String(record.id),
        createdOrder: typeof order === 'number' ? order : null,
      });
    }
  };
  take('card', mapping.cards);
  take('text', mapping.texts);
  take('shape', mapping.shapes);
  take('stroke', mapping.strokes);
  take('image', mapping.images);
  rows.sort((left, right) => {
    const leftOrder = left.createdOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.createdOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows;
}

function membershipOf(
  frames: unknown[],
  groups: unknown[],
  containment: unknown[],
): { frames: { id: string; memberItemIds: string[] }[]; groups: { id: string; memberItemIds: string[] }[] } {
  const rows = containment.filter((row): row is JsonRecord => !!row && typeof row === 'object');
  const members = (kind: string, id: string) =>
    rows
      .filter((row) => {
        const parent = row.parent;
        return !!parent && typeof parent === 'object' && (parent as JsonRecord).kind === kind && (parent as JsonRecord).id === id;
      })
      .map((row) => String(row.id));
  return {
    frames: frames.filter((frame): frame is JsonRecord => !!frame && typeof frame === 'object').map((frame) => ({
      id: String(frame.id),
      memberItemIds: members('frame', String(frame.id)),
    })),
    groups: groups.filter((group): group is JsonRecord => !!group && typeof group === 'object').map((group) => ({
      id: String(group.id),
      memberItemIds: members('group', String(group.itemId)),
    })),
  };
}

interface DraftResource {
  id: string;
  mime: string;
  bytes: Buffer;
}

function resourceDrafts(assets: unknown[], research: unknown): DraftResource[] {
  const drafts: DraftResource[] = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const record = asset as JsonRecord;
    if (typeof record.id !== 'string' || typeof record.mime !== 'string' || typeof record.base64 !== 'string' || record.base64.length === 0)
      continue;
    drafts.push({ id: record.id, mime: record.mime, bytes: Buffer.from(record.base64, 'base64') });
  }
  const files = research && typeof research === 'object' ? (research as JsonRecord).files : undefined;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const record = file as JsonRecord;
      if (typeof record.id !== 'string' || typeof record.base64 !== 'string' || record.base64.length === 0) continue;
      drafts.push({
        id: `research:${record.id}`,
        mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
        bytes: Buffer.from(record.base64, 'base64'),
      });
    }
  }
  drafts.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return drafts;
}

export function buildFullPackage(db: Database.Database, projectId: string, exportedAt: string, research?: unknown): Buffer {
  const project = db
    .prepare('SELECT id, name, version_id AS versionId, revision FROM mapping_projects WHERE id=?')
    .get(projectId) as { id: string; name: string; versionId: string; revision: number } | undefined;
  if (!project) throw new DomainError('NOT_FOUND', '项目不存在', 404);
  const archived = db.prepare('SELECT research, extensions FROM mapping_import_archive WHERE project_id=?').get(projectId) as { research: string; extensions: string } | undefined;
  const effectiveResearch = research === undefined ? (archived ? (JSON.parse(archived.research) as unknown) : null) : research ?? null;
  const extensions = archived ? (JSON.parse(archived.extensions) as unknown) ?? {} : {};
  const loaded = Object.fromEntries(
    (Object.keys(RECORD_QUERIES) as RecordName[]).map((name) => [name, records(db, projectId, name)]),
  ) as Record<RecordName, { parsed: unknown[]; stored: { json: string }[] }>;
  const assets = (db.prepare('SELECT value FROM mapping_assets WHERE project_id=? ORDER BY id').all(projectId) as { value: string }[]).map(
    (row) => JSON.parse(row.value) as unknown,
  );
  const versions = (
    db
      .prepare('SELECT domain, id, version_id AS versionId, value FROM mapping_versions WHERE project_id=? ORDER BY domain, id, version_id')
      .all(projectId) as { domain: string; id: string; versionId: string; value: string }[]
  ).map((row) => ({
    domain: row.domain,
    id: row.id,
    versionId: row.versionId,
    value: JSON.parse(row.value) as unknown,
    json: row.value,
  }));
  const historyRow = db.prepare('SELECT value FROM mapping_history WHERE project_id=?').get(projectId) as { value: string } | undefined;
  const history = redactSecrets(historyRow ? JSON.parse(historyRow.value) : { undo: [], redo: [] });
  const changes = (
    db.prepare('SELECT revision, receipt FROM mapping_changes WHERE project_id=? ORDER BY revision').all(projectId) as {
      revision: number;
      receipt: string;
    }[]
  ).map((row) => ({ revision: row.revision, receipt: redactSecrets(JSON.parse(row.receipt) as unknown) }));
  const mappingRecords = Object.fromEntries((Object.keys(RECORD_QUERIES) as RecordName[]).map((name) => [name, loaded[name].parsed]));
  const drafts = resourceDrafts(assets, effectiveResearch);
  const resources = drafts.map((draft, index) => {
    const sha256 = assetHash(draft.bytes);
    return {
      id: draft.id,
      mime: draft.mime,
      sha256,
      path: `resources/${String(index).padStart(4, '0')}-${sha256}`,
      bytes: draft.bytes,
    };
  });
  const manifest = {
    format: 'forkwise-project' as const,
    schemaVersion: 2 as const,
    exportedAt,
    projectId: project.id,
    revision: project.revision,
    research: effectiveResearch,
    mapping: {
      project,
      ...mappingRecords,
      assets,
      versions: versions.map(({ domain, id, versionId, value }) => ({ domain, id, versionId, value })),
      history,
      changes,
      membership: membershipOf(loaded.frames.parsed, loaded.groups.parsed, loaded.containment.parsed),
      stack: stackOf(mappingRecords),
      stored: {
        ...Object.fromEntries((Object.keys(RECORD_QUERIES) as RecordName[]).map((name) => [name, loaded[name].stored])),
        versions: versions.map(({ domain, id, versionId, json }) => ({ domain, id, versionId, json })),
      },
    },
    resources: resources.map(({ id, mime, sha256, path }) => ({ id, mime, sha256, path })),
    extensions,
  };
  return writeZip([
    { name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(manifest)) },
    ...resources.map((resource) => ({ name: resource.path, data: resource.bytes })),
  ]);
}
