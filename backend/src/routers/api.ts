import { registerManualUpdates } from './manual-updates.js';
import { registerLocalDelivery } from './local-delivery.js';
import { ActionHistoryStatus, HistoryTravel } from '../contracts/action-history.js';
import { WorkspaceSchema, SyncSchema, JobSummarySchema } from '../contracts/responses.js';
import { registerTranscription } from './transcription.js';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Principal } from '../services/access.js';
import type { ResearchController } from '../controllers/research.js';
import { DomainError, requireThat } from '../domain/errors.js';
import { Id, Time } from '../contracts/entities.js';
import { ProjectInput, WriteRequest } from '../contracts/commands.js';
import {
  ChangesSchema,
  EntitySchema,
  ErrorSchema,
  JobSchema,
  ProjectSchema,
  StateSchema,
  ok,
  response,
} from '../contracts/responses.js';
import { registerAssets } from './assets.js';
import { registerPrototypeMigration } from './prototype-migration.js';
import { registerMaintenance } from './maintenance.js';
import type { MaintenanceService } from '../services/maintenance.js';
import { SecFilingInput, SecHistoryInput } from '../contracts/sec-filings.js';
import { PublicDataInput } from '../services/public-data.js';
import { CanvasMaterialInput, FileInput } from '../services/material-files.js';
import { ResearchTaskInput } from '../contracts/research-tasks.js';
import { InitialResearchInput } from '../contracts/initial-research.js';
import { FileImportInput } from '../services/file-import.js';
import { ImpactReviewPage, ImpactReviews } from '../contracts/impact-reviews.js';
import {
  ResearchOverview,
  ObjectResearchResults,
  ResultsPage,
} from '../contracts/research-results.js';

export type Env = { Variables: { principal: Principal } };
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 500, 503].map((status) => [
    status,
    { description: '业务或权限错误', content: { 'application/json': { schema: ErrorSchema } } },
  ]),
);
const output = (schema: z.ZodType) => ({
  200: { description: '操作成功', content: { 'application/json': { schema: response(schema) } } },
  ...errors,
});
const params = z.object({ projectId: Id });
const target = params.extend({ id: Id });
const headers = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const json = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema } },
});
export function createApi(
  controller: ResearchController,
  origin: string,
  maintenance?: MaintenanceService,
) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            code: 'INVALID_REQUEST',
            data: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
            message: '请求格式不符合接口契约',
          },
          400,
        );
    },
  });
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    requireThat(host === new URL(origin).host, 'INVALID_HOST', '本机入口地址不匹配', 403);
    const requestOrigin = c.req.header('origin');
    requireThat(
      !requestOrigin || requestOrigin === origin,
      'INVALID_ORIGIN',
      '拒绝其他网站调用本机服务',
      403,
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.path !== '/health') {
      const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ?? '';
      c.set('principal', controller.access.authenticate(token));
    }
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 36 * 1024 * 1024,
      onError: (c) =>
        c.json({ code: 'BODY_TOO_LARGE', data: null, message: '请求过大，请分批导入' }, 413),
    }),
  );
  app.get('/health', (c) => c.json(ok({ status: 'ok' })));
  const p = '/api/v1';
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects`,
      responses: output(z.array(ProjectSchema)),
    }),
    (c) => c.json(ok(controller.projects(c.get('principal')))),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects`,
      request: { headers, body: json(ProjectInput) },
      responses: output(ProjectSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.create(
            c.get('principal'),
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/state`,
      request: { params, query: z.object({ asOf: Time.optional() }) },
      responses: output(StateSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.state(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('query').asOf,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/action-history`,
      request: { params },
      responses: output(ActionHistoryStatus),
    }),
    (c) => c.json(ok(controller.actionHistory(c.get('principal'), c.req.valid('param').projectId))),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/action-history/travel`,
      request: { params, headers, body: json(HistoryTravel) },
      responses: output(ChangesSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.travel(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/operations`,
      request: { params, headers, body: json(WriteRequest) },
      responses: output(ChangesSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.execute(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/operations/{id}`,
      request: { params: target },
      responses: output(z.unknown()),
    }),
    (c) =>
      c.json(
        ok(
          controller.operation(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('param').id,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/objects/{id}/history`,
      request: { params: target },
      responses: output(z.array(EntitySchema)),
    }),
    (c) =>
      c.json(
        ok(
          controller.history(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('param').id,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/materials/{id}`,
      request: { params: target },
      responses: output(z.object({ id: Id, text: z.string() })),
    }),
    (c) =>
      c.json(
        ok(
          controller.material(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('param').id,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/jobs`,
      request: { params },
      responses: output(z.array(JobSummarySchema)),
    }),
    (c) => c.json(ok(controller.jobs(c.get('principal'), c.req.valid('param').projectId))),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/jobs/{id}`,
      request: { params: target },
      responses: output(JobSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.job(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('param').id,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/research-results`,
      request: { params },
      responses: output(ResearchOverview),
    }),
    (c) =>
      c.json(ok(controller.researchOverview(c.get('principal'), c.req.valid('param').projectId))),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/objects/{id}/research-results`,
      request: { params: target, query: ResultsPage },
      responses: output(ObjectResearchResults),
    }),
    (c) =>
      c.json(
        ok(
          controller.objectResults(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('param').id,
            c.req.valid('query'),
          ),
        ),
      ),
  );
  const evaluateInput = z
    .object({ conditionId: Id, ruleVersionId: Id, evidenceIds: z.array(Id).max(100) })
    .strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/impact-reviews`,
      request: { params, query: ImpactReviewPage },
      responses: output(ImpactReviews),
    }),
    (c) =>
      c.json(
        ok(
          controller.impactReviews(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.valid('query'),
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/evaluations`,
      request: { params, headers, body: json(evaluateInput) },
      responses: output(JobSchema),
    }),
    (c) =>
      c.json(
        ok(
          controller.evaluate(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.header('Idempotency-Key')!,
            evaluateInput.parse(c.req.valid('json')),
          ),
        ),
      ),
  );
  for (const action of ['cancel', 'retry'] as const)
    app.openapi(
      createRoute({
        method: 'post',
        path: `${p}/projects/{projectId}/jobs/{id}/${action}`,
        request: { params: target, headers },
        responses: output(JobSchema),
      }),
      (c) =>
        c.json(
          ok(
            controller.jobAction(
              c.get('principal'),
              c.req.valid('param').projectId,
              c.req.header('Idempotency-Key')!,
              c.req.valid('param').id,
              action,
            ),
          ),
        ),
    );
  const grant = z
    .object({
      projectIds: z.array(Id).min(1).max(100),
      personalRecordProjects: z.array(Id).max(100).default([]),
    })
    .strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/agent-grants`,
      responses: output(
        z.array(
          z.object({
            id: Id,
            projects: z.array(Id),
            expiresAt: Time,
            expired: z.boolean(),
            personalRecordProjects: z.array(Id),
          }),
        ),
      ),
    }),
    (c) => {
      controller.access.human(c.get('principal'));
      return c.json(ok(controller.access.grants()));
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: `${p}/agent-grants/{id}`,
      request: { params: z.object({ id: Id }), headers },
      responses: output(z.object({ id: Id, revoked: z.boolean() })),
    }),
    (c) => {
      const principal = c.get('principal');
      controller.access.human(principal);
      const id = c.req.valid('param').id;
      return c.json(
        ok(
          controller.write.idempotent(
            principal.actor,
            '__grants__',
            c.req.header('Idempotency-Key')!,
            { op: 'grant.revoke', id },
            () => controller.access.revokeGrant(id),
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/agent-grants`,
      request: { headers, body: json(grant) },
      responses: output(
        z.object({
          token: z.string(),
          projectIds: z.array(Id),
          personalRecordProjects: z.array(Id),
        }),
      ),
    }),
    (c) =>
      c.json(
        ok(
          controller.grant(
            c.get('principal'),
            c.req.header('Idempotency-Key')!,
            grant.parse(c.req.valid('json')).projectIds,
            grant.parse(c.req.valid('json')).personalRecordProjects,
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/sync`,
      request: {
        params,
        query: z.object({
          afterRevision: z.coerce.number().int().nonnegative(),
          layoutVersion: z.coerce.number().int().nonnegative(),
        }),
      },
      responses: output(SyncSchema),
    }),
    (c) => {
      const query = c.req.valid('query');
      return c.json(
        ok(
          controller.sync(
            c.get('principal'),
            c.req.valid('param').projectId,
            query.afterRevision,
            query.layoutVersion,
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/workspace`,
      request: { params },
      responses: output(WorkspaceSchema),
    }),
    (c) => c.json(ok(controller.workspace(c.get('principal'), c.req.valid('param').projectId))),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/projects/{projectId}/canvas-materials',
      request: { params, headers, body: json(CanvasMaterialInput) },
      responses: output(z.object({ sourceVersionId: Id, fileId: Id, changes: ChangesSchema })),
    }),
    (c) => {
      const id = c.req.valid('param').projectId,
        p = c.get('principal');
      controller.access.project(p, id);
      return c.json(
        ok(
          controller.files.attachCanvas(
            id,
            p.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
  registerManualUpdates(app, controller);
  registerTranscription(app, controller);
  registerLocalDelivery(app, controller);
  registerAssets(app, controller);
  registerPrototypeMigration(app, controller);
  registerMaintenance(app, controller, maintenance);
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/initial-research`,
      request: { params, headers, body: json(InitialResearchInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const principal = c.get('principal'),
        id = c.req.valid('param').projectId;
      controller.access.project(principal, id);
      return c.json(
        ok({
          ...controller.initialResearch.request(
            id,
            principal.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
          runToken: null,
        }),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/research-tasks`,
      request: { params, headers, body: json(ResearchTaskInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const principal = c.get('principal'),
        id = c.req.valid('param').projectId;
      controller.access.project(principal, id);
      return c.json(
        ok({
          ...controller.researchTasks.request(
            id,
            principal.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
          runToken: null,
        }),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/files/import`,
      request: { params, headers, body: json(FileImportInput) },
      responses: output(
        z.object({
          fileId: Id,
          hash: z.string(),
          job: JobSchema,
          deduplicated: z.boolean(),
          changes: ChangesSchema,
        }),
      ),
    }),
    (c) =>
      c.json(
        ok(
          controller.importFile(
            c.get('principal'),
            c.req.valid('param').projectId,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/files`,
      request: { params, headers, body: json(FileInput) },
      responses: output(
        z.object({ fileId: Id, hash: z.string(), job: JobSchema, deduplicated: z.boolean() }),
      ),
    }),
    (c) => {
      const principal = c.get('principal');
      const id = c.req.valid('param').projectId;
      controller.access.project(principal, id);
      return c.json(
        ok(
          controller.files.upload(
            id,
            principal.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/files/{id}`,
      request: { params: target },
      responses: {
        200: {
          description: '经过项目权限校验的原文件',
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
        ...errors,
      },
    }),
    (c) => {
      const { projectId, id } = c.req.valid('param');
      controller.access.project(c.get('principal'), projectId);
      const file = controller.files.file(projectId, id);
      c.header('Content-Type', file.mime);
      c.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      c.header('Content-Security-Policy', "default-src 'none'; sandbox");
      return c.body(new Uint8Array(file.bytes));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/projects/{projectId}/materials/{id}/anchors`,
      request: { params: target },
      responses: output(z.unknown()),
    }),
    (c) => {
      const { projectId, id } = c.req.valid('param');
      controller.access.project(c.get('principal'), projectId);
      return c.json(ok(controller.files.artifact(projectId, id)));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/data-sources`,
      responses: output(
        z.object({
          schemaVersion: z.number(),
          version: z.string(),
          sources: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
    }),
    (c) => c.json(ok(controller.publicData.catalog)),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/public-data`,
      request: { params, headers, body: json(PublicDataInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const principal = c.get('principal');
      const id = c.req.valid('param').projectId;
      controller.access.project(principal, id);
      const job = controller.publicData.request(
        id,
        principal.actor,
        c.req.header('Idempotency-Key')!,
        c.req.valid('json'),
      );
      return c.json(ok({ ...job, runToken: null }));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/public-data/filing`,
      request: { params, headers, body: json(SecFilingInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const principal = c.get('principal'),
        projectId = c.req.valid('param').projectId;
      controller.access.project(principal, projectId);
      const job = controller.filings.request(
        projectId,
        principal.actor,
        c.req.header('Idempotency-Key')!,
        c.req.valid('json'),
      );
      return c.json(ok({ ...job, runToken: null }));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/projects/{projectId}/public-data/history-index`,
      request: { params, headers, body: json(SecHistoryInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const principal = c.get('principal'),
        projectId = c.req.valid('param').projectId;
      controller.access.project(principal, projectId);
      const job = controller.publicData.historyRequest(
        projectId,
        principal.actor,
        c.req.header('Idempotency-Key')!,
        c.req.valid('json'),
      );
      return c.json(ok({ ...job, runToken: null }));
    },
  );
  app.openAPIRegistry.registerComponent('securitySchemes', 'LocalSession', {
    type: 'http',
    scheme: 'bearer',
    description: '本机签发的个人或项目范围 Agent 会话',
  });
  app.doc(`${p}/openapi.json`, {
    openapi: '3.0.0',
    info: { title: '见岔（Forkwise）本机研究 API', version: '0.1.0' },
    security: [{ LocalSession: [] }],
  });
  app.notFound((c) => c.json({ code: 'NOT_FOUND', data: null, message: '接口不存在' }, 404));
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json(
        { code: error.code, data: error.details, message: error.message },
        error.status,
      );
    if (error instanceof z.ZodError)
      return c.json(
        { code: 'INVALID_REQUEST', data: null, message: '请求或结果不符合数据契约' },
        400,
      );
    return c.json(
      {
        code: 'INTERNAL_ERROR',
        data: null,
        message: '操作失败，未完成的写入已回滚；请使用原操作键查询或重试',
      },
      500,
    );
  });
  return app;
}
