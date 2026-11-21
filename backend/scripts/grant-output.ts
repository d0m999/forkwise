import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { requireThat } from '../src/domain/errors.js';
import { hasWorkspaceDataEntries } from '../src/mapping/storage.js';

export function grantOutputPath(directory: string, out: string): string {
  requireThat(!out.endsWith(sep), 'INVALID_SCOPE', '--out 必须指向文件', 403);
  // Native realpath resolves symlinks before traversing subsequent '..' segments.
  const outputParent = realpathSync.native(dirname(out));
  const workspaceDirectory = statSync(directory);
  const outputDirectory = statSync(outputParent);
  const isSourceWorkspace =
    workspaceDirectory.dev === outputDirectory.dev && workspaceDirectory.ino === outputDirectory.ino;
  requireThat(
    !isSourceWorkspace && !hasWorkspaceDataEntries(outputParent),
    'INVALID_SCOPE', '请将令牌输出到工作台数据目录之外', 403,
  );
  return join(outputParent, basename(out));
}

export function issueGrantFile(outputPath: string, issue: (token: string) => void): string {
  const token = randomBytes(32).toString('base64url');
  const fd = openSync(outputPath, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, token + '\n');
    } finally {
      closeSync(fd);
    }
    // 完整写出并关闭私有文件后，才把会话写入数据库。
    issue(token);
  } catch (error) {
    unlinkSync(outputPath);
    throw error;
  }
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
