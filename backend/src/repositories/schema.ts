import {
  sqliteTable,
  text,
  integer,
  blob,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  question: text('question').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
});
export const entities = sqliteTable(
  'entities',
  {
    id: text('id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    versionId: text('version_id').notNull(),
    contentVersionId: text('content_version_id').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    index('entity_kind').on(t.projectId, t.kind, t.deletedAt),
  ],
);
export const versions = sqliteTable(
  'versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    entityId: text('entity_id').notNull(),
    version: integer('version').notNull(),
    contentVersionId: text('content_version_id').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).notNull(),
    actor: text('actor', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.entityId],
      foreignColumns: [entities.projectId, entities.id],
    }),
    uniqueIndex('entity_version').on(t.projectId, t.entityId, t.version),
    index('version_asof').on(t.projectId, t.createdAt),
  ],
);
export const links = sqliteTable(
  'links',
  {
    projectId: text('project_id').notNull(),
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.fromId, t.toId, t.role] }),
    foreignKey({
      columns: [t.projectId, t.fromId],
      foreignColumns: [entities.projectId, entities.id],
    }),
    foreignKey({
      columns: [t.projectId, t.toId],
      foreignColumns: [entities.projectId, entities.id],
    }),
    index('incoming_links').on(t.projectId, t.toId),
  ],
);
export const materials = sqliteTable(
  'materials',
  {
    projectId: text('project_id').notNull(),
    sourceVersionId: text('source_version_id').notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceVersionId] }),
    foreignKey({
      columns: [t.projectId, t.sourceVersionId],
      foreignColumns: [entities.projectId, entities.id],
    }),
  ],
);
export const operations = sqliteTable(
  'operations',
  {
    actorId: text('actor_id').notNull(),
    projectId: text('project_id').notNull(),
    key: text('key').notNull(),
    hash: text('hash').notNull(),
    response: text('response', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  // The JSON expression index is maintained by custom migration 0003.
  (t) => [primaryKey({ columns: [t.actorId, t.projectId, t.key] })],
);
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    input: text('input', { mode: 'json' }).notNull(),
    output: text('output', { mode: 'json' }),
    error: text('error'),
    attempt: integer('attempt').notNull().default(0),
    runToken: text('run_token'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    usage: text('usage', { mode: 'json' }),
  },
  (t) => [
    uniqueIndex('job_dedupe').on(t.projectId, t.dedupeKey),
    index('job_queue').on(t.state, t.createdAt),
  ],
);
// Disposable read projection. Migration 0006 maintains it from canonical jobs.
export const researchResultJobs = sqliteTable('research_result_jobs', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  stale: integer('stale'),
  taskGaps: text('task_gaps'),
  coverage: text('coverage').notNull(),
});
export const researchChecks = sqliteTable(
  'research_checks',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => researchResultJobs.jobId, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    checkIndex: integer('check_index').notNull(),
    finishedAt: text('finished_at').notNull(),
    targetId: text('target_id'),
    targetVersionId: text('target_version_id'),
    scopedVersion: text('scoped_version'),
    kind: text('kind'),
    premiseIds: text('premise_ids'),
    conclusionId: text('conclusion_id'),
    context: text('context').notNull(),
    relation: text('relation'),
    aspect: text('aspect'),
    explanationPreview: text('explanation_preview'),
    check: text('check').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.checkIndex] }),
    index('research_target_results').on(
      t.projectId,
      t.targetId,
      t.finishedAt,
      t.jobId,
      t.checkIndex,
    ),
    index('research_project_results').on(t.projectId, t.finishedAt, t.jobId, t.checkIndex),
  ],
);
export const layouts = sqliteTable('layouts', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id),
  version: integer('version').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const judgments = sqliteTable('judgments', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  title: text('title').notNull(),
  refs: text('refs', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
});
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  actorId: text('actor_id').notNull(),
  type: text('type').notNull(),
  projects: text('projects', { mode: 'json' }).notNull(),
  expiresAt: text('expires_at').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).notNull().default('{}'),
});
export const searchChunks = sqliteTable(
  'search_chunks',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    projectId: text('project_id').notNull(),
    entityId: text('entity_id').notNull(),
    versionId: text('version_id')
      .notNull()
      .references(() => versions.id),
    kind: text('kind').notNull(),
    offset: integer('offset').notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    uniqueIndex('chunk_identity').on(t.versionId, t.offset),
    index('project_chunks').on(t.projectId, t.entityId),
  ],
);
export const embeddings = sqliteTable(
  'embeddings',
  {
    chunkId: integer('chunk_id')
      .notNull()
      .references(() => searchChunks.rowid),
    model: text('model').notNull(),
    dimension: integer('dimension').notNull(),
    vector: text('vector', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.chunkId, t.model] })],
);
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});
export const fileAssets = sqliteTable(
  'file_assets',
  {
    id: text('id').notNull(),
    projectId: text('project_id').notNull(),
    sourceId: text('source_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    hash: text('hash').notNull(),
    bytes: blob('bytes', { mode: 'buffer' }).notNull(),
    retrievedAt: text('retrieved_at').notNull(),
    publishedAt: text('published_at'),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.id] }),
    foreignKey({
      columns: [t.projectId, t.sourceId],
      foreignColumns: [entities.projectId, entities.id],
    }),
    uniqueIndex('file_source_hash').on(t.projectId, t.sourceId, t.hash),
  ],
);
export const parsedArtifacts = sqliteTable(
  'parsed_artifacts',
  {
    projectId: text('project_id').notNull(),
    sourceVersionId: text('source_version_id').notNull(),
    fileId: text('file_id').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceVersionId] }),
    foreignKey({
      columns: [t.projectId, t.sourceVersionId],
      foreignColumns: [entities.projectId, entities.id],
    }),
    foreignKey({
      columns: [t.projectId, t.fileId],
      foreignColumns: [fileAssets.projectId, fileAssets.id],
    }),
  ],
);

// Bounded user undo/redo state, separate from permanent object audit versions.
export const actionHistory = sqliteTable('action_history', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id),
  data: text('data', { mode: 'json' }).notNull(),
});

export const workflowGroups = sqliteTable(
  'workflow_groups',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    rootJobId: text('root_job_id')
      .notNull()
      .references(() => jobs.id),
    applied: integer('applied', { mode: 'boolean' }).notNull().default(true),
    stopped: integer('stopped', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('workflow_root').on(t.rootJobId), index('workflow_project').on(t.projectId)],
);
export const workflowGroupTasks = sqliteTable(
  'workflow_group_tasks',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    groupId: text('group_id')
      .notNull()
      .references(() => workflowGroups.id),
  },
  (t) => [index('workflow_tasks_group').on(t.groupId)],
);
