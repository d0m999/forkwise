import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  api,
  type Card,
  type Command,
  type Project,
  type ProjectState,
} from "./api";
import "./style.css";

type CardData = {
  card: Card;
  editing: boolean;
  title: string;
  onTitle: (value: string) => void;
  onFinish: () => void;
  onEdit: () => void;
  onBody: () => void;
  onComposition: (value: boolean) => void;
};
function ThoughtCard({ data }: NodeProps<Node<CardData>>) {
  return (
    <article className="thought-card">
      {data.editing ? (
        <textarea
          className="card-title nodrag nowheel"
          aria-label="卡片标题"
          autoFocus
          value={data.title}
          onChange={(e) => data.onTitle(e.target.value)}
          onCompositionStart={() => data.onComposition(true)}
          onCompositionEnd={() => data.onComposition(false)}
          onBlur={data.onFinish}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              data.onFinish();
            }
          }}
        />
      ) : (
        <button className="title-button nodrag" onClick={data.onEdit}>
          {data.card.title || "未命名卡片"}
        </button>
      )}
      {data.card.body.blocks[0]?.text && (
        <p className="preview">{data.card.body.blocks[0].text}</p>
      )}
      <button className="body-button nodrag" onClick={data.onBody}>
        编辑正文
      </button>
    </article>
  );
}
const nodeTypes = { thought: ThoughtCard };
interface Draft {
  projectId: string;
  cardId: string;
  field: "title" | "body";
  value: string;
  generation: number;
  command?: Command;
}
function Workspace() {
  const [dimensions, setDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectState | null>(null);
  const authority = useRef<ProjectState | null>(null);
  const [nav, setNav] = useState(false),
    [pinned, setPinned] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState("");
  const [placing, setPlacing] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [bodyCard, setBodyCard] = useState<string | null>(null);
  const [draftView, setDraftView] = useState<Draft | null>(null),
    draft = useRef<Draft | null>(null);
  const [status, setStatus] = useState("正在打开本机资料…"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const pendingAction = useRef<{
    command: Command;
    onDone?: () => void;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composition = useRef(false),
    generation = useRef(0),
    saving = useRef<Promise<boolean> | null>(null);
  const flow = useReactFlow();
  const updateState = (value: ProjectState) => {
    authority.current = value;
    setState(value);
  };
  const refresh = async (id: string) => {
    const value = await api.project(id);
    updateState(value);
    setProjects(await api.projects());
    return value;
  };
  const select = async (id: string) => {
    if (pendingAction.current) {
      fail(new Error("请先重试未完成的保存"));
      return;
    }
    if (!(await flush())) return;
    setBusy(true);
    try {
      await refresh(id);
      setEditing(null);
      setBodyCard(null);
      setPlacing(false);
      if (!pinned) setNav(false);
      history.replaceState(null, "", "?project=" + encodeURIComponent(id));
      setStatus("已保存到本机");
      setError("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : "本机服务暂时不可用");
    setStatus("保存未完成");
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
    if (composition.current) return false;
    if (saving.current) {
      if (!(await saving.current)) return false;
      return flush();
    }
    const current = draft.current;
    if (!current) return true;
    const card = authority.current?.cards.find((c) => c.id === current.cardId);
    if (!card || authority.current?.project.id !== current.projectId) {
      fail(new Error("草稿对应的卡片尚未加载，请保留输入"));
      return false;
    }
    const original =
      current.field === "title" ? card.title : card.body.blocks[0]!.text;
    if (current.value === original && !current.command) {
      draft.current = null;
      setDraftView(null);
      setStatus("已保存到本机");
      return true;
    }
    // Keep this exact command through a lost response; later typing is a new generation.
    const command: Command =
      current.command ??
      (current.field === "title"
        ? {
            commandId: crypto.randomUUID(),
            projectId: current.projectId,
            type: "thought.title",
            expected: card.versionId,
            payload: { id: card.id, title: current.value },
          }
        : {
            commandId: crypto.randomUUID(),
            projectId: current.projectId,
            type: "body.edit",
            expected: card.body.versionId,
            payload: { id: card.id, text: current.value },
          });
    current.command = command;
    setStatus("正在保存…");
    saving.current = (async () => {
      try {
        await api.execute(command);
        await refresh(current.projectId);
        if (draft.current?.generation === current.generation) {
          draft.current = null;
          setDraftView(null);
          setStatus("已保存到本机");
        } else {
          setStatus("等待保存…");
          timer.current = setTimeout(() => void flush(), 400);
        }
        setError("");
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    return result;
  }
  function scheduleSave() {
    clearTimeout(timer.current);
    if (composition.current) return;
    timer.current = setTimeout(() => void flush(), 400);
    if (!maxTimer.current)
      maxTimer.current = setTimeout(() => void flush(), 2000);
  }
  function compose(value: boolean) {
    composition.current = value;
    if (value) {
      clearTimeout(timer.current);
      clearTimeout(maxTimer.current);
      maxTimer.current = undefined;
    } else scheduleSave();
  }
  function change(field: Draft["field"], card: Card, value: string) {
    if (!state) return;
    const next: Draft = {
      projectId: state.project.id,
      cardId: card.id,
      field,
      value,
      generation: ++generation.current,
    };
    draft.current = next;
    setDraftView(next);
    setStatus("等待保存…");
    scheduleSave();
  }
  async function action(command: Command, onDone?: () => void) {
    if (
      pendingAction.current &&
      pendingAction.current.command.commandId !== command.commandId
    ) {
      fail(new Error("请先重试未完成的保存"));
      return;
    }
    if (!(await flush())) return;
    pendingAction.current = { command, ...(onDone ? { onDone } : {}) };
    setBusy(true);
    setStatus("正在保存…");
    try {
      await api.execute(command);
      await refresh(command.projectId);
      setStatus("已保存到本机");
      setError("");
      pendingAction.current = null;
      onDone?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function createProject() {
    const id = crypto.randomUUID();
    await action(
      {
        commandId: crypto.randomUUID(),
        projectId: id,
        type: "project.create",
        expected: null,
        payload: { name: "未命名研究" },
      },
      () => {
        setBodyCard(null);
        setEditing(null);
        setNav(false);
        history.replaceState(null, "", "?project=" + id);
      },
    );
  }
  async function createCard(x: number, y: number) {
    if (!state) return;
    const id = crypto.randomUUID();
    await action(
      {
        commandId: crypto.randomUUID(),
        projectId: state.project.id,
        type: "thought.create",
        expected: null,
        payload: { id, title: "", text: "", x, y },
      },
      () => {
        setPlacing(false);
        setEditing(id);
      },
    );
  }
  async function editCard(id: string, field: "title" | "body") {
    if (!(await flush())) return;
    setEditing(field === "title" ? id : null);
    if (field === "body") setBodyCard(id);
  }
  useEffect(() => {
    let active = true;
    void api
      .projects()
      .then(async (all) => {
        if (!active) return;
        setProjects(all);
        const id = new URLSearchParams(location.search).get("project");
        const first = all.find((p) => p.id === id) ?? all[0];
        if (first) {
          const value = await api.project(first.id);
          if (active) updateState(value);
        }
        if (active) setStatus("已保存到本机");
      })
      .catch((e) => {
        if (active) fail(e);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draft.current || saving.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      active = false;
      clearTimeout(timer.current);
      clearTimeout(maxTimer.current);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);
  const nodes: Node<CardData>[] = (state?.cards ?? []).map((card) => ({
    id: card.item.id,
    type: "thought",
    initialWidth: 280,
    initialHeight: 160,
    ...(dimensions[card.item.id]
      ? { measured: dimensions[card.item.id]! }
      : {}),
    position: { x: card.item.pose.x, y: card.item.pose.y },
    draggable: false,
    data: {
      card,
      editing: editing === card.id,
      title:
        draftView?.cardId === card.id && draftView.field === "title"
          ? draftView.value
          : card.title,
      onTitle: (value) => change("title", card, value),
      onFinish: () => {
        if (!composition.current) {
          setEditing(null);
          void flush();
        }
      },
      onEdit: () => void editCard(card.id, "title"),
      onBody: () => void editCard(card.id, "body"),
      onComposition: compose,
    },
  }));
  const currentBody = state?.cards.find((c) => c.id === bodyCard);
  return (
    <div className="workspace">
      <header className="topbar">
        <button
          aria-label="项目导航"
          aria-expanded={nav}
          onClick={() => setNav(!nav)}
        >
          见岔
        </button>
        <div className="project-tabs" role="tablist" aria-label="研究项目">
          {projects.map((project) => (
            <button
              role="tab"
              key={project.id}
              aria-selected={project.id === state?.project.id}
              disabled={busy}
              onClick={() => void select(project.id)}
              title={project.id}
            >
              {project.name}
              <small>{project.id.slice(0, 6)}</small>
            </button>
          ))}
        </div>
        <button onClick={() => void createProject()} disabled={busy}>
          新建研究
        </button>
        {state && (
          <button
            aria-label="重命名当前项目"
            disabled={busy}
            onClick={() => {
              setRenaming(state.project.id);
              setName(state.project.name);
            }}
          >
            重命名
          </button>
        )}
      </header>
      {nav && (
        <aside className="project-nav">
          <div className="nav-heading">
            研究项目{" "}
            <button aria-pressed={pinned} onClick={() => setPinned(!pinned)}>
              {pinned ? "取消固定" : "固定"}
            </button>
          </div>
          {projects.map((project) => (
            <button
              key={project.id}
              disabled={busy}
              aria-current={project.id === state?.project.id}
              onClick={() => void select(project.id)}
            >
              {project.name}
              <small>{project.id.slice(0, 6)}</small>
            </button>
          ))}
        </aside>
      )}
      <main className={currentBody ? "canvas with-editor" : "canvas"}>
        {state ? (
          <ReactFlow
            ariaLabelConfig={{
              "controls.ariaLabel": "画布视图",
              "controls.zoomIn.ariaLabel": "放大",
              "controls.zoomOut.ariaLabel": "缩小",
              "controls.fitView.ariaLabel": "适应画布",
            }}
            nodes={nodes}
            onNodesChange={(changes) => {
              const measured = changes.filter(
                (change) => change.type === "dimensions" && change.dimensions,
              );
              if (measured.length)
                setDimensions((previous) => {
                  const next = { ...previous };
                  for (const change of measured)
                    if (change.type === "dimensions" && change.dimensions)
                      next[change.id] = change.dimensions;
                  return next;
                });
            }}
            edges={[]}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onPaneClick={(event) => {
              if (placing && !busy) {
                const point = flow.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                });
                void createCard(point.x, point.y);
              }
            }}
          >
            <Background gap={24} color="#dce0e7" />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="empty">
            <h1>从一个想法开始</h1>
            <p>新建研究，在画布上记下第一张卡片。</p>
          </div>
        )}
        {state && (
          <div className="creation-tools" aria-label="创作工具">
            <button aria-pressed={!placing} onClick={() => setPlacing(false)}>
              选择 / 移动
            </button>
            <button
              aria-pressed={placing}
              disabled={busy}
              onClick={() => setPlacing(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  const rect = event.currentTarget
                    .closest("main")!
                    .getBoundingClientRect();
                  const point = flow.screenToFlowPosition({
                    x: rect.x + rect.width / 2 - 140,
                    y: rect.y + rect.height / 2 - 80,
                  });
                  void createCard(point.x, point.y);
                }
              }}
            >
              卡片
            </button>
            {placing && <span>点击画布放置卡片</span>}
          </div>
        )}
      </main>
      {currentBody && (
        <aside className="body-editor">
          <header>
            <h2>{currentBody.title || "未命名卡片"}</h2>
            <button
              aria-label="关闭正文"
              onClick={() =>
                void flush().then((ok) => {
                  if (ok) setBodyCard(null);
                })
              }
            >
              关闭
            </button>
          </header>
          <label htmlFor="card-body">卡片正文</label>
          <textarea
            id="card-body"
            value={
              draftView?.cardId === currentBody.id && draftView.field === "body"
                ? draftView.value
                : currentBody.body.blocks[0]!.text
            }
            onChange={(e) => change("body", currentBody, e.target.value)}
            onCompositionStart={() => compose(true)}
            onCompositionEnd={() => compose(false)}
            onBlur={() => void flush()}
            placeholder="写下你的想法…"
          />
        </aside>
      )}
      <div className="save-state">
        <span role="status" aria-live="polite">
          {status}
        </span>
        {error && (
          <>
            <span role="alert">{error}</span>
            <button
              disabled={busy}
              onClick={() => {
                const pending = pendingAction.current;
                if (pending) void action(pending.command, pending.onDone);
                else if (draft.current) void flush();
                else location.reload();
              }}
            >
              重试保存
            </button>
          </>
        )}
      </div>
      {renaming && (
        <div className="dialog-shade">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="重命名项目"
            onSubmit={(e) => {
              e.preventDefault();
              if (state && name.trim())
                void action(
                  {
                    commandId: crypto.randomUUID(),
                    projectId: renaming,
                    type: "project.rename",
                    expected: state.project.versionId,
                    payload: { name },
                  },
                  () => setRenaming(null),
                );
            }}
          >
            <h2>重命名项目</h2>
            <label htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              autoFocus
              maxLength={240}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing && e.key === "Enter")
                  e.preventDefault();
                if (e.key === "Escape" && !e.nativeEvent.isComposing)
                  setRenaming(null);
              }}
            />
            <div>
              <button type="button" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button type="submit" disabled={busy || !name.trim()}>
                保存名称
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <Workspace />
  </ReactFlowProvider>,
);
