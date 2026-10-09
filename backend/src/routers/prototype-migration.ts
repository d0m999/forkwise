import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './api.js';
import type { ResearchController } from '../controllers/research.js';
import { PrototypeMigrationService } from '../services/prototype-migration.js';
import {
  PrototypeMigrationInput,
  PrototypeMigrationCommit,
  MigrationPreview,
  MigrationResult,
  MigrationReport,
} from '../contracts/prototype-migration.js';
import { ErrorSchema, ok, response } from '../contracts/responses.js';
import { Id } from '../contracts/entities.js';

export function registerPrototypeMigration(app: OpenAPIHono<Env>, controller: ResearchController) {
  const service = new PrototypeMigrationService(controller.write, controller.search);
  const output = (schema: z.ZodType) => ({
    200: { description: '操作成功', content: { 'application/json': { schema: response(schema) } } },
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 422, 500].map((status) => [
        status,
        {
          description: '副本、权限或完整性错误',
          content: { 'application/json': { schema: ErrorSchema } },
        },
      ]),
    ),
  });
  const body = (schema: z.ZodType) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/prototype-migrations/preview',
      request: { body: body(PrototypeMigrationInput) },
      responses: output(MigrationPreview),
    }),
    (c) => {
      const principal = c.get('principal');
      controller.access.human(principal);
      return c.json(ok(service.preview(principal.actor, c.req.valid('json'))));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/prototype-migrations',
      request: {
        headers: z.object({ 'Idempotency-Key': z.string().min(8).max(128) }),
        body: body(PrototypeMigrationCommit),
      },
      responses: output(MigrationResult),
    }),
    (c) => {
      const principal = c.get('principal');
      controller.access.human(principal);
      return c.json(
        ok(service.import(principal.actor, c.req.header('Idempotency-Key')!, c.req.valid('json'))),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/projects/{projectId}/prototype-migration',
      request: { params: z.object({ projectId: Id }) },
      responses: output(
        z
          .object({ workspace: z.record(z.string(), z.unknown()), report: MigrationReport })
          .strict(),
      ),
    }),
    (c) => {
      const principal = c.get('principal'),
        projectId = c.req.valid('param').projectId;
      controller.access.human(principal);
      controller.access.project(principal, projectId);
      return c.json(ok(service.record(projectId)));
    },
  );
}
