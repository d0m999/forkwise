import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import type { Mapping } from './mapping.js';
import type { Principal } from '../services/access.js';
import { DomainError, requireThat } from '../domain/errors.js';

export function createWorkspaceApp(
  mapping: Mapping,
  origin: string,
  staticFile: (path: string) => Response,
) {
  const url = new URL(origin);
  requireThat(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin,
    'INVALID_ORIGIN',
    '仅支持本机回环入口',
  );
  const cookieName = `forkwise_workspace_${url.port}`;
  const app = new Hono<{ Variables: { principal: Principal } }>();
  app.use('*', async (c, next) => {
    requireThat(
      (c.req.header('host') ?? new URL(c.req.url).host) === url.host,
      'INVALID_HOST',
      '本机入口地址不匹配',
      403,
    );
    const requestOrigin = c.req.header('origin');
    requireThat(
      !requestOrigin || requestOrigin === origin,
      'INVALID_ORIGIN',
      '仅允许本机页面访问',
      403,
    );
    const site = c.req.header('sec-fetch-site');
    requireThat(
      !site || site === 'none' || site === 'same-origin',
      'CROSS_SITE',
      '拒绝跨站访问',
      403,
    );
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      requireThat(requestOrigin === origin, 'INVALID_ORIGIN', '写入需要本机页面来源', 403);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    await next();
  });
  app.use('/api/*', async (c, next) => {
    const token =
      c.req.header('authorization')?.replace(/^Bearer /, '') ?? getCookie(c, cookieName) ?? '';
    c.set('principal', mapping.access.authenticate(token));
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) => c.json({ code: 'TOO_LARGE', message: '内容超过本次保存上限' }, 413),
    }),
  );
  app.get('/api/mapping/projects', (c) =>
    c.json(mapping.read({ type: 'projects' }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id', (c) =>
    c.json(mapping.read({ type: 'project', projectId: c.req.param('id') }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id/changes', (c) =>
    c.json(
      mapping.observe(
        { projectId: c.req.param('id'), afterRevision: Number(c.req.query('after') ?? 0) },
        c.get('principal'),
      ),
    ),
  );
  app.post('/api/mapping/execute', async (c) =>
    c.json(mapping.execute(await c.req.json(), c.get('principal'))),
  );
  app.get('/', (c) => {
    requireThat(
      c.req.header('sec-fetch-mode') === 'navigate' &&
        ['none', 'same-origin'].includes(c.req.header('sec-fetch-site') ?? ''),
      'LOCAL_NAVIGATION_REQUIRED',
      '请在本机浏览器直接打开工作台',
      403,
    );
    let valid = false;
    try {
      valid = mapping.access.authenticate(getCookie(c, cookieName) ?? '').actor.type === 'human';
    } catch {
      /* Start a new local browser session. */
    }
    if (!valid)
      setCookie(c, cookieName, mapping.access.issue('human', ['*']), {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        maxAge: 8 * 60 * 60,
      });
    const file = staticFile('/index.html');
    return c.newResponse(file.body, file);
  });
  app.get('/assets/*', (c) => {
    const file = staticFile(c.req.path);
    return c.newResponse(file.body, file);
  });
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json({ code: error.code, message: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ code: 'INVALID_COMMAND', message: '保存请求格式无效；原内容未修改' }, 400);
    return c.json({ code: 'SAVE_FAILED', message: '保存失败，请保留当前输入并重试' }, 503);
  });
  return app;
}
