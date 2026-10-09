import type { Snapshot } from '@forkwise/public-data-core';
import type { Job } from '../repositories/jobs.js';
import type { GraphWriteService } from './graph-write.js';
import { digest } from './graph-write.js';
import { requireThat } from '../domain/errors.js';
import type { ChangeSet } from '../contracts/entities.js';

export function saveFilingFile(write: GraphWriteService, job: Job, snapshot: Snapshot) {
  const projectId = job.projectId,
    sourceId = `sec_filing_${digest(snapshot.url)}`;
  const state = write.repo.snapshot(projectId),
    source = state.objects.find((e) => e.id === sourceId);
  requireThat(
    !source ||
      (source.kind === 'source' &&
        source.data.url === snapshot.url &&
        source.data.rights === 'public'),
    'SOURCE_ID_CONFLICT',
    '申报文件来源身份冲突',
    409,
  );
  const changes: ChangeSet = source
    ? {
        projectId,
        revisionBefore: state.project.revision,
        revisionAfter: state.project.revision,
        upserted: [],
        deletedIds: [],
      }
    : write.execute(projectId, { id: `job_${job.id}`, type: 'system' }, `source_${sourceId}`, {
        expected: {},
        commands: [
          {
            op: 'source.create',
            id: sourceId,
            data: {
              title: `SEC ${snapshot.cik} ${snapshot.lineage?.form ?? ''} ${snapshot.lineage?.accessionNumber}`,
              publisher: 'SEC',
              rights: 'public',
              url: snapshot.url,
            },
          },
        ],
      });
  const fileId = `sec_file_${digest({ sourceId, hash: snapshot.hash })}`;
  const prior = write.repo.db
    .prepare('SELECT hash FROM file_assets WHERE project_id=? AND id=?')
    .get(projectId, fileId) as { hash: string } | undefined;
  if (!prior)
    write.repo.db
      .prepare(
        'INSERT INTO file_assets(id,project_id,source_id,name,mime,hash,bytes,retrieved_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        fileId,
        projectId,
        sourceId,
        snapshot.lineage!.primaryDocument.split('/').at(-1),
        'text/html',
        snapshot.hash,
        Buffer.from(snapshot.raw, 'utf8'),
        snapshot.retrievedAt,
        null,
      );
  else requireThat(prior.hash === snapshot.hash, 'FILE_ID_CONFLICT', '原文件身份冲突', 409);
  return { fileId, sourceId, changes };
}

export function saveFilingText(
  write: GraphWriteService,
  job: Job,
  saved: { fileId: string; sourceId: string },
  artifact: {
    text: string;
    status: 'complete' | 'partial' | 'failed';
    normalizerVersion: string;
    gaps: string[];
    [key: string]: unknown;
  },
  provenance: {
    provider: string;
    adapterVersion: string;
    snapshotHash: string;
    requestUrl: string;
  },
) {
  const sourceVersionId = `sec_text_${digest({ fileId: saved.fileId, text: artifact.text, normalizerVersion: artifact.normalizerVersion, status: artifact.status })}`;
  const state = write.repo.snapshot(job.projectId),
    prior = state.objects.find((e) => e.id === sourceVersionId);
  if (prior)
    return {
      sourceVersionId,
      changes: {
        projectId: job.projectId,
        revisionBefore: state.project.revision,
        revisionAfter: state.project.revision,
        upserted: [],
        deletedIds: [],
      },
    };
  const source = state.objects.find((e) => e.id === saved.sourceId);
  requireThat(source?.kind === 'source', 'SOURCE_NOT_FOUND', '申报来源已移除', 404);
  const changes = write.execute(
    job.projectId,
    { id: `job_${job.id}`, type: 'system' },
    `parse_${sourceVersionId}`,
    {
      expected: { [source.id]: source.version },
      commands: [
        {
          op: 'source.parse',
          id: sourceVersionId,
          sourceId: source.id,
          fileId: saved.fileId,
          text: artifact.text,
          status: artifact.status,
          message: artifact.gaps.join('；').slice(0, 2000),
          normalizerVersion: artifact.normalizerVersion,
          textOrigin: 'html_body',
          provenance,
        },
      ],
    },
  );
  write.repo.db
    .prepare(
      'INSERT INTO parsed_artifacts(project_id,source_version_id,file_id,data) VALUES(?,?,?,?)',
    )
    .run(job.projectId, sourceVersionId, saved.fileId, JSON.stringify(artifact));
  return { sourceVersionId, changes };
}
