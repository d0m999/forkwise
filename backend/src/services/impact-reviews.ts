import { z } from 'zod';
import { ImpactReviewPage, ImpactReviews } from '../contracts/impact-reviews.js';
import type { ResearchRepository } from '../repositories/research.js';
import type { AnyEntity, Entity } from '../contracts/entities.js';
import { readImpactProposal, reviewCurrent } from '../domain/impact-review.js';
import { verificationContext } from '../domain/verification.js';
import { digest } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';
const text = (e: AnyEntity | undefined) =>
  e?.kind === 'statement' ? e.data.text : e?.kind === 'inference' ? e.data.reason : '';
/** On-demand, bounded reading of impact proposals. No material bodies are sent. */
export function readImpactReviews(
  repo: ResearchRepository,
  projectId: string,
  raw: unknown,
): z.infer<typeof ImpactReviews> {
  const page = ImpactReviewPage.parse(raw);
  let cursor: [string, string, string, string, string, number] | undefined;
  if (page.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(page.cursor, 'base64url').toString());
    } catch {
      /* validated below */
    }
    requireThat(
      Array.isArray(cursor) &&
        cursor.length === 6 &&
        cursor[0] === projectId &&
        cursor[1] === (page.targetId ?? '') &&
        cursor[2] === (page.jobId ?? '') &&
        typeof cursor[3] === 'string' &&
        typeof cursor[4] === 'string' &&
        Number.isInteger(cursor[5]),
      'INVALID_CURSOR',
      '复核列表游标不属于此项目或读取范围',
      400,
    );
  }
  return repo.db
    .transaction(() => {
      const state = repo.snapshot(projectId),
        objects = new Map(state.objects.map((e) => [e.id, e]));
      const reviews = new Map(
        state.objects
          .filter((e): e is Entity<'review'> => e.kind === 'review')
          .map((e) => [`${e.data.jobId}:${e.data.proposalIndex}`, e]),
      );
      const rows = repo.db
        .prepare(
          `SELECT j.id, j.updated_at AS at, CAST(p.key AS INTEGER) AS idx
      FROM jobs j, json_each(j.output,'$.result.proposals') p
      WHERE j.project_id=? AND j.kind='research.impact' AND j.state IN ('succeeded','partial')
      ${page.targetId ? "AND json_extract(p.value,'$.target.id')=?" : ''}
      ${page.jobId ? 'AND j.id=?' : ''}
      ${cursor ? 'AND (j.updated_at,j.id,CAST(p.key AS INTEGER)) < (?,?,?)' : ''}
      ORDER BY j.updated_at DESC,j.id DESC,CAST(p.key AS INTEGER) DESC LIMIT ?`,
        )
        .all(
          projectId,
          ...(page.targetId ? [page.targetId] : []),
          ...(page.jobId ? [page.jobId] : []),
          ...(cursor ? cursor.slice(3) : []),
          page.limit + 1,
        ) as { id: string; at: string; idx: number }[];
      const selected = rows.slice(0, page.limit);
      const items = selected.map((row) => {
        const candidate = readImpactProposal(repo, projectId, row.id, row.idx),
          target = objects.get(candidate.proposal.target.id),
          review = reviews.get(`${row.id}:${row.idx}`);
        const available = target && (target.kind === 'statement' || target.kind === 'inference');
        const context = available ? verificationContext(objects, target) : [];
        const valid =
          !candidate.stale &&
          available &&
          target.contentVersionId === candidate.proposal.target.versionId &&
          digest(context) === digest(candidate.context);
        const currentReview =
          review &&
          review.data.proposalHash === candidate.fingerprint &&
          reviewCurrent(
            objects,
            review,
            repo.version(projectId, review.data.target.id, review.data.target.versionId),
          );
        return {
          jobId: row.id,
          proposalIndex: row.idx,
          createdAt: row.at,
          proposal: candidate.proposal,
          originalText: text(
            repo.version(
              projectId,
              candidate.proposal.target.id,
              candidate.proposal.target.versionId,
            ),
          ),
          originalContext: candidate.context.map((r) => ({
            id: r.id,
            text: text(repo.version(projectId, r.id, r.versionId)),
          })),
          proposalState: !available
            ? ('unavailable' as const)
            : valid
              ? ('current' as const)
              : ('stale' as const),
          reviewState: !review
            ? ('pending' as const)
            : !currentReview
              ? ('stale' as const)
              : review.data.disposition === 'later'
                ? ('later' as const)
                : ('completed' as const),
          current: available
            ? {
                expected: Object.fromEntries(
                  [target.id, ...context.map((r) => r.id), ...(review ? [review.id] : [])].map(
                    (id) => [id, objects.get(id)!.version],
                  ),
                ),
                target: { id: target.id, versionId: target.versionId },
                context,
                text: text(target),
                stance: target.data.stance,
                contextTexts: context.map((r) => ({ id: r.id, text: text(objects.get(r.id)) })),
              }
            : null,
          review: review ?? null,
        };
      });
      const last = selected.at(-1);
      return {
        projectId,
        revision: state.project.revision,
        items,
        nextCursor:
          rows.length > page.limit && last
            ? Buffer.from(
                JSON.stringify([
                  projectId,
                  page.targetId ?? '',
                  page.jobId ?? '',
                  last.at,
                  last.id,
                  last.idx,
                ]),
              ).toString('base64url')
            : null,
      };
    })
    .deferred();
}
