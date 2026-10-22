import { initializeImages } from './image.js';
import { initializeText } from './text.js';
import { initializeShapes } from './shape.js';
import { initializeStrokes } from './stroke.js';
import { initializeMediaTasks } from './media-tasks.js';
import { initializeMedia } from './media.js';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  lstatSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Mapping, type CommitOptions } from './mapping.js';
import { initializeHistory } from './history.js';
import { initializeVersions } from './versions.js';
import { initializeTags } from './tags.js';
import { initializeSearchState } from './search-state.js';

// Separate from research.sqlite: opening the workspace never runs legacy migrations,
// activation recovery, background jobs, or retention cleanup.
export function openMapping(directory: string, options: CommitOptions = {}): Mapping {
  if (!directory || !isAbsolute(directory)) throw new Error('必须显式提供绝对路径的数据目录');
  const applicationId = 1179472720;
  let existing = false;
  let sidecar = false;
  let accessFile = false;
  try {
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory()) throw new Error('请使用独立的真实数据目录');
    if (directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o077) !== 0)
      throw new Error('数据目录必须仅归当前本机账户访问（0700）；原权限未修改');
    const allowed = new Set([
      'workspace.sqlite',
      'workspace.sqlite-wal',
      'workspace.sqlite-shm',
      'local-access.json',
    ]);
    for (const entry of readdirSync(directory)) {
      const info = lstatSync(join(directory, entry));
      if (entry === 'workspace.sqlite') existing = true;
      if (entry === 'local-access.json') accessFile = true;
      if (entry === 'workspace.sqlite-wal' || entry === 'workspace.sqlite-shm') sidecar = true;
      if (!allowed.has(entry) || !info.isFile() || info.nlink !== 1)
        throw new Error('数据目录包含旧资料或链接，请使用新的隔离目录');
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error('数据文件必须仅归当前本机账户访问（0600）；原权限未修改');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existing && sidecar) throw new Error('缺失主库，残留 WAL/SHM 已保留；请先恢复完整副本');
  if (!existing && accessFile) throw new Error('缺失主库，启动凭证原件已保留');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'workspace.sqlite');
  if (existing) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(100);
      const length = readSync(fd, header, 0, header.length, 0);
      if (
        length !== 100 ||
        header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
        header.readUInt32BE(68) !== applicationId ||
        header.readUInt32BE(60) !== 1
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
      db.pragma(`application_id = ${applicationId}`);
      db.pragma('user_version = 1');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, type TEXT NOT NULL, projects TEXT NOT NULL, expires_at TEXT NOT NULL, capabilities TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, version_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_cards(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_receipts(project_id TEXT NOT NULL REFERENCES mapping_projects(id), command_id TEXT NOT NULL, actor_id TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(project_id, command_id));
      CREATE TABLE IF NOT EXISTS mapping_changes(project_id TEXT NOT NULL REFERENCES mapping_projects(id), revision INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(project_id, revision));
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
    return new Mapping(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
}
