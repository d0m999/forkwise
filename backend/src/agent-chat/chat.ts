import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { CodexConnection, codexChatModel, codexModelArgs, codexStorageEnvironment } from './codex.js';
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
const openResult = threadResult.extend({ model: z.string(), ...nativePermissions.shape });
type NativeThread = z.infer<typeof nativeThread>;

type Turn = { id: string; status: string };
type TerminalNotify = (method: string, params: unknown) => void;
type PreparedTerminal = { connection: CodexConnection; permissions: z.infer<typeof nativePermissions> };
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
type RunningChat = {
  messages: Message[];
  previousTurnId: string | null;
  question?: Message;
  rejectedModelTurnId?: string;
  completedTurn?: Turn;
};
const blockedHistory = () => new DomainError(
  'CODEX_HISTORY_UNVERIFIED',
  '原生会话中有见岔无法核实来源的历史。可在此查看，材料外传资格核验前请在终端继续。',
  403,
);
const loginMessage = '请在终端运行 codex login，完成后回到见岔刷新。';
const modelUnavailableMessage = `当前 Codex 需要提供 ${codexChatModel} 才能发送。请检查原生模型列表后刷新。`;
const rerouteGraceMs = 2_000;
const modelRerouted = z.object({ threadId: z.string(), turnId: z.string(), toModel: z.string() });
const readError = () => new DomainError('CODEX_HISTORY_UNAVAILABLE', '无法读取这段原生会话，请检查本机 Codex 会话位置。', 503);

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
    if (current === chat.checkpoint) return;
    if (!ownResume || !chat.checkpoint || !repeatsVerifiedSettings(bytes, chat.checkpoint, history.id)) throw blockedHistory();
    chat.checkpoint = current;
    this.save();
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
    this.verifyRecording(chat, history, ownResume);
    this.matchLegacyContinuation(chat, history, chat.checkpoint!);
    return history;
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
    const active = this.running.get(id);
    if (active) return this.runningDetail(chat, active);
    if (!chat.threadId) return this.detail(chat, [], false);
    const connection = this.connect();
    try {
      await connection.initialize(this.version);
      const thread = await this.read(connection, chat.threadId);
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
            prepared = { connection, permissions: opened.data };
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
    const active: RunningChat = { messages: [], previousTurnId: null };
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
      this.saveModelRejection(chat, turnId, active.previousTurnId);
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
            if (!earlyEvents || earlyRerouteId || active.previousTurnId === turnId) return;
            // A missing start reply must not delay an interrupt requested after dispatch.
            earlyRerouteId = turnId;
          }
          void connection?.call('turn/interrupt', { threadId, turnId }).catch(() => {});
          return;
        }
        const terminalContent = terminal && (method === 'turn/completed' ||
          method === 'item/started' || method === 'item/completed');
        if (!turn) {
          if (terminalContent || method === 'turn/completed')
            earlyEvents?.push({ method, params });
          return;
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
        // Keep terminal content buffered until native history confirms the turn's final status.
        if (method === 'turn/completed') {
          const result = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(params);
          if (result.success && result.data.threadId === chat.threadId && turn.id === result.data.turn.id) {
            active.completedTurn = result.data.turn;
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
      const effort = terminal?.settings.effort;
      requireThat(!effort || effort === model.defaultReasoningEffort ||
        model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort),
      'CODEX_TERMINAL_PARAMS', '当前 Luna 模型不支持所选推理强度。', 400);
      const previous = chat.threadId;
      if (previous) {
        const history = await this.verifiedHistory(connection, chat, previous, Boolean(terminal?.prepared));
        active.messages = nativeMessages(history, chat.rejectedModelTurnId);
        active.previousTurnId = history.turns.at(-1)?.id ?? null;
      }
      if (!terminal?.prepared) {
        const checkpoint = chat.checkpoint;
        const opened = openResult.safeParse(await connection.call(previous ? 'thread/resume' : 'thread/start', {
          ...(previous ? { threadId: previous, excludeTurns: true } : {}),
          cwd: this.cwd, model: codexChatModel,
        }));
        requireThat(opened.success && (!previous || opened.data.thread.id === previous),
          'CODEX_THREAD_UNAVAILABLE', '无法启动或恢复这段原生 Codex 会话。', 503);
        requireThat(opened.data.model === codexChatModel, 'CODEX_MODEL_MISMATCH',
          `见岔只允许 ${codexChatModel}，本轮未发送。`, 503);
        if (terminal) {
          reopenedTerminal = { history: opened.data.thread, checkpoint };
          requireTerminalPermissions(terminal.settings, opened.data);
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
      void this.finish(chat, active, connection, readyToFinish, turn).then(verified => {
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
      if (reopenedTerminal) this.settleResume(chat, reopenedTerminal.history, reopenedTerminal.checkpoint);
      clearTimeout(rerouteDeadline);
      this.running.delete(id);
      throw error;
    }
  }

  private async finish(chat: SavedChat, active: RunningChat, connection: CodexConnection, readyToFinish: Promise<void>, started: Turn) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readyToFinish, new Promise<void>(resolve => {
        timer = setTimeout(resolve, 10 * 60 * 1000);
      })]);
      const confirmed = active.completedTurn?.id === started.id ? active.completedTurn : undefined;
      let thread: NativeThread | undefined;
      try {
        if (confirmed && !active.rejectedModelTurnId) {
          thread = await this.read(connection, chat.threadId!);
          if (thread.model != null && thread.model !== codexChatModel) {
            active.rejectedModelTurnId = started.id;
            this.saveModelRejection(chat, started.id, active.previousTurnId, confirmed.status);
          }
        }
      } finally {
        await connection.close();
        if (active.rejectedModelTurnId === started.id) {
          // A matching notification can arrive while the child drains stdout after stdin EOF.
          const status = active.completedTurn?.id === started.id ? active.completedTurn.status : undefined;
          if (chat.rejectedModelTurnStatus !== status || this.unsavedRejectionWarnings.has(chat.id)) {
            this.saveModelRejection(chat, started.id, active.previousTurnId, status);
          }
        }
      }
      if (chat.rejectedModelTurnId === started.id) return;
      requireThat(confirmed && thread, 'CODEX_TURN_UNKNOWN', 'Codex 连接已结束。请读取原生会话确认回合结果。', 503);
      requireThat(['completed', 'interrupted', 'failed'].includes(confirmed.status) &&
          thread.turns.some(turn => turn.id === started.id && turn.status === confirmed.status),
        'CODEX_TURN_UNKNOWN', '原生历史尚未确认本轮结果，请重新读取会话。', 503);
      chat.model = thread.model ?? chat.model;
      chat.checkpoint = fingerprint(thread);
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
