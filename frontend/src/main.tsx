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
  MappingError,
  authorizeLocalSession,
  type Card,
  type Command,
  type Project,
  type ProjectState,
} from "./api";
import "./style.css";
import {
  DraftRecovery,
  draftAssetIds,
  type Draft,
  type Recovery,
} from "./draft-recovery";
import { usePoseSave } from "./pose-save";

type CardData = {
  card: Card;
  editing: boolean;
  title: string;
  onTitle: (value: string) => void;
  onFinish: () => void;
  onEdit: () => void;
  onBody: () => void;
  onComposition: (value: boolean) => void;
  onMove: (dx: number, dy: number) => void;
  movingDisabled: boolean;
  historyBlocked: boolean;
};
function ThoughtCard({ data }: NodeProps<Node<CardData>>) {
  return (
    <article className="thought-card">
      <button
        className="move-handle nodrag"
        aria-label="移动卡片：方向键调整位置"
        disabled={data.movingDisabled}
        onKeyDown={(event) => {
          const delta = {
            ArrowLeft: [-10, 0],
            ArrowRight: [10, 0],
            ArrowUp: [0, -10],
            ArrowDown: [0, 10],
          }[event.key];
          if (delta) {
            event.preventDefault();
            event.stopPropagation();
            data.onMove(delta[0]!, delta[1]!);
          }
        }}
      >
        移动
      </button>
      {data.editing ? (
        <textarea
          className="card-title nodrag nowheel"
          aria-label="卡片标题"
          autoFocus
          readOnly={data.historyBlocked}
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
        <button
          className="title-button nodrag"
          disabled={data.historyBlocked}
          onClick={data.onEdit}
        >
          {data.title || "未命名卡片"}
        </button>
      )}
      {data.card.body.blocks[0]?.text && (
        <p className="preview">{data.card.body.blocks[0].text}</p>
      )}
      <button
        className="body-button nodrag"
        disabled={data.historyBlocked}
        onClick={data.onBody}
      >
        编辑正文
      </button>
    </article>
  );
}
const nodeTypes = { thought: ThoughtCard };
function draftKey(projectId: string, cardId: string, field: Draft["field"]) {
  return JSON.stringify([projectId, cardId, field]);
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
  const bodyBinding = useRef<{
    projectId: string;
    card: Card;
    removalActionId?: string;
  } | null>(null);
  const [deletedBody, setDeletedBody] = useState<{
    projectId: string;
    card: Card;
    actionId?: string;
    canRestore: boolean;
  } | null>(null);
  const [draftView, setDraftView] = useState<Record<string, Draft>>({}),
    drafts = useRef<Record<string, Draft>>({});
  const unconfirmed = useRef<Draft | null>(null);
  const recovery = useRef<DraftRecovery | null>(null);
  const recoveryTask = useRef(0),
    editorEpoch = useRef(0);
  const [recoveries, setRecoveries] = useState<
    { key: string; value: Recovery }[]
  >([]);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [deletedRecovery, setDeletedRecovery] = useState<{
    projectId: string;
    cardId: string;
    actionId?: string;
  } | null>(null);
  function persistDrafts() {
    try {
      recovery.current ??= new DraftRecovery();
      recovery.current.write(
        Object.values(drafts.current),
        closedDrafts.current,
        unconfirmed.current,
      );
      setRecoveryError("");
      return true;
    } catch {
      setRecoveryError(
        "恢复区写入失败，请保留当前页面并重试；未确认输入可能无法在重开后恢复",
      );
      return false;
    }
  }
  function scanRecovery() {
    try {
      recovery.current ??= new DraftRecovery();
      setRecoveries(recovery.current.list());
      if (recovery.current.damaged)
        setRecoveryError("部分恢复记录损坏，原件已保留；其他草稿仍可恢复");
    } catch {
      setRecoveryError("恢复区无法读取，原始草稿已保留");
    }
  }
  async function restoreDraft(entry: { key: string; value: Recovery }) {
    if (historyBlocked || composition.current) return;
    const saved = entry.value;
    const task = ++recoveryTask.current;
    setRecoveryNotice("");
    const epoch = editorEpoch.current,
      inputGeneration = generation.current;
    const projectId = authority.current?.project.id;
    const boundCardId = bodyBinding.current?.card.id;
    // Authorization to recover is tied to this task and the editor state at
    // the click, including edits that have already received an ACK by readback.
    const stillCurrent = () => {
      if (task !== recoveryTask.current) return false;
      if (
        epoch === editorEpoch.current &&
        inputGeneration === generation.current &&
        authority.current?.project.id === projectId &&
        projectId === saved.projectId &&
        bodyBinding.current?.card.id === boundCardId &&
        !composition.current &&
        !historyLock.current &&
        !historyCommand.current &&
        !pendingAction.current
      )
        return true;
      setRecoveryNotice(
        "恢复检查期间内容或编辑对象已变化，原草稿仍保留，请重新选择恢复",
      );
      return false;
    };
    try {
      if (!(await flush()) || !stillCurrent()) return;
      const identity = await api.cardIdentity(saved.projectId, saved.cardId);
      if (!stillCurrent()) return;
      if (identity.availability === "not_found")
        throw new Error("草稿身份不属于此项目，原件已保留");
      const latest = await api.project(saved.projectId);
      if (!stillCurrent()) return;
      const card = latest.cards.find((c) => c.id === saved.cardId);
      if (!card) {
        const timeline = await api.history(saved.projectId);
        if (!stillCurrent()) return;
        const target = timeline.redo.at(-1);
        setDeletedRecovery({
          projectId: saved.projectId,
          cardId: saved.cardId,
          ...(target?.target.id === saved.cardId &&
          target.label === "thought.create"
            ? { actionId: target.id }
            : {}),
        });
        setRecoveryError("这张卡片已删除，恢复草稿已保留，不能自动复活");
        return;
      }
      if (authority.current?.project.id !== saved.projectId) return;
      updateState(latest);
      breakBodyGroup();
      for (const draft of [
        ...saved.closed,
        ...saved.drafts,
        ...(saved.pending ? [saved.pending] : []),
      ])
        generation.current = Math.max(generation.current, draft.generation);
      for (const draft of saved.drafts)
        drafts.current[draftKey(draft.projectId, draft.cardId, draft.field)] =
          draft;
      closedDrafts.current.push(...saved.closed);
      unconfirmed.current = saved.pending;
      // Transfer ownership only after the full journal is durable at its new key.
      if (!persistDrafts()) return;
      recovery.current!.remove(entry.key);
      scanRecovery();
      setDraftView({ ...drafts.current });
      bodyBinding.current = { projectId: saved.projectId, card };
      setBodyCard(card.id);
      setDeletedBody(null);
      await flush();
    } catch (e) {
      if (stillCurrent()) fail(e);
    }
  }
  const closedDrafts = useRef<Draft[]>([]);
  const bodyGroup = useRef<{
    id: string;
    cardId: string;
    at: number;
    inputType: string;
    start: number;
    end: number;
  } | null>(null);
  function breakBodyGroup() {
    // Focus changes must not split an unfinished IME unit into saved fragments.
    if (composition.current) return;
    const group = bodyGroup.current;
    if (group) {
      const draft = Object.values(drafts.current).find(
        (d) =>
          d.field === "body" &&
          d.cardId === group.cardId &&
          d.editGroup === group.id,
      );
      if (
        draft &&
        !draft.rejected &&
        draft.generation !== unconfirmed.current?.generation &&
        !closedDrafts.current.some((d) => d.generation === draft.generation)
      )
        closedDrafts.current.push(draft);
    }
    bodyGroup.current = null;
  }
  useEffect(() => {
    const beforeInput = (event: Event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.id !== "card-body"
      )
        return;
      const input = event as InputEvent;
      if (
        !input.isComposing &&
        /^(format|insertFromPaste|insertFromDrop)/.test(input.inputType)
      )
        breakBodyGroup();
    };
    document.addEventListener("beforeinput", beforeInput, true);
    return () => document.removeEventListener("beforeinput", beforeInput, true);
  });
  const conflictRef = useRef<{ draft: Draft; remote: Card } | null>(null);
  const [conflict, setConflict] = useState<{
    draft: Draft;
    remote: Card;
  } | null>(null);
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
    compositionPrefixCutoff = useRef(0),
    generation = useRef(0),
    saving = useRef<Promise<boolean> | null>(null);
  const layoutBarrier = useRef<{ cutoff: number } | null>(null);
  const flow = useReactFlow();
  const titleGroup = useRef<{ cardId: string; id: string } | null>(null);
  const historyLock = useRef(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const historyCommand = useRef<Extract<
    Command,
    { type: "history.undo" | "history.redo" }
  > | null>(null);
  const historyActionId = useRef<string | null>(null);
  const historyBlocked = historyBusy || !!historyCommand.current;
  async function travel(
    direction: "undo" | "redo" | "retry",
    restoreActionId?: string,
  ) {
    if (
      historyLock.current ||
      composition.current ||
      busy ||
      pendingAction.current ||
      // Unknown results can only resume through the explicit retry action.
      (historyCommand.current ? direction !== "retry" : direction === "retry")
    )
      return;
    editorEpoch.current++;
    historyLock.current = true;
    setHistoryBusy(true);
    try {
      breakBodyGroup();
      if (!(await pose.flush()) || !(await flush())) return;
      setEditing(null);
      titleGroup.current = null;
      const projectId = authority.current?.project.id;
      if (!projectId) return;
      if (!historyCommand.current && direction !== "retry") {
        const timeline = await api.history(projectId);
        const target = (
          direction === "undo" ? timeline.undo : timeline.redo
        ).at(-1);
        if (restoreActionId && target?.id !== restoreActionId) {
          setDeletedBody((previous) =>
            previous ? { ...previous, canRestore: false } : previous,
          );
          setHistoryNotice("这次删除的恢复已不可用");
          return;
        }
        historyActionId.current = target?.id ?? null;
        // The same revision checked by execute binds this request to the exact
        // action inspected above. A racing write rejects the whole travel.
        historyCommand.current = {
          commandId: crypto.randomUUID(),
          projectId,
          type: direction === "undo" ? "history.undo" : "history.redo",
          expected: timeline.revision,
          payload: {},
        };
      }
      const command = historyCommand.current;
      if (!command) return;
      const receipt = await api.execute(command);
      const binding = bodyBinding.current;
      if (
        binding?.projectId === projectId &&
        receipt.deletedIds?.includes(binding.card.id) &&
        historyActionId.current
      )
        binding.removalActionId = historyActionId.current;
      await refresh(projectId);
      historyCommand.current = null;
      historyActionId.current = null;
      setHistoryNotice(
        `${command.type === "history.undo" ? "已撤销" : "已重做"}：${receipt.historyTarget?.title || "未命名卡片"}`,
      );
      setStatus("已保存到本机");
      setError("");
    } catch (e) {
      if (
        e instanceof MappingError &&
        ["VERSION_CONFLICT", "HISTORY_EMPTY"].includes(e.code)
      ) {
        const projectId = historyCommand.current?.projectId;
        historyCommand.current = null;
        historyActionId.current = null;
        setDeletedBody((previous) =>
          previous ? { ...previous, canRestore: false } : previous,
        );
        if (projectId) {
          try {
            await refresh(projectId);
          } catch {
            /* Keep the bound panel; recovery remains unconfirmed. */
          }
        }
      }
      fail(e);
    } finally {
      historyLock.current = false;
      setHistoryBusy(false);
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        !["z", "y"].includes(event.key.toLowerCase())
      )
        return;
      if (event.isComposing || event.keyCode === 229 || composition.current)
        return;
      const target = event.target as HTMLElement;
      // Title editing retains the browser text undo route until the round ends.
      if (target.closest("input, .card-title, [contenteditable=true]")) return;
      event.preventDefault();
      event.stopPropagation();
      void travel(
        event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo",
      );
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });
  const updateState = (
    value: ProjectState,
    timeline?: Awaited<ReturnType<typeof api.history>>,
  ) => {
    const current = authority.current;
    // Concurrent action/save readbacks may arrive out of order. Never replace
    // an acknowledged project revision with an older snapshot.
    if (
      current?.project.id === value.project.id &&
      value.project.revision < current.project.revision
    )
      return;
    const binding = bodyBinding.current;
    if (binding?.projectId === value.project.id) {
      const card = value.cards.find((c) => c.id === binding.card.id);
      if (card) {
        binding.card = card;
        delete binding.removalActionId;
        setDeletedBody(null);
      } else {
        setDeletedBody({
          projectId: binding.projectId,
          card: binding.card,
          ...(binding.removalActionId
            ? { actionId: binding.removalActionId }
            : {}),
          canRestore:
            !!binding.removalActionId &&
            timeline?.redo.at(-1)?.id === binding.removalActionId,
        });
      }
    }
    authority.current = value;
    setState(value);
  };
  const refresh = async (id: string) => {
    const value = await api.project(id);
    const timeline = await api.history(id);
    updateState(value, timeline);
    setProjects(await api.projects());
    return value;
  };
  const pose = usePoseSave(refresh);
  function startMove(projectId: string, card: Card) {
    // Geometry remains interactive while the prefix of input waits for ACK.
    // Reserve this boundary so later typing cannot overtake the move either.
    breakBodyGroup();
    const barrier = {
      cutoff: composition.current
        ? compositionPrefixCutoff.current
        : generation.current,
    };
    if (
      !pose.start(projectId, card, {
        beforeSubmit: async () =>
          (await drainCompletedPrefix(barrier.cutoff)) !== "unknown",
        afterAttempt: () => {
          if (layoutBarrier.current === barrier) layoutBarrier.current = null;
          void flush();
        },
      })
    )
      return false;
    layoutBarrier.current = barrier;
    return true;
  }
  const handoff = async (id: string) => {
    const value = await api.project(id);
    const all = await api.projects();
    // Keep the old project's authority while the destination is loading: the
    // visible editors may still accept input during those requests.
    if (!(await pose.flush()) || !(await flush())) return false;
    updateState(value);
    setProjects(all);
    return true;
  };
  const select = async (id: string) => {
    if (historyLock.current || historyCommand.current) return;
    if (pendingAction.current) {
      fail(new Error("请先重试未完成的保存"));
      return;
    }
    editorEpoch.current++;
    breakBodyGroup();
    if (!(await pose.flush()) || !(await flush())) return;
    if (id === authority.current?.project.id) return;
    setBusy(true);
    try {
      if (!(await handoff(id))) return;
      setEditing(null);
      bodyBinding.current = null;
      setDeletedBody(null);
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
  async function drainCompletedPrefix(
    cutoff: number,
  ): Promise<"drained" | "explicitConflict" | "unknown"> {
    if (await flush(cutoff, true)) return "drained";
    // A confirmed conflict preserves both bodies for an explicit later choice.
    // An unknown response still needs recovery with the original command ID.
    return conflictRef.current ? "explicitConflict" : "unknown";
  }
  async function flush(
    limit = Infinity,
    completedPrefix = false,
  ): Promise<boolean> {
    limit = Math.min(limit, layoutBarrier.current?.cutoff ?? Infinity);
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
    if ((!completedPrefix && composition.current) || conflictRef.current)
      return false;
    if (saving.current) {
      if (!(await saving.current)) return false;
      return flush(limit, completedPrefix);
    }
    const current =
      unconfirmed.current ??
      closedDrafts.current[0] ??
      Object.values(drafts.current)[0];
    if (!current || current.generation > limit) return true;
    const key = draftKey(current.projectId, current.cardId, current.field);
    const card = authority.current?.cards.find((c) => c.id === current.cardId);
    if (!card || authority.current?.project.id !== current.projectId) {
      fail(new Error("草稿对应的卡片尚未加载，请保留输入"));
      return false;
    }
    // Only execute can decide a no-op against current.expected. The displayed
    // authority can predate the remote version explicitly chosen after a conflict.
    // Keep this exact command through a lost response; later typing is a new generation.
    const command: Command =
      current.command ??
      (current.field === "title"
        ? {
            commandId: crypto.randomUUID(),
            projectId: current.projectId,
            type: "thought.title",
            ...(current.editGroup ? { editGroup: current.editGroup } : {}),
            expected: current.expected,
            payload: { id: card.id, title: current.value },
          }
        : {
            commandId: crypto.randomUUID(),
            projectId: current.projectId,
            type: "body.edit",
            ...(current.editGroup ? { editGroup: current.editGroup } : {}),
            expected: current.expected,
            payload: {
              id: card.id,
              text: current.value,
              ...(draftAssetIds(current)
                ? { requiredAssetIds: draftAssetIds(current)! }
                : {}),
            },
          });
    current.command = command;
    unconfirmed.current = current;
    persistDrafts();
    setStatus("正在保存…");
    saving.current = (async () => {
      try {
        const receipt = await api.execute(command);
        await refresh(current.projectId);
        for (const newer of [
          ...closedDrafts.current,
          ...Object.values(drafts.current),
        ]) {
          if (
            newer.cardId === current.cardId &&
            newer.field === current.field &&
            newer.generation !== current.generation &&
            // A no-op confirms current.expected; a later readback may belong
            // to another writer and cannot rebase this unsaved generation.
            newer.expected === current.expected
          ) {
            // A no-op confirms current.expected; a later readback may belong
            // to another writer and cannot rebase this unsaved generation.
            newer.expected =
              (current.field === "title"
                ? receipt.versions?.thought
                : receipt.versions?.body) ?? current.expected;
          }
        }
        closedDrafts.current = closedDrafts.current.filter(
          (d) => d.generation !== current.generation,
        );
        unconfirmed.current = null;
        if (drafts.current[key]?.generation === current.generation)
          delete drafts.current[key];
        persistDrafts();
        setDraftView({ ...drafts.current });
        setStatus(
          Object.keys(drafts.current).length ? "等待保存…" : "已保存到本机",
        );
        setError("");
        return true;
      } catch (e) {
        if (
          e instanceof MappingError &&
          ["INVALID_COMMAND", "TOO_LARGE", "MEDIA_NOT_PERSISTED"].includes(
            e.code,
          )
        ) {
          // These replies explicitly reject before mutation. A corrected draft
          // may use a new request; transport failures must retain the old one.
          current.rejected = true;
          // A media refusal does not remove the draft's referenced resources.
          // Without an edit, retry the same request with its full requirements.
          if (e.code !== "MEDIA_NOT_PERSISTED") delete current.command;
          unconfirmed.current = null;
          closedDrafts.current = closedDrafts.current.filter(
            (d) => d.generation !== current.generation,
          );
          persistDrafts();
        }
        if (e instanceof MappingError && e.code === "VERSION_CONFLICT") {
          try {
            const latest = await api.project(current.projectId);
            const remote = latest.cards.find((c) => c.id === current.cardId);
            if (remote) {
              conflictRef.current = { draft: current, remote };
              setConflict(conflictRef.current);
            }
          } catch {
            /* Keep the original draft/command available for retry. */
          }
        }
        fail(e);
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    // A completed command only confirms its own generation. Drain newer input
    // before allowing a project switch or any other editor handoff.
    return result ? flush(limit, completedPrefix) : false;
  }
  function scheduleSave() {
    clearTimeout(timer.current);
    if (composition.current) return;
    timer.current = setTimeout(() => void flush(), 400);
    if (!maxTimer.current)
      maxTimer.current = setTimeout(() => void flush(), 2000);
  }
  function compose(value: boolean) {
    editorEpoch.current++;
    if (value) {
      breakBodyGroup();
      compositionPrefixCutoff.current = generation.current;
    }
    composition.current = value;
    if (value) {
      clearTimeout(timer.current);
      clearTimeout(maxTimer.current);
      maxTimer.current = undefined;
    } else scheduleSave();
  }
  function change(
    field: Draft["field"],
    card: Card,
    value: string,
    input?: { inputType: string; start: number; end: number },
  ) {
    if (!state || historyLock.current || historyCommand.current) return;
    if (field === "body") {
      const type = composition.current
        ? "composition"
        : input?.inputType || "insertText";
      const group = bodyGroup.current;
      if (
        !group ||
        group.cardId !== card.id ||
        (!composition.current &&
          (Date.now() - group.at > 1000 ||
            group.inputType !== type ||
            type === "insertFromPaste"))
      ) {
        breakBodyGroup();
        bodyGroup.current = {
          id: crypto.randomUUID(),
          cardId: card.id,
          at: Date.now(),
          inputType: type,
          start: input?.start ?? 0,
          end: input?.end ?? 0,
        };
      } else
        Object.assign(group, {
          at: Date.now(),
          start: input?.start ?? 0,
          end: input?.end ?? 0,
        });
    }
    const previous =
      drafts.current[draftKey(state.project.id, card.id, field)] ??
      (unconfirmed.current?.projectId === state.project.id &&
      unconfirmed.current.cardId === card.id &&
      unconfirmed.current.field === field
        ? unconfirmed.current
        : undefined);
    const requiredAssetIds = previous ? draftAssetIds(previous) : undefined;
    const next: Draft = {
      projectId: state.project.id,
      cardId: card.id,
      field,
      value,
      generation: ++generation.current,
      ...(requiredAssetIds ? { requiredAssetIds } : {}),
      ...(field === "title" && titleGroup.current?.cardId === card.id
        ? { editGroup: titleGroup.current.id }
        : field === "body" && bodyGroup.current
          ? { editGroup: bodyGroup.current.id }
          : {}),
      expected:
        drafts.current[draftKey(state.project.id, card.id, field)]?.expected ??
        (unconfirmed.current?.cardId === card.id &&
        unconfirmed.current.field === field
          ? unconfirmed.current.expected
          : field === "title"
            ? card.versionId
            : card.body.versionId),
    };
    drafts.current[draftKey(next.projectId, card.id, field)] = next;
    persistDrafts();
    setDraftView({ ...drafts.current });
    setStatus("等待保存…");
    scheduleSave();
  }
  const resolving = useRef(false);
  async function resolveConflict(choice: "mine" | "remote" = "mine") {
    const current = conflictRef.current;
    if (!current || resolving.current || composition.current) return;
    resolving.current = true;
    try {
      const { draft, remote } = current;
      const key = draftKey(draft.projectId, draft.cardId, draft.field);
      const readback = await api.project(draft.projectId);
      const checked = readback.cards.find((c) => c.id === draft.cardId);
      if (!checked) {
        updateState(readback);
        throw new Error("这张卡片已删除，冲突草稿已保留");
      }
      const version = (card: Card) =>
        draft.field === "title" ? card.versionId : card.body.versionId;
      if (version(checked) !== version(remote)) {
        conflictRef.current = { draft, remote: checked };
        setConflict(conflictRef.current);
        throw new Error("已保存内容再次更新，请比较后重新选择");
      }
      const latest = drafts.current[key] ?? draft;
      const remoteValue =
        draft.field === "title" ? remote.title : remote.body.blocks[0]!.text;
      recovery.current ??= new DraftRecovery();
      // A choice may discard many local groups. Preserve the complete alternative
      // before changing any draft or issuing a version-checked write.
      recovery.current.archive({
        projectId: draft.projectId,
        cardId: draft.cardId,
        field: draft.field,
        value: choice === "mine" ? remoteValue : latest.value,
        expected: version(remote),
        generation: ++generation.current,
        ...(choice === "remote" && draftAssetIds(latest)
          ? { requiredAssetIds: draftAssetIds(latest)! }
          : {}),
      });
      const next: Draft = {
        projectId: draft.projectId,
        cardId: draft.cardId,
        field: draft.field,
        value: choice === "mine" ? latest.value : remoteValue,
        generation: ++generation.current,
        expected: version(remote),
        ...(choice === "mine" && draftAssetIds(latest)
          ? { requiredAssetIds: draftAssetIds(latest)! }
          : {}),
      };
      closedDrafts.current = closedDrafts.current.filter(
        (d) => draftKey(d.projectId, d.cardId, d.field) !== key,
      );
      if (draft.field === "body" && bodyGroup.current?.cardId === draft.cardId)
        bodyGroup.current = null;
      drafts.current[key] = next;
      unconfirmed.current = null;
      conflictRef.current = null;
      setConflict(null);
      persistDrafts();
      scanRecovery();
      setDraftView({ ...drafts.current });
      if (await flush()) {
        if (layoutBarrier.current) void pose.flush();
      }
    } catch (e) {
      fail(e);
    } finally {
      resolving.current = false;
    }
  }
  async function action(command: Command, onDone?: () => void) {
    if (historyLock.current || historyCommand.current) return;
    if (
      pendingAction.current &&
      pendingAction.current.command.commandId !== command.commandId
    ) {
      fail(new Error("请先重试未完成的保存"));
      return;
    }
    editorEpoch.current++;
    breakBodyGroup();
    if (!(await pose.flush()) || !(await flush())) return;
    pendingAction.current = { command, ...(onDone ? { onDone } : {}) };
    setBusy(true);
    setStatus("正在保存…");
    try {
      await api.execute(command);
      if (command.projectId !== authority.current?.project.id) {
        if (!(await handoff(command.projectId))) return;
      } else {
        await refresh(command.projectId);
        if (!(await flush())) return;
      }
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
        bodyBinding.current = null;
        setDeletedBody(null);
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
    const editGroup = crypto.randomUUID();
    await action(
      {
        commandId: crypto.randomUUID(),
        projectId: state.project.id,
        editGroup,
        type: "thought.create",
        expected: null,
        payload: { id, title: "", text: "", x, y },
      },
      () => {
        setPlacing(false);
        titleGroup.current = { cardId: id, id: editGroup };
        setEditing(id);
      },
    );
  }
  async function editCard(id: string, field: "title" | "body") {
    if (historyLock.current || historyCommand.current) return;
    if (composition.current) return;
    editorEpoch.current++;
    breakBodyGroup();
    await flush();
    // A failed save belongs to the old card; switching the visible editor
    // never changes that draft's target or its pending command.
    titleGroup.current =
      field === "title" ? { cardId: id, id: crypto.randomUUID() } : null;
    setEditing(field === "title" ? id : null);
    if (field === "body") {
      const card = authority.current?.cards.find((c) => c.id === id);
      if (!card || !authority.current) return;
      bodyBinding.current = { projectId: authority.current.project.id, card };
      setDeletedBody(null);
      setBodyCard(id);
    }
  }
  useEffect(() => {
    let active = true;
    void authorizeLocalSession()
      .then(() => api.projects())
      .then(async (all) => {
        if (!active) return;
        setProjects(all);
        const id = new URLSearchParams(location.search).get("project");
        const first = all.find((p) => p.id === id) ?? all[0];
        if (first) {
          const value = await api.project(first.id);
          if (active) updateState(value);
        }
        if (active) {
          scanRecovery();
          setStatus("已保存到本机");
        }
      })
      .catch((e) => {
        if (active) fail(e);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        Object.keys(drafts.current).length ||
        saving.current ||
        pose.hasPending()
      ) {
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
    position: pose.positions[card.item.id] ?? {
      x: card.item.pose.x,
      y: card.item.pose.y,
    },
    draggable: !busy && !historyBlocked && !pose.pending,
    data: {
      card,
      editing: editing === card.id,
      title:
        draftView[draftKey(state!.project.id, card.id, "title")]?.value ??
        card.title,
      onTitle: (value) => change("title", card, value),
      onFinish: () => {
        if (!composition.current) {
          editorEpoch.current++;
          setEditing(null);
          titleGroup.current = null;
          void flush();
        }
      },
      onEdit: () => void editCard(card.id, "title"),
      onBody: () => void editCard(card.id, "body"),
      onComposition: compose,
      movingDisabled: busy || historyBlocked || pose.pending,
      historyBlocked,
      onMove: (dx, dy) => {
        if (startMove(state!.project.id, card))
          pose.finish({ x: card.item.pose.x + dx, y: card.item.pose.y + dy });
      },
    },
  }));
  const currentBody = state?.cards.find((c) => c.id === bodyCard);
  const panelCard =
    currentBody ??
    (deletedBody &&
    deletedBody.projectId === state?.project.id &&
    deletedBody.card.id === bodyCard
      ? deletedBody.card
      : undefined);
  return (
    <div className="workspace">
      <header className="topbar">
        <button
          disabled={!state || busy || historyBlocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void travel("undo")}
        >
          撤销
        </button>
        <button
          disabled={!state || busy || historyBlocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void travel("redo")}
        >
          重做
        </button>
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
              disabled={busy || historyBlocked}
              onClick={() => void select(project.id)}
              title={project.id}
            >
              {project.name}
              <small>{project.id.slice(0, 6)}</small>
            </button>
          ))}
        </div>
        <button
          onClick={() => void createProject()}
          disabled={busy || historyBlocked}
        >
          新建研究
        </button>
        {state && (
          <button
            aria-label="重命名当前项目"
            disabled={busy || historyBlocked}
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
              disabled={busy || historyBlocked}
              aria-current={project.id === state?.project.id}
              onClick={() => void select(project.id)}
            >
              {project.name}
              <small>{project.id.slice(0, 6)}</small>
            </button>
          ))}
        </aside>
      )}
      <main className={panelCard ? "canvas with-editor" : "canvas"}>
        {state ? (
          <ReactFlow
            ariaLabelConfig={{
              "controls.ariaLabel": "画布视图",
              "controls.zoomIn.ariaLabel": "放大",
              "controls.zoomOut.ariaLabel": "缩小",
              "controls.fitView.ariaLabel": "适应画布",
            }}
            nodes={nodes}
            onNodeDragStart={(_, node) => {
              const card = authority.current?.cards.find(
                (c) => c.item.id === node.id,
              );
              if (card) startMove(authority.current!.project.id, card);
            }}
            onNodeDragStop={(_, node) => pose.finish(node.position)}
            onNodesChange={(changes) => {
              for (const change of changes)
                if (change.type === "position" && change.position)
                  pose.preview(change.id, change.position);
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
            nodesDraggable
            nodesFocusable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onPaneClick={(event) => {
              if (placing && !busy && !historyBlocked) {
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
              disabled={busy || historyBlocked}
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
      {panelCard && (
        <aside className="body-editor">
          <header>
            <h2>
              {(draftView[draftKey(state!.project.id, panelCard.id, "title")]
                ?.value ??
                panelCard.title) ||
                "未命名卡片"}
            </h2>
            <button
              aria-label="关闭正文"
              onClick={() => {
                if (composition.current) return;
                editorEpoch.current++;
                breakBodyGroup();
                persistDrafts();
                void flush();
                bodyBinding.current = null;
                setDeletedBody(null);
                setBodyCard(null);
              }}
            >
              关闭
            </button>
          </header>
          {!currentBody ? (
            <section className="deleted-body" aria-label="已删除卡片">
              <p>这张卡片已删除</p>
              <button
                disabled={historyBlocked || !deletedBody?.canRestore}
                onClick={() => {
                  const actionId = deletedBody?.actionId;
                  if (actionId) void travel("redo", actionId);
                }}
              >
                撤销删除
              </button>
              {!deletedBody?.canRestore && <p>这次删除的恢复已不可用</p>}
            </section>
          ) : (
            <>
              <label htmlFor="card-body">卡片正文</label>
              <textarea
                id="card-body"
                readOnly={historyBlocked}
                value={
                  draftView[draftKey(state!.project.id, currentBody.id, "body")]
                    ?.value ?? currentBody.body.blocks[0]!.text
                }
                onChange={(e) =>
                  change("body", currentBody, e.target.value, {
                    inputType: (e.nativeEvent as InputEvent).inputType,
                    start: e.target.selectionStart,
                    end: e.target.selectionEnd,
                  })
                }
                onSelect={(e) => {
                  const group = bodyGroup.current;
                  if (
                    !composition.current &&
                    group &&
                    (e.currentTarget.selectionStart !== group.start ||
                      e.currentTarget.selectionEnd !== group.end)
                  )
                    breakBodyGroup();
                }}
                onCompositionStart={() => compose(true)}
                onCompositionEnd={() => compose(false)}
                onBlur={() => {
                  breakBodyGroup();
                  void flush();
                }}
                placeholder="写下你的想法…"
              />
            </>
          )}
        </aside>
      )}
      {pose.conflict && !conflict && (
        <section className="conflict-panel" aria-label="布局冲突">
          <h2>布局已由其他调用者更新</h2>
          <p>
            已保存位置：{pose.conflict.pose.x}, {pose.conflict.pose.y}
          </p>
          <p>画布保留你本次移动的位置，确认后保存；对方版本保留在历史中。</p>
          <button onClick={pose.resolveConflict}>确认保留本次位置</button>
        </section>
      )}
      {conflict && (
        <section className="conflict-panel" aria-label="保存冲突">
          <h2>
            {conflict.draft.field === "body" ? "正文" : "标题"}
            已由其他调用者更新
          </h2>
          <p>
            比较两份内容并明确选择。选择生效前，会先将另一份保存为可恢复副本。
          </p>
          <label>
            已保存的{conflict.draft.field === "body" ? "正文" : "标题"}
            <textarea
              readOnly
              value={
                conflict.draft.field === "body"
                  ? conflict.remote.body.blocks[0]!.text
                  : conflict.remote.title
              }
            />
          </label>
          <label>
            我的{conflict.draft.field === "body" ? "正文" : "标题"}
            <textarea
              readOnly
              value={
                draftView[
                  draftKey(
                    conflict.draft.projectId,
                    conflict.draft.cardId,
                    conflict.draft.field,
                  )
                ]?.value ?? conflict.draft.value
              }
            />
          </label>
          <button onClick={() => void resolveConflict("mine")}>
            确认保留我的{conflict.draft.field === "body" ? "正文" : "标题"}
          </button>
          <button onClick={() => void resolveConflict("remote")}>
            确认保留已保存的{conflict.draft.field === "body" ? "正文" : "标题"}
          </button>
        </section>
      )}
      {recoveries.some((r) => r.value.projectId === state?.project.id) && (
        <section className="recovery-panel" aria-label="草稿恢复">
          <h2>可恢复草稿</h2>
          {recoveries
            .filter((r) => r.value.projectId === state?.project.id)
            .map((entry) => (
              <article key={entry.key}>
                <p>
                  {state?.cards.find((c) => c.id === entry.value.cardId)
                    ?.title || "原卡片"}
                </p>
                <pre>{entry.value.drafts.map((d) => d.value).join("\n")}</pre>
                <button onClick={() => void restoreDraft(entry)}>
                  恢复草稿
                </button>
              </article>
            ))}
        </section>
      )}
      {deletedRecovery?.projectId === state?.project.id &&
        !state?.cards.some((c) => c.id === deletedRecovery?.cardId) && (
          <aside className="body-editor" aria-label="已删除卡片">
            <h2>这张卡片已删除</h2>
            <p>原草稿仍保留在恢复区。</p>
            <button
              disabled={historyBlocked || !deletedRecovery?.actionId}
              onClick={() => {
                if (deletedRecovery?.actionId)
                  void travel("redo", deletedRecovery.actionId);
              }}
            >
              撤销删除
            </button>
            {!deletedRecovery?.actionId && <p>这次删除的恢复已不可用</p>}
            <button onClick={() => setDeletedRecovery(null)}>关闭</button>
          </aside>
        )}
      {(recoveryNotice || recoveryError) && (
        <div className="recovery-error" role="alert">
          {recoveryNotice && <p>{recoveryNotice}</p>}
          {recoveryError && <p>{recoveryError}</p>}
        </div>
      )}
      {historyNotice && (
        <div className="history-notice" aria-live="polite">
          {historyNotice}
        </div>
      )}
      <div className="save-state">
        <span role="status" aria-live="polite">
          {pose.error
            ? "布局保存未完成"
            : pose.pending || pose.dragging
              ? "布局等待保存…"
              : status}
        </span>
        {(error || pose.error) && (
          <>
            <span role="alert">
              {[error, pose.error].filter(Boolean).join("；")}
            </span>
            <button
              disabled={busy || !!pose.conflict || (!!conflict && !pose.error)}
              onClick={() => {
                if (historyCommand.current) {
                  void travel("retry");
                  return;
                }
                if (pose.error) {
                  void pose.flush();
                  return;
                }
                const pending = pendingAction.current;
                if (pending) void action(pending.command, pending.onDone);
                else if (Object.keys(drafts.current).length) void flush();
                else location.reload();
              }}
            >
              {historyCommand.current
                ? historyCommand.current.type === "history.undo"
                  ? "重试撤销"
                  : "重试重做"
                : "重试保存"}
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
              <button
                type="submit"
                disabled={busy || historyBlocked || !name.trim()}
              >
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
