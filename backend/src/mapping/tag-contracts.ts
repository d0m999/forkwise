import { z } from 'zod';
const Id = z.string().min(1).max(160);
const Envelope = { commandId: Id, projectId: Id };
export const TagCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...Envelope, type: z.literal('tag.delete'), expected: z.object({ tag: Id, cardTags: z.record(Id, Id) }).strict(), payload: z.object({ id: Id }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('tag.update'), expected: Id, payload: z.object({ id: Id, name: z.string().min(1).max(240).optional(), color: z.enum(['#f1f0ec','#e3e2df','#eee0da','#f8dfc4','#f4e9b9','#dce8dd','#d9e7f1','#e8dff0','#f1dfe8','#f3dcd8']).optional() }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('card.tags'), expected: Id.nullable(), payload: z.object({ id: Id, tagIds: z.array(Id) }).strict() }).strict(),
  z.object({ ...Envelope, type: z.literal('tag.create'), expected: z.union([z.null(), z.object({ cardTags: Id.nullable() }).strict()]), payload: z.object({ id: Id, name: z.string().min(1).max(240), cardId: Id.optional() }).strict() }).strict(),
]);
