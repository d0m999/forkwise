import { z } from 'zod';

const Id = z.string().min(1).max(160);
const Envelope = { commandId: Id, projectId: Id };
const Name = z.string().min(1).max(4096);

export interface CardAttachmentItem {
  id: string;
  assetId: string;
  name: string;
}
export interface CardAttachmentSet {
  id: string;
  versionId: string;
  items: CardAttachmentItem[];
}

export const CardAttachmentCommands = z.discriminatedUnion('type', [
  z.object({
    ...Envelope,
    type: z.literal('card.attachment.add'),
    expected: z.object({ attachments: Id.nullable() }).strict(),
    payload: z.object({ id: Id, assetId: Id, name: Name }).strict(),
  }).strict(),
  z.object({
    ...Envelope,
    type: z.literal('card.attachment.remove'),
    expected: z.object({ attachments: Id }).strict(),
    payload: z.object({ id: Id, attachmentId: Id }).strict(),
  }).strict(),
]);
