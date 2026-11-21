import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';

function privateToCurrentUser(info: Stats) {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

function requireCredentialFile(info: Stats, name: 'local-access.json' | 'session.key') {
  const ownerAccess = name === 'session.key' ? 0o400 : 0o600;
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    !privateToCurrentUser(info) ||
    (info.mode & ownerAccess) !== ownerAccess
  )
    throw new Error(`${name}必须是当前本机账户独占的普通文件，请检查所有者、链接和权限`);
}

/** Check legacy credentials before the server lock or restore can change the directory. */
export function inspectLegacyCredentials(directory: string): Buffer | undefined {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || !privateToCurrentUser(info) || (info.mode & 0o700) !== 0o700)
    throw new Error('数据目录必须是当前本机账户独占的真实目录（0700）');

  const access = lstatSync(join(directory, 'local-access.json'), { throwIfNoEntry: false });
  if (access) requireCredentialFile(access, 'local-access.json');

  const keyPath = join(directory, 'session.key');
  const key = lstatSync(keyPath, { throwIfNoEntry: false });
  if (!key) return undefined;
  requireCredentialFile(key, 'session.key');
  const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    requireCredentialFile(opened, 'session.key');
    if (opened.size !== 32) throw new Error('本机会话密钥损坏');
    const secret = readFileSync(fd);
    if (secret.length !== 32) throw new Error('本机会话密钥损坏');
    return secret;
  } finally {
    closeSync(fd);
  }
}

export function writeLegacyAccessFile(path: string, origin: string, issueToken: () => string) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    requireCredentialFile(fstatSync(fd), 'local-access.json');
    const token = issueToken();
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify({ url: `${origin}/#token=${token}`, origin, token }));
  } finally {
    closeSync(fd);
  }
}
