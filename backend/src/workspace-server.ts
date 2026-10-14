import { serve } from '@hono/node-server';
import {
  existsSync,
  lstatSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMapping } from './mapping/storage.js';
import { createWorkspaceApp } from './mapping/http.js';

const directory = process.env.FORKWISE_DATA_DIR;
if (!directory)
  throw new Error('请显式设置 FORKWISE_DATA_DIR 为新的开放工作台目录；不读取旧 .data');
const port = Number(process.env.FORKWISE_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FORKWISE_PORT 必须为 1024–65535');
const webRoot = resolve(fileURLToPath(new URL('../workspace/', import.meta.url)));
if (!existsSync(resolve(webRoot, 'index.html')))
  throw new Error('开放工作台尚未构建，请先运行 npm run build:workspace；旧入口未改变');
const origin = `http://127.0.0.1:${port}`;
const mapping = openMapping(directory);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const app = createWorkspaceApp(mapping, origin, (path) => {
  const file = resolve(webRoot, '.' + path);
  if (
    !file.startsWith(webRoot + sep) ||
    !existsSync(file) ||
    !lstatSync(file).isFile() ||
    !types[extname(file)]
  )
    return new Response('资源不存在', { status: 404 });
  return new Response(readFileSync(file), { headers: { 'Content-Type': types[extname(file)]! } });
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  const accessPath = resolve(directory, 'local-access.json');
  let fd: number | undefined;
  try {
    fd = openSync(accessPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error('启动凭证文件权限不安全');
    const token = mapping.access.issue('human', ['*']);
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify({ url: `${origin}/#token=${token}`, origin }));
    console.log(
      `见岔开放工作台：${origin}（仅本机）。请用本机账户打开 ${accessPath} 中的 url；凭证不会输出到日志。`,
    );
  } catch {
    console.error('无法写入仅本人可读的启动凭证，已停止新入口；原入口未改变');
    process.exitCode = 1;
    close();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
});
server.on('error', () => {
  mapping.close();
  console.error('开放工作台启动失败；请检查端口占用，旧入口未改变');
  process.exitCode = 1;
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => {
    mapping.close();
  });
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  // Accepted preconnections/incomplete HTTP requests are not classified as
  // idle by Node. Explicit shutdown closes them after synchronous Mapping
  // transactions have completed; it must not wait for a browser context.
  if ('closeAllConnections' in server) server.closeAllConnections();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
