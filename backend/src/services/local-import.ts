import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve, relative, sep, basename } from 'node:path';
import { z } from '@hono/zod-openapi';
import { Source, Time, type Actor } from '../contracts/entities.js';
import { FileInput, type MaterialFileService } from './material-files.js';
import { importMaterialFile } from './file-import.js';
import { requireThat, DomainError } from '../domain/errors.js';

export const PathImportInput = z
  .object({
    source: Source,
    path: z.string().min(1).max(4096),
    mime: FileInput.shape.mime,
    publishedAt: Time.nullable(),
  })
  .strict();
export function importLocalFile(
  files: MaterialFileService,
  roots: Record<string, string[]>,
  projectId: string,
  actor: Actor,
  key: string,
  raw: unknown,
) {
  const input = PathImportInput.parse(raw);
  files.write.repo.project(projectId);
  return files.write.idempotent(actor, projectId, key, { op: 'file.import-path', input }, () => {
    const configured = roots[projectId] ?? [];
    requireThat(configured.length > 0, 'PATH_IMPORT_DISABLED', '当前项目未配置本机导入目录', 403);
    requireThat(isAbsolute(input.path), 'PATH_FORBIDDEN', '需要目录内单文件的绝对路径', 403);
    const path = resolve(input.path);
    const root = configured.find((r) => isAbsolute(r) && path.startsWith(resolve(r) + sep));
    requireThat(root, 'PATH_FORBIDDEN', '文件不在当前项目的导入目录内', 403);
    let fd: number | undefined;
    try {
      const canonicalRoot = realpathSync(root);
      requireThat(
        realpathSync(path).startsWith(canonicalRoot + sep),
        'PATH_FORBIDDEN',
        '文件越过配置目录',
        403,
      );
      let component = resolve(root);
      requireThat(
        !lstatSync(component).isSymbolicLink(),
        'SYMLINK_FORBIDDEN',
        '不允许符号链接目录',
        403,
      );
      for (const part of relative(component, path).split(sep)) {
        component = resolve(component, part);
        requireThat(
          !lstatSync(component).isSymbolicLink(),
          'SYMLINK_FORBIDDEN',
          '不允许符号链接文件或中间目录',
          403,
        );
      }
      const before = lstatSync(path);
      requireThat(
        before.isFile() && before.size > 0 && before.size <= 25_000_000,
        'INVALID_FILE_SIZE',
        '只允许 1 字节至 25 MB 的普通文件',
      );
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      requireThat(
        opened.isFile() && before.ino === opened.ino && before.dev === opened.dev,
        'FILE_CHANGED',
        '文件在打开时改变',
        409,
      );
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const n = readSync(fd, buffer, count, buffer.length - count, null);
        if (!n) break;
        count += n;
      }
      const bytes = buffer.subarray(0, count),
        after = fstatSync(fd),
        pathAfter = lstatSync(path);
      requireThat(
        bytes.length === before.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          pathAfter.ino === before.ino &&
          pathAfter.dev === before.dev &&
          realpathSync(path).startsWith(canonicalRoot + sep),
        'FILE_CHANGED',
        '读取过程中原文件改变，请重新检查',
        409,
      );
      return importMaterialFile(files, projectId, actor, randomUUID(), {
        source: input.source,
        file: {
          name: basename(path),
          mime: input.mime,
          base64: bytes.toString('base64'),
          publishedAt: input.publishedAt,
        },
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('FILE_UNAVAILABLE', '文件无法安全读取，请检查路径及访问权限', 422);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}
