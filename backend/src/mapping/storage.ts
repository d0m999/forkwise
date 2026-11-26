import { initializeFrames } from './frame.js';
import { initializeGroups } from './group.js';
import { initializeAttachments } from './attachment.js';
import { initializeConnectors } from './connector.js';
import { initializeImages } from './image.js';
import { initializeText } from './text.js';
import { initializeShapes } from './shape.js';
import { initializeStrokes } from './stroke.js';
import { initializeMediaTasks } from './media-tasks.js';
import { initializeMedia } from './media.js';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  fstatSync,
  lstatSync,
  readdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  constants,
  type Stats,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Mapping, type CommitOptions } from './mapping.js';
import { initializeHistory } from './history.js';
import { initializeVersions } from './versions.js';
import { initializeTags } from './tags.js';
import { initializeSearchState } from './search-state.js';
import { initializeCuts } from './cut.js';
import { initializeOrganize } from './organize-store.js';
import { WORKSPACE_APPLICATION_ID, WORKSPACE_DATABASE_FILENAME, WORKSPACE_DATABASE_VERSION } from './workspace-storage-contract.js';
const workspaceWalFilename = `${WORKSPACE_DATABASE_FILENAME}-wal`;
const workspaceShmFilename = `${WORKSPACE_DATABASE_FILENAME}-shm`;
const workspaceAccessFilename = 'local-access.json';
const workspaceDataFilenames = new Set([
  WORKSPACE_DATABASE_FILENAME,
  workspaceWalFilename,
  workspaceShmFilename,
  workspaceAccessFilename,
]);

export function hasWorkspaceDataEntries(directory: string): boolean {
  for (const filename of workspaceDataFilenames) {
    if (lstatSync(join(directory, filename), { throwIfNoEntry: false }) !== undefined) return true;
  }
  return false;
}

function requirePrivateWorkspaceFile(info: Stats) {
  if (!info.isFile() || info.nlink !== 1)
    throw new Error('数据目录包含旧资料或链接，请使用新的隔离目录');
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error('数据文件必须仅归当前本机账户访问（0600）；原权限未修改');
}

function inspectWorkspaceDirectory(directory: string) {
  if (!directory || !isAbsolute(directory)) throw new Error('必须显式提供绝对路径的数据目录');
  let existing = false;
  let sidecar = false;
  let accessFile = false;
  try {
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory()) throw new Error('请使用独立的真实数据目录');
    if (directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o077) !== 0)
      throw new Error('数据目录必须仅归当前本机账户访问（0700）；原权限未修改');
    for (const entry of readdirSync(directory)) {
      const info = lstatSync(join(directory, entry));
      if (entry === WORKSPACE_DATABASE_FILENAME) existing = true;
      if (entry === workspaceAccessFilename) accessFile = true;
      if (entry === workspaceWalFilename || entry === workspaceShmFilename) sidecar = true;
      if (!workspaceDataFilenames.has(entry))
        throw new Error('数据目录包含旧资料或链接，请使用新的隔离目录');
      requirePrivateWorkspaceFile(info);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existing && sidecar) throw new Error('缺失主库，残留 WAL/SHM 已保留；请先恢复完整副本');
  if (!existing && accessFile) throw new Error('缺失主库，启动凭证原件已保留');
  return { existing, accessFile };
}

export function readWorkspaceAccessFile(directory: string): string {
  const { accessFile } = inspectWorkspaceDirectory(directory);
  if (!accessFile) throw new Error('数据目录缺少启动凭证');
  const fd = openSync(
    join(directory, workspaceAccessFilename),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    requirePrivateWorkspaceFile(fstatSync(fd));
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

// Separate from research.sqlite: opening the workspace never runs legacy migrations,
// activation recovery, background jobs, or retention cleanup.
export function openMapping(directory: string, options: CommitOptions = {}): Mapping {
  const { existing } = inspectWorkspaceDirectory(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, WORKSPACE_DATABASE_FILENAME);
  if (existing) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(100);
      const length = readSync(fd, header, 0, header.length, 0);
      if (
        length !== 100 ||
        header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
        header.readUInt32BE(68) !== WORKSPACE_APPLICATION_ID ||
        header.readUInt32BE(60) !== WORKSPACE_DATABASE_VERSION
      )
        throw new Error('数据库不是受支持的开放工作台格式；原件已保留');
    } finally {
      closeSync(fd);
    }
  } else {
    // Fail rather than follow a concurrently created file or symlink.
    closeSync(openSync(path, 'wx', 0o600));
  }
  const db = new Database(path);
  try {
    if (!existing) {
      db.pragma(`application_id = ${WORKSPACE_APPLICATION_ID}`);
      db.pragma(`user_version = ${WORKSPACE_DATABASE_VERSION}`);
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, type TEXT NOT NULL, projects TEXT NOT NULL, expires_at TEXT NOT NULL, capabilities TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_guide(slot INTEGER PRIMARY KEY CHECK(slot = 1), preference TEXT NOT NULL CHECK(preference IN ('skipped', 'completed')));
      CREATE TABLE IF NOT EXISTS mapping_projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, version_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_cards(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_receipts(project_id TEXT NOT NULL REFERENCES mapping_projects(id), command_id TEXT NOT NULL, actor_id TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(project_id, command_id));
      CREATE TABLE IF NOT EXISTS mapping_changes(project_id TEXT NOT NULL REFERENCES mapping_projects(id), revision INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(project_id, revision));
      CREATE TABLE IF NOT EXISTS mapping_import_archive(project_id TEXT PRIMARY KEY REFERENCES mapping_projects(id), research TEXT, history TEXT, changes TEXT, extensions TEXT);
      CREATE TABLE IF NOT EXISTS mapping_import_edit_times(project_id TEXT NOT NULL REFERENCES mapping_projects(id), card_id TEXT NOT NULL, edited_at TEXT NOT NULL, PRIMARY KEY(project_id, card_id));
    `);
    initializeMedia(db);
    initializeMediaTasks(db);
    initializeVersions(db);
    initializeHistory(db);
    initializeTags(db);
    initializeSearchState(db);
    initializeText(db);
    initializeShapes(db);
    initializeStrokes(db);
    initializeImages(db);
    initializeConnectors(db);
    initializeGroups(db);
    initializeAttachments(db);
    initializeFrames(db);
    initializeCuts(db);
    initializeOrganize(db);
    return new Mapping(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
}
