import { z } from 'zod';
import type { CompactQuery } from './compact-contracts.js';
import { TITLE_COLORS } from './presentation-values.js';

const Id = z.string().min(1).max(160);
const Name = z.string().trim().min(1).max(240);
const Envelope = { commandId: Id, projectId: Id };
export const BodyBlock = z.object({ id: Id, type: z.string().min(1), text: z.string().optional(), inlineId: Id.optional() }).passthrough();
export type Block = z.infer<typeof BodyBlock>;
const BodyInput = {
  text: z.string().max(200000).optional(),
  blocks: z.array(BodyBlock).min(1).refine(blocks => blocks.reduce((n, b) => n + (b.text?.length ?? 0), Math.max(0, blocks.length - 1)) <= 200000, '正文文字不能超过200000').optional(),
};
export const MappingCommand = z.discriminatedUnion('type', [
  z.object({
    ...Envelope,
    type: z.literal('thought.delete'),
    expected: z.object({ thought: Id, body: Id, pose: Id, appearance: Id.nullable() }).strict(),
    payload: z.object({ id: Id }).strict(),
  }).strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.layout'),
      expected: z.object({ thought: Id, body: Id, pose: Id, appearance: Id.nullable() }).strict(),
      payload: z.object({ id: Id, necessaryHeight: z.number().finite().positive() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.appearance'),
      expected: Id.nullable(),
      payload: z
        .object({ id: Id, titleColor: z.enum(TITLE_COLORS), showPreview: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('pose.batch'),
      expected: z.record(Id, Id),
      payload: z
        .object({
          poses: z
            .array(
              z
                .object({
                  id: Id,
                  x: z.number().finite(),
                  y: z.number().finite(),
                  width: z.number().finite().positive(),
                  height: z.number().finite().positive(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('history.undo'),
      expected: z.number().int().nonnegative(),
      payload: z.object({ actionId: Id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('history.redo'),
      expected: z.number().int().nonnegative(),
      payload: z.object({ actionId: Id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('card.edit'),
      expected: z.object({ body: Id, pose: Id }).strict(),
      payload: z
        .object({
          id: Id,
          ...BodyInput,
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict().refine((p) => (p.text === undefined) !== (p.blocks === undefined), '正文须提供text或blocks之一'),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('pose.move'),
      expected: Id,
      payload: z.object({ id: Id, x: z.number().finite(), y: z.number().finite() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('project.rename'),
      expected: Id,
      payload: z.object({ name: Name }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('thought.title'),
      editGroup: Id.optional(),
      expected: Id,
      payload: z.object({ id: Id, title: z.string().max(10000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('body.edit'),
      editGroup: Id.optional(),
      expected: Id,
      payload: z
        .object({
          id: Id,
          ...BodyInput,
          requiredAssetIds: z.array(Id).max(128).optional(),
        })
        .strict().refine((p) => (p.text === undefined) !== (p.blocks === undefined), '正文须提供text或blocks之一'),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('project.create'),
      expected: z.null(),
      payload: z.object({ name: Name }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('thought.create'),
      editGroup: Id.optional(),
      expected: z.null(),
      payload: z
        .object({
          id: Id,
          title: z.string().max(10000),
          text: z.string().max(200000),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
    })
    .strict(),
]);
export type Command = z.infer<typeof MappingCommand>;
export interface Project {
  id: string;
  name: string;
  versionId: string;
  revision: number;
}
export interface Card {
  id: string;
  title: string;
  versionId: string;
  appearance?: {
    id: string;
    versionId: string;
    titleColor: Extract<Command, { type: 'card.appearance' }>['payload']['titleColor'];
    showPreview: boolean;
  };
  body: { id: string; versionId: string; blocks: Block[] };
  item: {
    id: string;
    versionId: string;
    pose: { x: number; y: number; width: number; height: number };
    heightPolicy?: { manualHeight: number | null; necessaryHeight: number; previewFloor?: number };
  };
}
export interface ProjectState {
  project: Project;
  cards: Card[];
}
export interface Receipt {
  commandId: string;
  projectId: string;
  revision: number;
  changedIds: string[];
  deletedIds?: string[];
  historyTarget?: { id: string; title: string; label: string };
  versions?: { thought: string; body: string; pose: string; appearance?: string };
}
export type VersionQuery = {
  type: 'version';
  projectId: string;
  domain: 'body' | 'pose' | 'appearance';
  id: string;
  versionId: string;
};
export type CardIdentity =
  | { availability: 'available'; card: Card }
  | { availability: 'deleted' | 'not_found' };
export type IdentityQuery = { type: 'card.identity'; projectId: string; id: string };
export type ReadQuery =
  | CompactQuery
  | IdentityQuery
  | { type: 'history'; projectId: string }
  | { type: 'projects' }
  | { type: 'project'; projectId: string }
  | VersionQuery;

export interface Change extends Receipt {
  cardChanges?: { before: Card; after: Card }[];
  before: Project | Card | null;
  after: Project | Card | null;
  actor: { id: string; type: 'human' | 'agent' | 'system' };
  writtenAt: string;
}

export interface HistoryAction {
  id: string;
  label: string;
  target: { id: string; title: string };
  actor: Change['actor'];
}
export interface ProjectHistory {
  revision: number;
  undo: HistoryAction[];
  redo: HistoryAction[];
}
