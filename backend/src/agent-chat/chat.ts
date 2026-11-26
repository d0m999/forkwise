import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { CodexConnection, codexModel, codexProvider } from './codex.js';

const savedChat = z.object({
  id: z.uuid(),
  threadId: z.uuid().nullable(),
  model: z.string().nullable(),
  checkpoint: z.string().nullable(),
});
type SavedChat = z.infer<typeof savedChat>;
type Message = { id: string; role: 'user' | 'assistant'; text: string };
const nativeItem = z.object({ id: z.string(), type: z.string(), text: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() });
const nativeTurn = z.object({ id: z.string(), status: z.string(), items: z.array(nativeItem) });
const nativeThread = z.object({ id: z.uuid(), path: z.string().nullable(), turns: z.array(nativeTurn),
  status: z.object({ type: z.string() }), model: z.string().nullable().optional() });
const threadResult = z.object({ thread: nativeThread });
const openResult = threadResult.extend({ model: z.string(), modelProvider: z.string() });
type NativeThread = z.infer<typeof nativeThread>;

type Turn = { id: string; status: string };
type RunningChat = { messages: Message[] };
const blockedHistory = () => new DomainError(
  'CODEX_HISTORY_UNVERIFIED',
  '原生会话中有见岔无法核实来源的历史。可在此查看，材料外传资格核验前请在终端继续。',
  403,
);
const readError = () => new DomainError('CODEX_HISTORY_UNAVAILABLE', '无法读取这段原生会话，请检查本机 Codex 会话位置。', 503);

function nativeMessages(thread: NativeThread): Message[] {
  const result: Message[] = [];
  for (const turn of thread.turns) {
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
  private readonly processes = new Set<CodexConnection>();
  private readonly file: string;
  private readonly cwd: string;
  private closing = false;

  constructor(directory: string, private readonly version: string, private readonly token: () => Promise<string>) {
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
    renameSync(next, this.file);
  }

  private find(id: string) {
    const chat = this.chats.find(candidate => candidate.id === id);
    requireThat(chat, 'CODEX_CONVERSATION_NOT_FOUND', '找不到这段见岔对话。', 404);
    return chat;
  }

  private summary({ id, threadId, model }: SavedChat) {
    return { id, threadId, model };
  }

  private detail(chat: SavedChat, messages: Message[], busy: boolean, model = chat.model) {
    const codexHome = process.env.CODEX_HOME;
    const resumeCommand = chat.threadId && !busy
      ? `${codexHome ? 'CODEX_HOME=' + terminalQuote(codexHome) + ' ' : ''}codex --no-daemon resume -C ${terminalQuote(this.cwd)} ${terminalQuote(chat.threadId)}`
      : undefined;
    return { ...this.summary(chat), model, messages, busy, resumeCommand, error: this.errors.get(chat.id) };
  }

  list() { return this.chats.map(chat => this.summary(chat)); }

  create() {
    const chat = { id: randomUUID(), threadId: null, model: null, checkpoint: null };
    this.chats.unshift(chat);
    try { this.save(); } catch (error) { this.chats.shift(); throw error; }
    return this.summary(chat);
  }

  private connect(token: string, onEvent: (method: string, params: unknown) => void = () => {}, onClose = () => {}) {
    requireThat(!this.closing, 'CODEX_UNAVAILABLE', '工作台正在关闭。', 503);
    const connection = new CodexConnection(this.cwd, token, onEvent, () => {
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

  async get(id: string) {
    const chat = this.find(id);
    const active = this.running.get(id);
    if (active) return this.detail(chat, active.messages, true);
    if (!chat.threadId) return this.detail(chat, [], false);
    // Native history is a local read. It does not require or use a plan token.
    const connection = this.connect('');
    try {
      await connection.initialize(this.version);
      const thread = await this.read(connection, chat.threadId);
      return this.detail(chat, nativeMessages(thread), thread.status.type === 'active', thread.model ?? chat.model);
    } finally { await connection.close(); }
  }

  async send(id: string, text: string) {
    const chat = this.find(id);
    requireThat(!this.running.has(id), 'CODEX_TURN_ACTIVE', '请等待当前回合结束。', 409);
    const active: RunningChat = { messages: [] };
    this.running.set(id, active);
    this.errors.delete(id);
    let connection: CodexConnection | undefined;
    let turn: Turn | undefined;
    let resolveTerminal: (value: Turn | undefined) => void = () => {};
    const terminal = new Promise<Turn | undefined>(resolve => { resolveTerminal = resolve; });
    try {
      connection = this.connect(await this.token(), (method, params) => {
        if (method === 'turn/completed') {
          const result = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(params);
          if (result.success && result.data.threadId === chat.threadId && (!turn || turn.id === result.data.turn.id)) {
            resolveTerminal(result.data.turn);
          }
        }
        if (method === 'item/agentMessage/delta') {
          const result = z.object({ threadId: z.string(), itemId: z.string(), delta: z.string() }).safeParse(params);
          if (!result.success || result.data.threadId !== chat.threadId) return;
          const { itemId, delta } = result.data;
          const message = active.messages.find(item => item.role === 'assistant' && item.id === itemId);
          if (message) message.text += delta;
          else active.messages.push({ id: itemId, role: 'assistant', text: delta });
        }
      }, () => resolveTerminal(undefined));
      await connection.initialize(this.version);
      const previous = chat.threadId;
      if (previous) {
        const history = await this.read(connection, previous);
        requireThat(history.status.type !== 'active' && !history.turns.some(item => item.status === 'inProgress'),
          'CODEX_TURN_ACTIVE', '请结束终端中的当前 Codex 回合，再回见岔继续。', 409);
        // The display projection omits entries used when Codex reconstructs
        // model context. Only a recording already verified by Forkwise can
        // resume for inference before G4. Changed recordings remain readable.
        if (!chat.checkpoint || fingerprint(history) !== chat.checkpoint) throw blockedHistory();
        active.messages = nativeMessages(history);
      }
      const opened = openResult.safeParse(await connection.call(previous ? 'thread/resume' : 'thread/start', {
        ...(previous ? { threadId: previous, excludeTurns: true } : {}),
        cwd: this.cwd, model: codexModel, modelProvider: codexProvider,
      }));
      requireThat(opened.success && opened.data.modelProvider === codexProvider &&
        (!previous || opened.data.thread.id === previous),
        'CODEX_PROVIDER_MISMATCH', 'Codex 未使用见岔授权的模型服务，未发送问题。', 503);
      chat.threadId = opened.data.thread.id;
      chat.model = opened.data.model;
      this.save();
      active.messages.push({ id: randomUUID(), role: 'user', text });
      const started = z.object({ turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(
        await connection.call('turn/start', { threadId: chat.threadId, input: [{ type: 'text', text, text_elements: [] }] }),
      );
      requireThat(started.success, 'CODEX_TURN_UNKNOWN', '无法确认发送结果，请重新读取会话后再试。', 503);
      turn = started.data.turn;
      void this.finish(chat, connection, terminal, turn);
      return this.detail(chat, active.messages, true);
    } catch (error) {
      if (connection) await connection.close();
      this.running.delete(id);
      throw error;
    }
  }

  private async finish(chat: SavedChat, connection: CodexConnection, terminal: Promise<Turn | undefined>, started: Turn) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([terminal, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 10 * 60 * 1000);
      })]);
      requireThat(result?.id === started.id, 'CODEX_TURN_UNKNOWN', 'Codex 连接已结束。请读取原生会话确认回合结果。', 503);
      const thread = await this.read(connection, chat.threadId!);
      // Let Codex release its native writer before publishing completion.
      await connection.close();
      chat.model = thread.model ?? chat.model;
      chat.checkpoint = fingerprint(thread);
      this.save();
      if (result.status !== 'completed') {
        this.errors.set(chat.id, result.status === 'interrupted' ? '此回合已中断。' : '此回合未完成，请检查 Codex、模型和网络后再试。');
      }
    } catch (error) {
      this.errors.set(chat.id, error instanceof DomainError ? error.message : '无法确认原生会话结果，请重新读取。');
    } finally {
      clearTimeout(timer);
      await connection.close();
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
