import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { requireThat } from '../domain/errors.js';
import { WORKSPACE_DATABASE_FILENAME } from './workspace-storage-contract.js';

export const BACKUP_MANIFEST = 'manifest.json';
const block = 512;

// Accept only the two regular files written by our ustar producer. The
// archive never supplies a destination path or any filesystem metadata.
export async function unpackWorkspaceBackup(archive: string, database: string) {
  const file = await open(archive, 'r');
  try {
    const { size } = await file.stat();
    let offset = 0;
    const read = async (length: number) => {
      const bytes = Buffer.alloc(length);
      const result = await file.read(bytes, 0, length, offset);
      requireThat(result.bytesRead === length, 'BACKUP_TAR', '备份归档不完整');
      offset += length;
      return bytes;
    };
    const entry = async (name: string) => {
      const header = await read(block);
      const expectedName = Buffer.alloc(100);
      expectedName.write(name, 'ascii');
      const length = header.toString('latin1', 124, 136);
      const checksum = header.toString('latin1', 148, 156);
      let actualChecksum = 0;
      for (let index = 0; index < block; index++)
        actualChecksum += index >= 148 && index < 156 ? 32 : header[index]!;
      requireThat(
        header.subarray(0, 100).equals(expectedName) &&
          (header[156] === 48 || header[156] === 0) &&
          header.toString('latin1', 257, 265) === 'ustar\0' + '00' &&
          header.subarray(157, 257).every(byte => byte === 0) &&
          header.subarray(345, 500).every(byte => byte === 0) &&
          /^[0-7]+[\0 ]*$/.test(length) && /^[0-7]+[\0 ]*$/.test(checksum) &&
          Number.parseInt(checksum, 8) === actualChecksum,
        'BACKUP_TAR',
        '备份归档包含未知、重复或损坏的条目',
      );
      const bytes = Number.parseInt(length, 8);
      const start = offset;
      const padded = Math.ceil(bytes / block) * block;
      requireThat(bytes > 0 && start + padded + 2 * block <= size, 'BACKUP_TAR', '备份归档的条目不完整');
      return { start, bytes, next: start + padded };
    };
    const manifest = await entry(BACKUP_MANIFEST);
    requireThat(manifest.bytes <= 4096, 'BACKUP_TAR', '备份清单超出格式上限');
    const json = (await read(manifest.bytes)).toString('utf8');
    offset = manifest.next;
    const sqlite = await entry(WORKSPACE_DATABASE_FILENAME);
    offset = sqlite.next;
    const remaining = size - offset;
    requireThat(
      remaining >= 2 * block && remaining <= 20 * block && remaining % block === 0 &&
        (await read(remaining)).every(byte => byte === 0),
      'BACKUP_TAR',
      '备份归档包含额外条目或无效的结束标记',
    );
    await pipeline(
      createReadStream(archive, { start: sqlite.start, end: sqlite.start + sqlite.bytes - 1 }),
      createWriteStream(database, { flags: 'wx', mode: 0o600 }),
    );
    return json;
  } finally {
    await file.close();
  }
}
