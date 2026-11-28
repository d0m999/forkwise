import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { CodexConnection, codexChatModel, codexModelArgs, codexStorageEnvironment } from './codex.js';
import { bundledLunaWorld, createRolloutContextVerifier, rolloutOpenSettings, type RolloutOpenSettings } from './rollout-context.js';
import { isNativeTurnAbortMarker, isTurnUsageRecord, rolloutEnvelope, turnTextPhase as phase, turnUsageNotification,
  verifiedTextPayload, type TurnUsage } from './rollout-text.js';
import { openTerminalSocket } from './terminal-socket.js';
import { nativePermissions, requireTerminalPermissions, terminalProtocol, type TerminalTurnSettings } from './terminal-protocol.js';

const savedChat = z.object({
  id: z.uuid(),
  threadId: z.uuid().nullable(),
  model: z.string().nullable(),
  checkpoint: z.string().nullable(),
  rejectedModelTurnId: z.string().optional(),
  rejectedModelTurnStatus: z.string().optional(),
  rejectedAfterTurnId: z.string().nullable().optional(),
  verifiedContinuationTurnId: z.string().optional(),
  legacyContinuationCheckpoint: z.string().optional(),
  legacyContinuationTurnId: z.string().optional(),
  continuedAfterRejection: z.boolean().optional(),
}).transform(({ continuedAfterRejection, ...chat }) => {
  // The old flag attests only to the recording saved with it. Future sends replace checkpoint.
  if (continuedAfterRejection && chat.checkpoint) chat.legacyContinuationCheckpoint = chat.checkpoint;
  return chat;
});
type SavedChat = z.infer<typeof savedChat>;
type Message = { id: string; role: 'user' | 'assistant'; text: string };
const nativeItem = z.object({ id: z.string(), type: z.string(), text: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() });
const nativeTurn = z.object({ id: z.string(), status: z.string(), items: z.array(nativeItem) });
const nativeThread = z.object({ id: z.uuid(), path: z.string().nullable(), turns: z.array(nativeTurn),
  status: z.object({ type: z.string() }), model: z.string().nullable().optional() });
const threadResult = z.object({ thread: nativeThread });
const openResult = threadResult.extend({ thread: nativeThread.extend({
  source: z.unknown().optional(), originator: z.string().nullish(), cliVersion: z.string().optional(),
  historyMode: z.string().optional(),
}), model: z.string(), modelProvider: z.string().optional(), cwd: z.string().optional(),
  ...nativePermissions.shape });
type NativeThread = z.infer<typeof nativeThread>;

type Turn = { id: string; status: string };
type TerminalNotify = (method: string, params: unknown) => void;
type PreparedTerminal = { connection: CodexConnection; permissions: z.infer<typeof nativePermissions>; openSettings?: RolloutOpenSettings };
type TerminalTurn = {
  owner: symbol;
  prepared: PreparedTerminal | undefined;
  clientUserMessageId: string | undefined;
  settings: TerminalTurnSettings;
  signal: AbortSignal;
  started: (connection: CodexConnection, turn: Turn) => void;
  notify: TerminalNotify;
};
type TerminalLease = { owner: symbol; state: 'offered' | 'resuming' | 'idle'; close: () => Promise<void> };
type RecordingStart = { size: number; checkpoint: string; baseInstructions?: string };
type CreatedRecording = { path: string; cwd: string; source: string; modelProvider: string;
  originator: string; cliVersion: string; historyMode: string };
type AgentMessage = { id: string; text: string; phase?: z.infer<typeof phase> };
type RunningChat = {
  messages: Message[];
  previousTurnIds: string[];
  question?: Message;
  rejectedModelTurnId?: string;
  completedTurn?: z.infer<typeof completedEvent>['turn'];
  recordingStart?: RecordingStart;
  createdRecording?: CreatedRecording;
  openSettings?: RolloutOpenSettings;
  effort?: string;
  usageUpdates: TurnUsage[];
  userMessageId?: string;
  agentMessages: Map<string, AgentMessage>;
};
const blockedHistory = () => new DomainError(
  'CODEX_HISTORY_UNVERIFIED',
  '原生会话中有见岔无法核实来源的历史。可在此查看，材料外传资格核验前请在终端继续。',
  403,
);
const loginMessage = '请在终端运行 codex login，完成后回到见岔刷新。';
const modelUnavailableMessage = `当前 Codex 需要提供 ${codexChatModel} 才能发送。请检查原生模型列表后刷新。`;
const rerouteGraceMs = 2_000;
const turnHistoryReadAttempts = 5;
const turnHistoryRetryMs = 250;
const modelRerouted = z.object({ threadId: z.string(), turnId: z.string(), toModel: z.string() });
const readError = () => new DomainError('CODEX_HISTORY_UNAVAILABLE', '无法读取这段原生会话，请检查本机 Codex 会话位置。', 503);
const completedEvent = z.object({ threadId: z.string(), turn: z.object({
  id: z.string(), status: z.string(), error: z.object({ message: z.string(), codexErrorInfo: z.unknown().optional() }).nullish(),
}) });

function matchingCompletion(params: unknown, threadId: string | null, turnId: string) {
  const result = completedEvent.safeParse(params);
  if (result.success && result.data.threadId === threadId && result.data.turn.id === turnId) return result.data.turn;
}

function rejectedModelMessage(status?: string) {
  const message = `见岔只允许 ${codexChatModel}，已隐藏本轮内容。`;
  if (status === 'interrupted') return message + 'Codex 已中断本轮。';
  if (status === 'completed') return message + 'Codex 已完成本轮。';
  if (status === 'failed') return message + 'Codex 回合执行失败。';
  return message + '原生回合结果未确认。';
}

function historyRejectionMessage(chat: SavedChat, thread: NativeThread) {
  // A rejected turn can be absent from the recording. null means the history
  // was empty before sending. Older indexes have no recorded boundary.
  const boundary = thread.turns.some(turn => turn.id === chat.rejectedModelTurnId)
    ? chat.rejectedModelTurnId : chat.rejectedAfterTurnId;
  const hasLaterTurn = boundary === null
    ? thread.turns.length > 0
    : thread.turns.some((turn, index) => turn.id === boundary && index < thread.turns.length - 1);
  return hasLaterTurn ? undefined : rejectedModelMessage(chat.rejectedModelTurnStatus);
}

function nativeMessages(thread: NativeThread, rejectedModelTurnId?: string): Message[] {
  const result: Message[] = [];
  for (const turn of thread.turns) {
    if (turn.id === rejectedModelTurnId) continue;
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const text = item.content?.map(part => part.type === 'text' ? part.text ?? '' : '').filter(Boolean).join('\n');
        if (text) result.push({ id: item.id, role: 'user', text });
      }
      if (item.type === 'agentMessage' && item.text) result.push({ id: item.id, role: 'assistant', text: item.text });
    }
  }
  return result;
}

function privateDirectory(directory: string) {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = lstatSync(directory);
  requireThat(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0,
    'CODEX_PRIVATE_DIRECTORY_REQUIRED', 'Codex 对话目录必须为当前本机账户的私有目录。', 503);
  return directory;
}

function readPrivateFile(path: string, accept: (size: number) => boolean): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireThat(info.isFile() && info.uid === process.getuid?.() && info.nlink === 1 && accept(info.size),
      'CODEX_HISTORY_UNAVAILABLE', '无法核实本机 Codex 文件。', 503);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function recording(thread: NativeThread) {
  if (!thread.path) throw readError();
  return readPrivateFile(thread.path, size => size <= 64 * 1024 * 1024);
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(thread: NativeThread) {
  return digest(recording(thread));
}

// These are the text and lifecycle records of a controlled Codex 0.172 turn.
// Payloads that can carry additional context stay outside this allowlist.
const lifecycleTiming = {
  turn_id: z.string(), root_turn_id: z.string().optional(), started_at: z.int().optional(),
};
const finishTiming = {
  ...lifecycleTiming, completed_at: z.int().optional(), duration_ms: z.int().optional(),
  time_to_first_token_ms: z.int().optional(),
};
// The rollout uses the core protocol's snake_case tags. The app-server notification
// uses camelCase and folds an invalid prompt into its public "other" category.
const wireErrorCode = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const nativeErrorCode = z.union([
  z.enum(['context_window_exceeded', 'session_budget_exceeded', 'usage_limit_exceeded', 'api_key_spend_limit_exceeded',
    'project_spend_limit_exceeded', 'organization_spend_limit_exceeded', 'rate_limit_exceeded', 'flex_unavailable',
    'server_overloaded', 'model_not_found', 'policy_capacity_unavailable', 'inference_hook_denied', 'cyber_policy',
    'bio_policy', 'misalignment_policy_violation', 'too_many_denials', 'internal_server_error', 'unauthorized', 'bad_request',
    'invalid_prompt', 'sandbox_error', 'thread_rollback_failed', 'other'])
    .transform(name => name === 'invalid_prompt' ? 'other' : wireErrorCode(name)),
  z.union(['http_connection_failed', 'response_stream_connection_failed', 'response_stream_disconnected',
    'response_too_many_failed_attempts'].map(name => z.strictObject({ [name]: z.strictObject({
    http_status_code: z.int().min(0).max(65535).nullable(),
  }) }).transform(value => ({ [wireErrorCode(name)]: { httpStatusCode: value[name]!.http_status_code } })))),
  z.strictObject({ active_turn_not_steerable: z.strictObject({ turn_kind: z.enum(['review', 'compact']) }) })
    .transform(({ active_turn_not_steerable }) => ({ activeTurnNotSteerable: { turnKind: active_turn_not_steerable.turn_kind } })),
]);
const completedTextItem = z.object({ threadId: z.string(), turnId: z.string(),
  item: z.discriminatedUnion('type', [
    z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string(), phase }),
    z.object({ type: z.literal('userMessage'), id: z.string(),
      content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]) }),
  ]) });
const emptyArray = z.array(z.never()).length(0).optional();
const textPart = z.strictObject({ type: z.literal('text'), text: z.string(), text_elements: emptyArray });
const eventPayload = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('task_started'), ...lifecycleTiming, trace_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    turn_attribution: z.strictObject({ turn_id: z.string(), root_turn_id: z.string().nullish(),
      turn_trigger: z.null().optional(), parent_turn_id: z.null().optional(), initiating_agent_path: z.null().optional() }).optional(),
    model_context_window: z.int().nullable().optional(), collaboration_mode_kind: z.literal('default').optional() }),
  z.strictObject({ type: z.literal('task_complete'), ...finishTiming,
    last_agent_message: z.string().nullable(), error: z.strictObject({ message: z.string(), codex_error_info: nativeErrorCode.nullish() }).optional() }),
  z.strictObject({ type: z.literal('turn_aborted'), ...finishTiming, reason: z.literal('interrupted') }),
  z.strictObject({ type: z.literal('user_message'), client_id: z.string().optional(), message: z.string(),
    local_images: emptyArray, local_audio: emptyArray, text_elements: emptyArray }),
  z.strictObject({ type: z.literal('agent_message'), message: z.string(), phase, memory_citation: z.null().optional() }),
  z.strictObject({ type: z.literal('item_completed'), thread_id: z.string(), turn_id: z.string(),
    content_token_count: z.int().nonnegative().optional(), started_at_ms: z.int().optional(), completed_at_ms: z.int(),
    item: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('UserMessage'), id: z.string(), client_id: z.string().optional(), content: z.tuple([textPart]) }),
      z.strictObject({ type: z.literal('AgentMessage'), id: z.string(), phase,
        content: z.array(z.strictObject({ type: z.literal('Text'), text: z.string() })).min(1) }),
    ]) }),
]);
const ordinal = z.int().nonnegative().optional();
const rolloutLine = { timestamp: z.iso.datetime(), ordinal };
const sessionHeader = z.strictObject({ ...rolloutLine, type: z.literal('session_meta'), payload: z.strictObject({
  id: z.uuid(), session_id: z.uuid(), timestamp: z.iso.datetime(), cwd: z.string(), source: z.enum(['vscode', 'cli', 'mcp']),
  originator: z.string(), cli_version: z.string(), model_provider: z.string(),
  account_scoped: z.literal(true).optional(), creator_user_id: z.string().optional(), creator_account_id: z.string().optional(),
  runtime_workspace_roots: z.array(z.string()).optional(), thread_source: z.literal('user').optional(),
  history_mode: z.enum(['legacy', 'paginated']), memory_mode: z.literal('disabled').optional(),
  multi_agent_version: z.literal('disabled').optional(), context_window: z.strictObject({ window_id: z.uuid() }).optional(),
  base_instructions: z.strictObject({ text: z.string(), provenance: z.strictObject({
    type: z.literal('model'), model: z.literal(codexChatModel),
  }) }),
}) });
function parseVerifiedRolloutLine(line: Buffer): unknown {
  let raw: {
    type?: unknown;
    payload?: { type?: unknown; rate_limits?: { primary?: unknown; secondary?: unknown } };
  } | null;
  try { raw = JSON.parse(line.toString('utf8')); } catch { throw blockedHistory(); }
  // The compact native encoding also rules out duplicate keys hiding content.
  const windows = raw?.type === 'event_msg' && raw.payload?.type === 'token_count' ? raw.payload.rate_limits : undefined;
  // The supported Node versions expose rawJSON, which is newer than the ES2023 type library.
  const json = JSON as typeof JSON & { rawJSON(source: string): object };
  const encodePercent = windows && function (this: unknown, key: string, value: unknown) {
    if (key !== 'used_percent' || (this !== windows.primary && this !== windows.secondary) ||
        typeof value !== 'number' || !Number.isFinite(value)) return value;
    // Codex 0.172.0's Serde f64 formatter uses fixed notation at decimal
    // exponents -5 through 15 and includes .0 for integers in that range.
    const magnitude = Math.abs(value);
    if (magnitude >= 1e16 || (magnitude > 0 && magnitude < 1e-5)) return json.rawJSON(value.toExponential());
    if (Object.is(value, -0)) return json.rawJSON('-0.0');
    return Number.isInteger(value) ? json.rawJSON(`${value}.0`) : value;
  };
  const expected = JSON.stringify(raw, encodePercent ?? undefined);
  if (!line.equals(Buffer.from(expected))) throw blockedHistory();
  return raw;
}

function createdRecordingStart(thread: NativeThread, created: CreatedRecording) {
  if (thread.path !== created.path) throw blockedHistory();
  const bytes = recording(thread);
  const end = bytes.indexOf(10);
  if (end < 0) return;
  const header = sessionHeader.safeParse(parseVerifiedRolloutLine(bytes.subarray(0, end)));
  if (!header.success) return;
  const { payload, ordinal } = header.data;
  const instructions = payload.base_instructions.text;
  if (payload.id !== thread.id || payload.session_id !== thread.id || payload.cwd !== created.cwd ||
      payload.source !== created.source || payload.model_provider !== created.modelProvider ||
      payload.originator !== created.originator || payload.cli_version !== created.cliVersion || payload.history_mode !== created.historyMode ||
      (ordinal !== (payload.history_mode === 'paginated' ? 0 : undefined)) ||
      payload.runtime_workspace_roots?.some(root => root !== created.cwd) ||
      (instructions && (created.cliVersion !== '0.172.0' || !bundledLunaWorld.has(digest(Buffer.from(instructions))))))
    throw blockedHistory();
  // The controlled thread/start identifies the new root and its file. Read only
  // that creation record while its native writer is still active.
  const prefix = bytes.subarray(0, end + 1);
  return { size: prefix.length, checkpoint: digest(prefix), baseInstructions: instructions };
}

function retriedTurnCheckpoint(thread: NativeThread, turn: NonNullable<RunningChat['completedTurn']>,
  active: RunningChat, clientUserMessageId?: string) {
  const bytes = recording(thread);
  const previous = active.recordingStart;
  if (!previous || bytes.length <= previous.size || bytes.at(-1) !== 10 ||
      (previous.size > 0 && bytes[previous.size - 1] !== 10) || digest(bytes.subarray(0, previous.size)) !== previous.checkpoint)
    throw blockedHistory();
  const answers = [...active.agentMessages.values()];
  const seenInput = new Set<string>();
  const answerOffsets = new Map<string, number>();
  const inputMatches = (format: string, text: string, clientId?: string) => {
    if (seenInput.has(format) || text !== active.question?.text || (clientId !== undefined && clientId !== clientUserMessageId))
      throw blockedHistory();
    seenInput.add(format);
  };
  const answerMatches = (format: string, text: string, phase: AgentMessage['phase'], itemId?: string) => {
    const offset = answerOffsets.get(format) ?? 0;
    const expected = answers[offset];
    if (!expected || expected.text !== text || (expected.phase ?? null) !== (phase ?? null) ||
        (itemId !== undefined && itemId !== expected.id)) throw blockedHistory();
    answerOffsets.set(format, offset + 1);
  };
  let lastOrdinal: number | undefined;
  if (previous.size > 0) {
    const lastLine = bytes.toString('utf8', bytes.lastIndexOf(10, previous.size - 2) + 1, previous.size - 1);
    try { lastOrdinal = z.object({ ordinal }).parse(JSON.parse(lastLine)).ordinal; } catch { throw blockedHistory(); }
  }
  // A resumed writer can repeat settings before task_started. The first-turn
  // bootstrap is only eligible after the controlled creation header was verified.
  const firstTurn = active.previousTurnIds.length === 0;
  let baseInstructions = previous.baseInstructions;
  if (!firstTurn && active.openSettings) {
    // The full prefix hash matched above. Read its original profile to verify
    // settings repeated on resume, including the built-in personality override.
    const end = bytes.indexOf(10);
    if (end >= 0 && end < previous.size) {
      const header = sessionHeader.safeParse(parseVerifiedRolloutLine(bytes.subarray(0, end)));
      if (header.success && header.data.payload.id === thread.id) baseInstructions = header.data.payload.base_instructions.text;
    }
  }
  const verifyContext = createRolloutContextVerifier(
    !firstTurn || (active.createdRecording && previous.size > 0) ? active.openSettings : undefined,
    thread.id, turn.id, active.effort, firstTurn, baseInstructions);
  let started = false;
  let sawMessage = false;
  let position = previous.size;
  while (position < bytes.length) {
    const first = position === previous.size;
    const end = bytes.indexOf(10, position);
    const parsed = rolloutEnvelope.safeParse(parseVerifiedRolloutLine(bytes.subarray(position, end)));
    if (!parsed.success) throw blockedHistory();
    const line = parsed.data;
    position = end + 1;
    const currentOrdinal = line.ordinal;
    if (lastOrdinal !== undefined ? currentOrdinal !== lastOrdinal + 1
      : currentOrdinal !== undefined && (previous.size > 0 || !first || currentOrdinal !== 0)) throw blockedHistory();
    lastOrdinal = currentOrdinal;
    const last = position === bytes.length;
    const resumePreamble = first && !firstTurn && line.type === 'event_msg';
    if (!last && !sawMessage && (started || resumePreamble) && verifyContext(line)) continue;
    if (!verifyContext.complete()) throw blockedHistory();
    if (!last && started && sawMessage && isTurnUsageRecord(line, thread.id, turn.id, active.usageUpdates)) continue;
    // An early interrupt can leave only the marker and abort event after the turn starts.
    if (!last && started && turn.status === 'interrupted' && bytes.indexOf(10, position) === bytes.length - 1 &&
        isNativeTurnAbortMarker(line, turn.id)) continue;
    const payload = line.type === 'response_item' ? verifiedTextPayload(line, turn.id)
      : line.type === 'event_msg' && line.metadata === undefined ? eventPayload.safeParse(line.payload).data : undefined;
    if (!payload) throw blockedHistory();
    if (('turn_id' in payload && payload.turn_id !== turn.id) ||
        ('root_turn_id' in payload && payload.root_turn_id !== undefined && payload.root_turn_id !== turn.id)) throw blockedHistory();
    if (last) {
      if (payload.type === 'turn_aborted' && turn.status === 'interrupted') continue;
      if (payload.type === 'task_complete' && turn.status === (payload.error ? 'failed' : 'completed') &&
          payload.error?.message === turn.error?.message &&
          isDeepStrictEqual(payload.error?.codex_error_info ?? null, turn.error?.codexErrorInfo ?? null) &&
          (payload.last_agent_message === null || payload.last_agent_message === answers.at(-1)?.text)) continue;
      throw blockedHistory();
    }
    if (payload.type !== 'task_started') sawMessage = true;
    switch (payload.type) {
      case 'task_started': {
        const attribution = payload.turn_attribution;
        if (started || sawMessage || (attribution && (attribution.turn_id !== turn.id ||
            (attribution.root_turn_id != null && attribution.root_turn_id !== turn.id)))) throw blockedHistory();
        started = true;
        break;
      }
      case 'message':
        if (payload.role === 'user') inputMatches('response_item', payload.content[0].text);
        else answerMatches('response_item', payload.content.map(part => part.text).join(''), payload.phase, payload.id);
        break;
      case 'user_message': inputMatches('event_msg', payload.message, payload.client_id); break;
      case 'agent_message': answerMatches('event_msg', payload.message, payload.phase); break;
      case 'item_completed':
        if (payload.thread_id !== thread.id) throw blockedHistory();
        if (payload.item.type === 'UserMessage') {
          if (payload.item.id !== active.userMessageId) throw blockedHistory();
          inputMatches('item_completed', payload.item.content[0].text, payload.item.client_id);
        } else {
          answerMatches('item_completed', payload.item.content.map(part => part.text).join(''), payload.item.phase, payload.item.id);
        }
        break;
      default: throw blockedHistory();
    }
  }
  return digest(bytes);
}

// Codex 0.172 can flush an unchanged settings event when a resumed TUI is
// merely closed. Permit one byte-identical repeat apart from its timestamp,
// only on our own resume, and only after proving the full preceding file.
function repeatsVerifiedSettings(bytes: Buffer, checkpoint: string, threadId: string) {
  if (bytes.at(-1) !== 10) return false;
  const start = bytes.lastIndexOf(10, bytes.length - 2) + 1;
  const prefix = bytes.subarray(0, start);
  if (!start || digest(prefix) !== checkpoint) return false;
  const header = /^\{"timestamp":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z",/;
  const setting = '"type":"event_msg","payload":{"type":"thread_settings_applied",';
  const added = bytes.toString('utf8', start, bytes.length - 1);
  const body = added.replace(header, '');
  if (body === added || !body.startsWith(setting)) return false;
  const previous = prefix.toString('utf8').split('\n').findLast(line =>
    header.test(line) && line.replace(header, '').startsWith(setting));
  if (previous?.replace(header, '') !== body || !bytes.subarray(start, -1).equals(Buffer.from(added))) return false;
  try {
    const event = JSON.parse(added);
    return event.payload.thread_id === threadId && event.payload.thread_settings?.model === codexChatModel;
  } catch { return false; }
}

// Native clients can hydrate history through the resume response or later pages.
function terminalHistory(result: unknown, method: string, rejectedId?: string) {
  if (!rejectedId) return result;
  if (method === 'thread/turns/list' || method === 'thread/items/list') {
    const page = z.object({ data: z.array(z.object({
      id: z.string().optional(), turnId: z.string().optional(),
    }).passthrough()) }).passthrough().parse(result);
    return { ...page, data: page.data.filter(entry =>
      method === 'thread/turns/list' ? entry.id && entry.id !== rejectedId : entry.turnId && entry.turnId !== rejectedId) };
  }
  const response = z.object({ thread: z.object({
    turns: z.array(z.object({ id: z.string() }).passthrough()),
  }).passthrough() }).passthrough().parse(result);
  // Our resume request always requests inline turns, without an initial page.
  return { ...response, initialTurnsPage: null, thread: { ...response.thread, preview: '',
    turns: response.thread.turns.filter(turn => turn.id !== rejectedId) } };
}

function terminalQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export class AgentChat {
  private readonly chats: SavedChat[];
  private readonly running = new Map<string, RunningChat>();
  private readonly errors = new Map<string, string>();
  private readonly unsavedRejectionWarnings = new Map<string, string>();
  private readonly processes = new Set<CodexConnection>();
  private readonly terminals = new Map<string, TerminalLease>();
  private readonly file: string;
  private readonly cwd: string;
  private closing = false;

  constructor(directory: string, private readonly version: string) {
    this.file = join(directory, 'conversations.json');
    this.cwd = privateDirectory(join(directory, 'no-project'));
    try {
      this.chats = z.array(savedChat).parse(JSON.parse(readPrivateFile(this.file, size => size <= 1024 * 1024).toString('utf8')));
      requireThat((lstatSync(this.file).mode & 0o077) === 0, 'CODEX_STORAGE_UNAVAILABLE', '对话索引必须是私有文件。', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.chats = [];
    }
  }

  private save() {
    const next = join(this.cwd, '..', `conversations-${randomUUID()}.tmp`);
    writeFileSync(next, JSON.stringify(this.chats), { mode: 0o600, flag: 'wx' });
    try { renameSync(next, this.file); } catch (error) { unlinkSync(next); throw error; }
    this.unsavedRejectionWarnings.clear(); // The index contains every conversation.
  }

  private saveModelRejection(chat: SavedChat, turnId: string, previousTurnId: string | null, status?: string) {
    chat.rejectedModelTurnId = turnId;
    chat.rejectedModelTurnStatus = status;
    chat.rejectedAfterTurnId = previousTurnId;
    delete chat.verifiedContinuationTurnId;
    delete chat.legacyContinuationCheckpoint;
    delete chat.legacyContinuationTurnId;
    try { this.save(); } catch {
      this.unsavedRejectionWarnings.set(chat.id, '拒绝回合的记录未保存。重启后可能重新显示本轮内容或丢失最新状态。');
    }
  }

  private matchLegacyContinuation(chat: SavedChat, thread: NativeThread, checkpoint: string) {
    if (!chat.rejectedModelTurnId || checkpoint !== chat.legacyContinuationCheckpoint) return false;
    const predecessor = thread.turns.findIndex(turn => turn.id === chat.rejectedAfterTurnId);
    const completed = (turn: Turn) => turn.status === 'completed' && turn.id !== chat.rejectedModelTurnId;
    // Prefer the first continuation after a known boundary. With only the old
    // flag, earlier completed turns could predate the rejection.
    const continuation = chat.rejectedAfterTurnId === null || predecessor >= 0
      ? thread.turns.slice(predecessor + 1).find(completed)
      : thread.turns.findLast(completed);
    if (continuation) {
      // A coexisting turn ID can attest to a different recording.
      if (chat.verifiedContinuationTurnId) chat.legacyContinuationTurnId = continuation.id;
      else chat.verifiedContinuationTurnId = continuation.id;
      delete chat.legacyContinuationCheckpoint;
      this.unsavedRejectionWarnings.set(chat.id, '续聊状态未保存。重启后可能重新显示拒绝提示。');
    }
    return true;
  }

  private find(id: string) {
    const chat = this.chats.find(candidate => candidate.id === id);
    requireThat(chat, 'CODEX_CONVERSATION_NOT_FOUND', '找不到这段见岔对话。', 404);
    return chat;
  }

  private summary({ id, threadId, model }: SavedChat) {
    return { id, threadId, model };
  }

  private detail(chat: SavedChat, messages: Message[], busy: boolean, model = chat.model, rejection?: string) {
    let resumeCommand: string | undefined;
    if (chat.threadId && !busy) {
      const environment = codexStorageEnvironment.flatMap(name => {
        const value = process.env[name];
        return value ? [`${name}=${terminalQuote(value)}`] : [];
      });
      resumeCommand = [...environment, 'codex', '--no-daemon', ...codexModelArgs, 'resume', '--model', codexChatModel, '-C',
        terminalQuote(this.cwd), terminalQuote(chat.threadId)].join(' ');
    }
    let error = rejection ?? this.errors.get(chat.id);
    const warning = this.unsavedRejectionWarnings.get(chat.id);
    if (warning) error = (error ?? '') + warning;
    return { ...this.summary(chat), model, messages, busy, resumeCommand, error };
  }

  private runningDetail(chat: SavedChat, active: RunningChat) {
    const messages = active.question && !active.rejectedModelTurnId ? [...active.messages, active.question] : active.messages;
    const rejection = active.rejectedModelTurnId
      ? rejectedModelMessage(active.rejectedModelTurnId === chat.rejectedModelTurnId ? chat.rejectedModelTurnStatus : undefined)
      : undefined;
    return this.detail(chat, messages, true, chat.model, rejection);
  }

  list() { return this.chats.map(chat => this.summary(chat)); }

  create() {
    const chat = { id: randomUUID(), threadId: null, model: null, checkpoint: null };
    this.chats.unshift(chat);
    try { this.save(); } catch (error) { this.chats.shift(); throw error; }
    return this.summary(chat);
  }

  private connect(onEvent: (method: string, params: unknown) => void = () => {}, onClose = () => {}) {
    requireThat(!this.closing, 'CODEX_UNAVAILABLE', '工作台正在关闭。', 503);
    const connection = new CodexConnection(this.cwd, onEvent, () => {
      this.processes.delete(connection);
      onClose();
    });
    this.processes.add(connection);
    return connection;
  }

  private async read(connection: CodexConnection, threadId: string) {
    const result = threadResult.safeParse(await connection.call('thread/read', { threadId, includeTurns: true }));
    if (!result.success || result.data.thread.id !== threadId) throw readError();
    return result.data.thread;
  }

  private verifyRecording(chat: SavedChat, history: NativeThread, ownResume: boolean) {
    const bytes = recording(history);
    const current = digest(bytes);
    if (current !== chat.checkpoint) {
      if (!ownResume || !chat.checkpoint || !repeatsVerifiedSettings(bytes, chat.checkpoint, history.id)) throw blockedHistory();
      chat.checkpoint = current;
      this.save();
    }
    return { size: bytes.length, checkpoint: current };
  }

  private settleResume(chat: SavedChat, history: NativeThread, checkpoint: string | null) {
    if (chat.checkpoint !== checkpoint) return;
    try { this.verifyRecording(chat, history, true); } catch {
      // Unknown changes keep the previous checkpoint and block the next send.
    }
  }

  private async verifiedHistory(connection: CodexConnection, chat: SavedChat, threadId: string, ownResume = false) {
    const history = await this.read(connection, threadId);
    requireThat(history.status.type !== 'active' && !history.turns.some(item => item.status === 'inProgress'),
      'CODEX_TURN_ACTIVE', '请结束终端中的当前 Codex 回合，再回见岔继续。', 409);
    // The native file also contains context absent from the display projection.
    const start = this.verifyRecording(chat, history, ownResume);
    this.matchLegacyContinuation(chat, history, start.checkpoint);
    return { history, start };
  }

  async status(): Promise<{ loggedIn: boolean; modelAvailable: boolean; message?: string }> {
    const connection = this.connect();
    try {
      await connection.initialize(this.version);
      if (!(await connection.loggedIn())) return { loggedIn: false, modelAvailable: false, message: loginMessage };
      try {
        const modelAvailable = await connection.hasChatModel();
        return { loggedIn: true, modelAvailable, ...(modelAvailable ? {} : { message: modelUnavailableMessage }) };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { loggedIn: true, modelAvailable: false, message: '暂时无法检查 Codex 模型列表。请刷新后再试。' };
      }
    } finally { await connection.close(); }
  }

  async get(id: string) {
    const chat = this.find(id);
    let active = this.running.get(id);
    if (active) return this.runningDetail(chat, active);
    if (!chat.threadId) return this.detail(chat, [], false);
    const connection = this.connect();
    try {
      await connection.initialize(this.version);
      const thread = await this.read(connection, chat.threadId);
      active = this.running.get(id);
      if (active) return this.runningDetail(chat, active);
      let rejection: string | undefined;
      try {
        if (chat.rejectedModelTurnId && !thread.turns.some(turn =>
          turn.id === chat.verifiedContinuationTurnId || turn.id === chat.legacyContinuationTurnId)) {
          rejection = historyRejectionMessage(chat, thread);
          if (chat.legacyContinuationCheckpoint && (rejection || thread.status.type !== 'active') &&
              this.matchLegacyContinuation(chat, thread, fingerprint(thread))) {
            rejection = undefined;
          }
        }
        if (chat.verifiedContinuationTurnId && this.unsavedRejectionWarnings.has(id)) this.save();
      } catch {
        // Keep history readable. detail() reports any index change still pending.
      }
      return this.detail(chat, nativeMessages(thread, chat.rejectedModelTurnId), thread.status.type === 'active', thread.model ?? chat.model, rejection);
    } finally { await connection.close(); }
  }

  async terminal(id: string) {
    const chat = this.find(id);
    const threadId = chat.threadId;
    requireThat(threadId && chat.checkpoint, 'CODEX_HISTORY_UNVERIFIED', '请先在见岔完成可核验的首轮对话。', 403);
    const old = this.terminals.get(id);
    requireThat(!this.running.has(id) && (!old || old.state === 'offered'),
      'CODEX_TURN_ACTIVE', '请先结束当前回合或终端接续。', 409);
    const owner = Symbol(id);
    let closed = false;
    let reader: CodexConnection | undefined;
    let preparing: CodexConnection | undefined;
    let prepared: PreparedTerminal | undefined;
    let driving: { connection: CodexConnection; turnId: string } | undefined;
    let resumedHistory: NativeThread | undefined;
    let beforeResume: string | null = null;
    const release = async () => {
      closed = true;
      try {
        const connection = prepared?.connection ?? preparing;
        if (connection) {
          await connection.close();
          if (resumedHistory) this.settleResume(chat, resumedHistory, beforeResume);
        }
      } finally {
        if (this.terminals.get(id)?.owner === owner) this.terminals.delete(id);
        await reader?.close();
      }
    };
    const lease: TerminalLease = { owner, state: 'offered', close: release };
    this.terminals.set(id, lease);
    try {
      if (old) await old.close();
      const handle = terminalProtocol(threadId, {
        initialize: async () => {
          requireThat(!reader && !closed, 'CODEX_TERMINAL_EXPIRED', '终端接续已结束。', 409);
          reader = this.connect();
          return reader.initialize(this.version);
        },
        query: async (method, params) => {
          requireThat(reader && !closed, 'CODEX_TERMINAL_EXPIRED', '终端接续已结束。', 409);
          if (!method.startsWith('thread/')) return reader.call(method, params);
          requireThat(!this.running.has(id), 'CODEX_HISTORY_UNAVAILABLE', '请在本轮结束后读取会话。', 409);
          const response = await reader.call(method, params);
          requireThat(!this.running.has(id), 'CODEX_HISTORY_UNAVAILABLE', '请在本轮结束后读取会话。', 409);
          return terminalHistory(response, method, chat.rejectedModelTurnId);
        },
        resume: async () => {
          requireThat(!closed && lease.state === 'offered' && !this.running.has(id) && this.terminals.get(id) === lease,
            'CODEX_TURN_ACTIVE', '当前会话已被占用。', 409);
          lease.state = 'resuming';
          try {
            const connection = preparing = this.connect();
            await connection.initialize(this.version);
            requireThat(await connection.loggedIn(), 'CODEX_LOGIN_REQUIRED', loginMessage, 401);
            requireThat(await connection.hasChatModel(), 'CODEX_MODEL_UNAVAILABLE', modelUnavailableMessage, 503);
            await this.verifiedHistory(connection, chat, threadId);
            beforeResume = chat.checkpoint;
            const result = await connection.call('thread/resume', { threadId, cwd: this.cwd, model: codexChatModel });
            const opened = openResult.safeParse(result);
            requireThat(opened.success && opened.data.thread.id === threadId && opened.data.model === codexChatModel,
              'CODEX_THREAD_UNAVAILABLE', '无法核验终端接续的原生会话和模型。', 503);
            resumedHistory = opened.data.thread;
            prepared = { connection, permissions: opened.data, openSettings: rolloutOpenSettings(result, this.cwd) };
            lease.state = 'idle';
            return terminalHistory(result, 'thread/resume', chat.rejectedModelTurnId);
          } catch (error) {
            await preparing?.close();
            prepared = undefined;
            lease.state = 'offered';
            throw error;
          } finally {
            preparing = undefined;
          }
        },
        turn: async (text, clientUserMessageId, settings, notify, signal) => {
          requireThat(!closed && lease.state === 'idle' && this.terminals.get(id) === lease,
            'CODEX_TERMINAL_EXPIRED', '终端接续已结束。', 409);
          let startedTurn: Turn | undefined;
          const native = prepared;
          if (native) requireTerminalPermissions(settings, native.permissions);
          prepared = undefined;
          try {
            await this.send(id, text, { owner, prepared: native, clientUserMessageId, settings, notify, signal,
              started(connection, turn) {
                driving = { connection, turnId: turn.id };
                startedTurn = turn;
              },
            });
          } catch (error) {
            if (native && resumedHistory) this.settleResume(chat, resumedHistory, beforeResume);
            throw error;
          }
          return { turn: startedTurn };
        },
        interrupt: async turnId => {
          requireThat(driving?.turnId === turnId && this.running.has(id),
            'CODEX_TURN_UNKNOWN', '找不到此终端发起的活动回合。', 409);
          return driving.connection.call('turn/interrupt', { threadId, turnId });
        },
      });
      const socket = await openTerminalSocket(handle, release);
      lease.close = socket.close;
      if (closed || this.closing || this.terminals.get(id) !== lease) {
        await socket.close();
        throw new DomainError('CODEX_TERMINAL_EXPIRED', '终端接续已结束。', 409);
      }
      return { command: ['codex', '--remote', terminalQuote(socket.url), 'resume', '--model', codexChatModel,
        terminalQuote(threadId)].join(' '), expiresAt: socket.expiresAt };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async send(id: string, text: string, terminal?: TerminalTurn) {
    const chat = this.find(id);
    const lease = this.terminals.get(id);
    requireThat(!this.running.has(id), 'CODEX_TURN_ACTIVE', '请等待当前回合结束。', 409);
    requireThat(lease?.state !== 'resuming', 'CODEX_TURN_ACTIVE', '请等待终端恢复当前会话。', 409);
    const active: RunningChat = { messages: [], previousTurnIds: [], agentMessages: new Map(), usageUpdates: [] };
    this.running.set(id, active);
    this.errors.delete(id);
    let connection: CodexConnection | undefined;
    let turn: (Turn & { items: [] }) | undefined;
    let reopenedTerminal: { history: NativeThread; checkpoint: string | null } | undefined;
    let rerouteDeadline: ReturnType<typeof setTimeout> | undefined;
    let beginFinish: () => void = () => {};
    const terminalEvents: { method: string; params: unknown }[] = [];
    let earlyEvents: { method: string; params: unknown }[] | undefined;
    let earlyRerouteId: string | undefined;
    const readyToFinish = new Promise<void>(resolve => { beginFinish = resolve; });
    const rejectModelTurn = (turnId: string) => {
      active.rejectedModelTurnId = turnId;
      this.saveModelRejection(chat, turnId, active.previousTurnIds.at(-1) ?? null);
      // Give turn/completed a short window even if the interrupt RPC fails or never replies.
      rerouteDeadline = setTimeout(beginFinish, rerouteGraceMs);
    };
    try {
      if (!terminal && lease?.state === 'idle') await lease.close();
      const onEvent = (method: string, params: unknown) => {
        if (method === 'model/rerouted') {
          const reroute = modelRerouted.safeParse(params);
          if (!reroute.success || reroute.data.threadId !== chat.threadId || reroute.data.toModel === codexChatModel) return;
          const { threadId, turnId } = reroute.data;
          if (turn) {
            if (turn.id !== turnId || active.rejectedModelTurnId) return;
            rejectModelTurn(turnId);
          } else {
            if (!earlyEvents || earlyRerouteId || active.previousTurnIds.at(-1) === turnId) return;
            // A missing start reply must not delay an interrupt requested after dispatch.
            earlyRerouteId = turnId;
          }
          void connection?.call('turn/interrupt', { threadId, turnId }).catch(() => {});
          return;
        }
        const terminalContent = terminal && (method === 'turn/completed' ||
          method === 'item/started' || method === 'item/completed');
        if (!turn) {
          if (terminalContent || method === 'turn/completed' || method === 'item/completed' || method === 'thread/tokenUsage/updated')
            earlyEvents?.push({ method, params });
          return;
        }
        if (method === 'thread/tokenUsage/updated') {
          const usage = turnUsageNotification.safeParse(params);
          if (usage.success && usage.data.threadId === chat.threadId && usage.data.turnId === turn.id) {
            active.usageUpdates.push(usage.data.tokenUsage);
          }
        }
        if (terminalContent) {
          const event = z.object({ threadId: z.string(), turnId: z.string().optional(),
            turn: z.object({id: z.string()}).optional(), item: z.object({type: z.string()}).optional() }).safeParse(params);
          if (event.success && event.data.threadId === chat.threadId) {
            const eventTurn = event.data.turn?.id ?? event.data.turnId;
            if (eventTurn === turn.id && (!event.data.item || ['userMessage', 'agentMessage'].includes(event.data.item.type)))
              terminalEvents.push({ method, params });
          }
        }
        if (method === 'item/completed') {
          const message = completedTextItem.safeParse(params);
          if (message.success && message.data.threadId === chat.threadId && message.data.turnId === turn.id) {
            const { item } = message.data;
            if (item.type === 'agentMessage') active.agentMessages.set(item.id, item);
            else if (item.content[0].text === active.question?.text) active.userMessageId = item.id;
          }
        }
        // Keep terminal content buffered until native history confirms the turn's final status.
        if (method === 'turn/completed') {
          const completed = matchingCompletion(params, chat.threadId, turn.id);
          if (completed) {
            active.completedTurn = completed;
            beginFinish();
          }
        }
      };
      if (terminal?.prepared) {
        connection = terminal.prepared.connection;
        connection.observe(onEvent, beginFinish);
      } else {
        connection = this.connect(onEvent, beginFinish);
        await connection.initialize(this.version);
      }
      requireThat(await connection.loggedIn(), 'CODEX_LOGIN_REQUIRED', loginMessage, 401);
      const model = await connection.chatModel();
      requireThat(model, 'CODEX_MODEL_UNAVAILABLE', modelUnavailableMessage, 503);
      active.openSettings = terminal?.prepared?.openSettings;
      const effort = terminal?.settings.effort;
      if (effort) active.effort = effort;
      requireThat(!effort || effort === model.defaultReasoningEffort ||
        model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort),
      'CODEX_TERMINAL_PARAMS', '当前 Luna 模型不支持所选推理强度。', 400);
      const previous = chat.threadId;
      if (previous) {
        const { history, start } = await this.verifiedHistory(connection, chat, previous, Boolean(terminal?.prepared));
        active.recordingStart = start;
        active.messages = nativeMessages(history, chat.rejectedModelTurnId);
        active.previousTurnIds = history.turns.map(turn => turn.id);
      }
      if (!terminal?.prepared) {
        const checkpoint = chat.checkpoint;
        const result = await connection.call(previous ? 'thread/resume' : 'thread/start', {
          ...(previous ? { threadId: previous, excludeTurns: true } : {}),
          cwd: this.cwd, model: codexChatModel,
        });
        const opened = openResult.safeParse(result);
        requireThat(opened.success && (!previous || opened.data.thread.id === previous),
          'CODEX_THREAD_UNAVAILABLE', '无法启动或恢复这段原生 Codex 会话。', 503);
        requireThat(opened.data.model === codexChatModel, 'CODEX_MODEL_MISMATCH',
          `见岔只允许 ${codexChatModel}，本轮未发送。`, 503);
        if (terminal) {
          reopenedTerminal = { history: opened.data.thread, checkpoint };
          requireTerminalPermissions(terminal.settings, opened.data);
        }
        active.openSettings = rolloutOpenSettings(result, this.cwd);
        if (!previous && opened.data.thread.turns.length === 0) {
          // The native writer may defer creating a new rollout until there is input.
          active.recordingStart = { size: 0, checkpoint: digest(Buffer.alloc(0)) };
          const { thread: { path, source, originator, cliVersion, historyMode }, cwd, modelProvider } = opened.data;
          if (path && typeof source === 'string' && cwd && modelProvider && originator && cliVersion && historyMode &&
              !lstatSync(path, { throwIfNoEntry: false })) {
            active.createdRecording = { path, cwd, source: source === 'appServer' ? 'mcp' : source,
              modelProvider, originator, cliVersion, historyMode };
          }
        }
        chat.threadId = opened.data.thread.id;
        chat.model = opened.data.model;
        this.save();
      }
      active.question = { id: randomUUID(), role: 'user', text };
      terminal?.signal.throwIfAborted();
      earlyEvents = [];
      const response = await connection.call('turn/start', { threadId: chat.threadId, model: codexChatModel,
        ...(terminal?.clientUserMessageId ? { clientUserMessageId: terminal.clientUserMessageId } : {}),
        ...(effort ? { effort } : {}),
        input: [{ type: 'text', text, text_elements: [] }] });
      const started = z.object({ turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(response);
      requireThat(started.success, 'CODEX_TURN_UNKNOWN', '无法确认发送结果，请重新读取会话后再试。', 503);
      turn = { id: started.data.turn.id, status: 'inProgress', items: [] };
      if (earlyRerouteId === turn.id) rejectModelTurn(turn.id);
      terminal?.started(connection, turn);
      terminal?.notify('turn/started', { threadId: chat.threadId, turn });
      for (const event of earlyEvents) onEvent(event.method, event.params);
      earlyEvents = undefined;
      void this.finish(chat, active, connection, readyToFinish, turn, terminal?.clientUserMessageId).then(verified => {
        if (terminal && verified) {
          for (const event of terminalEvents) terminal.notify(event.method, event.params);
        } else if (terminal) {
          terminal.notify('error', { threadId: chat.threadId, turnId: started.data.turn.id, willRetry: false,
            error: { message: '见岔未能核验本轮结果。请回到右栏查看。', codexErrorInfo: null, additionalDetails: null } });
          if (lease?.owner === terminal.owner) void lease.close().catch(() => {});
        }
      }).finally(() => clearTimeout(rerouteDeadline));
      return this.runningDetail(chat, active);
    } catch (error) {
      if (connection) await connection.close();
      // A reroute can arrive while the connection drains after a failed start.
      if (!turn && earlyRerouteId) {
        let status: string | undefined;
        for (const event of earlyEvents ?? []) {
          if (event.method !== 'turn/completed') continue;
          const completed = matchingCompletion(event.params, chat.threadId, earlyRerouteId);
          if (completed) status = completed.status;
        }
        this.saveModelRejection(chat, earlyRerouteId, active.previousTurnIds.at(-1) ?? null, status);
      }
      if (reopenedTerminal) this.settleResume(chat, reopenedTerminal.history, reopenedTerminal.checkpoint);
      clearTimeout(rerouteDeadline);
      this.running.delete(id);
      throw error;
    }
  }

  private async finish(chat: SavedChat, active: RunningChat, connection: CodexConnection, readyToFinish: Promise<void>, started: Turn,
    clientUserMessageId?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readyToFinish, new Promise<void>(resolve => {
        timer = setTimeout(resolve, 10 * 60 * 1000);
      })]);
      const confirmed = active.completedTurn?.id === started.id ? active.completedTurn : undefined;
      const hasTerminalStatus = confirmed && ['completed', 'interrupted', 'failed'].includes(confirmed.status);
      const previousTurnId = active.previousTurnIds.at(-1) ?? null;
      let thread: NativeThread | undefined;
      let retried = false;
      let rejectedFromHistory = false;
      try {
        if (confirmed) {
          for (let attempt = 1; attempt <= turnHistoryReadAttempts; attempt++) {
            if (attempt > 1) await delay(turnHistoryRetryMs);
            if (active.rejectedModelTurnId && !rejectedFromHistory) break;
            const history = await this.read(connection, chat.threadId!);
            if (!hasTerminalStatus) break;
            // Attribute the thread model only to the sole new turn we can identify.
            // Conflicting statuses still leave that turn's content hidden.
            const count = active.previousTurnIds.length;
            const last = history.turns[count];
            if (active.previousTurnIds.some((id, index) => history.turns[index]?.id !== id) ||
                history.turns.length > count + 1 || (last && last.id !== started.id)) throw blockedHistory();
            if (!last) continue;
            if (rejectedFromHistory || (history.model != null && history.model !== codexChatModel)) {
              const status = last.status === confirmed.status ? confirmed.status : undefined;
              if (!rejectedFromHistory || chat.rejectedModelTurnStatus !== status) {
                this.saveModelRejection(chat, started.id, previousTurnId, status);
              }
              rejectedFromHistory = true;
              active.rejectedModelTurnId = started.id;
              if (last.status === 'inProgress') continue;
              break;
            }
            if (last.status !== confirmed.status) continue;
            if (attempt > 1 && active.createdRecording) {
              const start = createdRecordingStart(history, active.createdRecording);
              if (start) active.recordingStart = start;
            }
            thread = history;
            retried = attempt > 1;
            break;
          }
        }
      } finally {
        await connection.close();
        if (active.rejectedModelTurnId === started.id) {
          // A matching notification can arrive while the child drains stdout after stdin EOF.
          const status = rejectedFromHistory ? chat.rejectedModelTurnStatus
            : active.completedTurn?.id === started.id ? active.completedTurn.status : undefined;
          if (chat.rejectedModelTurnStatus !== status || this.unsavedRejectionWarnings.has(chat.id)) {
            this.saveModelRejection(chat, started.id, previousTurnId, status);
          }
        }
      }
      if (chat.rejectedModelTurnId === started.id) return;
      requireThat(confirmed, 'CODEX_TURN_UNKNOWN', 'Codex 连接已结束。请读取原生会话确认回合结果。', 503);
      requireThat(thread, 'CODEX_TURN_UNKNOWN', '原生历史尚未确认本轮结果，请重新读取会话。', 503);
      chat.checkpoint = retried
        ? retriedTurnCheckpoint(thread, confirmed, active, clientUserMessageId)
        : fingerprint(thread);
      chat.model = thread.model ?? chat.model;
      // Keep the first verified continuation still in history across later sends and native rollbacks.
      // A delayed rejected turn can appear after it in the recording.
      if (chat.rejectedModelTurnId && confirmed.status === 'completed' &&
          !thread.turns.some(turn => turn.id === chat.verifiedContinuationTurnId)) {
        chat.verifiedContinuationTurnId = started.id;
      }
      this.save();
      if (confirmed.status !== 'completed') {
        this.errors.set(chat.id, confirmed.status === 'interrupted' ? '此回合已中断。' : '此回合未完成，请检查 Codex、模型和网络后再试。');
      }
      return true;
    } catch (error) {
      this.errors.set(chat.id, error instanceof DomainError ? error.message : '无法确认原生会话结果，请重新读取。');
    } finally {
      clearTimeout(timer);
      this.running.delete(chat.id);
    }
  }

  async close() {
    this.closing = true;
    await Promise.all([...this.terminals.values()].map(terminal => terminal.close()));
    await Promise.all([...this.processes].map(connection => connection.close()));
  }
}

export function openAgentChatDirectory(workspaceDirectory: string) {
  return privateDirectory(join(workspaceDirectory, 'agent-chat'));
}
