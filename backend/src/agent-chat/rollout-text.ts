import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const turnTextPhase = z.enum(['commentary', 'partial_answer', 'final_answer']).nullish();
const emptyArray = z.array(z.never()).length(0).optional();
const userText = z.strictObject({ type: z.literal('message'), role: z.literal('user'),
  content: z.tuple([z.strictObject({ type: z.literal('input_text'), text: z.string() })]) });
const assistantText = z.strictObject({ type: z.literal('message'), role: z.literal('assistant'),
  id: z.string().optional(), phase: turnTextPhase, status: z.literal('completed').optional(),
  content: z.array(z.strictObject({ type: z.literal('output_text'), text: z.string(),
    annotations: emptyArray, logprobs: emptyArray })).min(1) });
const turnTextPayload = z.discriminatedUnion('role', [userText, assistantText]);

export const rolloutEnvelope = z.strictObject({
  timestamp: z.iso.datetime(), ordinal: z.int().nonnegative().optional(), type: z.string(),
  payload: z.unknown(), metadata: z.unknown().optional(),
});
export type RolloutRecord = z.infer<typeof rolloutEnvelope>;

const count = z.int().nonnegative();
const nativeMessage = z.object({
  metadata: z.strictObject({
    history_sequence: count, sampled_through_sequence: count, user_input_order: count,
    client_authored: z.literal(false), model_search_state: z.literal('unused'),
    mcp_attribution: z.strictObject({ status: z.literal('none') }).optional(),
    retained_source: z.strictObject({
      id: z.strictObject({ message_id: z.string(), turn_id: z.string(), role: z.enum(['user', 'assistant']) }),
      revision: z.templateLiteral(['retained_', z.uuidv7()]), complete: z.literal(true),
    }),
  }),
  payload: z.discriminatedUnion('role', [
    userText.extend({
      id: z.templateLiteral(['msg_', z.uuidv7()]),
      internal_chat_message_metadata_passthrough: z.strictObject({
        turn_id: z.string(), create_time: z.number().positive(), content_item_kinds: z.tuple([z.literal('user.text')]),
        content_item_metadata: z.tuple([z.strictObject({ provenance: z.strictObject({ type: z.literal('user') }) })]),
      }),
    }),
    assistantText.extend({
      id: z.string().min(1), status: z.literal('completed'),
      internal_chat_message_metadata_passthrough: z.strictObject({
        turn_id: z.string(), content_item_kinds: z.array(z.literal('unknown')).min(1),
      }),
    }),
  ]),
});

// Native response items carry the turn ID only. The caller owns the thread file
// and compares the normalized text, assistant ID and phase with item/completed.
export function verifiedTextPayload(record: RolloutRecord, turnId: string): z.infer<typeof turnTextPayload> | undefined {
  if (record.metadata === undefined) return turnTextPayload.safeParse(record.payload).data;
  const result = nativeMessage.safeParse(record);
  if (!result.success) return;
  const { metadata, payload } = result.data;
  const source = metadata.retained_source.id;
  const internal = payload.internal_chat_message_metadata_passthrough;
  if (source.turn_id === turnId && internal.turn_id === turnId && source.message_id === payload.id &&
      source.role === payload.role && metadata.sampled_through_sequence < metadata.history_sequence &&
      (metadata.mcp_attribution !== undefined) === (payload.role === 'user') &&
      internal.content_item_kinds.length === payload.content.length) return payload;
}

const abortMarkerText = '<turn_aborted>\n' +
  'The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. ' +
  'If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>';
const nativeAbortMarker = z.object({
  type: z.literal('response_item'),
  metadata: z.strictObject({ history_sequence: count, sampled_through_sequence: count,
    client_authored: z.literal(false), model_search_state: z.literal('unused') }),
  payload: userText.extend({
    id: z.templateLiteral(['msg_', z.uuidv7()]),
    content: z.tuple([z.strictObject({ type: z.literal('input_text'), text: z.literal(abortMarkerText) })]),
    internal_chat_message_metadata_passthrough: z.strictObject({
      turn_id: z.string(), create_time: z.number().positive(), content_item_kinds: z.tuple([z.literal('generic.turn_aborted')]),
      content_item_metadata: z.tuple([z.strictObject({
        provenance: z.strictObject({ type: z.literal('harness'), hook: z.literal(false) }),
      })]),
    }),
  }),
});

export function isNativeTurnAbortMarker(record: RolloutRecord, turnId: string): boolean {
  const result = nativeAbortMarker.safeParse(record);
  if (!result.success) return false;
  const { payload, metadata } = result.data;
  return payload.internal_chat_message_metadata_passthrough.turn_id === turnId &&
    metadata.sampled_through_sequence < metadata.history_sequence;
}

const usage = z.strictObject({ input_tokens: count, cached_input_tokens: count, cache_write_input_tokens: count,
  output_tokens: count, reasoning_output_tokens: count, total_tokens: count });
const notificationUsage = z.strictObject({ inputTokens: count, cachedInputTokens: count, cacheWriteInputTokens: count,
  outputTokens: count, reasoningOutputTokens: count, totalTokens: count }).transform(value => ({
  input_tokens: value.inputTokens, cached_input_tokens: value.cachedInputTokens, cache_write_input_tokens: value.cacheWriteInputTokens,
  output_tokens: value.outputTokens, reasoning_output_tokens: value.reasoningOutputTokens, total_tokens: value.totalTokens,
}));
export const turnUsageNotification = z.strictObject({ threadId: z.string(), turnId: z.string(),
  tokenUsage: z.strictObject({ total: notificationUsage, last: notificationUsage, modelContextWindow: z.int().positive() }),
});
export type TurnUsage = z.infer<typeof turnUsageNotification>['tokenUsage'];

const rateLimitWindow = z.strictObject({
  used_percent: z.number().nonnegative(), window_minutes: count.nullable(), resets_at: count.nullable(),
}).nullable();
const usageRecord = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token_usage_record'), payload: z.strictObject({
    thread_id: z.string(), session_id: z.string(), turn_id: z.string(), root_turn_id: z.string(),
    response_id: z.string().max(256).regex(/^resp_[A-Za-z0-9_-]+$/),
    usage, turn_token_usage: usage, thread_token_usage: usage,
  }) }),
  z.object({ type: z.literal('event_msg'), payload: z.strictObject({
    type: z.literal('token_count'),
    info: z.strictObject({ total_token_usage: usage, last_token_usage: usage, last_usage_includes_reasoning: z.literal(true),
      model_context_window: z.int().positive() }).nullable(),
    rate_limits: z.strictObject({ limit_id: z.literal('codex'), limit_name: z.null(), primary: rateLimitWindow, secondary: rateLimitWindow,
      credits: z.null(), individual_limit: z.null(), spend_control_reached: z.null(), plan_type: z.null(), rate_limit_reached_type: z.null() }),
  }) }),
]);

export function isTurnUsageRecord(record: RolloutRecord, threadId: string, turnId: string,
  updates: readonly TurnUsage[]): boolean {
  if (record.metadata !== undefined) return false;
  const result = usageRecord.safeParse(record);
  if (!result.success) return false;
  if (result.data.type === 'event_msg') {
    const { info } = result.data.payload;
    if (info === null) return updates.length === 0;
    return updates.some(tokenUsage => info.model_context_window === tokenUsage.modelContextWindow &&
      isDeepStrictEqual(info.total_token_usage, tokenUsage.total) && isDeepStrictEqual(info.last_token_usage, tokenUsage.last));
  }
  const p = result.data.payload;
  // One model response per controlled text turn: per-response and per-turn usage coincide.
  return p.thread_id === threadId && p.session_id === threadId && p.turn_id === turnId && p.root_turn_id === turnId &&
    isDeepStrictEqual(p.usage, p.turn_token_usage) && updates.some(tokenUsage =>
      isDeepStrictEqual(p.thread_token_usage, tokenUsage.total) && isDeepStrictEqual(p.usage, tokenUsage.last));
}
