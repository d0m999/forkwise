import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { requireThat } from '../domain/errors.js';
import { isRestrictedCanvasImage } from '../services/redact-canvas.js';
import type { AssetChange, Project } from './contracts.js';
import { assetHash, readAsset, verifyAssetBytes } from './media.js';
import { validImage } from './media-blocks.js';
import { isRecord, verifyConnectorTargets, verifyProjectRecords, type PackageFailure } from './package-verify.js';
import { OrganizeArchiveImportCheck } from './organize-archive.js';
import type { OrganizeTask } from './organize-contracts.js';
import { VerificationBinding } from './verification-contracts.js';
import { invalidVerificationReferences, verificationReferences, type VerificationReference } from './verification-evidence.js';
import { matchesVerificationBinding, verificationBindingVersion } from './versions.js';
import { readProjectState } from './project-state.js';
import { WORKSPACE_APPLICATION_ID, WORKSPACE_DATABASE_VERSION } from './workspace-storage-contract.js';

type History = Record<'undo' | 'redo', { session: string; assetChanges?: AssetChange[] }[]>;

function workspaceSchema(db: Database.Database) {
  return JSON.stringify(db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
  ).all());
}

function records(values: unknown) {
  return Array.isArray(values) ? values.filter(isRecord) : [];
}

function checkArchivedResearch(archive: Record<string, unknown>) {
  requireThat(!records(archive.tasks).some(task => task.runToken != null),
    'BACKUP_SESSIONS', '备份中的旧研究归档含任务运行凭据');
  const objects = records(archive.objects);
  const restricted = new Set(objects.flatMap(object =>
    object.kind === 'source' && typeof object.id === 'string' && isRecord(object.data) && object.data.rights === 'restricted'
      ? [object.id] : []));
  const unavailable = new Set(objects.flatMap(object =>
    object.kind === 'source_version' && typeof object.id === 'string' && isRecord(object.data) &&
      typeof object.data.sourceId === 'string' && restricted.has(object.data.sourceId) ? [object.id] : []));
  const rightsNotice = '旧研究归档含有权利限制的原文，无法生成或恢复此备份';
  requireThat(!records(archive.artifacts).some(artifact => typeof artifact.sourceVersionId === 'string' && unavailable.has(artifact.sourceVersionId)),
    'BACKUP_RESTRICTED_RESEARCH', rightsNotice);
  // Match the v1 exporter's known citation, artifact and source-text forms
  // wherever they are retained in the v1 archive's versions or task results.
  const pending: unknown[] = unavailable.size ? [archive] : [];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isRecord(value)) {
      const blocked = typeof value.sourceVersionId === 'string' && unavailable.has(value.sourceVersionId);
      if (blocked && ('quote' in value || value.kind === 'image')) {
        requireThat(value.unavailableReason === 'rights' && (!('quote' in value) || value.quote === ''),
          'BACKUP_RESTRICTED_RESEARCH', rightsNotice);
      } else if (blocked && 'artifact' in value) {
        requireThat(value.artifact === null && typeof value.omission === 'string' && value.omission,
          'BACKUP_RESTRICTED_RESEARCH', rightsNotice);
      } else if (typeof value.id === 'string' && unavailable.has(value.id) && 'text' in value) {
        requireThat(value.text === null && typeof value.omission === 'string' && value.omission,
          'BACKUP_RESTRICTED_RESEARCH', rightsNotice);
      }
      for (const item of Object.values(value)) pending.push(item);
    }
  }

  const restrictedHashes = new Set<string>();
  for (const file of records(archive.files)) {
    const restrictedFile = typeof file.sourceId === 'string' && restricted.has(file.sourceId);
    if (restrictedFile && typeof file.hash === 'string') restrictedHashes.add(file.hash);
    const base64 = file.base64;
    if (typeof base64 === 'string' && base64) {
      requireThat(!restrictedFile, 'BACKUP_RESTRICTED_RESEARCH', rightsNotice);
      const bytes = Buffer.from(base64, 'base64');
      requireThat(typeof file.hash !== 'string' || assetHash(bytes) === file.hash,
        'ASSET_CORRUPT', '旧研究归档的原件字节损坏');
    } else requireThat(typeof file.omission === 'string' && file.omission, 'BACKUP_ASSET_MISSING', '旧研究归档缺失原件及省略说明');
  }
  if (!restrictedHashes.size) return;
  const layouts = [isRecord(archive.layout) ? archive.layout.data : undefined];
  if (isRecord(archive.actionHistory)) {
    for (const { layout } of records(archive.actionHistory.entries))
      if (isRecord(layout)) layouts.push(layout.before, layout.after);
  }
  for (const layout of layouts) {
    const canvas = isRecord(layout) ? layout.canvas : undefined;
    const annotations = isRecord(canvas) ? canvas.annotations : undefined;
    const files = isRecord(annotations) ? annotations.files : undefined;
    if (isRecord(files)) requireThat(
      !Object.values(files).some(file => isRecord(file) && isRestrictedCanvasImage(file.dataURL, restrictedHashes)),
      'BACKUP_RESTRICTED_RESEARCH',
      '旧研究归档的画布含有权利限制的原件，无法生成或恢复此备份',
    );
  }
}

function checkSnapshot(db: Database.Database) {
  requireThat(
    db.pragma('application_id', { simple: true }) === WORKSPACE_APPLICATION_ID &&
      db.pragma('user_version', { simple: true }) === WORKSPACE_DATABASE_VERSION &&
      db.pragma('journal_mode', { simple: true }) === 'delete',
    'BACKUP_DATABASE_FORMAT',
    '备份的数据库格式或版本不受支持',
  );
  requireThat(
    db.pragma('integrity_check', { simple: true }) === 'ok' && !db.prepare('PRAGMA foreign_key_check').get(),
    'BACKUP_DATABASE_INTEGRITY',
    '备份数据库完整性检查失败',
  );
  requireThat(!db.prepare('SELECT 1 FROM sessions LIMIT 1').get(), 'BACKUP_SESSIONS', '备份含有效范围以外的会话记录');
  for (const row of db.prepare('SELECT value FROM mapping_history ORDER BY rowid').iterate() as Iterable<{ value: string }>) {
    const stack = JSON.parse(row.value) as History;
    for (const action of [...stack.undo, ...stack.redo]) {
      requireThat(action.session === '', 'BACKUP_SESSIONS', '备份历史含会话身份记录');
      for (const change of action.assetChanges ?? []) verifyAssetBytes(change.after);
    }
  }
  for (const row of db.prepare('SELECT project_id AS projectId,id FROM mapping_assets').iterate() as Iterable<{ projectId: string; id: string }>)
    readAsset(db, row.projectId, row.id);
  // Only current, known references require a current asset row. An undone
  // paste can legitimately keep its bytes exclusively on the redo stack.
  const hasAsset = db.prepare('SELECT 1 FROM mapping_assets WHERE project_id = ? AND id = ?');
  const requireAsset = (projectId: string, id: unknown) => requireThat(
    typeof id === 'string' && hasAsset.get(projectId, id),
    'BACKUP_ASSET_MISSING',
    '备份数据库缺少当前内容引用的原件',
  );
  // These projections join their identity table for ordering. A missing
  // identity would silently hide a current record; historical identities may remain.
  for (const [current, identity, label] of [
    ['mapping_cards', 'mapping_card_ids', '卡片'],
    ['mapping_connectors', 'mapping_connector_ids', '普通连线'],
    ['mapping_frames', 'mapping_frame_ids', '分区'],
    ['mapping_groups', 'mapping_group_ids', '组合'],
  ] as const) {
    requireThat(!db.prepare(`
      SELECT 1 FROM ${current} records
      LEFT JOIN ${identity} ids ON ids.id = records.id AND ids.project_id = records.project_id
      WHERE ids.id IS NULL LIMIT 1
    `).get(), 'BACKUP_DATABASE_INTEGRITY', `备份数据库缺少与现有${label}同项目的身份记录`);
  }
  const projects = db.prepare('SELECT id,name,version_id AS versionId,revision FROM mapping_projects').iterate() as Iterable<Project>;
  for (const project of projects) {
    const verification: VerificationReference[] = [];
    const bindings = new Map<string, VerificationBinding>();
    for (const row of db.prepare(`SELECT id,version_id AS versionId,value FROM mapping_versions WHERE project_id=? AND domain='verificationOrigin'`)
      .iterate(project.id) as Iterable<{ id: string; versionId: string; value: string }>) {
      const binding = VerificationBinding.safeParse(JSON.parse(row.value));
      requireThat(binding.success && binding.data.id === row.id,
        'BACKUP_VERIFICATION_EVIDENCE', '备份中的查证卡版本格式无效');
      bindings.set(`${row.id}\u0000${row.versionId}`, binding.data);
      verification.push({ origin: binding.data.origin, path: `versions.${row.id}` });
    }
    // Use the normal read path so structurally valid SQLite files still have
    // to open as projects, including blocks above SQLite JSON's nesting limit.
    const state = readProjectState(db, project);
    const failures: PackageFailure[] = [];
    const projection = { ...state };
    verifyProjectRecords(projection, failures);
    verifyConnectorTargets(projection, failures);
    requireThat(failures.length === 0, 'BACKUP_DATABASE_INTEGRITY',
      `备份数据库含不可读取的项目记录（${failures[0]?.path ?? ''}）。`);
    for (const card of state.cards) {
      for (const block of card.body.blocks)
        if (validImage(block)) requireAsset(project.id, block.assetId);
      for (const item of card.attachments?.items ?? []) requireAsset(project.id, item.assetId);
      const bound = bindings.get(`${card.id}\u0000${verificationBindingVersion(card.versionId, card.body.versionId)}`);
      if (card.verificationOrigin || bound) {
        requireThat(!card.aiOrigin && matchesVerificationBinding(bound, card.verificationOrigin, card.title, card.body.blocks),
          'BACKUP_VERIFICATION_EVIDENCE', '备份中当前卡片的查证原文与冻结版本不一致');
      }
    }
    for (const image of state.images ?? []) requireAsset(project.id, image.content.assetId);
    for (const row of db.prepare('SELECT id,task FROM mapping_organize_tasks WHERE project_id=?')
      .iterate(project.id) as Iterable<{ id: string; task: string }>) {
      verification.push(...verificationReferences(JSON.parse(row.task) as OrganizeTask, `tasks.${row.id}`));
    }
    const archived = db.prepare('SELECT research,extensions FROM mapping_import_archive WHERE project_id=?')
      .get(project.id) as { research: string; extensions: string } | undefined;
    if (archived) {
      const research: unknown = JSON.parse(archived.research);
      if (isRecord(research)) checkArchivedResearch(research);
      const extensions: unknown = JSON.parse(archived.extensions);
      if (isRecord(extensions) && extensions.forkwiseOrganize !== undefined) {
        const parsed = OrganizeArchiveImportCheck.safeParse(extensions.forkwiseOrganize);
        requireThat(parsed.success, 'BACKUP_VERIFICATION_EVIDENCE', '备份中的查证或整理归档格式无效');
        for (const archive of parsed.data)
          for (const task of archive.tasks) verification.push(...verificationReferences(task, `archive.${task.id}`));
      }
    }
    for (const { reason } of invalidVerificationReferences(verification, id => {
      if (!hasAsset.get(project.id, id)) return;
      const asset = readAsset(db, project.id, id);
      return { kind: asset.kind, mime: asset.mime, hash: asset.hash, raw: () => Buffer.from(asset.base64, 'base64').toString('utf8') };
    })) requireThat(false, 'BACKUP_VERIFICATION_EVIDENCE', reason);
  }
}

export async function writeWorkspaceSnapshot(source: Database.Database, destination: string) {
  await source.backup(destination);
  await chmod(destination, 0o600);
  const db = new Database(destination, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('secure_delete = ON');
    db.transaction(() => {
      db.exec('DELETE FROM sessions');
      const update = db.prepare('UPDATE mapping_history SET value = ? WHERE project_id = ?');
      const rows = db.prepare('SELECT project_id,value FROM mapping_history').all() as { project_id: string; value: string }[];
      for (const row of rows) {
        const stack = JSON.parse(row.value) as History;
        // Keep the string field and the history order. This field is a
        // token hash used only to group edits from the originating session.
        for (const action of [...stack.undo, ...stack.redo]) action.session = '';
        update.run(JSON.stringify(stack), row.project_id);
      }
      const updateResearch = db.prepare('UPDATE mapping_import_archive SET research = ? WHERE project_id = ?');
      const archives = db.prepare('SELECT project_id,research FROM mapping_import_archive WHERE research IS NOT NULL').all() as
        { project_id: string; research: string }[];
      for (const row of archives) {
        const research: unknown = JSON.parse(row.research);
        if (!isRecord(research)) continue;
        const tasksWithToken = records(research.tasks).filter(task => task.runToken != null);
        if (!tasksWithToken.length) continue;
        for (const task of tasksWithToken) task.runToken = null;
        updateResearch.run(JSON.stringify(research), row.project_id);
      }
    })();
    db.exec('VACUUM');
    checkSnapshot(db);
  } finally {
    db.close();
  }
}

export function checkWorkspaceRestore(source: Database.Database, path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('trusted_schema = OFF');
    requireThat(workspaceSchema(db) === workspaceSchema(source), 'BACKUP_DATABASE_FORMAT', '备份数据库结构与当前版本不兼容');
    checkSnapshot(db);
  } finally {
    db.close();
  }
}

export async function workspaceFileDigest(path: string) {
  const sha = createHash('sha256');
  for await (const bytes of createReadStream(path)) sha.update(bytes);
  return { bytes: (await stat(path)).size, sha256: sha.digest('hex') };
}
