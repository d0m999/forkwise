import { z } from 'zod';

const Id = z.string().min(1).max(160);
const Positive = z.number().finite().positive();
const Member = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card'), thought: Id, body: Id, pose: Id, appearance: Id.nullable(), cardTags: Id.nullable() }).strict(),
  z.object({ kind: z.literal('text'), text: Id, pose: Id }).strict(),
  z.object({ kind: z.literal('shape'), pose: Id }).strict(),
  z.object({ kind: z.literal('image'), image: Id, pose: Id }).strict(),
]);
const Expected = z.object({ groups: z.record(Id, Id), containment: z.record(Id, Id.nullable()), items: z.record(Id, Member) }).strict();
const Selection = { groupIds: z.array(Id).min(1), directItemIds: z.array(Id) };
export const GroupGeometryCommands = z.discriminatedUnion('type', [
  z.object({ commandId: Id, projectId: Id, type: z.literal('group.rotate90'), expected: Expected,
    payload: z.object({ ...Selection, direction: z.enum(['left', 'right']) }).strict() }).strict(),
  z.object({ commandId: Id, projectId: Id, type: z.literal('group.scale'), expected: Expected,
    payload: z.object({ ...Selection, anchorCorner: z.enum(['nw', 'ne', 'sw', 'se']), scale: Positive,
      measurements: z.object({ cards: z.record(Id, z.object({ forWidth: Positive, necessaryHeight: Positive }).strict()),
        texts: z.record(Id, z.object({ width: Positive, height: Positive }).strict()) }).strict() }).strict() }).strict(),
]);
export type GroupGeometryCommand = z.infer<typeof GroupGeometryCommands>;
export type GeometryMemberExpected = z.infer<typeof Member>;
