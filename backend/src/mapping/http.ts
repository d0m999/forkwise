import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { Mapping } from './mapping.js';
import type { Principal } from '../services/access.js';
import { DomainError, requireThat } from '../domain/errors.js';
import { CompactQuerySchema } from './compact-contracts.js';
import { ObserveQuerySchema } from './observe-contracts.js';
import { SearchQuerySchema } from './search-contracts.js';
import { EXECUTE_FALLBACK_CODE } from './recovery-contract.js';

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
  const tooLarge = (c: { json: (body: { code: string; message: string }, status: 413) => Response }) =>
    c.json({ code: 'TOO_LARGE', message: '内容超过本次保存上限' }, 413);
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/mapping/execute') return next();
    return bodyLimit({ maxSize: 1_000_000, onError: tooLarge })(c, next);
  });
  app.post('/api/session', (c) => {
    mapping.access.human(c.get('principal'));
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    // Navigation headers establish origin context, never the OS user's identity.
    mapping.access.human(mapping.access.authenticate(token));
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    return c.json({ authorized: true });
  });
  app.get('/api/mapping/projects', (c) =>
    c.json(mapping.read({ type: 'projects' }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id', (c) =>
    c.json(mapping.read({ type: 'project', projectId: c.req.param('id') }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id/map', (c) => {
    const parameters = c.req.query();
    const query = CompactQuerySchema.parse({
      ...parameters,
      type: 'map',
      projectId: c.req.param('id'),
      ...(parameters.budget === undefined ? {} : { budget: Number(parameters.budget) }),
    });
    return c.json(mapping.read(query, c.get('principal')));
  });
  app.post('/api/mapping/projects/:id/search', async (c) => {
    const input = SearchQuerySchema.omit({ type: true, projectId: true }).parse(await c.req.json());
    return c.json(await mapping.read({ ...input, type: 'search', projectId: c.req.param('id') }, c.get('principal')));
  });
  app.get('/api/mapping/projects/:id/search-state', (c) =>
    c.json(mapping.read({ type: 'search.state', projectId: c.req.param('id') }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id/cards/:cardId/identity', (c) =>
    c.json(
      mapping.read(
        { type: 'card.identity', projectId: c.req.param('id'), id: c.req.param('cardId') },
        c.get('principal'),
      ),
    ),
  );
  app.get('/api/mapping/projects/:id/assets/:assetId', (c) =>
    c.json(mapping.read({type:'asset',projectId:c.req.param('id'),id:c.req.param('assetId')},c.get('principal'))));
  app.get('/api/mapping/projects/:id/assets/:assetId/content', (c) => {
    let asset;
    try {
      asset = mapping.read({ type: 'asset', projectId: c.req.param('id'), id: c.req.param('assetId') }, c.get('principal'));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MEDIA_NOT_PERSISTED')
        throw new DomainError('NOT_FOUND', '资产不存在或不属于本项目', 404);
      throw error;
    }
    const bytes = new Uint8Array(Buffer.from(asset.base64, 'base64'));
    if (asset.width !== undefined) {
      return new Response(bytes, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox; style-src 'none'; img-src 'none'" } });
    }
    const requested = c.req.query('disposition');
    if (requested !== undefined && requested !== 'inline' && requested !== 'attachment')
      throw new DomainError('INVALID_COMMAND', '打开方式只能是 inline 或 attachment', 400);
    const mime = asset.mime;
    const forced = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'image/svg+xml' || mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml') || mime === 'application/javascript' || mime === 'text/javascript' || mime === 'application/ecmascript' || mime === 'text/ecmascript';
    const inlineable = !forced && (mime === 'application/pdf' || mime === 'text/plain' || mime.startsWith('image/'));
    const disposition = !inlineable || requested === 'attachment' ? 'attachment' : 'inline';
    const encoded = encodeURIComponent(asset.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(bytes, { headers: {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': disposition === 'inline' ? "default-src 'none'; style-src 'none'; img-src 'none'" : "default-src 'none'; sandbox; style-src 'none'; img-src 'none'",
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encoded}`,
    } });
  });
  app.get('/api/mapping/projects/:id/history', (c) =>
    c.json(mapping.read({ type: 'history', projectId: c.req.param('id') }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id/cuts/:cutId', (c) =>
    c.json(mapping.read({ type: 'cut.state', projectId: c.req.param('id'), cutId: c.req.param('cutId') }, c.get('principal'))),
  );
  app.get('/api/mapping/projects/:id/changes', (c) =>
    c.json(
      mapping.observe(
        ObserveQuerySchema.parse(
          (() => {
            const { after, budget, limit, ...parameters } = c.req.query();
            return {
              ...parameters,
              projectId: c.req.param('id'),
              afterRevision: Number(after ?? 0),
              ...(budget === undefined ? {} : { budget: Number(budget) }),
              ...(limit === undefined ? {} : { limit: Number(limit) }),
            };
          })(),
        ),
        c.get('principal'),
      ),
    ),
  );
  app.get('/api/mapping/projects/:id/versions/:domain/:objectId/:versionId', (c) =>
    c.json(
      mapping.read(
        {
          type: 'version',
          projectId: c.req.param('id'),
          domain: z.enum(['body', 'pose', 'appearance', 'tag', 'cardTags', 'shape', 'stroke', 'image', 'connector', 'group', 'containment']).parse(c.req.param('domain')),
          id: c.req.param('objectId'),
          versionId: c.req.param('versionId'),
        },
        c.get('principal'),
      ),
    ),
  );
  app.post('/api/mapping/execute', bodyLimit({ maxSize: 48 * 1024 * 1024, onError: tooLarge }), async (c) =>
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
    const file = staticFile('/index.html');
    return c.newResponse(file.body, file);
  });
  app.get('/assets/*', (c) => {
    const file = staticFile(c.req.path);
    return c.newResponse(file.body, file);
  });
  app.onError((error, c) => {
    const searching = c.req.path.endsWith('/search');
    if (error instanceof DomainError)
      return c.json(
        {
          code: error.code,
          message: error.message,
          ...(c.req.path.endsWith('/map') || c.req.path.endsWith('/changes')
            ? { details: error.details }
            : {}),
        },
        error.status,
      );
    if (error instanceof ZodError || error instanceof SyntaxError)
      return searching ? c.json({ code: 'INVALID_QUERY', message: '搜索条件格式无效；原输入未修改' }, 400)
        : c.req.path.endsWith('/map') || c.req.path.endsWith('/changes')
        ? c.json({ code: 'INVALID_QUERY', message: '地图读取请求格式无效' }, 400)
        : c.json({ code: 'INVALID_COMMAND', message: '保存请求格式无效；原内容未修改' }, 400);
    return searching ? c.json({ code: 'SEARCH_FAILED', message: '搜索暂时不可用，请保留当前条件并重试' }, 503)
      : c.json({ code: EXECUTE_FALLBACK_CODE, message: '保存失败，请保留当前输入并重试' }, 503);
  });
  return app;
}
