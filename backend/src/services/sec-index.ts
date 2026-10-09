import {
  assertIndexSnapshot,
  resolveSubmissionHistory,
  SourceError,
  type IndexSnapshot,
} from '@forkwise/public-data-core';
import { createHash } from 'node:crypto';
import type { ResearchRepository } from '../repositories/research.js';
import { requireThat, DomainError } from '../domain/errors.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Rebuild the immutable SEC index descriptor; history is always bound to its saved root. */
export function readSecIndex(
  repo: ResearchRepository,
  projectId: string,
  id: string,
): { snapshot: IndexSnapshot; historyRoot?: IndexSnapshot } {
  const objects = repo.snapshot(projectId).objects,
    visited = new Set<string>();
  const read = (id: string): { snapshot: IndexSnapshot; historyRoot?: IndexSnapshot } => {
    requireThat(
      !visited.has(id) && visited.size < 2,
      'INVALID_INDEX_SOURCE',
      '索引来历重复或超过根索引与历史分片两级',
    );
    visited.add(id);
    const version = objects.find((e) => e.id === id);
    requireThat(
      version?.kind === 'source_version',
      'INDEX_NOT_FOUND',
      '索引材料不属于当前项目或已不可用',
      404,
    );
    const source = objects.find((e) => e.id === version.data.sourceId),
      provenance = version.data.provenance;
    const match =
      provenance &&
      /^https:\/\/data\.sec\.gov\/submissions\/(CIK(\d{10})(?:-submissions-\d{3,6})?\.json)$/.exec(
        provenance.requestUrl,
      );
    requireThat(
      source?.kind === 'source' &&
        source.data.rights === 'public' &&
        source.data.url === provenance?.requestUrl &&
        provenance?.provider === 'sec-edgar' &&
        match,
      'INVALID_INDEX_SOURCE',
      '需要已保存且来历完整的 SEC 原始申报索引',
    );
    const raw = repo.material(projectId, id),
      fingerprint = hash(raw);
    requireThat(
      fingerprint === version.data.contentHash && fingerprint === provenance.snapshotHash,
      'INVALID_INDEX_SNAPSHOT',
      '索引原文与快照指纹不符',
    );
    const snapshot: IndexSnapshot = {
      sourceId: 'sec-edgar',
      dataset: 'submissions',
      cik: match[2]!,
      url: provenance.requestUrl,
      raw,
      hash: fingerprint,
    };
    if (!match[1]!.includes('-submissions-')) {
      requireThat(
        !provenance.indexParent,
        'INVALID_INDEX_SOURCE',
        '根索引不能伪装成另一索引的分片',
      );
      assertIndexSnapshot(snapshot);
      return { snapshot };
    }
    requireThat(provenance.indexParent, 'INVALID_INDEX_SOURCE', '历史索引缺少固定父索引来历');
    const parent = read(provenance.indexParent.sourceVersionId).snapshot;
    requireThat(
      parent.dataset === 'submissions' && parent.hash === provenance.indexParent.snapshotHash,
      'INVALID_INDEX_SOURCE',
      '历史索引的父版本或指纹不符',
    );
    snapshot.dataset = 'submissions-history';
    snapshot.history = {
      indexUrl: parent.url,
      indexHash: parent.hash,
      ...resolveSubmissionHistory(parent.raw, parent.cik, match[1]!),
    };
    assertIndexSnapshot(snapshot, parent);
    return { snapshot, historyRoot: parent };
  };
  try {
    return read(id);
  } catch (error) {
    if (error instanceof SourceError) throw new DomainError(error.code, error.message);
    throw error;
  }
}
