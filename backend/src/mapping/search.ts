import type { Block, ProjectState } from './contracts.js';
import type { SearchQuery, SearchResult, SearchRange, SearchSegment } from './search-contracts.js';
import { foldText, parseSearch, type SearchLanguage } from './search-language.js';
import { editableBlock, type TableCell } from './general-blocks.js';

function ranges(text: string, unit: string, language: SearchLanguage): SearchRange[] {
  const result: SearchRange[] = [];
  const folded = foldText(text, language),
    term = foldText(unit, language).text;
  for (
    let start = folded.text.indexOf(term);
    start >= 0;
    start = folded.text.indexOf(term, start + 1)
  )
    result.push({ start: folded.starts[start]!, end: folded.ends[start + term.length - 1]! });
  return result;
}

function segmentsFor(blocks: Block[]): SearchSegment[] {
  return blocks.flatMap((block) => {
    if (!editableBlock(block)) return [];
    if (
      ['text', 'heading', 'listItem', 'quote', 'code'].includes(block.type) &&
      typeof block.text === 'string'
    )
      return [{ blockId: block.id, text: block.text }];
    if (block.type === 'image' && typeof block.caption === 'string')
      return [{ blockId: block.id, text: block.caption }];
    if (block.type === 'table')
      return (block.rows as TableCell[][]).flatMap((row, r) =>
        row.map((cell, c) => ({ blockId: block.id, text: cell.text, row: r, column: c })),
      );
    return [];
  });
}

function mergeRanges(ranges: SearchRange[]): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function searchProject(
  state: ProjectState,
  query: SearchQuery,
  language: SearchLanguage,
  editTimes: Map<string, string>,
): SearchResult {
  const parsed = parseSearch(query.text, language, query.literal),
    { units } = parsed;
  const capabilities = { normalization: 'ready' as const, segmentation: 'ready' as const };
  const tagIds = [...new Set(query.tagIds ?? [])];
  const invalidTagIds = tagIds.filter(
    (id) => !state.tags?.some((tag) => tag.id === id && !tag.deleted),
  );
  if (invalidTagIds.length)
    return {
      state: 'invalid_tags',
      projectId: state.project.id,
      revision: state.project.revision,
      query: parsed,
      results: [],
      invalidTagIds,
      capabilities,
    };
  const results: SearchResult['results'] = [];
  for (const card of state.cards) {
    if (tagIds.some((id) => !card.cardTags?.tagIds.includes(id))) continue;
    const segments = segmentsFor(card.body.blocks);
    const byUnit = units.map((unit) => ({
      title: ranges(card.title, unit.text, language),
      body: segments.flatMap((segment, index) =>
        ranges(segment.text, unit.text, language).map((range) => ({
          ...range,
          segment: index,
          blockId: segment.blockId,
        })),
      ),
    }));
    if (byUnit.some((hit) => !hit.title.length && !hit.body.length)) continue;
    const titleCount = byUnit.filter((hit) => hit.title.length).length;
    results.push({
      cardId: card.id,
      title: card.title,
      thoughtVersion: card.versionId,
      bodyVersion: card.body.versionId,
      contentEditedAt: editTimes.get(card.id) ?? null,
      segments,
      titleHits: mergeRanges(byUnit.flatMap((hit) => hit.title)),
      bodyHits: segments.flatMap((segment, index) =>
        mergeRanges(
          byUnit.flatMap((hit) => hit.body.filter((range) => range.segment === index)),
        ).map((range) => ({ ...range, segment: index, blockId: segment.blockId })),
      ),
      titleRank: titleCount === units.length ? 0 : titleCount ? 1 : 2,
    });
  }
  results.sort(
    (a, b) =>
      a.titleRank - b.titleRank ||
      (b.contentEditedAt ?? '').localeCompare(a.contentEditedAt ?? '') ||
      (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0),
  );
  return {
    state: 'ready',
    projectId: state.project.id,
    revision: state.project.revision,
    query: parsed,
    results,
    invalidTagIds: [],
    capabilities,
  };
}
