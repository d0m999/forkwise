import type { CanvasConnector, ConnectorLabel } from './connector-contracts.js';
import type { CanvasImage } from './image-contracts.js';
import type { CanvasText } from './text-contracts.js';
import type { CanvasShape } from './shape-contracts.js';
import type { CanvasStroke } from './stroke-contracts.js';
import { z } from 'zod';
import type { Card, Project, Tag } from './contracts.js';

const common = {
  type: z.literal('map'),
  projectId: z.string().min(1).max(160),
  snapshot: z.string().uuid().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  budget: z.number().int().positive().max(1_048_576).default(131_072),
};
export const CompactQuerySchema = z.discriminatedUnion('view', [
  z.object({ ...common, view: z.literal('connector-index') }).strict(),
  z.object({ ...common, view: z.literal('connector-detail'), connectorId: z.string().min(1).max(160), snapshot: z.string().uuid() }).strict(),
  z.object({ ...common, view: z.literal('image-index') }).strict(),
  z.object({ ...common, view: z.literal('image-detail'), imageId: z.string().min(1).max(160), snapshot: z.string().uuid() }).strict(),
  z.object({ ...common, view: z.literal('stroke-index') }).strict(),
  z.object({ ...common, view: z.literal('stroke-detail'), strokeId: z.string().min(1).max(160), snapshot: z.string().uuid() }).strict(),
  z.object({ ...common, view: z.literal('shape-index') }).strict(),
  z.object({ ...common, view: z.literal('shape-detail'), shapeId: z.string().min(1).max(160), snapshot: z.string().uuid() }).strict(),
  z.object({ ...common, view: z.literal('text-index') }).strict(),
  z.object({ ...common, view: z.literal('text-detail'), textId: z.string().min(1).max(160), snapshot: z.string().uuid() }).strict(),
  z.object({ ...common, view: z.literal('tags') }).strict(),
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
  cardTags?: Card['cardTags'];
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
export type TextIndex = Omit<CanvasText, 'kind' | 'content'> & { type: 'text'; order: number; content: Omit<CanvasText['content'], 'runs'> & { runCount: number; availability: 'not_fetched' } };
export type ShapeIndex = Omit<CanvasShape, 'kind' | 'content'> & { type: 'shape'; order: number; content: Omit<CanvasShape['content'], 'shortText'> & { availability: 'not_fetched' } };
export type StrokeIndex = Omit<CanvasStroke, 'kind' | 'content'> & { type: 'stroke'; order: number; content: Omit<CanvasStroke['content'], 'path'> & { pointCount: number; availability: 'not_fetched' } };
export type ImageIndex = Omit<CanvasImage, 'kind' | 'content'> & { type: 'image'; order: number; content: { assetId: string; availability: 'not_fetched' } };
export type ConnectorIndex = Omit<CanvasConnector, 'kind' | 'label'> & { type: 'connector'; order: number;
  label?: (Omit<ConnectorLabel, 'text'> & { availability: 'not_fetched'; textCodePoints: number; textJsonSha256: string }) | null };
export type CompactItem = ConnectorIndex | ImageIndex | StrokeIndex | ShapeIndex | TextIndex | CardIndex | BodySlice | DetailChunk | Tag;
export interface CompactPage<T = CompactItem> {
  scope: { types: ('thought' | 'text' | 'shape' | 'stroke' | 'image' | 'connector')[]; relations: 'not_implemented' | 'connectors'; order: 'creation_ordinal' };
  project: Project;
  snapshot: string;
  revision: number;
  expiresAt: number;
  budgetUnit: 'utf8_bytes';
  bytes: number;
  totalItems: number;
  coverage: { start: number; end: number; complete: boolean };
  fidelity: 'index' | 'partial_body' | 'lossless_json_chunks' | 'tags' | 'text-index' | 'shape-index' | 'stroke-index' | 'image-index' | 'connector-index';
  availability: 'available' | 'deleted' | 'not_found';
  target?: { connectorId: string; versionId?: string } | { imageId: string; versionId?: string } | { cardId: string; bodyId?: string; versionId?: string } | { shapeId: string; versionId?: string } | { strokeId: string; versionId?: string };
  summary: null;
  nextCursor: string | null;
  items: T[];
}
