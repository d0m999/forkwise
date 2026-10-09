import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { ResearchRepository } from '../repositories/research.js';
import { requireThat } from '../domain/errors.js';
export const MaterialPage = z
  .object({
    start: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(20000).default(12000),
  })
  .strict();
export function readMaterialPage(
  repo: ResearchRepository,
  projectId: string,
  id: string,
  raw: unknown,
) {
  const { start: requested, limit } = MaterialPage.parse(raw);
  const version = repo.snapshot(projectId).objects.find((e) => e.id === id);
  requireThat(version?.kind === 'source_version', 'MATERIAL_NOT_FOUND', '材料版本不存在', 404);
  const text = repo.material(projectId, id),
    hash = createHash('sha256').update(text).digest('hex');
  requireThat(
    hash === version.data.contentHash && text.length === version.data.textLength,
    'MATERIAL_CORRUPTED',
    '文本与固定材料指纹不一致',
    409,
  );
  requireThat(requested <= text.length, 'INVALID_RANGE', '读取起点超出材料范围');
  const split = (at: number) =>
    at > 0 &&
    at < text.length &&
    /[\uDC00-\uDFFF]/.test(text[at]!) &&
    /[\uD800-\uDBFF]/.test(text[at - 1]!);
  const start = split(requested) ? requested - 1 : requested;
  let end = Math.min(text.length, start + limit);
  if (split(end)) end--;
  if (end === start && end < text.length) end = Math.min(text.length, start + 2);
  const row = repo.db
    .prepare('SELECT data FROM parsed_artifacts WHERE project_id=? AND source_version_id=?')
    .get(projectId, id) as { data: string } | undefined;
  const artifact = row ? JSON.parse(row.data) : {};
  const anchors = (artifact.regions ?? artifact.blocks ?? [])
    .filter((r: { start: number; end: number }) => r.start < end && r.end > start)
    .slice(0, 1000);
  const segment = text.slice(start, end);
  return {
    sourceVersionId: id,
    versionId: version.contentVersionId,
    hash,
    segmentHash: createHash('sha256').update(segment).digest('hex'),
    totalLength: text.length,
    start,
    end,
    nextStart: end < text.length ? end : null,
    text: segment,
    anchors,
    coverage: version.data.coverage ?? 'unknown',
    textOrigin: version.data.textOrigin ?? 'unknown',
  };
}
