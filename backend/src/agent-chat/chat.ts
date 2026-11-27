import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { CodexConnection, codexChatModel, codexModelArgs, codexStorageEnvironment } from './codex.js';

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
const openResult = threadResult.extend({ model: z.string() });
type NativeThread = z.infer<typeof nativeThread>;

type Turn = { id: string; status: string };
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
  if (!chat.rejectedModelTurnId || thread.turns.some(turn => turn.id === chat.verifiedContinuationTurnId)) return;
  // A rejected turn can be absent from the recording. null means the history
  // was empty before sending. Older indexes have no recorded boundary.
  const boundary = thread.turns.some(turn => turn.id === chat.rejectedModelTurnId)
    ? chat.rejectedModelTurnId : chat.rejectedAfterTurnId;
  const hasLaterTurn = boundary === null
    ? thread.turns.length > 0
    : thread.turns.some((turn, index) => turn.id === boundary && index < thread.turns.length - 1);
  if (hasLaterTurn) return;
  if (chat.legacyContinuationCheckpoint) {
    try {
      if (fingerprint(thread) === chat.legacyContinuationCheckpoint) return;
    } catch {
      // History can still be displayed when its recording cannot be verified.
    }
  }
  return rejectedModelMessage(chat.rejectedModelTurnStatus);
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

function fingerprint(thread: NativeThread) {
  if (!thread.path) throw readError();
  return createHash('sha256').update(readPrivateFile(thread.path, size => size <= 64 * 1024 * 1024)).digest('hex');
}

function terminalQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export class AgentChat {
  private readonly chats: SavedChat[];
  private readonly running = new Map<string, RunningChat>();
  private readonly errors = new Map<string, string>();
  private readonly unsavedRejections = new Set<string>();
  private readonly processes = new Set<CodexConnection>();
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
    this.unsavedRejections.clear(); // The index contains every conversation.
  }

  private saveModelRejection(chat: SavedChat, turnId: string, previousTurnId: string | null, status?: string) {
    chat.rejectedModelTurnId = turnId;
    chat.rejectedModelTurnStatus = status;
    chat.rejectedAfterTurnId = previousTurnId;
    delete chat.verifiedContinuationTurnId;
    delete chat.legacyContinuationCheckpoint;
    try { this.save(); } catch { this.unsavedRejections.add(chat.id); }
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
    if (this.unsavedRejections.has(chat.id)) {
      error = (error ?? '') + '拒绝回合的记录未保存。重启后可能重新显示本轮内容或丢失最新状态。';
    }
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
      const rejection = historyRejectionMessage(chat, thread);
      return this.detail(chat, nativeMessages(thread, chat.rejectedModelTurnId), thread.status.type === 'active', thread.model ?? chat.model, rejection);
    } finally { await connection.close(); }
  }

  async send(id: string, text: string) {
    const chat = this.find(id);
    requireThat(!this.running.has(id), 'CODEX_TURN_ACTIVE', '请等待当前回合结束。', 409);
    const active: RunningChat = { messages: [], previousTurnId: null };
    this.running.set(id, active);
    this.errors.delete(id);
    let connection: CodexConnection | undefined;
    let turn: Turn | undefined;
    let rerouteDeadline: ReturnType<typeof setTimeout> | undefined;
    let beginFinish: () => void = () => {};
    const readyToFinish = new Promise<void>(resolve => { beginFinish = resolve; });
    const savePendingRejection = () => {
      if (!turn || active.rejectedModelTurnId !== turn.id) return;
      this.saveModelRejection(chat, turn.id, active.previousTurnId);
    };
    try {
      connection = this.connect((method, params) => {
        if (method === 'model/rerouted') {
          const reroute = modelRerouted.safeParse(params);
          if (reroute.success && reroute.data.threadId === chat.threadId &&
              (!turn || turn.id === reroute.data.turnId) && reroute.data.toModel !== codexChatModel &&
              !active.rejectedModelTurnId) {
            const { threadId, turnId } = reroute.data;
            active.rejectedModelTurnId = turnId;
            savePendingRejection();
            // Give turn/completed a short window even if the interrupt RPC fails or never replies.
            rerouteDeadline = setTimeout(beginFinish, rerouteGraceMs);
            void connection?.call('turn/interrupt', { threadId, turnId }).catch(() => {});
          }
          return;
        }
        // Assistant text is published from verified native history after the turn ends.
        if (method === 'turn/completed') {
          const result = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(params);
          if (result.success && result.data.threadId === chat.threadId && (!turn || turn.id === result.data.turn.id)) {
            active.completedTurn = result.data.turn;
            beginFinish();
          }
        }
      }, beginFinish);
      await connection.initialize(this.version);
      requireThat(await connection.loggedIn(), 'CODEX_LOGIN_REQUIRED', loginMessage, 401);
      requireThat(await connection.hasChatModel(), 'CODEX_MODEL_UNAVAILABLE', modelUnavailableMessage, 503);
      const previous = chat.threadId;
      if (previous) {
        const history = await this.read(connection, previous);
        requireThat(history.status.type !== 'active' && !history.turns.some(item => item.status === 'inProgress'),
          'CODEX_TURN_ACTIVE', '请结束终端中的当前 Codex 回合，再回见岔继续。', 409);
        // The display projection omits entries used when Codex reconstructs
        // model context. Only a recording already verified by Forkwise can
        // resume for inference before G4. Changed recordings remain readable.
        if (!chat.checkpoint || fingerprint(history) !== chat.checkpoint) throw blockedHistory();
        active.messages = nativeMessages(history, chat.rejectedModelTurnId);
        active.previousTurnId = history.turns.at(-1)?.id ?? null;
      }
      const opened = openResult.safeParse(await connection.call(previous ? 'thread/resume' : 'thread/start', {
        ...(previous ? { threadId: previous, excludeTurns: true } : {}),
        cwd: this.cwd, model: codexChatModel,
      }));
      requireThat(opened.success && (!previous || opened.data.thread.id === previous),
        'CODEX_THREAD_UNAVAILABLE', '无法启动或恢复这段原生 Codex 会话。', 503);
      requireThat(opened.data.model === codexChatModel, 'CODEX_MODEL_MISMATCH',
        `见岔只允许 ${codexChatModel}，本轮未发送。`, 503);
      chat.threadId = opened.data.thread.id;
      chat.model = opened.data.model;
      this.save();
      active.question = { id: randomUUID(), role: 'user', text };
      const started = z.object({ turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(
        await connection.call('turn/start', { threadId: chat.threadId, model: codexChatModel, input: [{ type: 'text', text, text_elements: [] }] }),
      );
      requireThat(started.success, 'CODEX_TURN_UNKNOWN', '无法确认发送结果，请重新读取会话后再试。', 503);
      turn = started.data.turn;
      savePendingRejection();
      void this.finish(chat, active, connection, readyToFinish, turn).finally(() => clearTimeout(rerouteDeadline));
      return this.runningDetail(chat, active);
    } catch (error) {
      if (connection) await connection.close();
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
          if (chat.rejectedModelTurnStatus !== status || this.unsavedRejections.has(chat.id)) {
            this.saveModelRejection(chat, started.id, active.previousTurnId, status);
          }
        }
      }
      if (chat.rejectedModelTurnId === started.id) return;
      requireThat(confirmed && thread, 'CODEX_TURN_UNKNOWN', 'Codex 连接已结束。请读取原生会话确认回合结果。', 503);
      chat.model = thread.model ?? chat.model;
      chat.checkpoint = fingerprint(thread);
      // Keep the first verified continuation still in history across later sends and native rollbacks.
      // A delayed rejected turn can appear after it in the recording.
      if (chat.rejectedModelTurnId && confirmed.status === 'completed' &&
          !thread.turns.some(turn => turn.id === chat.verifiedContinuationTurnId) &&
          thread.turns.some(turn => turn.id === started.id && turn.status === 'completed')) {
        chat.verifiedContinuationTurnId = started.id;
      }
      this.save();
      if (confirmed.status !== 'completed') {
        this.errors.set(chat.id, confirmed.status === 'interrupted' ? '此回合已中断。' : '此回合未完成，请检查 Codex、模型和网络后再试。');
      }
    } catch (error) {
      this.errors.set(chat.id, error instanceof DomainError ? error.message : '无法确认原生会话结果，请重新读取。');
    } finally {
      clearTimeout(timer);
      this.running.delete(chat.id);
    }
  }

  async close() {
    this.closing = true;
    await Promise.all([...this.processes].map(connection => connection.close()));
  }
}

export function openAgentChatDirectory(workspaceDirectory: string) {
  return privateDirectory(join(workspaceDirectory, 'agent-chat'));
}
