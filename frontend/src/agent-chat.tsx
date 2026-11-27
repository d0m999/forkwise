import { useEffect, useRef, useState, type FormEvent } from "react";
import "./agent-chat.css";

type ChatStatus = { loggedIn: boolean; modelAvailable: boolean; message?: string };
type Conversation = { id: string; threadId: string | null; model: string | null };
type Message = { id: string; role: "user" | "assistant"; text: string };
type ConversationDetail = Conversation & { busy: boolean; messages: Message[]; error?: string; resumeCommand?: string };

async function chatRequest<T>(path: string, fallback: string, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/agent-chat${path}`, {
      credentials: "same-origin",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options.body),
      }),
    });
  } catch {
    throw new Error(fallback);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message ?? fallback);
  return result as T;
}

export function AgentChat({ open }: { open: boolean }) {
  const [chatStatus, setChatStatus] = useState<ChatStatus>();
  const [conversations, setConversations] = useState<Conversation[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<ConversationDetail>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [resumeCommandCopied, setResumeCommandCopied] = useState(false);
  const acceptedDrafts = useRef(new Map<string, string>());
  const transcript = useRef<HTMLDivElement>(null);
  const current = detail?.id === selectedId ? detail : undefined;
  const draft = selectedId ? drafts[selectedId] ?? "" : "";
  const lastMessage = current?.messages.at(-1);
  const resumeCommand = current?.resumeCommand;
  const modelAvailable = chatStatus?.modelAvailable === true;

  useEffect(() => {
    if (!open) return;
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") setRefresh(value => value + 1);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [open]);

  useEffect(() => {
    if (!open || pending) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const status = await chatRequest<ChatStatus>("/status", "暂时无法检查 Codex 登录状态。", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setChatStatus(status);
        if (status.loggedIn) {
          const list = await chatRequest<{ conversations: Conversation[] }>("/conversations", "暂时无法读取对话列表。", { signal: controller.signal });
          if (controller.signal.aborted) return;
          setConversations(list.conversations);
          setSelectedId(id => list.conversations.some(conversation => conversation.id === id) ? id : list.conversations[0]?.id);
        }
        setListError("");
      } catch (error) {
        if (!controller.signal.aborted) setListError((error as Error).message);
      }
    })();
    return () => controller.abort();
  }, [open, pending, refresh]);

  const loggedIn = chatStatus?.loggedIn === true;
  useEffect(() => {
    if (!open || !loggedIn || !selectedId || pending) return;
    const controller = new AbortController();
    const path = `/conversations/${encodeURIComponent(selectedId)}`;
    let timeout: number | undefined;
    async function readDetail() {
      try {
        const result = await chatRequest<ConversationDetail>(path, "暂时无法读取对话。", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(result);
        setDetailError("");
        if (result.busy) {
          timeout = window.setTimeout(() => void readDetail(), 1000);
        } else {
          const sent = acceptedDrafts.current.get(result.id);
          acceptedDrafts.current.delete(result.id);
          if (sent && !result.error) setDrafts(values => values[result.id] === sent ? { ...values, [result.id]: "" } : values);
        }
      } catch (error) {
        if (!controller.signal.aborted) setDetailError((error as Error).message);
      }
    }
    void readDetail();
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [open, loggedIn, selectedId, pending, refresh]);

  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [open, selectedId, lastMessage?.id, lastMessage?.text]);

  async function createConversation() {
    setPending(true);
    setActionError("");
    setResumeCommandCopied(false);
    try {
      const created = await chatRequest<Conversation>("/conversations", "暂时无法新建对话。", { body: {} });
      setConversations(list => [created, ...(list ?? [])]);
      setSelectedId(created.id);
      setDetailError("");
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modelAvailable || !current || !draft.trim() || pending || current.busy) return;
    setPending(true);
    setActionError("");
    setResumeCommandCopied(false);
    try {
      const result = await chatRequest<ConversationDetail>(`/conversations/${encodeURIComponent(current.id)}/turns`, "暂时无法发送消息。", { body: { text: draft } });
      setDetail(result);
      setDetailError("");
      if (result.busy) acceptedDrafts.current.set(result.id, draft);
      else if (!result.error) setDrafts(values => ({ ...values, [result.id]: "" }));
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function copyResumeCommand(command: string) {
    setResumeCommandCopied(false);
    setActionError("");
    try {
      await navigator.clipboard.writeText(command);
      setResumeCommandCopied(true);
    } catch {
      setActionError("无法访问剪贴板。请选中终端命令手动复制。");
    }
  }

  return (
    <aside id="agent-chat" className="agent-chat" aria-labelledby="agent-chat-title" hidden={!open}
      onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <header className="agent-chat-header">
        <div>
          <h2 id="agent-chat-title">Codex 对话</h2>
          <p>无项目</p>
        </div>
        <button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>刷新</button>
      </header>
      {listError && <p className="agent-chat-error" role="alert">{listError}</p>}
      {actionError && <p className="agent-chat-error" role="alert">{actionError}</p>}
      {loggedIn ? (
        <>
          {!modelAvailable && <p className="agent-chat-error" role="alert">{chatStatus.message ?? "当前 Codex 账户无法使用 gpt-6-luna。"}</p>}
          <div className="agent-chat-conversations">
            {!!conversations?.length && <select aria-label="对话列表" value={selectedId ?? ""} disabled={pending} onChange={event => {
              setSelectedId(event.target.value);
              setActionError("");
              setDetailError("");
              setResumeCommandCopied(false);
            }}>
              {conversations.map(conversation => <option key={conversation.id} value={conversation.id}>
                {`对话 ${conversation.threadId?.slice(0, 8) ?? conversation.id.slice(0, 8)}`}
              </option>)}
            </select>}
            <button type="button" disabled={pending} onClick={() => void createConversation()}>新建对话</button>
          </div>
          {current?.threadId && <dl className="agent-chat-identity">
            <dt>引擎</dt><dd>Codex</dd>
            <dt>模型</dt><dd>{current.model ?? "未报告"}</dd>
            <dt>原生会话 ID</dt><dd><code>{current.threadId}</code></dd>
          </dl>}
          {detailError && <p className="agent-chat-error" role="alert">{detailError}</p>}
          {current?.error && <p className="agent-chat-error" role="alert">{current.error}</p>}
          <div className="agent-chat-transcript" role="log" aria-label="对话消息" ref={transcript}>
            {!current && !detailError && <p className="agent-chat-muted">{selectedId ? "正在读取对话…" : conversations?.length === 0 ? "新建一段对话开始聊天。" : "正在读取对话列表…"}</p>}
            {current?.messages.map(message => <article key={message.id} className="agent-chat-message" data-role={message.role}>
              <strong>{message.role === "user" ? "你" : "Codex"}</strong>
              <p>{message.text}</p>
            </article>)}
          </div>
          {current?.busy && <p className="agent-chat-muted" role="status">Codex 正在处理当前回合…</p>}
          {current && <form className="agent-chat-compose" onSubmit={event => void send(event)}>
            <label htmlFor="agent-chat-message">消息</label>
            <textarea id="agent-chat-message" rows={3} placeholder="输入合成测试问题" value={draft} readOnly={pending || current.busy}
              onChange={event => { const value = event.target.value; setDrafts(values => ({ ...values, [current.id]: value })); }} />
            <button type="submit" className="agent-chat-primary" disabled={!modelAvailable || pending || current.busy || !draft.trim()}>发送</button>
          </form>}
          {modelAvailable && current && resumeCommand && !current.busy && <details className="agent-chat-resume" key={current.id}>
            <summary>终端续聊</summary>
            <code>{resumeCommand}</code>
            <button type="button" disabled={pending} onClick={() => void copyResumeCommand(resumeCommand)}>复制终端命令</button>
          </details>}
          {modelAvailable && resumeCommandCopied && <p className="agent-chat-muted" role="status">已复制终端命令。</p>}
        </>
      ) : (
        <div className="agent-chat-sign-in">
          {chatStatus ? (
            <p role="status">{chatStatus.message ?? <>请在终端运行 <code>codex login</code>，登录后点击刷新。</>}</p>
          ) : !listError && <p role="status">正在检查 Codex 登录状态…</p>}
        </div>
      )}
    </aside>
  );
}
