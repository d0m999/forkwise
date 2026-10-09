import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { Id } from '../contracts/entities.js';
import { ResearchTaskInput } from '../contracts/research-tasks.js';
import { ExternalSubmit, ExternalEvaluationInput } from '../contracts/external-research.js';
import { ExternalTranscriptionInput } from '../contracts/transcription.js';
import { DrawingOperations } from '../contracts/drawing.js';
import { ChangesSchema, JobSchema, ErrorSchema, ok, response } from '../contracts/responses.js';
import { importLocalFile, PathImportInput } from '../services/local-import.js';
import { readMaterialPage, MaterialPage } from '../services/material-read.js';
import { editDrawings } from '../services/drawing.js';
import type { Env } from './api.js';
import type { ResearchController } from '../controllers/research.js';
import { requireThat } from '../domain/errors.js';
const p = '/api/v1/projects/{projectId}',
  params = z.object({ projectId: Id }),
  target = params.extend({ id: Id });
const headers = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const body = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const output = (schema: z.ZodType) => ({
  200: { description: '成功', content: { 'application/json': { schema: response(schema) } } },
  ...Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 422, 503].map((s) => [
      s,
      { description: '业务错误', content: { 'application/json': { schema: ErrorSchema } } },
    ]),
  ),
});
export function registerLocalDelivery(app: OpenAPIHono<Env>, controller: ResearchController) {
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/external-evaluations`,
      request: { params, headers, body: body(ExternalEvaluationInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId,
        principal = c.get('principal');
      controller.access.project(principal, id);
      return c.json(
        ok(
          controller.externalResearch.requestEvaluation(
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
      method: 'post',
      path: `${p}/external-research`,
      request: { params, headers, body: body(ResearchTaskInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId,
        principal = c.get('principal');
      controller.access.project(principal, id);
      return c.json(
        ok({
          ...controller.externalResearch.request(
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
      path: `${p}/external-research/{id}/submit`,
      request: { params: target, headers, body: body(ExternalSubmit) },
      responses: output(JobSchema),
    }),
    (c) => {
      const { projectId, id } = c.req.valid('param'),
        principal = c.get('principal');
      controller.access.project(principal, projectId);
      return c.json(
        ok(
          controller.externalResearch.submit(
            projectId,
            principal.actor,
            c.req.header('Idempotency-Key')!,
            id,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
  for (const action of ['cancel', 'retry'] as const)
    app.openapi(
      createRoute({
        method: 'post',
        path: `${p}/external-research/{id}/${action}`,
        request: { params: target, headers },
        responses: output(JobSchema),
      }),
      (c) => {
        const { projectId, id } = c.req.valid('param'),
          principal = c.get('principal');
        controller.access.project(principal, projectId);
        return c.json(
          ok(
            controller.externalResearch.action(
              projectId,
              principal.actor,
              c.req.header('Idempotency-Key')!,
              id,
              action,
            ),
          ),
        );
      },
    );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/files/import-path`,
      request: { params, headers, body: body(PathImportInput) },
      responses: output(z.unknown()),
    }),
    (c) => {
      const id = c.req.valid('param').projectId,
        principal = c.get('principal');
      controller.access.project(principal, id);
      return c.json(
        ok(
          importLocalFile(
            controller.files,
            controller.importRoots,
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
      path: `${p}/materials/{id}/segments`,
      request: { params: target, query: MaterialPage.extend({ jobId: Id.optional() }) },
      responses: output(z.unknown()),
    }),
    (c) => {
      const { projectId, id } = c.req.valid('param'),
        principal = c.get('principal');
      controller.access.project(principal, projectId);
      const { jobId, ...page } = c.req.valid('query'),
        data = readMaterialPage(controller.repo, projectId, id, page);
      if (jobId)
        controller.externalResearch.recordRead(projectId, principal.actor, jobId, {
          sourceVersionId: id,
          hash: data.hash,
          start: data.start,
          end: data.end,
          kind: 'text',
        });
      return c.json(ok(data));
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${p}/materials/{id}/image-data`,
      request: {
        params: target,
        query: z.object({
          page: z.coerce.number().int().min(1).max(1000).default(1),
          jobId: Id.optional(),
        }),
      },
      responses: output(z.unknown()),
    }),
    async (c) => {
      const { projectId, id } = c.req.valid('param'),
        principal = c.get('principal');
      controller.access.project(principal, projectId);
      const { page, jobId } = c.req.valid('query'),
        image = await controller.transcription.image(projectId, id, page, c.req.raw.signal);
      const version = controller.repo.snapshot(projectId).objects.find((e) => e.id === id);
      requireThat(
        version?.kind === 'source_version' && version.data.fileId,
        'FILE_NOT_FOUND',
        '原图不存在',
        404,
      );
      const fileHash = controller.files.file(projectId, version.data.fileId).hash;
      if (jobId)
        controller.externalResearch.recordRead(projectId, principal.actor, jobId, {
          sourceVersionId: id,
          fileHash,
          page,
          kind: 'image',
        });
      return c.json(ok({ ...image, fileHash, sourceVersionId: id, verified: false }));
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: `${p}/external-transcriptions`,
      request: { params, headers, body: body(ExternalTranscriptionInput) },
      responses: output(z.unknown()),
    }),
    async (c) => {
      const id = c.req.valid('param').projectId,
        principal = c.get('principal');
      controller.access.project(principal, id);
      return c.json(
        ok(
          await controller.transcription.submitExternal(
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
      method: 'post',
      path: `${p}/drawing-operations`,
      request: { params, headers, body: body(DrawingOperations) },
      responses: output(ChangesSchema),
    }),
    (c) => {
      const id = c.req.valid('param').projectId,
        principal = c.get('principal');
      controller.access.project(principal, id);
      return c.json(
        ok(
          editDrawings(
            controller.write,
            controller.files,
            id,
            principal.actor,
            c.req.header('Idempotency-Key')!,
            c.req.valid('json'),
          ),
        ),
      );
    },
  );
}
