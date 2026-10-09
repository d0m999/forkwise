import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  ManualUpdateInput,
  ManualUpdateRequest,
  ManualUpdatePreview,
  ManualUpdateResult,
  UpdatePage,
  UpdateEvents,
  UpdateTasks,
} from '../contracts/manual-updates.js';
import { Id } from '../contracts/entities.js';
import { response, ErrorSchema, ok } from '../contracts/responses.js';
import type { ResearchController } from '../controllers/research.js';
import type { Principal } from '../services/access.js';
import { readUpdateEvents, readUpdateTasks } from '../services/manual-update-events.js';
export function registerManualUpdates(
  app: OpenAPIHono<{ Variables: { principal: Principal } }>,
  c: ResearchController,
) {
  const params = z.object({ projectId: Id });
  const json = (schema: z.ZodType) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  const responses = (schema: z.ZodType) => ({
    200: { description: '操作成功', content: { 'application/json': { schema: response(schema) } } },
    400: { description: '请求无效', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: '无项目权限', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: '预览冲突', content: { 'application/json': { schema: ErrorSchema } } },
    ...Object.fromEntries(
      [401, 404, 413, 422, 500, 503].map((status) => [
        status,
        {
          description: '请求未完成，详见错误代码与原因',
          content: { 'application/json': { schema: ErrorSchema } },
        },
      ]),
    ),
  });
  const root = '/api/v1/projects/{projectId}/manual-updates';
  app.openapi(
    createRoute({
      method: 'post',
      path: root + '/preview',
      request: { params, body: json(ManualUpdateInput) },
      responses: responses(ManualUpdatePreview),
    }),
    (ctx) => {
      const id = ctx.req.valid('param').projectId;
      c.access.project(ctx.get('principal'), id);
      return ctx.json(ok(c.manualUpdates.preview(id, ctx.req.valid('json'))));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: root,
      request: {
        params,
        headers: z.object({ 'Idempotency-Key': z.string().min(8).max(128) }),
        body: json(ManualUpdateRequest),
      },
      responses: responses(ManualUpdateResult),
    }),
    (ctx) => {
      const id = ctx.req.valid('param').projectId,
        p = ctx.get('principal');
      c.access.project(p, id);
      return ctx.json(
        ok(
          c.manualUpdates.request(
            id,
            p.actor,
            ctx.req.header('Idempotency-Key')!,
            ctx.req.valid('json'),
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: root,
      request: { params, query: UpdatePage },
      responses: responses(UpdateEvents),
    }),
    (ctx) => {
      const id = ctx.req.valid('param').projectId;
      c.access.project(ctx.get('principal'), id);
      return ctx.json(ok(readUpdateEvents(c.repo, id, ctx.req.valid('query'))));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: root + '/{eventKey}/tasks',
      request: {
        params: params.extend({ eventKey: z.string().regex(/^[a-f0-9]{64}$/) }),
        query: UpdatePage,
      },
      responses: responses(UpdateTasks),
    }),
    (ctx) => {
      const { projectId, eventKey } = ctx.req.valid('param');
      c.access.project(ctx.get('principal'), projectId);
      return ctx.json(ok(readUpdateTasks(c.repo, projectId, eventKey, ctx.req.valid('query'))));
    },
  );
}
