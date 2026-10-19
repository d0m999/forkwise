import { z } from 'zod';

export const SearchQuerySchema = z
  .object({
    type: z.literal('search'),
    projectId: z.string().min(1).max(160),
    text: z.string().max(10000),
    tagIds: z.array(z.string().min(1).max(160)).max(200).optional(),
    retry: z.boolean().optional(),
    literal: z.boolean().optional(),
  })
  .strict();
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export interface SearchRange {
  start: number;
  end: number;
}
export interface SearchSegment {
  blockId: string;
  text: string;
  row?: number;
  column?: number;
}
export interface BodyHit extends SearchRange {
  segment: number;
  blockId: string;
}
export interface SearchResult {
  state: 'ready' | 'invalid_tags' | 'failed' | 'degraded';
  capabilities: { normalization: 'ready' | 'failed'; segmentation: 'ready' | 'failed' };
  message?: string;
  invalidTagIds: string[];
  projectId: string;
  revision: number;
  query: { input: string; units: { text: string; phrase: boolean }[]; unclosedQuote: boolean };
  results: {
    cardId: string;
    title: string;
    thoughtVersion: string;
    bodyVersion: string;
    contentEditedAt: string | null;
    titleHits: SearchRange[];
    bodyHits: BodyHit[];
    segments: SearchSegment[];
    titleRank: number;
  }[];
}
