import type { z } from 'zod';
import type { AnyEntity, Entity } from '../contracts/entities.js';
import {
  ResearchOverview,
  ObjectResearchResults,
  ResultsPage,
} from '../contracts/research-results.js';
import { requireThat } from '../domain/errors.js';
import { digest } from '../domain/canonical.js';
import { verificationContext } from '../domain/verification.js';
import type { ResearchRepository } from '../repositories/research.js';

type Applicability = 'current' | 'stale' | 'withdrawn' | 'unbound';
type Target = Entity<'statement'> | Entity<'inference'>;
type Summary = z.infer<typeof ResearchOverview>['targets'][number];
interface Row {
  jobId: string;
  index: number;
  finishedAt: string;
  targetId: string;
  targetVersionId: string;
  stale: number | null;
  withdrawn: number;
  scopedVersion: string | null;
  kind: string | null;
  premiseIds: string | null;
  conclusionId: string | null;
  context: string;
  relation: 'supports' | 'opposes' | 'qualifies' | 'background' | 'insufficient';
  aspect: 'reported_fact' | 'current_basis' | 'inference_basis' | null;
  explanationPreview: string;
  check: string | null;
  taskGaps: string | null;
  coverage: string | null;
}
type Cursor = [string, string, string, string, number];
function decodeCursor(raw: string | undefined, projectId: string, targetId: string): Cursor | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    /* invalid cursor */
  }
  requireThat(
    Array.isArray(value) &&
      value.length === 5 &&
      value[0] === projectId &&
      value[1] === targetId &&
      typeof value[2] === 'string' &&
      !Number.isNaN(Date.parse(value[2])) &&
      typeof value[3] === 'string' &&
      Number.isSafeInteger(value[4]) &&
      value[4] >= 0,
    'INVALID_CURSOR',
    '结果分页位置无效，请从第一页重新读取',
    400,
  );
  return value as Cursor;
}
function binding(objects: Map<string, AnyEntity>, target: Target) {
  return {
    target: { id: target.id, versionId: target.contentVersionId },
    context: verificationContext(objects, target),
  };
}
function linkApplicability(
  objects: Map<string, AnyEntity>,
  target: Target,
  link: Entity<'evidence_link'>,
): Exclude<Applicability, 'withdrawn'> {
  if (link.data.target.versionId !== target.contentVersionId) return 'stale';
  const evidence = objects.get(link.data.evidenceId);
  if (evidence?.kind !== 'evidence' || (target.kind === 'inference' && !link.data.context))
    return 'unbound';
  return digest(verificationContext(objects, target)) === digest(link.data.context ?? [])
    ? 'current'
    : 'stale';
}
function checkApplicability(
  objects: Map<string, AnyEntity>,
  target: Target,
  row: Row,
): Applicability {
  if (row.withdrawn) return 'withdrawn';
  if (row.scopedVersion !== row.targetVersionId || row.kind !== target.kind) return 'unbound';
  const context = JSON.parse(row.context) as { id: string; versionId: string }[];
  let refs: { id: string; versionId: string }[] = [];
  if (row.kind === 'inference') {
    const premises: unknown = row.premiseIds ? JSON.parse(row.premiseIds) : null;
    if (
      !Array.isArray(premises) ||
      !premises.every((x) => typeof x === 'string') ||
      !row.conclusionId
    )
      return 'unbound';
    refs = [...new Set([...premises, row.conclusionId])].sort().map((id) => ({
      id,
      versionId: context.find((x) => x.id === id)?.versionId ?? '',
    }));
    if (refs.some((x) => !x.versionId)) return 'unbound';
  }
  return !row.stale &&
    row.targetVersionId === target.contentVersionId &&
    digest(refs) === digest(verificationContext(objects, target))
    ? 'current'
    : 'stale';
}

/** Read only fixed target bindings and bounded result fields. In particular,
 * never load a job's material text or graph changes for canvas polling. */
function rows(
  repo: ResearchRepository,
  projectId: string,
  targetId?: string,
  page?: z.infer<typeof ResultsPage>,
) {
  const cursor = page && targetId ? decodeCursor(page.cursor, projectId, targetId) : null;
  return repo.db
    .prepare(
      `
    SELECT c.job_id AS jobId, c.check_index AS "index", c.finished_at AS finishedAt,
      c.target_id AS targetId, c.target_version_id AS targetVersionId,
      r.stale, CASE WHEN g.applied=0 THEN 1 ELSE 0 END AS withdrawn,
      c.scoped_version AS scopedVersion, c.kind, c.premise_ids AS premiseIds,
      c.conclusion_id AS conclusionId, c.context, c.relation, c.aspect,
      c.explanation_preview AS explanationPreview,
      ${page ? 'c."check", r.task_gaps AS taskGaps, r.coverage' : "NULL AS 'check', NULL AS taskGaps, NULL AS coverage"}
    FROM research_checks c JOIN research_result_jobs r ON r.job_id=c.job_id AND r.project_id=c.project_id
      LEFT JOIN workflow_group_tasks w ON w.project_id=c.project_id AND w.job_id=c.job_id
      LEFT JOIN workflow_groups g ON g.project_id=w.project_id AND g.id=w.group_id
    WHERE c.project_id=?
      ${targetId ? 'AND c.target_id=?' : ''}
      ${cursor ? 'AND (c.finished_at,c.job_id,c.check_index) < (?,?,?)' : ''}
    ORDER BY c.finished_at DESC,c.job_id DESC,c.check_index DESC ${page ? 'LIMIT ?' : ''}
  `,
    )
    .all(
      projectId,
      ...(targetId ? [targetId] : []),
      ...(cursor ? cursor.slice(2) : []),
      ...(page ? [page.limit + 1] : []),
    ) as Row[];
}

export function readResearchOverview(
  repo: ResearchRepository,
  projectId: string,
): z.infer<typeof ResearchOverview> {
  return repo.db
    .transaction(() => {
      const state = repo.snapshot(projectId),
        objects = new Map(state.objects.map((e) => [e.id, e]));
      const targets = new Map<string, Summary>();
      for (const target of state.objects)
        if (target.kind === 'statement' || target.kind === 'inference')
          targets.set(target.id, {
            ...binding(objects, target),
            evidence: { candidate: 0, adopted: 0, stale: 0, unbound: 0 },
            checks: { current: 0, stale: 0, withdrawn: 0, unbound: 0 },
            latest: null,
          });
      for (const link of state.objects)
        if (link.kind === 'evidence_link') {
          const summary = targets.get(link.data.target.id),
            target = objects.get(link.data.target.id) as Target;
          if (!summary) continue;
          const status = linkApplicability(objects, target, link);
          summary.evidence[status === 'current' ? link.data.participation : status]++;
        }
      for (const row of rows(repo, projectId)) {
        const summary = targets.get(row.targetId);
        if (!summary) continue;
        const status = checkApplicability(objects, objects.get(row.targetId) as Target, row);
        summary.checks[status]++;
        if (status === 'current' && !summary.latest)
          summary.latest = {
            jobId: row.jobId,
            index: row.index,
            finishedAt: row.finishedAt,
            relation: row.relation,
            ...(row.aspect ? { aspect: row.aspect } : {}),
            explanationPreview: row.explanationPreview,
          };
      }
      return { projectId, revision: state.project.revision, targets: [...targets.values()] };
    })
    .deferred();
}

export function readObjectResearchResults(
  repo: ResearchRepository,
  projectId: string,
  targetId: string,
  raw: unknown,
): z.infer<typeof ObjectResearchResults> {
  const page = ResultsPage.parse(raw);
  return repo.db
    .transaction(() => {
      const state = repo.snapshot(projectId),
        objects = new Map(state.objects.map((e) => [e.id, e]));
      const target = objects.get(targetId);
      requireThat(
        target && (target.kind === 'statement' || target.kind === 'inference'),
        'TARGET_NOT_FOUND',
        '本项目没有此主张或推导',
        404,
      );
      const result = rows(repo, projectId, targetId, page),
        visible = result.slice(0, page.limit),
        last = visible.at(-1);
      return ObjectResearchResults.parse({
        projectId,
        revision: state.project.revision,
        ...binding(objects, target),
        evidenceLinks: state.objects
          .filter(
            (e): e is Entity<'evidence_link'> =>
              e.kind === 'evidence_link' && e.data.target.id === targetId,
          )
          .map((e) => ({ id: e.id, applicability: linkApplicability(objects, target, e) })),
        checks: visible.map((row) => {
          const coverage = JSON.parse(row.coverage!);
          return {
            jobId: row.jobId,
            index: row.index,
            finishedAt: row.finishedAt,
            applicability: checkApplicability(objects, target, row),
            check: JSON.parse(row.check!),
            taskGaps: JSON.parse(row.taskGaps ?? '[]'),
            coverage: {
              sourceVersionIds: coverage.sourceVersionIds ?? [],
              mode: coverage.mode,
              modelCalled: coverage.modelCalled === null ? null : Boolean(coverage.modelCalled),
              networkQueries: coverage.networkQueries ?? [],
            },
          };
        }),
        nextCursor:
          result.length > page.limit && last
            ? Buffer.from(
                JSON.stringify([projectId, targetId, last.finishedAt, last.jobId, last.index]),
              ).toString('base64url')
            : null,
      });
    })
    .deferred();
}
