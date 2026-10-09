import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { Id, Time, Text } from '../contracts/entities.js';
import { ErrorSchema, ok, response } from '../contracts/responses.js';
import type { Env } from './api.js';
import type { ResearchController } from '../controllers/research.js';
import { AssetService, LayoutInput } from '../services/assets.js';
import {
  ArchiveSchema,
  LayoutSchema,
  JudgmentSchema,
  JudgmentSummary,
  SearchInput,
  SearchResult,
} from '../contracts/assets.js';
import { ArchiveService } from '../services/archive.js';
import { ProjectSchema } from '../contracts/responses.js';

export function registerAssets(app: OpenAPIHono<Env>, controller: ResearchController) {
  const assets = new AssetService(controller.repo, controller.write);
  const p = '/api/v1/projects/{projectId}';
  const params = z.object({ projectId: Id });
  const headers = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
  const output = (schema: z.ZodType) => ({
    200: { description: '操作成功', content: { 'application/json': { schema: response(schema) } } },
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 422, 500, 503].map((status) => [
        status,
        { description: '业务或权限错误', content: { 'application/json': { schema: ErrorSchema } } },
      ]),
    ),
  });
  const body = (schema: z.ZodType) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  const authorize = (principal: Parameters<typeof controller.access.project>[0], id: string) =>
    controller.access.project(principal, id);
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/layout`,
      request: { params },
      responses: output(LayoutSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(ok(assets.layout(id)));
    },
  );
  app.openapi(
    createRoute({
      method: 'put',
      path: `${p}/layout`,
      request: { params, headers, body: body(LayoutInput) },
      responses: output(LayoutSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(
        ok(
          assets.saveLayout(
            id,
            c.get('principal').actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/search`,
      request: { params, body: body(SearchInput) },
      responses: output(SearchResult),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      const input = SearchInput.parse(c.req.valid('json'));
      return c.json(ok(controller.search.search(id, input.query, input.asOf, input.vector)));
    },
  );
  const embedding = z
    .object({
      chunkId: z.number().int().positive(),
      model: z.string().min(1).max(200),
      values: z.array(z.number().finite()).min(1).max(8192),
    })
    .strict();
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/embeddings`,
      request: { params, headers, body: body(embedding) },
      responses: output(z.object({ indexed: z.boolean() })),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      const principal = c.get('principal');
      authorize(principal, id);
      const input = embedding.parse(c.req.valid('json'));
      return c.json(
        ok(
          controller.write.idempotent(
            principal.actor,
            id,
            c.req.header('Idempotency-Key')!,
            { op: 'embedding.save', input },
            () => {
              controller.search.embed(id, input.chunkId, input.model, input.values);
              return { indexed: true };
            },
          ),
        ),
      );
    },
  );
  const title = z.object({ title: Text }).strict();
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/judgments`,
      request: { params, headers, body: body(title) },
      responses: output(JudgmentSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(
        ok(
          assets.recordJudgment(
            id,
            c.get('principal').actor,
            c.req.header('Idempotency-Key')!,
            title.parse(c.req.valid('json')).title,
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/judgments`,
      request: { params },
      responses: output(z.array(JudgmentSummary)),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(ok(assets.judgments(id)));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/judgments/{id}`,
      request: { params: params.extend({ id: Id }) },
      responses: output(JudgmentSchema),
    }),
    (c) => {
      const { projectId, id } = c.req.valid('param');
      authorize(c.get('principal'), projectId);
      return c.json(ok(assets.judgment(projectId, id)));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/export`,
      request: { params },
      responses: output(ArchiveSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(ok(assets.export(id)));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/summary`,
      request: { params, query: z.object({ judgmentId: Id.optional() }) },
      responses: output(z.object({ markdown: z.string() })),
    }),
    (c) => {
      const id = c.req.valid('param').projectId;
      authorize(c.get('principal'), id);
      return c.json(ok({ markdown: assets.summary(id, c.req.valid('query').judgmentId) }));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/imports',
      request: { headers, body: body(ArchiveSchema) },
      responses: output(
        z.object({
          project: ProjectSchema,
          provenance: z.object({
            importedAt: Time,
            archiveHash: z.string(),
            historyAuthenticity: z.literal('unverified'),
            omissions: z.array(Id),
          }),
        }),
      ),
    }),
    (c) => {
      const principal = c.get('principal');
      controller.access.human(principal);
      return c.json(
        ok(
          new ArchiveService(controller.write, controller.search).import(
            principal.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
}
