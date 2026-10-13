import { z } from 'zod';

const Id = z.string().min(1).max(160);
const Name = z.string().trim().min(1).max(240);
const Envelope = { commandId: Id, projectId: Id };
export const MappingCommand = z.discriminatedUnion('type', [
  z
    .object({
      ...Envelope,
      type: z.literal('card.edit'),
      expected: z.object({ body: Id, pose: Id }).strict(),
      payload: z
        .object({
          id: Id,
          text: z.string().max(200000),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
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
      expected: Id,
      payload: z.object({ id: Id, title: z.string().max(10000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('body.edit'),
      expected: Id,
      payload: z.object({ id: Id, text: z.string().max(200000) }).strict(),
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
  body: { id: string; versionId: string; blocks: { id: string; type: 'text'; text: string }[] };
  item: {
    id: string;
    versionId: string;
    pose: { x: number; y: number; width: number; height: number };
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
  versions?: { thought: string; body: string; pose: string };
}
export type VersionQuery = {
  type: 'version';
  projectId: string;
  domain: 'body' | 'pose';
  id: string;
  versionId: string;
};
export type ReadQuery =
  | { type: 'projects' }
  | { type: 'project'; projectId: string }
  | VersionQuery;

export interface Change extends Receipt {
  before: Project | Card | null;
  after: Project | Card;
  actor: { id: string; type: 'human' | 'agent' | 'system' };
  writtenAt: string;
}
