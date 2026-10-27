import { z } from 'zod';

const Id = z.string().min(1).max(160);
export const GroupCommands = z.discriminatedUnion('type', [
  z.object({
    commandId: Id, projectId: Id, type: z.literal('group.create'),
    expected: z.object({ groups: z.record(Id, Id.nullable()), containment: z.record(Id, Id.nullable()) }).strict(),
    payload: z.object({ id: Id, itemIds: z.array(Id).min(2).refine(ids => new Set(ids).size === ids.length) }).strict(),
  }).strict(),
  z.object({
    commandId: Id, projectId: Id, type: z.literal('group.move'),
    expected: z.object({ group: Id, containment: z.record(Id, Id), poses: z.record(Id, Id) }).strict(),
    payload: z.object({ id: Id, dx: z.number().finite(), dy: z.number().finite() }).strict(),
  }).strict(),
]);
export type GroupCommand = z.infer<typeof GroupCommands>;
export interface GroupRecord {
  id: string;
  itemId: string;
  versionId: string;
  createdOrder: number;
}
export interface Containment {
  id: string;
  versionId: string;
  parent: { kind: 'group' | 'frame'; id: string } | null;
}
export interface CanvasGroup extends GroupRecord {
  kind: 'group';
  memberItemIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
}
export type GroupChange = { before: GroupRecord | null; after: GroupRecord | null };
export type ContainmentChange = { before: Containment | null; after: Containment | null };
