import { readSecIndex } from './sec-index.js';
import type { z } from 'zod';
import type { AnyEntity } from '../contracts/entities.js';
import type { MaterialRetrieval } from '../contracts/research-tasks.js';
import type { SearchRepository } from '../repositories/search.js';
import { requireThat, DomainError } from '../domain/errors.js';
import {
  selectCompanyFactPassages,
  selectSubmissionPassages,
  type SubmissionPassage,
  SourceError,
  type CompanyFactPassage,
} from '@forkwise/public-data-core';

export interface TaskMaterial {
  id: string;
  version: AnyEntity;
  text: string;
  /** UTF-16 offsets in the immutable original; omitted for legacy full-text inputs. */
  start?: number;
  end?: number;
  structure?: CompanyFactPassage['structure'] | SubmissionPassage['structure'];
}
interface Range {
  start: number;
  end: number;
}
export interface MaterialCoverage {
  method: 'selected_material_passages_v1';
  queries: string[];
  maxCharacters: number;
  selectedCharacters: number;
  sources: {
    sourceVersionId: string;
    totalCharacters: number;
    selectedCharacters: number;
    ranges: Range[];
    matchedCandidateChunks: number;
    candidateLimitReached: boolean;
    budgetLimited: boolean;
    complete: boolean;
    structure?: {
      method: 'sec_companyfacts_v1' | 'sec_submissions_v1';
      historyFileCount?: number;
      matchedRecords: number;
      records: { pointer: string; gaps: string[] }[];
    };
  }[];
  gaps: string[];
}
function merge(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
const length = (ranges: Range[]) => ranges.reduce((n, r) => n + r.end - r.start, 0);

export function secMaterialContext(version: AnyEntity) {
  if (version.kind !== 'source_version' || version.data.provenance?.provider !== 'sec-edgar')
    return;
  const url = version.data.provenance.requestUrl ?? '';
  const facts = /^https:\/\/data\.sec\.gov\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(url);
  if (facts) return { method: 'sec_companyfacts_v1' as const, cik: facts[1]! };
  const submissions = /^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
  if (submissions)
    return { method: 'sec_submissions_v1' as const, cik: submissions[1]!, history: false };
  const history =
    /^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})-submissions-\d{3,6}\.json$/.exec(url);
  if (history) return { method: 'sec_submissions_v1' as const, cik: history[1]!, history: true };
}

export function selectMaterialContext(
  projectId: string,
  originals: TaskMaterial[],
  search: SearchRepository,
  input: z.infer<typeof MaterialRetrieval>,
) {
  const queries = [...new Set(input.queries)],
    materials: TaskMaterial[] = [];
  const coverage: MaterialCoverage = {
    method: 'selected_material_passages_v1',
    queries,
    maxCharacters: input.maxCharacters,
    selectedCharacters: 0,
    sources: [],
    gaps: [],
  };
  const perSource = Math.floor(input.maxCharacters / originals.length);
  for (const original of originals) {
    const descriptor = secMaterialContext(original.version);
    if (descriptor) {
      if (descriptor.history) readSecIndex(search.repo, projectId, original.id);
      let selected;
      try {
        const select =
          descriptor.method === 'sec_companyfacts_v1'
            ? selectCompanyFactPassages
            : selectSubmissionPassages;
        selected = select(original.text, {
          queries,
          maxCharacters: perSource,
          expectedCik: descriptor.cik,
          history: descriptor.history ?? false,
        });
      } catch (error) {
        if (error instanceof SourceError) throw new DomainError(error.code, error.message);
        throw error;
      }
      materials.push(...selected.passages.map((p) => ({ ...original, ...p })));
      coverage.selectedCharacters += selected.selectedCharacters;
      coverage.sources.push({
        sourceVersionId: original.id,
        totalCharacters: original.text.length,
        selectedCharacters: selected.selectedCharacters,
        ranges: selected.passages.map(({ start, end }) => ({ start, end })),
        matchedCandidateChunks: selected.matchedRecords,
        candidateLimitReached: selected.candidateLimitReached,
        budgetLimited: selected.budgetLimited,
        complete: false,
        structure: {
          method: selected.method,
          ...('historyFileCount' in selected
            ? { historyFileCount: selected.historyFileCount }
            : {}),
          matchedRecords: selected.matchedRecords,
          records: selected.records,
        },
      });
      coverage.gaps.push(...selected.gaps.map((g) => `${original.id}：${g}`));
      if (!selected.records.length)
        coverage.gaps.push(`${original.id}：未取得可用结构化记录，不表示主张错误或全文没有依据`);
      if (selected.budgetLimited || selected.candidateLimitReached)
        coverage.gaps.push(
          `${original.id}：完整记录及其口径上下文超过本次预算或记录上限，部分记录未送入模型`,
        );
      continue;
    }
    search.ensureMaterialIndex(original.version, original.text);
    const found = search.materialChunks(projectId, original.version.versionId, queries);
    let ranges: Range[] = [],
      budgetLimited = false;
    for (const chunk of found.chunks) {
      requireThat(
        original.text.slice(chunk.offset, chunk.offset + chunk.text.length) === chunk.text,
        'SEARCH_INDEX_MISMATCH',
        '检索索引与所选原文不一致，请重建索引；未向模型提供不可靠片段',
      );
      let start = chunk.offset,
        end = chunk.offset + chunk.text.length;
      // Keep surrogate pairs intact, while all offsets remain native UTF-16 indices.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(original.text[start]!)) start--;
      if (end < original.text.length && /[\uDC00-\uDFFF]/.test(original.text[end]!)) end++;
      const next = merge([...ranges, { start, end }]);
      if (length(next) > perSource) {
        budgetLimited = true;
        continue;
      }
      ranges = next;
    }
    const selectedCharacters = length(ranges);
    const complete = selectedCharacters === original.text.length;
    coverage.sources.push({
      sourceVersionId: original.id,
      totalCharacters: original.text.length,
      selectedCharacters,
      ranges,
      matchedCandidateChunks: found.chunks.length,
      candidateLimitReached: found.candidateLimitReached,
      budgetLimited,
      complete,
    });
    coverage.selectedCharacters += selectedCharacters;
    if (!selectedCharacters)
      coverage.gaps.push(
        `${original.id}：所选查询未取得可用片段，不表示整份材料没有依据或主张错误`,
      );
    else if (!complete)
      coverage.gaps.push(
        `${original.id}：仅覆盖检索片段，未核查全文；片段可能缺少所属指标、单位或上下文`,
      );
    if (budgetLimited || found.candidateLimitReached)
      coverage.gaps.push(`${original.id}：检索候选或字符预算已达边界，仍有内容未进入本次分析`);
    for (const range of ranges)
      materials.push({ ...original, ...range, text: original.text.slice(range.start, range.end) });
  }
  return { materials, coverage };
}
