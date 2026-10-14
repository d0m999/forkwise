import { z } from 'zod';
import type { Card, Project } from './contracts.js';

const common = {
  type: z.literal('map'),
  projectId: z.string().min(1).max(160),
  snapshot: z.string().uuid().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  budget: z.number().int().positive().max(1_048_576).default(131_072),
};
export const CompactQuerySchema = z.discriminatedUnion('view', [
  z.object({ ...common, view: z.literal('index') }).strict(),
  z
    .object({
      ...common,
      view: z.literal('body'),
      cardId: z.string().min(1).max(160),
      snapshot: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...common,
      view: z.literal('detail'),
      cardId: z.string().min(1).max(160),
      snapshot: z.string().uuid(),
    })
    .strict(),
]);
export type CompactQuery = z.input<typeof CompactQuerySchema>;
export interface CardIndex {
  id: string;
  type: 'thought';
  title: string;
  versionId: string;
  order: number;
  body: { id: string; versionId: string; blockCount: number; availability: 'not_fetched' };
  item: Card['item'];
  appearance?: Card['appearance'];
}
export interface BodySlice {
  id: string;
  type: string;
  text: string;
  coverage: { returnedCodePoints: number; totalCodePoints: number; complete: boolean };
}
export interface DetailChunk {
  id: string;
  chunkIndex: number;
  chunkCount: number;
  jsonText: string;
}
export type CompactItem = CardIndex | BodySlice | DetailChunk;
export interface CompactPage<T = CompactItem> {
  scope: { types: ['thought']; relations: 'not_implemented'; order: 'creation_ordinal' };
  project: Project;
  snapshot: string;
  revision: number;
  expiresAt: number;
  budgetUnit: 'utf8_bytes';
  bytes: number;
  totalItems: number;
  coverage: { start: number; end: number; complete: boolean };
  fidelity: 'index' | 'partial_body' | 'lossless_json_chunks';
  availability: 'available' | 'deleted' | 'not_found';
  target?: { cardId: string; bodyId?: string; versionId?: string };
  summary: null;
  nextCursor: string | null;
  items: T[];
}
