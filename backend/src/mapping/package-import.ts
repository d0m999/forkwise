import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import { buildFullPackage } from './full-package.js';
import { inspectPackage, isRecord, type PackageFailure, type VerifiedPackage } from './package-verify.js';

type Json = Record<string, unknown>;
type Kind = 'card' | 'text' | 'shape' | 'stroke' | 'image' | 'connector' | 'frame' | 'group' | 'tag';

type CollectionName = 'cards' | 'texts' | 'shapes' | 'strokes' | 'images' | 'connectors' | 'frames' | 'groups' | 'containment' | 'attachments' | 'tags';

const KIND_COLLECTION: Record<Kind, CollectionName> = {
  card: 'cards', text: 'texts', shape: 'shapes', stroke: 'strokes', image: 'images',
  connector: 'connectors', frame: 'frames', group: 'groups', tag: 'tags',
};

const KIND_TABLES: Record<Exclude<Kind, 'tag'>, { ids: string; rows: string }> = {
  card: { ids: 'mapping_card_ids', rows: 'mapping_cards' },
  text: { ids: 'mapping_text_ids', rows: 'mapping_texts' },
  shape: { ids: 'mapping_shape_ids', rows: 'mapping_shapes' },
  stroke: { ids: 'mapping_stroke_ids', rows: 'mapping_strokes' },
  image: { ids: 'mapping_image_ids', rows: 'mapping_images' },
  connector: { ids: 'mapping_connector_ids', rows: 'mapping_connectors' },
  frame: { ids: 'mapping_frame_ids', rows: 'mapping_frames' },
  group: { ids: 'mapping_group_ids', rows: 'mapping_groups' },
};

const VERSION_KIND: Record<string, Kind> = {
  tag: 'tag', shape: 'shape', stroke: 'stroke', image: 'image',
  connector: 'connector', group: 'group', frame: 'frame', text: 'text',
};

export interface ImportCounts {
  cards: number;
  texts: number;
  shapes: number;
  strokes: number;
  images: number;
  connectors: number;
  frames: number;
  groups: number;
  containment: number;
  attachments: number;
  tags: number;
}

export interface ImportPreview {
  suggestedName: string;
  sourceProjectId: string;
  sourceRevision: number;
  counts: ImportCounts;
  versions: number;
  resources: number;
  hasResearch: boolean;
  extensionKeys: string[];
  undoDepth: number;
  redoDepth: number;
  failures: PackageFailure[];
  gaps: string[];
}

function packageError(message: string, failures: PackageFailure[]): DomainError {
  return new DomainError('INVALID_PACKAGE', message, 400, { failures });
}

export function decodeArchive(base64: string): Buffer {
  if (typeof base64 !== 'string' || base64.length === 0)
    throw packageError('完整项目包请求缺少文件内容', [{ code: 'PACKAGE_BASE64', path: 'payload.base64', expected: 'non-empty base64', actual: typeof base64 }]);
  return Buffer.from(base64, 'base64');
}

function arrayOf(map: Json | undefined, name: string): unknown[] {
  const value = map?.[name];
  return Array.isArray(value) ? value : [];
}

function recordsOf(value: Json, name: string): Json[] {
  const entries = value[name];
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function omissionGap(kind: '原件' | '材料原文', entries: Json[], missing: (entry: Json) => boolean): string[] {
  const omitted = entries.filter(missing);
  if (!omitted.length) return [];
  const labels = omitted.map((entry) => (typeof entry.name === 'string' && entry.name ? entry.name : typeof entry.id === 'string' ? entry.id : '未命名'));
  const reasons = [...new Set(omitted.map((entry) => (typeof entry.omission === 'string' && entry.omission ? entry.omission : '未说明原因')))];
  return [`旧研究归档有 ${omitted.length} 份${kind}未随包提供，只保留索引：${labels.join('、')}；原因：${reasons.join('；')}。`];
}

export function previewImport(base64: string): ImportPreview {
  const inspection = inspectPackage(decodeArchive(base64));
  const manifest = inspection.ok ? inspection.manifest : undefined;
  const mapping = (manifest?.mapping && typeof manifest.mapping === 'object' ? manifest.mapping : undefined) as Json | undefined;
  const project = (mapping?.project && typeof mapping.project === 'object' ? mapping.project : undefined) as Json | undefined;
  const counts = {
    cards: arrayOf(mapping, 'cards').length,
    texts: arrayOf(mapping, 'texts').length,
    shapes: arrayOf(mapping, 'shapes').length,
    strokes: arrayOf(mapping, 'strokes').length,
    images: arrayOf(mapping, 'images').length,
    connectors: arrayOf(mapping, 'connectors').length,
    frames: arrayOf(mapping, 'frames').length,
    groups: arrayOf(mapping, 'groups').length,
    containment: arrayOf(mapping, 'containment').length,
    attachments: arrayOf(mapping, 'attachments').length,
    tags: arrayOf(mapping, 'tags').length,
  };
  const research = manifest?.research ?? null;
  const extensions = (manifest?.extensions && typeof manifest.extensions === 'object' && !Array.isArray(manifest.extensions) ? manifest.extensions : {}) as Json;
  const history = (mapping?.history && typeof mapping.history === 'object' ? mapping.history : {}) as Json;
  const gaps: string[] = [];
  if (manifest && research === null) gaps.push('包内没有旧研究归档（research: null）；旧研究记录不会出现在这次导入中。');
  if (isRecord(research)) {
    gaps.push(
      ...omissionGap('原件', recordsOf(research, 'files'), (file) => typeof file.base64 !== 'string' || !file.base64),
      ...omissionGap('材料原文', recordsOf(research, 'materials'), (material) => material.text === null),
    );
  }
  const archive = isRecord(mapping?.archive) ? mapping.archive : null;
  if (archive) {
    const archivedHistory = isRecord(archive.history) ? archive.history : {};
    const archivedUndo = Array.isArray(archivedHistory.undo) ? archivedHistory.undo.length : 0;
    const archivedRedo = Array.isArray(archivedHistory.redo) ? archivedHistory.redo.length : 0;
    const archivedChanges = Array.isArray(archive.changes) ? archive.changes.length : 0;
    if (archivedUndo + archivedRedo + archivedChanges > 0)
      gaps.push(`包内还带有更早的历史归档（${archivedChanges} 条变更、${archivedUndo + archivedRedo} 条撤销记录），只作为不可执行的归档保留。`);
  }
  const extensionKeys = Object.keys(extensions);
  if (extensionKeys.length) gaps.push(`本版不解释这些扩展：${extensionKeys.join('、')}。扩展内容原样保留。`);
  const undo = Array.isArray(history.undo) ? history.undo.length : 0;
  const redo = Array.isArray(history.redo) ? history.redo.length : 0;
  if (undo + redo > 0) gaps.push(`包内撤销记录 ${undo + redo} 条不恢复为可继续撤销的步骤；新项目的可执行历史从空栈开始。`);
  return {
    suggestedName: typeof project?.name === 'string' && project.name ? project.name.slice(0, 240) : '',
    sourceProjectId: typeof manifest?.projectId === 'string' ? manifest.projectId : '',
    sourceRevision: typeof manifest?.revision === 'number' ? manifest.revision : 0,
    counts,
    versions: arrayOf(mapping, 'versions').length,
    resources: Array.isArray(manifest?.resources) ? manifest.resources.length : 0,
    hasResearch: research !== null,
    extensionKeys,
    undoDepth: undo,
    redoDepth: redo,
    failures: inspection.failures,
    gaps,
  };
}

interface IdentityMaps {
  byKind: Record<Kind, Map<string, string>>;
  itemIds: Set<string>;
}

function collectIdentities(mapping: Json): IdentityMaps {
  const byKind = Object.fromEntries((Object.keys(KIND_COLLECTION) as Kind[]).map((kind) => [kind, new Map<string, string>()])) as Record<Kind, Map<string, string>>;
  for (const kind of Object.keys(KIND_COLLECTION) as Kind[]) {
    for (const value of arrayOf(mapping, KIND_COLLECTION[kind])) {
      if (!value || typeof value !== 'object') continue;
      const id = (value as Json).id;
      if (typeof id !== 'string' || !id) continue;
      if (!byKind[kind].has(id)) byKind[kind].set(id, randomUUID());
    }
  }
  const itemIds = new Set<string>();
  for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images'] as const) {
    for (const value of arrayOf(mapping, name)) {
      if (!value || typeof value !== 'object') continue;
      const item = (value as Json).item;
      if (item && typeof item === 'object' && typeof (item as Json).id === 'string') itemIds.add((item as Json).id as string);
    }
  }
  return { byKind, itemIds };
}

function mapped(ids: IdentityMaps, kind: Kind, id: unknown): string | undefined {
  return typeof id === 'string' ? ids.byKind[kind].get(id) : undefined;
}

function keepMapped(ids: IdentityMaps, kind: Kind, id: unknown): unknown {
  if (typeof id !== 'string') return id;
  return ids.byKind[kind].get(id) ?? id;
}

function derived(cardId: string, kind: 'appearance' | 'cardTags' | 'attachments', current: unknown): string {
  if (typeof current === 'string' && current.startsWith(`${kind}:`)) return `${kind}:${cardId}`;
  return typeof current === 'string' ? current : `${kind}:${cardId}`;
}

function derivedFromVersion(ids: IdentityMaps, kind: 'appearance' | 'cardTags' | 'attachments', id: unknown): unknown {
  if (typeof id !== 'string') return id;
  const prefix = `${kind}:`;
  if (!id.startsWith(prefix)) return id;
  const oldCardId = id.slice(prefix.length);
  const next = ids.byKind.card.get(oldCardId);
  return next ? `${prefix}${next}` : id;
}

function rewriteEndpoint(value: unknown, ids: IdentityMaps): unknown {
  if (!value || typeof value !== 'object') return value;
  const endpoint = value as Json;
  if (endpoint.kind !== 'bound' || endpoint.targetKind !== 'frame') return value;
  return { ...endpoint, itemId: keepMapped(ids, 'frame', endpoint.itemId) };
}

function rewriteContainment(value: Json, ids: IdentityMaps): Json {
  const member = typeof value.id === 'string' && !ids.itemIds.has(value.id) && ids.byKind.frame.has(value.id)
    ? mapped(ids, 'frame', value.id)!
    : value.id;
  const parent = value.parent as Json | null | undefined;
  return {
    ...value,
    id: member,
    ...(parent && parent.kind === 'frame' ? { parent: { ...parent, id: keepMapped(ids, 'frame', parent.id) } } : {}),
  };
}

function rewriteCard(value: Json, ids: IdentityMaps): Json {
  const cardId = String(mapped(ids, 'card', value.id) ?? value.id);
  const next: Json = { ...value, id: cardId };
  const cardTags = value.cardTags as Json | undefined;
  if (cardTags) next.cardTags = { ...cardTags, id: derived(cardId, 'cardTags', cardTags.id), tagIds: Array.isArray(cardTags.tagIds) ? cardTags.tagIds.map((id) => keepMapped(ids, 'tag', id)) : cardTags.tagIds };
  const appearance = value.appearance as Json | undefined;
  if (appearance) next.appearance = { ...appearance, id: derived(cardId, 'appearance', appearance.id) };
  const attachments = value.attachments as Json | undefined;
  if (attachments) next.attachments = { ...attachments, id: derived(cardId, 'attachments', attachments.id) };
  return next;
}

function rewriteRecord(kind: Kind, value: Json, ids: IdentityMaps): Json {
  if (kind === 'card') return rewriteCard(value, ids);
  if (kind === 'connector') return { ...value, id: mapped(ids, kind, value.id) ?? value.id, start: rewriteEndpoint(value.start, ids), end: rewriteEndpoint(value.end, ids) };
  return { ...value, id: mapped(ids, kind, value.id) ?? value.id };
}

function rewriteVersion(value: Json, ids: IdentityMaps): Json {
  const domain = typeof value.domain === 'string' ? value.domain : '';
  if (domain === 'containment') {
    const content = value.value && typeof value.value === 'object' ? rewriteContainment(value.value as Json, ids) : value.value;
    return { ...value, id: content && typeof content === 'object' ? (content as Json).id : value.id, value: content };
  }
  if (domain === 'appearance' || domain === 'cardTags' || domain === 'attachments') {
    const id = derivedFromVersion(ids, domain, value.id);
    let content = value.value;
    if (content && typeof content === 'object') {
      const record = content as Json;
      content = { ...record, id: derivedFromVersion(ids, domain, record.id) };
      if (domain === 'cardTags' && Array.isArray(record.tagIds)) content = { ...(content as Json), tagIds: record.tagIds.map((tagId) => keepMapped(ids, 'tag', tagId)) };
    }
    return { ...value, id, value: content };
  }
  const kind = VERSION_KIND[domain];
  if (!kind) return value;
  const id = mapped(ids, kind, value.id) ?? value.id;
  let content = value.value;
  if (content && typeof content === 'object') {
    const record = content as Json;
    content = { ...record, ...(('id' in record) ? { id } : {}) };
    if (domain === 'connector') content = { ...(content as Json), start: rewriteEndpoint(record.start, ids), end: rewriteEndpoint(record.end, ids) };
  }
  return { ...value, id, value: content };
}

function rewriteResearch(value: unknown, projectId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const research = value as Json;
  const project = research.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) return value;
  return { ...research, project: { ...(project as Json), id: projectId } };
}

function assetRows(mapping: Json, files: Map<string, Buffer>, resources: Json[]): { id: string; value: string }[] {
  const byId = new Map<string, Json>();
  for (const resource of resources) {
    if (resource && typeof resource === 'object' && typeof (resource as Json).id === 'string') byId.set((resource as Json).id as string, resource as Json);
  }
  const rows: { id: string; value: string }[] = [];
  for (const value of arrayOf(mapping, 'assets')) {
    if (!value || typeof value !== 'object') continue;
    const asset = { ...(value as Json) };
    const resource = typeof asset.id === 'string' ? byId.get(asset.id) : undefined;
    const bytes = resource && typeof resource.path === 'string' ? files.get(resource.path) : undefined;
    if (bytes) asset.base64 = bytes.toString('base64');
    rows.push({ id: String(asset.id), value: JSON.stringify(asset) });
  }
  return rows;
}

export interface ImportRequest {
  projectId: string;
  name: string;
  archive: Buffer;
}

export function importPackage(db: Database.Database, request: ImportRequest): { revision: number } {
  // 提交时仍独立完整校验一次，不沿用预览结果；ZIP 由调用方解码后传入。
  const inspection = inspectPackage(request.archive);
  if (!inspection.ok || inspection.failures.length)
    throw packageError('完整项目包校验未通过；未创建新研究', inspection.failures);
  const verified: VerifiedPackage = inspection;
  const manifest = verified.manifest;
  const mapping = manifest.mapping as Json;
  const ids = collectIdentities(mapping);
  const sourceName = request.name;
  if (!sourceName) throw packageError('新研究名称不能为空', [{ code: 'NAME', path: 'payload.name', expected: 'non-empty', actual: '' }]);
  if (db.prepare('SELECT 1 FROM mapping_projects WHERE id=?').get(request.projectId))
    throw new DomainError('ID_CONFLICT', '身份已使用，请重新创建', 409);

  const versionId = randomUUID();
  db.prepare('INSERT INTO mapping_projects VALUES(?,?,?,1)').run(request.projectId, sourceName, versionId);

  const idStatements = new Map(Object.values(KIND_TABLES).map((table) => [table.ids, db.prepare(`INSERT INTO ${table.ids} VALUES(?,?)`)]));
  const rowStatements = new Map(Object.values(KIND_TABLES).map((table) => [table.rows, db.prepare(`INSERT INTO ${table.rows} VALUES(?,?,?)`)]));
  const insertId = (table: string, id: string) => idStatements.get(table)!.run(id, request.projectId);
  const cards = arrayOf(mapping, 'cards').map((value) => rewriteCard(value as Json, ids));
  for (const card of cards) {
    insertId(KIND_TABLES.card.ids, String(card.id));
    rowStatements.get(KIND_TABLES.card.rows)!.run(String(card.id), request.projectId, JSON.stringify(card));
  }
  for (const kind of ['text', 'shape', 'stroke', 'image', 'connector', 'frame', 'group'] as const) {
    const tables = KIND_TABLES[kind];
    for (const value of arrayOf(mapping, KIND_COLLECTION[kind])) {
      const record = rewriteRecord(kind, value as Json, ids);
      insertId(tables.ids, String(record.id));
      rowStatements.get(tables.rows)!.run(String(record.id), request.projectId, JSON.stringify(record));
    }
  }
  for (const value of arrayOf(mapping, 'containment')) {
    const row = rewriteContainment(value as Json, ids);
    db.prepare('INSERT INTO mapping_containment VALUES(?,?,?)').run(request.projectId, String(row.id), JSON.stringify(row));
  }
  for (const value of arrayOf(mapping, 'attachments'))
    db.prepare('INSERT INTO mapping_attachments VALUES(?,?,?)').run(request.projectId, String((value as Json).id), JSON.stringify(value));
  for (const value of arrayOf(mapping, 'tags')) {
    const tag = rewriteRecord('tag', value as Json, ids);
    db.prepare('INSERT INTO mapping_tags VALUES(?,?,?)').run(String(tag.id), request.projectId, JSON.stringify(tag));
  }
  for (const row of assetRows(mapping, verified.files, Array.isArray(manifest.resources) ? manifest.resources as Json[] : []))
    db.prepare('INSERT INTO mapping_assets VALUES(?,?,?)').run(request.projectId, row.id, row.value);
  for (const value of arrayOf(mapping, 'versions')) {
    const version = rewriteVersion(value as Json, ids);
    db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run(request.projectId, String(version.domain), String(version.id), String(version.versionId), JSON.stringify(version.value));
  }

  const research = rewriteResearch(manifest.research, request.projectId);
  const extensions = manifest.extensions ?? {};
  // 旧包带来的历史归档原样转存；只有首次导入才把包内的活历史当作归档。
  const archive = isRecord(mapping.archive)
    ? { history: mapping.archive.history, changes: mapping.archive.changes }
    : { history: mapping.history ?? { undo: [], redo: [] }, changes: mapping.changes ?? [] };
  db.prepare('INSERT INTO mapping_import_archive VALUES(?,?,?,?,?)').run(
    request.projectId,
    JSON.stringify(research),
    JSON.stringify(archive.history),
    JSON.stringify(archive.changes),
    JSON.stringify(extensions),
  );
  const editTimes = db.prepare('INSERT INTO mapping_import_edit_times VALUES(?,?,?)');
  // 形状已由 inspectPackage 的 EDIT_TIMES 检查保证；只按新卡号落库，已删除的卡不再保留时间（ADR 0032）。
  for (const row of arrayOf(mapping, 'editTimes') as { cardId: string; editedAt: string }[]) {
    const cardId = ids.byKind.card.get(row.cardId);
    if (cardId) editTimes.run(request.projectId, cardId, row.editedAt);
  }
  db.prepare('INSERT INTO mapping_history VALUES(?,?)').run(request.projectId, JSON.stringify({ undo: [], redo: [] }));

  let closureFailures: PackageFailure[] = [];
  try {
    const closure = inspectPackage(buildFullPackage(db, request.projectId, new Date().toISOString()));
    closureFailures = [...closure.failures];
    if (closure.ok) {
      const current = closure.manifest.mapping as Json;
      for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images', 'connectors', 'frames', 'groups', 'containment', 'attachments', 'tags', 'versions'] as const) {
        const expected = arrayOf(mapping, name).length;
        const actual = arrayOf(current, name).length;
        if (expected !== actual)
          closureFailures.push({ code: 'COUNT', path: `mapping.${name}`, expected: String(expected), actual: String(actual) });
      }
    }
  } catch (error) {
    closureFailures = [{ code: 'CLOSURE_EXCEPTION', path: 'package', expected: 'reexportable project', actual: error instanceof Error ? error.message : 'unknown' }];
  }
  if (closureFailures.length)
    throw new DomainError('IMPORT_CLOSURE_FAILED', '导入后的引用闭合未通过；未创建新研究', 422, { failures: closureFailures });
  return { revision: 1 };
}
