import type { ManualUpdateService } from '../services/manual-updates.js';
import type { TranscriptionService } from '../services/transcription.js';
import type { Principal, AccessService } from '../services/access.js';
import type { ResearchRepository } from '../repositories/research.js';
import type { GraphWriteService } from '../services/graph-write.js';
import type { EvaluationService } from '../services/evaluation.js';
import { requireThat } from '../domain/errors.js';
import type { Job } from '../repositories/jobs.js';
import type { SearchRepository } from '../repositories/search.js';
import type { SecFilingService } from '../services/sec-filings.js';
import type { PublicDataService } from '../services/public-data.js';
import type { MaterialFileService } from '../services/material-files.js';
import type { ResearchTaskService } from '../services/research-tasks.js';
import { readWorkspace, syncProject } from '../services/sync.js';
import type { InitialResearchService } from '../services/initial-research.js';
import { importMaterialFile } from '../services/file-import.js';
import { readResearchOverview, readObjectResearchResults } from '../services/research-results.js';
import { readImpactReviews } from '../services/impact-reviews.js';

export class ResearchController {
  constructor(
    readonly repo: ResearchRepository,
    readonly write: GraphWriteService,
    readonly access: AccessService,
    readonly evaluation: EvaluationService,
    readonly search: SearchRepository,
    readonly publicData: PublicDataService,
    readonly files: MaterialFileService,
    readonly researchTasks: ResearchTaskService,
    readonly transcription: TranscriptionService,
    readonly initialResearch: InitialResearchService,
    readonly filings: SecFilingService,
    readonly manualUpdates: ManualUpdateService,
  ) {}
  projects(p: Principal) {
    return this.repo
      .listProjects()
      .filter(
        (x) => p.projects.includes(x.id) || (p.actor.type === 'human' && p.projects.includes('*')),
      );
  }
  create(p: Principal, key: string, input: unknown) {
    this.access.human(p);
    return this.write.createProject(p.actor, key, input);
  }
  state(p: Principal, projectId: string, asOf?: string) {
    this.access.project(p, projectId);
    return this.repo.snapshot(projectId, asOf);
  }
  workspace(p: Principal, projectId: string) {
    this.access.project(p, projectId);
    return readWorkspace(this.repo, projectId);
  }
  sync(p: Principal, projectId: string, afterRevision: number, layoutVersion: number) {
    this.access.project(p, projectId);
    return syncProject(this.repo, projectId, afterRevision, layoutVersion);
  }
  execute(p: Principal, projectId: string, key: string, input: unknown) {
    this.access.project(p, projectId);
    return this.write.execute(projectId, p.actor, key, input);
  }
  actionHistory(p: Principal, projectId: string) {
    this.access.project(p, projectId);
    return this.write.history(projectId);
  }
  travel(p: Principal, projectId: string, key: string, input: unknown) {
    this.access.project(p, projectId);
    return this.write.travel(projectId, p.actor, key, input);
  }
  history(p: Principal, projectId: string, id: string) {
    this.access.project(p, projectId);
    return this.repo.history(projectId, id);
  }
  material(p: Principal, projectId: string, id: string) {
    this.access.project(p, projectId);
    return { id, text: this.repo.material(projectId, id) };
  }
  operation(p: Principal, projectId: string, key: string) {
    this.access.project(p, projectId);
    return this.write.operation(projectId, p.actor, key);
  }
  importFile(p: Principal, projectId: string, key: string, input: unknown) {
    this.access.project(p, projectId);
    return importMaterialFile(this.files, projectId, p.actor, key, input);
  }
  jobs(p: Principal, projectId: string) {
    this.access.project(p, projectId);
    this.repo.project(projectId);
    return this.evaluation.jobs.summaries(projectId);
  }
  researchOverview(p: Principal, projectId: string) {
    this.access.project(p, projectId);
    return readResearchOverview(this.repo, projectId);
  }
  impactReviews(p: Principal, projectId: string, page: unknown) {
    this.access.project(p, projectId);
    return readImpactReviews(this.repo, projectId, page);
  }
  objectResults(p: Principal, projectId: string, id: string, page: unknown) {
    this.access.project(p, projectId);
    return readObjectResearchResults(this.repo, projectId, id, page);
  }
  job(p: Principal, projectId: string, id: string) {
    this.access.project(p, projectId);
    this.repo.project(projectId);
    return this.publicJob(this.evaluation.jobs.get(projectId, id));
  }
  evaluate(
    p: Principal,
    projectId: string,
    key: string,
    input: { conditionId: string; evidenceIds: string[]; ruleVersionId: string },
  ) {
    this.access.project(p, projectId);
    return this.write.idempotent(
      p.actor,
      projectId,
      key,
      { op: 'evaluation.request', input },
      () => {
        this.evaluation.jobs.assertCapacity(projectId);
        return this.publicJob(
          this.evaluation.request(
            projectId,
            input.conditionId,
            input.evidenceIds,
            input.ruleVersionId,
          ),
        );
      },
    );
  }
  jobAction(p: Principal, projectId: string, key: string, id: string, action: 'cancel' | 'retry') {
    this.access.project(p, projectId);
    this.repo.project(projectId);
    return this.write.idempotent(p.actor, projectId, key, { op: `job.${action}`, id }, () =>
      this.publicJob(
        action === 'cancel'
          ? this.cancel(projectId, id)
          : this.evaluation.jobs.retry(projectId, id),
      ),
    );
  }
  grant(p: Principal, key: string, projectIds: string[]) {
    this.access.human(p);
    requireThat(projectIds.length > 0, 'PROJECT_REQUIRED', '必须选择授权的项目');
    for (const id of projectIds) {
      this.access.project(p, id);
      this.repo.project(id);
    }
    const token = this.access.grantToken(p.actor.id, key);
    // The reproducible token is returned to the local owner, never persisted in operation responses.
    const result = this.write.idempotent(
      p.actor,
      '__grants__',
      key,
      { op: 'grant', projectIds },
      () => {
        this.access.issue('agent', projectIds, 30 * 24 * 60 * 60 * 1000, token);
        return { projectIds };
      },
    );
    return { ...result, token };
  }
  private publicJob(job: Job) {
    return { ...job, runToken: null };
  }
  private cancel(projectId: string, id: string) {
    const kind = this.evaluation.jobs.get(projectId, id).kind;
    if (kind === 'source.sec-filing') return this.filings.cancel(projectId, id);
    if (kind === 'workflow.initial') return this.initialResearch.cancel(projectId, id);
    return kind === 'material.vision'
      ? this.transcription.cancel(projectId, id)
      : ['source.sec', 'source.sec-history'].includes(kind)
        ? this.publicData.cancel(projectId, id)
        : kind === 'material.parse'
          ? this.files.cancel(projectId, id)
          : kind.startsWith('research.')
            ? this.researchTasks.cancel(projectId, id)
            : this.evaluation.cancel(projectId, id);
  }
}
