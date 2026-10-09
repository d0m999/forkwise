import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './app.js';
import { OllamaClient, OllamaEvaluator } from './services/ollama.js';
import { SecClient } from '@forkwise/public-data-core';
import { recoverActivation } from './services/activate-restore.js';

const port = Number(process.env.FORKWISE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FORKWISE_PORT 必须是 1024–65535 的端口');
const origin = `http://127.0.0.1:${port}`;
const directory = resolve(process.env.FORKWISE_DATA_DIR ?? '.data');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, 'server.pid');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  if (Number.isSafeInteger(pid) && pid > 0) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('此数据目录已有服务进程，请复用现有入口');
  }
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
recoverActivation(directory);
const secretPath = join(directory, 'session.key');
if (!existsSync(secretPath))
  writeFileSync(secretPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
const secret = readFileSync(secretPath);
if (secret.length !== 32) throw new Error('本机会话密钥损坏');
const metricsPath = join(directory, 'metrics.json');
const metrics: string[] = existsSync(metricsPath)
  ? JSON.parse(readFileSync(metricsPath, 'utf8'))
  : [];
if (!Array.isArray(metrics) || !metrics.every((v) => typeof v === 'string' && v.trim()))
  throw new Error('metrics.json 应是本人启用的指标名称数组');
const model = process.env.FORKWISE_OLLAMA_MODEL;
const researchModel = model ? new OllamaClient(model) : undefined;
const visionModel = process.env.FORKWISE_OLLAMA_VISION_MODEL
  ? new OllamaClient(process.env.FORKWISE_OLLAMA_VISION_MODEL)
  : undefined;
const agent = researchModel ? new OllamaEvaluator(researchModel) : undefined;
const publicDataClient = process.env.SEC_USER_AGENT
  ? new SecClient({
      userAgent: process.env.SEC_USER_AGENT,
      cacheDirectory: join(directory, 'public-data-cache'),
    })
  : undefined;
const core = createApplication({
  database: join(directory, 'research.sqlite'),
  origin,
  secret,
  metrics,
  ...(visionModel ? { visionModel } : {}),
  ...(agent ? { agent } : {}),
  ...(researchModel ? { researchModel } : {}),
  ...(publicDataClient ? { publicDataClient } : {}),
});
core.jobs.recover();
const token = core.access.issue('human', ['*']);
const accessPath = join(directory, 'local-access.json');
writeFileSync(accessPath, JSON.stringify({ url: `${origin}/#token=${token}`, origin, token }), {
  mode: 0o600,
});
const root = new Hono();
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
for (const [url, name, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/transcription.js', 'transcription.js', 'text/javascript; charset=utf-8'],
  ['/canvas-recovery.js', 'canvas-recovery.js', 'text/javascript; charset=utf-8'],
  ['/canvas-bridge.js', 'canvas-bridge.js', 'text/javascript; charset=utf-8'],
  ['/drafts.js', 'drafts.js', 'text/javascript; charset=utf-8'],
  ['/conditions.js', 'conditions.js', 'text/javascript; charset=utf-8'],
  ['/prototype-migration.js', 'prototype-migration.js', 'text/javascript; charset=utf-8'],
  ['/condition-forms.js', 'condition-forms.js', 'text/javascript; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/api-client.js', 'api-client.js', 'text/javascript; charset=utf-8'],
  ['/operation-versions.js', 'operation-versions.js', 'text/javascript; charset=utf-8'],
  ['/maintenance.js', 'maintenance.js', 'text/javascript; charset=utf-8'],
  ['/image-citations.js', 'image-citations.js', 'text/javascript; charset=utf-8'],
  ['/text-reader.js', 'text-reader.js', 'text/javascript; charset=utf-8'],
  ['/materials.js', 'materials.js', 'text/javascript; charset=utf-8'],
  ['/research.js', 'research.js', 'text/javascript; charset=utf-8'],
  ['/research-results.js', 'research-results.js', 'text/javascript; charset=utf-8'],
  ['/manual-updates.js', 'manual-updates.js', 'text/javascript; charset=utf-8'],
  ['/manual-update-events.js', 'manual-update-events.js', 'text/javascript; charset=utf-8'],
  ['/impact-reviews.js', 'impact-reviews.js', 'text/javascript; charset=utf-8'],
  ['/research-entry.js', 'research-entry.js', 'text/javascript; charset=utf-8'],
  ['/research-entry-plans.js', 'research-entry-plans.js', 'text/javascript; charset=utf-8'],
  ['/request-journal.js', 'request-journal.js', 'text/javascript; charset=utf-8'],
  ['/request-store.js', 'request-store.js', 'text/javascript; charset=utf-8'],
  ['/verification.js', 'verification.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
]) {
  root.get(url!, (c) => {
    c.header('Content-Type', type!);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'",
    );
    return c.body(readFileSync(join(webRoot, name!)));
  });
}
root.get('/canvas/*', (c) => {
  const canvasRoot = join(webRoot, 'canvas'),
    path = resolve(canvasRoot, '.' + c.req.path.slice('/canvas'.length));
  if (!path.startsWith(canvasRoot + sep) || !existsSync(path))
    return c.text('画布资源未构建，请执行 npm run build', 404);
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  const type = mime[extname(path)];
  if (!type) return c.notFound();
  c.header('Content-Type', type);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'",
  );
  return c.body(readFileSync(path));
});
root.route('/', core.app);
let draining = false,
  activeWork: Promise<unknown> = Promise.resolve();
const timer = setInterval(() => {
  if (draining) return;
  draining = true;
  activeWork = Promise.all([
    core.evaluation.drain(),
    core.publicData.drain(),
    core.filings.drain(),
    core.files.drain(),
    core.researchTasks.drain(),
    core.transcription.drain(),
    core.initialResearch.drain(),
  ])
    .catch(() => {
      console.error('后台任务调度失败；请检查本机数据库与任务状态。');
    })
    .finally(() => {
      draining = false;
    });
}, 200);
timer.unref();
const retentionTimer = setInterval(() => {
  void core.maintenance
    ?.purgeDue()
    .then((results) => {
      if (results.some((r) => r.state === 'failed'))
        console.error('到期清理有未完成项，可在本机回收区核对后重试。');
    })
    .catch(() => console.error('到期清理未完成，请检查本机维护状态。'));
}, 60_000);
retentionTimer.unref();
void core.maintenance?.purgeDue().catch(() => console.error('启动时的到期清理未完成。'));
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port });
console.log(`见岔后端已监听 ${origin}。本机访问入口保存在 ${accessPath}，请勿公开该文件。`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  clearInterval(retentionTimer);
  core.evaluation.stop();
  core.publicData.stop();
  core.filings.stop();
  core.files.stop();
  core.researchTasks.stop();
  core.transcription.stop();
  core.initialResearch.stop();
  core.jobs.recover();
  const deadline = setTimeout(() => {
    console.error('后台任务未及时结束，已记录中断状态；下次启动请检查任务。');
    process.exit(1);
  }, 10_000);
  deadline.unref();
  server.close(() => {
    void Promise.all([activeWork, core.maintenance?.idle()]).then(() => {
      core.db.close();
      if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
      process.exit(0);
    });
  });
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
