import { ManualUpdateService } from './services/manual-updates.js';
import { ExternalResearchService } from './services/external-research.js';
import { TranscriptionService, type VisionModel } from './services/transcription.js';
import { randomBytes } from 'node:crypto';
import { AccessService } from './services/access.js';
import { GraphWriteService } from './services/graph-write.js';
import { EvaluationService, type AgentEvaluator } from './services/evaluation.js';
import { openDatabase } from './repositories/database.js';
import { ResearchRepository } from './repositories/research.js';
import { JobRepository } from './repositories/jobs.js';
import { ResearchController } from './controllers/research.js';
import { createApi } from './routers/api.js';
import { SearchRepository } from './repositories/search.js';
import { MaintenanceService } from './services/maintenance.js';
import { dirname } from 'node:path';
import { SecFilingService } from './services/sec-filings.js';
import { PublicDataService } from './services/public-data.js';
import type { SecClient } from '@forkwise/public-data-core';
import { MaterialFileService } from './services/material-files.js';
import { ResearchTaskService, type StructuredModel } from './services/research-tasks.js';
import { InitialResearchService } from './services/initial-research.js';

export function createApplication(options: {
  database: string;
  origin: string;
  secret?: Buffer;
  metrics?: string[];
  agent?: AgentEvaluator;
  publicDataClient?: SecClient;
  researchModel?: StructuredModel;
  visionModel?: VisionModel;
  importRoots?: Record<string, string[]>;
}) {
  const db = openDatabase(options.database);
  const repo = new ResearchRepository(db);
  const jobs = new JobRepository(db);
  const evaluation = new EvaluationService(repo, jobs, () => options.metrics ?? [], options.agent);
  const search = new SearchRepository(repo);
  const write = new GraphWriteService(
    repo,
    jobs.clock,
    (context, changed, reason) => {
      search.index(changed, context.texts);
      if (reason !== 'history') evaluation.autoEnqueue(context, changed);
    },
    (projectId, groupId) => initialResearch.abortStoppedGroup(projectId, groupId),
  );
  const access = new AccessService(db, Date.now, options.secret ?? randomBytes(32));
  const publicData = new PublicDataService(write, jobs, options.publicDataClient);
  const files = new MaterialFileService(write, jobs);
  const filings = new SecFilingService(write, jobs, files, options.publicDataClient);
  const researchTasks = new ResearchTaskService(write, jobs, options.researchModel, search);
  const externalResearch = new ExternalResearchService(researchTasks, evaluation);
  const manualUpdates = new ManualUpdateService(researchTasks);
  const initialResearch = new InitialResearchService(
    write,
    jobs,
    researchTasks,
    publicData,
    filings,
  );
  const transcription = new TranscriptionService(
    write,
    jobs,
    files,
    options.visionModel,
    researchTasks,
  );
  const controller = new ResearchController(
    repo,
    write,
    access,
    evaluation,
    search,
    publicData,
    files,
    researchTasks,
    transcription,
    initialResearch,
    filings,
    manualUpdates,
    externalResearch,
    options.importRoots ?? {},
  );
  const maintenance =
    options.database === ':memory:'
      ? undefined
      : new MaintenanceService(write, dirname(options.database));
  const app = createApi(controller, options.origin, maintenance);
  return {
    app,
    db,
    repo,
    write,
    access,
    evaluation,
    jobs,
    controller,
    search,
    maintenance,
    publicData,
    files,
    researchTasks,
    transcription,
    initialResearch,
    filings,
    manualUpdates,
    externalResearch,
  };
}
