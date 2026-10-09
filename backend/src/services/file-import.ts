import { randomUUID } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { Source, type Actor } from '../contracts/entities.js';
import { FileInput, type MaterialFileService } from './material-files.js';

export const FileImportInput = z
  .object({
    source: Source,
    file: FileInput.omit({ sourceId: true, expectedSourceVersion: true }),
  })
  .strict();

/** A single user import creates its source, bytes and parse job atomically. */
export function importMaterialFile(
  files: MaterialFileService,
  projectId: string,
  actor: Actor,
  key: string,
  raw: unknown,
) {
  const input = FileImportInput.parse(raw),
    write = files.write;
  write.repo.project(projectId);
  return write.idempotent(actor, projectId, key, { op: 'file.import', input }, () => {
    const sourceId = randomUUID();
    const changes = write.execute(projectId, actor, randomUUID(), {
      expected: {},
      commands: [{ op: 'source.create', id: sourceId, data: input.source }],
    });
    const uploaded = files.upload(projectId, actor, randomUUID(), {
      ...input.file,
      sourceId,
      expectedSourceVersion: 1,
    });
    return { ...uploaded, changes };
  });
}
