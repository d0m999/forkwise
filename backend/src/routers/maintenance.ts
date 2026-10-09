import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './api.js';
import type { ResearchController } from '../controllers/research.js';
import type { MaintenanceService } from '../services/maintenance.js';
import { ProjectLifecycle } from '../services/project-lifecycle.js';
import { requireThat } from '../domain/errors.js';
import { Id, Time } from '../contracts/entities.js';
import { ErrorSchema, ProjectSchema, ok, response } from '../contracts/responses.js';

export function registerMaintenance(
  app: OpenAPIHono<Env>,
  controller: ResearchController,
  maintenance?: MaintenanceService,
) {
  const lifecycle = new ProjectLifecycle(controller.write);
  const p = '/api/v1';
  const params = z.object({ projectId: Id });
  const headers = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
  const body = (schema: z.ZodType) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  const output = (schema: z.ZodType) => ({
    200: { description: '成功', content: { 'application/json': { schema: response(schema) } } },
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 422, 500, 503].map((status) => [
        status,
        { description: '业务或权限错误', content: { 'application/json': { schema: ErrorSchema } } },
      ]),
    ),
  });
  const owner = (principal: Parameters<typeof controller.access.human>[0]) => {
    controller.access.human(principal);
    return principal.actor;
  };
  const local = () => {
    requireThat(maintenance, 'MAINTENANCE_UNAVAILABLE', '此实例未配置本机备份目录', 503);
    return maintenance;
  };
  const rename = z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(100_000),
      question: z.string().max(20_000),
    })
    .strict();
  app.openapi(
    createRoute({
      method: 'patch',
      path: `${p}/projects/{projectId}`,
      request: { params, headers, body: body(rename) },
      responses: output(ProjectSchema),
    }),
    (c) => {
      const actor = owner(c.get('principal'));
      const id = c.req.valid('param').projectId;
      controller.access.project(c.get('principal'), id);
      const input = rename.parse(c.req.valid('json'));
      return c.json(
        ok(
          lifecycle.rename(
            actor,
            id,
            c.req.header('Idempotency-Key')!,
            input.expectedRevision,
            input.name,
            input.question,
          ),
        ),
      );
    },
  );
  const trash = z
    .object({ expectedRevision: z.number().int().nonnegative(), confirmName: z.string().min(1) })
    .strict();
  const deletion = z.object({ projectId: Id, deletedAt: Time, purgeAfter: Time });
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/trash`,
      request: { params, headers, body: body(trash) },
      responses: output(deletion),
    }),
    (c) => {
      const actor = owner(c.get('principal'));
      const id = c.req.valid('param').projectId;
      controller.access.project(c.get('principal'), id);
      const input = trash.parse(c.req.valid('json'));
      return c.json(
        ok(
          lifecycle.trash(
            actor,
            id,
            c.req.header('Idempotency-Key')!,
            input.expectedRevision,
            input.confirmName,
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/trash`,
      responses: output(
        z.array(
          z.object({
            id: Id,
            name: z.string(),
            deletedAt: Time,
            purgeAfter: Time,
            state: z.string(),
            remainingDays: z.number().int(),
          }),
        ),
      ),
    }),
    (c) => {
      owner(c.get('principal'));
      return c.json(ok(lifecycle.trashList()));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/restore`,
      request: { params, headers },
      responses: output(ProjectSchema),
    }),
    (c) => {
      const actor = owner(c.get('principal'));
      const id = c.req.valid('param').projectId;
      controller.access.project(c.get('principal'), id);
      return c.json(ok(lifecycle.restore(actor, id, c.req.header('Idempotency-Key')!)));
    },
  );
  const retention = z.object({ retentionDays: z.number().int().min(1).max(3650) }).strict();
  app.openapi(
    createRoute({ method: 'get', path: `${p}/settings/retention`, responses: output(retention) }),
    (c) => {
      owner(c.get('principal'));
      return c.json(ok({ retentionDays: lifecycle.retentionDays() }));
    },
  );
  app.openapi(
    createRoute({
      method: 'put',
      path: `${p}/settings/retention`,
      request: { headers, body: body(retention) },
      responses: output(retention),
    }),
    (c) => {
      const actor = owner(c.get('principal'));
      return c.json(
        ok(
          lifecycle.configure(
            actor,
            c.req.header('Idempotency-Key')!,
            retention.parse(c.req.valid('json')).retentionDays,
          ),
        ),
      );
    },
  );
  const backup = z.object({ id: Id, createdAt: Time, fingerprint: z.string() });
  app.openapi(
    createRoute({ method: 'get', path: `${p}/backups`, responses: output(z.array(backup)) }),
    (c) => {
      owner(c.get('principal'));
      return c.json(ok(local().backups.list()));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/backups`,
      request: { headers },
      responses: output(backup),
    }),
    async (c) => {
      const actor = owner(c.get('principal'));
      return c.json(ok(await local().backup(actor, c.req.header('Idempotency-Key')!)));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/backups/{id}/restore-isolated`,
      request: { params: z.object({ id: Id }), headers },
      responses: output(
        z.object({ directory: z.string(), fingerprint: z.string(), verified: z.boolean() }),
      ),
    }),
    async (c) => {
      const actor = owner(c.get('principal'));
      return c.json(
        ok(await local().restore(actor, c.req.header('Idempotency-Key')!, c.req.valid('param').id)),
      );
    },
  );
  const purge = z.object({ confirm: z.literal('purge-expired-projects') }).strict();
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/maintenance/purge-expired`,
      request: { body: body(purge) },
      responses: output(
        z.array(
          z.object({
            projectId: Id,
            state: z.string(),
            copies: z.array(z.string()).optional(),
            error: z.string().optional(),
          }),
        ),
      ),
    }),
    async (c) => {
      owner(c.get('principal'));
      return c.json(ok(await local().purgeDue()));
    },
  );
}
