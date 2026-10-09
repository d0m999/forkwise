import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './api.js';
import type { ResearchController } from '../controllers/research.js';
import { Id } from '../contracts/entities.js';
import { CorrectionInput, TranscriptionInput } from '../contracts/transcription.js';
import { JobSchema, ChangesSchema, ErrorSchema, ok, response } from '../contracts/responses.js';
const params = z.object({ projectId: Id });
const headers = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const json = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const output = (schema: z.ZodType) => ({
  200: { description: '成功', content: { 'application/json': { schema: response(schema) } } },
  400: { description: '校验失败', content: { 'application/json': { schema: ErrorSchema } } },
});
export function registerTranscription(app: OpenAPIHono<Env>, controller: ResearchController) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/projects/{projectId}/transcriptions',
      request: { params, headers, body: json(TranscriptionInput) },
      responses: output(JobSchema),
    }),
    (c) => {
      const p = c.get('principal'),
        id = c.req.valid('param').projectId;
      controller.access.project(p, id);
      return c.json(
        ok({
          ...controller.transcription.request(
            id,
            p.actor,
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
      path: '/api/v1/projects/{projectId}/transcription-corrections',
      request: { params, headers, body: json(CorrectionInput) },
      responses: output(
        z.object({
          sourceVersionId: Id,
          changes: ChangesSchema,
          artifact: z.record(z.string(), z.unknown()),
          impactAnalysis: z.object({
            targetIds: z.array(Id),
            conditionIds: z.array(Id),
            jobIds: z.array(Id),
            gap: z.string().nullable(),
          }),
        }),
      ),
    }),
    (c) => {
      const p = c.get('principal'),
        id = c.req.valid('param').projectId;
      controller.access.project(p, id);
      return c.json(
        ok(
          controller.transcription.correct(
            id,
            p.actor,
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
      path: '/api/v1/projects/{projectId}/materials/{id}/image',
      request: {
        params: params.extend({ id: Id }),
        query: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }),
      },
      responses: {
        200: {
          description: '用于对照的原图或 PDF 页图',
          content: {
            'image/png': { schema: z.string().openapi({ format: 'binary' }) },
            'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
      },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid('param');
      controller.access.project(c.get('principal'), projectId);
      const image = await controller.transcription.image(
        projectId,
        id,
        c.req.valid('query').page,
        c.req.raw.signal,
      );
      c.header('Content-Type', image.mime);
      return c.body(Buffer.from(image.base64, 'base64'));
    },
  );
}
