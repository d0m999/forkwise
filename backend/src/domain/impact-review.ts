import { z } from 'zod';
import { EntitySchema } from '../contracts/responses.js';
import type { AnyEntity, Entity } from '../contracts/entities.js';
import type { CommandInput } from '../contracts/commands.js';
import { Impact } from '../contracts/research-tasks.js';
import type { ResearchRepository } from '../repositories/research.js';
import type { WriteContext } from './write-context.js';
import { digest } from './canonical.js';
import { requireThat } from './errors.js';
import { verificationContext } from './verification.js';

/** Stable across rights-filtered exports: quotation bytes are checked against
 * material by research tasks, while the review pins their location and proposal. */
export function resolveImpactProposal(
  job: { kind: string; state: string; input: unknown; output: unknown } | undefined,
  index: number,
) {
  requireThat(
    job?.kind === 'research.impact' && ['succeeded', 'partial'].includes(job.state),
    'PROPOSAL_NOT_FOUND',
    '影响建议不属于当前项目或尚未完成',
    404,
  );
  const output = z.object({ result: Impact, stale: z.boolean().optional() }).parse(job.output);
  const input = z
    .object({ targets: z.array(EntitySchema), context: z.array(EntitySchema).default([]) })
    .parse(job.input);
  const proposal = output.result.proposals[index];
  requireThat(proposal, 'PROPOSAL_NOT_FOUND', '影响建议不存在', 404);
  const targets = input.targets,
    contexts = input.context;
  const matches = targets.filter(
    (e) => e.id === proposal.target.id && e.contentVersionId === proposal.target.versionId,
  );
  const target = matches[0];
  requireThat(
    matches.length === 1 && (target?.kind === 'statement' || target?.kind === 'inference'),
    'INVALID_PROPOSAL_SCOPE',
    '影响建议缺少唯一固定目标',
  );
  const context = verificationContext(new Map(contexts.map((e) => [e.id, e])), target);
  requireThat(
    context.every((r) => r.versionId),
    'INVALID_PROPOSAL_SCOPE',
    '影响建议缺少固定推导上下文',
  );
  const fingerprint = digest({
    ...proposal,
    context,
    citations: proposal.citations.map(({ quote: _q, unavailableReason: _u, ...anchor }) => anchor),
  });
  return { proposal, context, fingerprint, stale: Boolean(output.stale) };
}
export function readImpactProposal(
  repo: ResearchRepository,
  projectId: string,
  jobId: string,
  index: number,
) {
  const row = repo.db
    .prepare(
      `SELECT kind,state,json_extract(input,'$.targets') AS targets,
    json_extract(input,'$.context') AS context,json_extract(output,'$.result') AS result,
    json_extract(output,'$.stale') AS stale FROM jobs WHERE project_id=? AND id=?`,
    )
    .get(projectId, jobId) as
    | {
        kind: string;
        state: string;
        targets: string | null;
        context: string | null;
        result: string | null;
        stale: number | null;
      }
    | undefined;
  const result = resolveImpactProposal(
    row && {
      ...row,
      input: { targets: JSON.parse(row.targets ?? '[]'), context: JSON.parse(row.context ?? '[]') },
      output: { result: JSON.parse(row.result ?? 'null'), stale: Boolean(row.stale) },
    },
    index,
  );
  validateImpactBinding(result, (id, version) => repo.version(projectId, id, version));
  return result;
}
export function validateImpactBinding(
  result: ReturnType<typeof resolveImpactProposal>,
  lookup: (id: string, version: string) => AnyEntity | undefined,
) {
  const target = lookup(result.proposal.target.id, result.proposal.target.versionId);
  const ids =
    target?.kind === 'inference'
      ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
      : [];
  requireThat(
    (target?.kind === 'statement' || target?.kind === 'inference') &&
      digest(ids) === digest(result.context.map((r) => r.id)),
    'INVALID_PROPOSAL_SCOPE',
    '影响建议前提范围与固定目标不符',
  );
  for (const ref of [result.proposal.target, ...result.context]) {
    const version = lookup(ref.id, ref.versionId);
    requireThat(
      version && version.contentVersionId === ref.versionId,
      'INVALID_PROPOSAL_SCOPE',
      '影响建议的固定版本已无法核对',
    );
  }
}
export function reviewCurrent(
  objects: Map<string, AnyEntity>,
  review: Entity<'review'>,
  pinned: AnyEntity | undefined,
) {
  const target = objects.get(review.data.target.id);
  return Boolean(
    target &&
      !target.deletedAt &&
      pinned &&
      (target.kind === 'statement' || target.kind === 'inference') &&
      (pinned.kind === 'statement' || pinned.kind === 'inference') &&
      target.contentVersionId === pinned.contentVersionId &&
      digest(target.data.stance) === digest(pinned.data.stance) &&
      digest(verificationContext(objects, target)) === digest(review.data.context),
  );
}
export function applyReview(
  c: WriteContext,
  command: Extract<CommandInput, { op: 'impact.review' }>,
) {
  c.human();
  const target = c.readTarget(command.target.id),
    context = verificationContext(c.objects, target);
  for (const ref of context) c.read(ref.id, 'statement');
  requireThat(
    target.versionId === command.target.versionId && digest(context) === digest(command.context),
    'STALE_REVIEW_CONTEXT',
    '内容、个人立场或前提已变化，请重新核对后保存；草稿保留',
    409,
  );
  const candidate = readImpactProposal(c.repo, c.projectId, command.jobId, command.proposalIndex);
  requireThat(
    candidate.proposal.target.id === target.id,
    'INVALID_REVIEW_TARGET',
    '复核目标与影响建议不一致',
  );
  const prior = [...c.objects.values()].find(
    (e): e is Entity<'review'> =>
      !e.deletedAt &&
      e.kind === 'review' &&
      e.data.jobId === command.jobId &&
      e.data.proposalIndex === command.proposalIndex,
  );
  requireThat(
    !prior || prior.id === command.id,
    'REVIEW_EXISTS',
    '此建议已有复核记录，请按当前记录版本修改',
    409,
  );
  const data = {
    jobId: command.jobId,
    proposalIndex: command.proposalIndex,
    proposalHash: candidate.fingerprint,
    proposalTarget: candidate.proposal.target,
    target: command.target,
    context,
    disposition: command.disposition,
    reason: command.reason,
    reviewedAt: c.now,
  };
  if (prior) {
    c.expect(prior.id);
    requireThat(
      prior.data.proposalHash === candidate.fingerprint,
      'PROPOSAL_CHANGED',
      '原建议内容已改变，不能覆盖其复核记录',
    );
    const { reviewedAt: _before, ...before } = prior.data;
    const { reviewedAt: _after, ...after } = data;
    if (digest(before) === digest(after)) return;
    c.change(prior, data, true);
  } else c.add(command.id, 'review', data);
}
