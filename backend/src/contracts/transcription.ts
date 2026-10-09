import { z } from '@hono/zod-openapi';
import { Id, Text } from './entities.js';
import { ImageRegion } from './entities.js';
export { ImageRegion };
export const TranscriptionBlock = z
  .object({ text: Text, region: ImageRegion, uncertain: z.boolean() })
  .strict();
export const TranscriptionResult = z
  .object({ blocks: z.array(TranscriptionBlock).max(1000), gaps: z.array(Text).max(100) })
  .strict();
export const TranscriptionInput = z
  .object({ sourceVersionId: Id, page: z.number().int().min(1).max(1000).default(1) })
  .strict();
export const CorrectionInput = TranscriptionInput.extend({
  blocks: z.array(TranscriptionBlock).min(1).max(1000),
  reason: Text,
  confirmedAgainstImage: z.literal(true),
}).strict();
