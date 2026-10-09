import { z } from '@hono/zod-openapi';
import { Id } from './entities.js';
import { ProjectSchema } from './responses.js';

// One project per import keeps private drafts and the recovery copy inside its
// project boundary. The browser splits a multi-project workspace before upload.
export const PrototypeMigrationInput = z
  .object({
    workspace: z.record(z.string(), z.unknown()),
  })
  .strict();
export const MigrationIssue = z
  .object({ path: z.string(), code: z.string(), message: z.string() })
  .strict();
export const MigrationReport = z
  .object({
    converter: z.enum(['prototype-v1-to-project-v1', 'prototype-v1-to-project-v2']),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    legacyProjectId: z.string(),
    projectId: Id,
    name: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    mapping: z.array(z.object({ legacyId: z.string(), id: Id, kind: z.string() }).strict()),
    retained: z.array(z.string()),
    issues: z.array(MigrationIssue),
  })
  .strict();
export const MigrationPreview = z
  .object({ report: MigrationReport, previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const PrototypeMigrationCommit = PrototypeMigrationInput.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const MigrationResult = z
  .object({ project: ProjectSchema, report: MigrationReport, recoveryFileId: Id })
  .strict();
export type Report = z.infer<typeof MigrationReport>;
