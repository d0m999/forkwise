import { Citation, isImageCitation, type Actor, type AnyEntity } from '../contracts/entities.js';
import type { z } from 'zod';
import type { ResearchTaskService } from './research-tasks.js';
import { DomainError } from '../domain/errors.js';

export interface CorrectionTrigger {
  kind: 'transcription_correction';
  previousSourceVersionId: string;
  correctedSourceVersionId: string;
  page: number;
  conditionIds: string[];
}

/** Restrict analysis to references intersecting the corrected page, then follow
 * current evidence links and current condition evaluations. Historical judgments
 * are not part of this traversal and remain pinned to their original inputs. */
export function correctionScope(
  objects: AnyEntity[],
  previousId: string,
  page: number,
  artifact: any,
) {
  const spans: { start: number; end: number; page: number }[] =
    artifact.regions ?? artifact.pages ?? [];
  const cites = (citation: z.infer<typeof Citation>) =>
    citation.sourceVersionId === previousId &&
    (artifact.page === page ||
      (isImageCitation(citation)
        ? citation.page === page
        : spans.some((s) => s.page === page && s.start < citation.end && s.end > citation.start)));
  const map = new Map(objects.map((e) => [e.id, e]));
  const targets = new Set<string>(),
    conditions = new Set<string>();
  const evidenceIds = new Set(
    objects.filter((e) => e.kind === 'evidence' && cites(e.data.citation)).map((e) => e.id),
  );
  for (const e of objects) {
    if ((e.kind === 'statement' || e.kind === 'inference') && e.data.citations.some(cites))
      targets.add(e.id);
    if (
      e.kind === 'evidence_link' &&
      evidenceIds.has(e.data.evidenceId) &&
      map.get(e.data.target.id)?.contentVersionId === e.data.target.versionId
    )
      targets.add(e.data.target.id);
    if (
      e.kind === 'evaluation' &&
      map.get(e.data.condition.id)?.contentVersionId === e.data.condition.versionId &&
      (e.data.citations.some(cites) || e.data.evidenceIds.some((id) => evidenceIds.has(id)))
    )
      conditions.add(e.data.condition.id);
  }
  for (const id of conditions) {
    const condition = map.get(id);
    if (condition?.kind === 'condition')
      for (const target of condition.data.targetIds) targets.add(target);
  }
  // A changed premise can affect its immediately dependent inference. The model
  // receives its endpoints as context; it does not rewrite downstream conclusions.
  for (const e of objects)
    if (e.kind === 'inference' && e.data.premiseIds.some((id) => targets.has(id)))
      targets.add(e.id);
  return { targetIds: [...targets], conditionIds: [...conditions] };
}

export function enqueueCorrectionImpact(
  tasks: ResearchTaskService,
  projectId: string,
  actor: Actor,
  previousId: string,
  correctedId: string,
  page: number,
  artifact: unknown,
) {
  const repo = tasks.write.repo;
  const scope = correctionScope(repo.snapshot(projectId).objects, previousId, page, artifact);
  let jobIds: string[] = [],
    gap: string | null = null;
  if (scope.targetIds.length) {
    try {
      jobIds = repo.db
        .transaction(() => {
          const ids: string[] = [];
          for (let offset = 0; offset < scope.targetIds.length; offset += 100) {
            const job = tasks.request(
              projectId,
              actor,
              `correction_${correctedId}_${offset}`,
              {
                kind: 'impact',
                sourceVersionIds: [previousId, correctedId],
                targetIds: scope.targetIds.slice(offset, offset + 100),
              },
              {
                kind: 'transcription_correction',
                previousSourceVersionId: previousId,
                correctedSourceVersionId: correctedId,
                page,
                conditionIds: scope.conditionIds,
              },
            );
            ids.push(job.id);
          }
          return ids;
        })
        .immediate();
    } catch (error) {
      gap =
        error instanceof DomainError
          ? `${error.code}: ${error.message}`
          : '受影响分析未能排队，可选取新转写与相关对象重新分析';
    }
  }
  return { ...scope, jobIds, gap };
}
