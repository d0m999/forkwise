import { validImage } from './media-blocks.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staticSvg } from './static-svg.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { requireThat } from '../domain/errors.js';
import { rasterImage } from '../services/raster-image.js';
import type { Command } from './contracts.js';
export interface MediaAsset {
  id: string;
  name: string;
  mime: string;
  base64: string;
  width: number;
  height: number;
  hash: string;
}
export function initializeMedia(db: Database.Database) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS mapping_assets(project_id TEXT NOT NULL REFERENCES mapping_projects(id), id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id,id))',
  );
}
export function readAsset(db: Database.Database, projectId: string, id: string): MediaAsset {
  const row = db
    .prepare('SELECT value FROM mapping_assets WHERE project_id=? AND id=?')
    .get(projectId, id) as { value: string } | undefined;
  requireThat(row, 'MEDIA_NOT_PERSISTED', '所需媒体尚未持久保存，请完成或移除媒体后重试', 409);
  return JSON.parse(row.value) as MediaAsset;
}
export function saveAsset(
  db: Database.Database,
  command: Extract<Command, { type: 'asset.save' }>,
) {
  const p = command.payload,
    bytes = Buffer.from(p.base64, 'base64');
  requireThat(
    bytes.length > 0 && bytes.length <= 512 * 1024 && bytes.toString('base64') === p.base64,
    'INVALID_IMAGE',
    '图片须为有效字节且不超过512 KiB',
    413,
  );
  // Reject incomplete containers even when a tolerant decoder reports dimensions.
  const complete =
    p.mime === 'image/png'
      ? completePng(bytes)
      : p.mime === 'image/jpeg'
        ? bytes.subarray(-2).equals(Buffer.from([255, 217]))
        : p.mime === 'image/gif'
          ? bytes.at(-1) === 0x3b
          : p.mime === 'image/webp'
            ? bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length
            : p.mime === 'image/svg+xml';
  requireThat(complete, 'INVALID_IMAGE', '图片文件不完整，原内容已保留');
  const { width, height } =
    p.mime === 'image/svg+xml' ? staticSvg(bytes) : rasterImage(bytes, p.mime);
  const decoded = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../workers/media-decode.mjs', import.meta.url))],
    { input: bytes, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  requireThat(
    decoded.status === 0 && !decoded.error,
    'INVALID_IMAGE',
    '图片像素无法完整解码或处理超时，原内容已保留',
  );
  const dimensions = JSON.parse(decoded.stdout.toString()) as { width: number; height: number };
  requireThat(
    dimensions.width === width && dimensions.height === height,
    'INVALID_IMAGE',
    '图片解码尺寸不一致',
  );
  const value: MediaAsset = {
    ...p,
    width,
    height,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
  const existing = db
    .prepare('SELECT value FROM mapping_assets WHERE project_id=? AND id=?')
    .get(command.projectId, p.id) as { value: string } | undefined;
  requireThat(
    !existing || existing.value === JSON.stringify(value),
    'ID_CONFLICT',
    '不可变资源身份已使用',
    409,
  );
  if (!existing)
    db.prepare('INSERT INTO mapping_assets VALUES(?,?,?)').run(
      command.projectId,
      p.id,
      JSON.stringify(value),
    );
}

function completePng(bytes: Buffer): boolean {
  if (bytes.length < 20) return false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at),
      type = bytes.toString('ascii', at + 4, at + 8);
    if (at + size + 12 > bytes.length) return false;
    at += size + 12;
    if (type === 'IEND') return size === 0 && at === bytes.length;
  }
  return false;
}

export function validateImageAssets(
  db: Database.Database,
  projectId: string,
  blocks: import('./contracts.js').Block[],
) {
  for (const block of blocks)
    if (validImage(block)) {
      const a = readAsset(db, projectId, String(block.assetId));
      requireThat(
        block.name === a.name &&
          block.mime === a.mime &&
          block.naturalWidth === a.width &&
          block.naturalHeight === a.height,
        'INVALID_IMAGE',
        '图片引用与已保存原件不一致',
        409,
      );
    }
}
