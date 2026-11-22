import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, constants, closeSync, createWriteStream, fstatSync, linkSync, mkdirSync,
  openSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import type { AccessService, Principal } from '../services/access.js';
import { checkWorkspaceRestore, workspaceFileDigest, writeWorkspaceSnapshot } from './workspace-backup-snapshot.js';
import { BACKUP_MANIFEST, unpackWorkspaceBackup } from './workspace-backup-tar.js';
import { WORKSPACE_DATABASE_FILENAME, WORKSPACE_DATABASE_VERSION } from './workspace-storage-contract.js';

const recipientPattern = /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const identityPattern = /^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/;
const manifestSchema = z.object({
  format: z.literal('forkwise-workspace-backup'),
  version: z.literal(1),
  backupId: z.uuid(),
  createdAt: z.iso.datetime(),
  sourceVersion: z.string().regex(/^\d+\.\d+\.\d+ \([a-f0-9]{12}\)$/),
  databaseVersion: z.literal(WORKSPACE_DATABASE_VERSION),
  database: z.object({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();

export interface WorkspaceBackupSettings {
  version: string;
  recipient: string | undefined;
  identityFile: string | undefined;
}

function findAge() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, 'age');
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return executable;
    } catch { /* Continue through PATH. */ }
  }
}

function readIdentity(path: string | undefined) {
  requireThat(path && isAbsolute(path), 'BACKUP_CONFIG', '请在本机启动时设置 FORKWISE_BACKUP_IDENTITY 为 age 私钥文件的绝对路径。', 503);
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
          info.size === 0 || info.size > 16_384) throw new Error('invalid identity file');
      const identity = readFileSync(fd, 'utf8');
      const keys = identity.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      requireThat(keys.length && keys.every(key => identityPattern.test(key)),
        'BACKUP_CONFIG', '请使用 age-keygen 生成的本机 X25519 私钥。', 503);
      // Only the validated native keys reach age, through stdin, never argv.
      return keys.join('\n') + '\n';
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('BACKUP_CONFIG', 'age 私钥文件不可读或权限不安全。请使用当前账户独占、无链接的私钥文件（0600）。', 503);
  }
}

function runTool(
  executable: string,
  args: string[],
  step: 'pack' | 'encrypt' | 'decrypt',
  identity?: string,
) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(executable, args, { env: {}, encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if (step === 'pack') return reject(new DomainError('BACKUP_TAR', '无法创建 tar 归档，请检查可用磁盘空间。', 503));
      if (step === 'encrypt') return reject(new DomainError('BACKUP_ENCRYPT', 'age 无法加密，请检查备份公钥和可用磁盘空间。', 503));
      if (stderr.includes('no identity matched'))
        return reject(new DomainError('BACKUP_WRONG_KEY', '所配置的 age 私钥与此备份不匹配。'));
      if (/truncat|unexpected EOF|failed to decrypt|authentication failed|parsing .*(header|stanza)/i.test(stderr))
        return reject(new DomainError('BACKUP_CIPHERTEXT', '备份密文不完整或损坏。'));
      reject(new DomainError('BACKUP_DECRYPT', 'age 无法解密此备份，请检查文件格式、私钥和可用磁盘空间。'));
    });
    child.stdin?.on('error', () => { /* Command failure is reported above. */ });
    child.stdin?.end(identity);
  });
}

async function makeStage(parent: string, operation: 'backup' | 'restore') {
  try {
    return await mkdtemp(join(parent, `.forkwise-${operation}-`));
  } catch {
    const action = operation === 'backup' ? '备份' : '恢复';
    throw new DomainError('BACKUP_STAGING', `无法在工作台数据目录旁创建私有${action}临时目录，请检查上级目录权限和可用空间。`, 503);
  }
}

export class WorkspaceBackup {
  constructor(
    private readonly db: Database.Database,
    private readonly access: AccessService,
    private readonly settings: WorkspaceBackupSettings,
  ) {}

  private authorize(actor: Principal) {
    this.access.validate(actor);
    this.access.human(actor);
    this.access.project(actor, '*');
  }

  status(actor: Principal) {
    this.authorize(actor);
    const version = this.settings.version;
    const age = findAge();
    if (!age) {
      const message = '找不到 age。安装后请通过 PATH 提供 age，再重开工作台。';
      return { version, backupBlockedReason: message, restoreBlockedReason: message };
    }
    let restoreBlockedReason: string | null = null;
    try {
      readIdentity(this.settings.identityFile);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      restoreBlockedReason = error.message;
    }
    const backupBlockedReason = this.settings.recipient && recipientPattern.test(this.settings.recipient)
      ? null : '请在本机启动时设置 FORKWISE_BACKUP_RECIPIENT 为有效的 age 公钥（age1…）。';
    return { version, backupBlockedReason, restoreBlockedReason };
  }

  async create(actor: Principal) {
    const { backupBlockedReason, version } = this.status(actor);
    requireThat(!backupBlockedReason, 'BACKUP_CONFIG', backupBlockedReason ?? '', 503);
    const age = findAge();
    requireThat(age, 'BACKUP_CONFIG', '找不到 age，请安装并重开工作台。', 503);
    const parent = dirname(dirname(realpathSync(this.db.name)));
    const stage = await makeStage(parent, 'backup');
    try {
      const database = join(stage, WORKSPACE_DATABASE_FILENAME);
      try {
        await writeWorkspaceSnapshot(this.db, database);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('BACKUP_SNAPSHOT', '无法生成工作台快照，请检查数据库和可用磁盘空间。', 503);
      }
      const backupId = randomUUID();
      const createdAt = new Date().toISOString();
      const manifest: z.infer<typeof manifestSchema> = {
        format: 'forkwise-workspace-backup', version: 1, backupId, createdAt, sourceVersion: version,
        databaseVersion: WORKSPACE_DATABASE_VERSION, database: await workspaceFileDigest(database),
      };
      await writeFile(join(stage, BACKUP_MANIFEST), JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
      const archive = join(stage, 'workspace.tar');
      const ciphertext = join(stage, 'workspace.tar.age');
      await runTool('/usr/bin/tar', ['--format', 'ustar', '-cf', archive, '-C', stage, BACKUP_MANIFEST, WORKSPACE_DATABASE_FILENAME], 'pack');
      await runTool(age, ['-r', this.settings.recipient!, '-o', ciphertext, archive], 'encrypt');
      const encrypted = await open(ciphertext, 'r');
      try {
        const { size } = await encrypted.stat();
        const filename = `forkwise-workspace-${createdAt.slice(0, 10)}-${backupId}.tar.age`;
        const body = Readable.toWeb(encrypted.createReadStream()) as unknown as ReadableStream<Uint8Array>;
        return { body, size, filename };
      } catch (error) {
        await encrypted.close();
        throw error;
      }
    } finally {
      // An open descriptor can serve the ciphertext after unlink on macOS.
      await rm(stage, { recursive: true, force: true });
    }
  }

  async restore(actor: Principal, input: ReadableStream<Uint8Array> | null) {
    this.authorize(actor);
    const age = findAge();
    requireThat(age, 'BACKUP_CONFIG', '找不到 age，请安装并重开工作台。', 503);
    const identity = readIdentity(this.settings.identityFile);
    requireThat(input, 'BACKUP_FILE_REQUIRED', '请先选择一个已加密的工作台备份。', 400);
    const dataDirectory = dirname(realpathSync(this.db.name));
    const parent = dirname(dataDirectory);
    const stage = await makeStage(parent, 'restore');
    try {
      const ciphertext = join(stage, 'workspace.tar.age');
      const archive = join(stage, 'workspace.tar');
      try {
        await pipeline(
          Readable.fromWeb(input as unknown as NodeReadableStream<Uint8Array>),
          createWriteStream(ciphertext, { flags: 'wx', mode: 0o600 }),
        );
      } catch {
        throw new DomainError('BACKUP_UPLOAD', '备份文件未传输完成，请检查磁盘空间后重试。');
      }
      await runTool(age, ['-d', '-i', '-', '-o', archive, ciphertext], 'decrypt', identity);
      const database = join(stage, WORKSPACE_DATABASE_FILENAME);
      let json: string;
      try {
        json = await unpackWorkspaceBackup(archive, database);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('BACKUP_RESTORE_STAGING', '无法在私有临时目录写入恢复数据库，请检查磁盘空间和目录权限。', 503);
      }
      let manifest: z.infer<typeof manifestSchema>;
      try {
        manifest = manifestSchema.parse(JSON.parse(json));
      } catch {
        throw new DomainError('BACKUP_MANIFEST', '备份清单格式无效，或版本不受此工作台支持。');
      }
      const actual = await workspaceFileDigest(database);
      requireThat(
        actual.bytes === manifest.database.bytes && actual.sha256 === manifest.database.sha256,
        'BACKUP_HASH', '数据库字节数或 SHA-256 与备份清单不符。',
      );
      try {
        checkWorkspaceRestore(this.db, database);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('BACKUP_DATABASE_INTEGRITY', '无法读取或校验备份数据库。');
      }

      const directory = join(parent, `forkwise-restored-${manifest.backupId}`);
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new DomainError('BACKUP_TARGET_EXISTS', '此备份的恢复目录已存在，请检查先前恢复的副本。', 409);
        throw new DomainError('BACKUP_TARGET', '无法在工作台旁创建恢复目录，请检查目录权限和可用空间。', 503);
      }
      try {
        linkSync(database, join(directory, WORKSPACE_DATABASE_FILENAME));
      } catch {
        rmdirSync(directory);
        throw new DomainError('BACKUP_TARGET', '无法交付已校验的数据库，请检查目录权限和可用空间。', 503);
      }
      unlinkSync(database);
      return { directory, sourceVersion: manifest.sourceVersion };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
