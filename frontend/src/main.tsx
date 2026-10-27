import { canvasPlainText } from "./canvas-paste";
import { useCanvasImageInput } from "./canvas-image-input";
import { ImageWriteRejected, useImageGeometry } from "./image-geometry";
import { CanvasImageNode, imageNodes } from "./canvas-image";
import { ShapeAppearanceRecovery } from "./shape-appearance-recovery";
import { ShapeAppearance, type ShapeAppearanceBinding } from "./shape-appearance";
import { useShapeTextSave } from "./shape-text-save";
import { useShapeMove } from "./shape-move";
import { ShapeTextEditor } from "./shape-text-editor";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
import type { CanvasStroke } from "../../backend/src/mapping/stroke-contracts";
import { TextConflictPanel } from "./text-conflict";
import { CanvasMoveConflictPanel } from "./canvas-move-conflict";
import { orderCanvas } from './canvas-order';
import { useCanvasMove } from './canvas-move';
import { useCanvasSelection, type CanvasSelection } from './canvas-selection';
import { createGroupCommand } from './canvas-group-commands';
import { CanvasGroups } from './canvas-groups';
import { CanvasTextNode } from './canvas-text';
import { CanvasShapeNode, shapeNodes } from './canvas-shape';
import { CanvasStrokeNode, strokeNodes } from './canvas-stroke';
import { StrokeTools, type PenKind } from './stroke-tools';
import { StrokePreview, useStrokeDraw } from './stroke-draw';
import { StrokeCreateRecovery } from './stroke-create-recovery';
import { useConnectorCreate } from './connector-create';
import { useConnectorEdit } from './connector-edit';
import { captureCardDeletion, incidentConnectorVersions } from './connector-deletion';
import { ConnectorCreateControls, ConnectorEndpointControls, ConnectorHandles, ConnectorPathControls } from './connector-controls';
import { useConnectorTargets } from './connector-targets';
import { CanvasConnector, ConnectorPreview, ConnectorEntries } from './canvas-connector';
import { useConnectorLabelEdit } from './connector-label-edit';
import { DetachedConnectorLabelEditor } from './connector-label';
import type { CanvasConnector as Connector } from '../../backend/src/mapping/connector-contracts';
import { ShapeTools, type ShapeType } from './shape-tools';
import { useCanvasTexts } from './text-session';
import { ProjectSearch } from './project-search';
import type { SearchReading } from './search-reading';
import { BodyFind } from './body-find';
import { useMediaQueue } from './media-queue';
import { imageTask } from '../../backend/src/mapping/media-blocks';
import { DEFAULT_APPEARANCE } from "../../backend/src/mapping/presentation-values";
import { bodyText } from "../../backend/src/mapping/body-text";
import { WritingBoard } from "./writing-board";
import { ParagraphEditor, type TextCursor } from "./paragraph-editor";
import type { Block } from "../../backend/src/mapping/contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useReactFlow,
  useStoreApi,
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
  draftCoveredBy,
  sameDraftInput,
  type Draft,
  type Recovery,
} from "./draft-recovery";
import { usePoseSave } from "./pose-save";
import { alignMove, type Guide, type Position } from "./canvas-geometry";
import { useCardResize } from "./card-resize";
import { InlineTitle } from "./inline-title";
import { CardMenu } from "./card-menu";
import { bodyPreviewText, useCardPresentation } from "./card-presentation";
import { useCardLayoutSave } from "./card-layout-save";
import { useAppearanceSave, type AppearanceInput } from "./appearance-save";
import { ProjectTags, CardTagSummary } from "./project-tags";
import type { Tag } from "../../backend/src/mapping/contracts";

type CardData = {
  cardOnlySelection: boolean;
  tags: Tag[];
  card: Card;
  previewBody: Card["body"];
  editing: boolean;
  title: string;
  onTitle: (value: string) => void;
  onFinish: () => void;
  onEdit: () => void;
  onBody: () => void;
  onCanvasChoice: () => void;
  onDelete: () => void;
  onAppearance: (value: AppearanceInput) => void;
  appearanceValue: AppearanceInput;
  onMeasure: (card: Card, height: number) => void;
  measurable: boolean;
  onComposition: (value: boolean) => void;
  onMove: (dx: number, dy: number) => void;
  movingDisabled: boolean;
  historyBlocked: boolean;
  resizable: boolean;
  onResize: (event: React.PointerEvent<HTMLElement>, direction: string) => void;
  onResizeKey: (
    event: React.KeyboardEvent<HTMLElement>,
    direction: string,
  ) => void;
};
function ThoughtCard({ data, selected }: NodeProps<Node<CardData>>) {
  const anchor = useRef<HTMLElement>(null);
  const lines = useCardPresentation(
    anchor,
    data.card,
    data.onMeasure,
    data.measurable && data.title === data.card.title,
  );
  const text = bodyPreviewText(data.previewBody);
  return (
    <article
      ref={anchor}
      tabIndex={-1}
      className="thought-card"
      onClickCapture={data.onCanvasChoice}
      style={
        {
          "--card-title-color": data.appearanceValue.titleColor,
        } as React.CSSProperties
      }
    >
      {selected && data.cardOnlySelection && (
        <CardMenu
          anchor={anchor}
          card={data.card}
          value={data.appearanceValue}
          blocked={data.historyBlocked}
          onEdit={data.onEdit}
          onBody={data.onBody}
          onDelete={data.onDelete}
          onAppearance={data.onAppearance}
        />
      )}
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
        <InlineTitle
          blocked={data.historyBlocked}
          value={data.title}
          onChange={data.onTitle}
          onComposition={data.onComposition}
          onFinish={data.onFinish}
        />
      ) : (
        <button
          className="title-button"
          disabled={data.historyBlocked}
          onDoubleClick={data.onEdit}
        >
          {data.title || "未命名卡片"}
        </button>
      )}
      <CardTagSummary card={data.card} tags={data.tags} onOpen={data.onBody} />
      {text && data.appearanceValue.showPreview && (
        <div
          className="preview-region"
          style={{ display: lines > 0 ? undefined : "none" }}
        >
          <p
            className="preview"
            data-preview-lines={lines}
            style={{ height: `${lines * 22}px`, WebkitLineClamp: lines }}
            onDoubleClick={data.onBody}
          >
            {text}
          </p>
        </div>
      )}
      <button
        className="body-button nodrag"
        disabled={data.historyBlocked}
        onClick={data.onBody}
      >
        编辑正文
      </button>
      {data.resizable &&
        Object.entries({
          nw: "左上",
          n: "上",
          ne: "右上",
          e: "右",
          se: "右下",
          s: "下",
          sw: "左下",
          w: "左",
        }).map(([direction, label]) => (
          <button
            key={direction}
            className={`card-resize ${direction} nodrag nopan`}
            aria-label={`调整卡片尺寸：${label}`}
            disabled={data.movingDisabled}
            onPointerDown={(event) => data.onResize(event, direction)}
            onKeyDown={(event) => data.onResizeKey(event, direction)}
          />
        ))}
    </article>
  );
}
const nodeTypes = { thought: ThoughtCard, canvasText: CanvasTextNode, canvasShape: CanvasShapeNode, canvasStroke: CanvasStrokeNode, canvasImage: CanvasImageNode };
function draftKey(projectId: string, cardId: string, field: Draft["field"]) {
  return JSON.stringify([projectId, cardId, field]);
}
function Workspace() {
  const [state, setState] = useState<ProjectState | null>(null);
  const canvasSelection = useCanvasSelection(state);
  const selection = canvasSelection.directItemIds, setSelection = canvasSelection.setItems;
  const flowSelection = canvasSelection.flowSelectedItemIds;
  const marqueeSelection = useRef<{
    previous: CanvasSelection;
    selectedIds: Set<string>;
    shift: boolean;
  } | null>(null);
  const [panTool, setPanTool] = useState(false);
  const [shapePreset, setShapePreset] = useState<ShapeType | null>(null);
  const shapeCreating = useRef(false);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<Guide[]>([]);
  const moving = useRef<{
    cards: Card[];
    anchor: Card;
    raw?: Position;
    aligned?: Position;
  } | null>(null);
  const bypass = useRef(false);
  const [dimensions, setDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [projects, setProjects] = useState<Project[]>([]);
  const authority = useRef<ProjectState | null>(null);
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);
  const selectedConnector = selectedConnectors.length === 1 ? selectedConnectors[0]! : null;
  function setSelectedConnector(id: string | null) { setSelectedConnectors(id ? [id] : []); }
  const strokeSelected = selection.some(id => state?.strokes?.some(stroke => stroke.item.id === id));
  const [syncNotice, setSyncNotice] = useState("");
  const [nav, setNav] = useState(false),
    [pinned, setPinned] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState("");
  const [placing, setPlacing] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [bodyCard, setBodyCard] = useState<string | null>(null);
  const [bodyOpened, setBodyOpened] = useState(0);
  const [searchSeed, setSearchSeed] = useState<SearchReading | null>(null), [bodySearchReading, setBodySearchReading] = useState<SearchReading | null>(null);
  const bodyBinding = useRef<{
    projectId: string;
    card: Card;
    removalActionId?: string;
    restoreDirection?: "undo" | "redo";
    wasDeleted?: boolean;
    retainedContent?: Card;
  } | null>(null);
  const awaitBodySelection = useRef(false);
  const [deletedBody, setDeletedBody] = useState<{
    projectId: string;
    card: Card;
    actionId?: string;
    canRestore: boolean;
    direction: "undo" | "redo";
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
    direction?: "undo" | "redo";
  } | null>(null);
  function persistDrafts() {
    try {
      recovery.current ??= new DraftRecovery();
      recovery.current.write(
        Object.values(drafts.current),
        closedDrafts.current,
        unconfirmed.current,
      );
      setRecoveryError(
        recovery.current.damaged
          ? "部分恢复记录损坏，原件已保留；其他草稿仍可恢复"
          : "",
      );
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
      const entries = recovery.current.list();
      setRecoveries(entries);
      if (recovery.current.damaged)
        setRecoveryError("部分恢复记录损坏，原件已保留；其他草稿仍可恢复");
      return entries.some(
        (entry) => entry.value.projectId === authority.current?.project.id,
      );
    } catch {
      setRecoveryError("恢复区无法读取，原始草稿已保留");
      return false;
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
        const deletion = [...timeline.undo].reverse().find(a => a.target.id === saved.cardId && a.label === "thought.delete");
        const target = deletion ?? timeline.redo.at(-1);
        setDeletedRecovery({
          projectId: saved.projectId,
          cardId: saved.cardId,
          ...(target?.target.id === saved.cardId &&
          ["thought.create", "thought.delete"].includes(target.label)
            ? { actionId: target.id, direction: deletion ? "undo" as const : "redo" as const }
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
    blockId?: string;
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
  const cardDeletion = useRef<ReturnType<typeof captureCardDeletion>>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composition = useRef(false),
    compositionPrefixCutoff = useRef(0),
    generation = useRef(0),
    saving = useRef<Promise<boolean> | null>(null);
  const layoutBarrier = useRef<{ cutoff: number } | null>(null);
  const flow = useReactFlow();
  const canvasStore = useStoreApi();
  const titleGroup = useRef<{ cardId: string; id: string } | null>(null);
  const historyLock = useRef(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const historyCommand = useRef<Extract<
    Command,
    { type: "history.undo" | "history.redo" }
  > | null>(null);
  const historyActionId = useRef<string | null>(null);
  const connectorLabelHistory = useRef<{ projectId: string; id: string; versionId: string } | null>(null);
  const [connectorLabelHistoryBusy, setConnectorLabelHistoryBusy] = useState(false);
  const connectorPending = useRef<() => boolean>(() => false);
  const historyBlocked = historyBusy || !!historyCommand.current || connectorPending.current();
  async function travel(
    direction: "undo" | "redo" | "retry",
    restoreActionId?: string,
    keepConnectorLabel = false,
  ) {
    const ownerProjectId = authority.current?.project.id;
    if (
      !ownerProjectId || connectorPending.current() || imageGeometry.hasPending(ownerProjectId) || imageInput.hasPending(ownerProjectId) ||
      historyLock.current ||
      composition.current ||
      busy ||
      pendingAction.current || strokeDraw.hasPending() ||
      // Unknown results can only resume through the explicit retry action.
      (historyCommand.current ? direction !== "retry" : direction === "retry")
    )
      return;
    if (!(await shapeMove.flush()) ||
      (!connectorLabelHistory.current && !(await (keepConnectorLabel ? connectorLabel.flush() : connectorLabel.finish()))) ||
      !(await shapeText.finish()) || !(await texts.finish())) return;
    if (authority.current?.project.id !== ownerProjectId || connectorPending.current() || imageGeometry.hasPending(ownerProjectId) || imageInput.hasPending(ownerProjectId) ||
      historyLock.current || composition.current || pendingAction.current || strokeDraw.hasPending() ||
      (historyCommand.current ? direction !== "retry" : direction === "retry")) return;
    if (keepConnectorLabel && !connectorLabelHistory.current) {
      const editingLabel = connectorLabel.currentSession();
      if (!editingLabel || editingLabel.projectId !== ownerProjectId) return;
      connectorLabelHistory.current = { projectId: ownerProjectId, id: editingLabel.value.id, versionId: editingLabel.value.versionId };
    }
    editorEpoch.current++;
    historyLock.current = true;
    setHistoryBusy(true);
    try {
      breakBodyGroup();
      const excluded = restoreActionId ? (deletedBody?.actionId === restoreActionId ? deletedBody.card.id : deletedRecovery?.actionId === restoreActionId ? deletedRecovery.cardId : undefined) : undefined;
      if (
        !(await appearance.flush()) ||
        !(await cardLayout.flush()) ||
        !(await pose.flush()) ||
        !(await flush(Infinity, false, excluded))
      )
        return;
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
          payload: restoreActionId ? { actionId: restoreActionId } : {},
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
        { binding.removalActionId = historyActionId.current; binding.restoreDirection = command.type === "history.undo" ? "redo" : "undo"; }
      await refresh(projectId);
      const labelOwner = connectorLabelHistory.current;
      if (labelOwner?.projectId === projectId) {
        const value = authority.current?.connectors?.find(line => line.id === labelOwner.id) ?? null;
        const expected = receipt.connectorVersions?.[labelOwner.id] ?? labelOwner.versionId;
        connectorLabel.acceptHistory(value, receipt.deletedIds?.includes(labelOwner.id) ? value !== null : value?.versionId !== expected);
      }
      historyCommand.current = null;
      historyActionId.current = null;
      setHistoryNotice(
        `${command.type === "history.undo" ? "已撤销" : "已重做"}：${receipt.historyTarget?.title || "未命名卡片"}`,
      );
      const retained = !!unconfirmed.current || closedDrafts.current.length > 0 || Object.keys(drafts.current).length > 0;
      setStatus(retained ? "保存未完成" : "已保存到本机");
      setError(retained ? "原卡草稿仍未确认，请重试原请求或明确处理版本冲突" : "");
    } catch (e) {
      if (
        e instanceof MappingError &&
        ["VERSION_CONFLICT", "HISTORY_EMPTY", "HISTORY_TARGET_CHANGED"].includes(e.code)
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
      if (!historyCommand.current) connectorLabelHistory.current = null;
      setConnectorLabelHistoryBusy(!!connectorLabelHistory.current && !!historyCommand.current);
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
      if (target.closest("dialog.project-search, dialog.shape-appearance-dialog")) return;
      // Text inputs and title rounds own native text undo; non-text controls
      // such as the appearance checkbox use the project's action history.
      const input = target.closest("input");
      if (
        (input &&
          ["text", "search", "email", "url", "tel", "password", "number"].includes(
            input.type,
          )) ||
        target.closest(".card-title, .shape-text-input, .connector-label-input, [contenteditable=true]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void travel(
        event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo",
      ).finally(() => {
        // History temporarily disables non-text inputs. Restore only the
        // surviving control, without stealing focus after a selection change.
        requestAnimationFrame(() => {
          if (
            input?.isConnected &&
            !input.disabled &&
            document.activeElement === document.body
          )
            input.focus();
        });
      });
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
        binding.wasDeleted = false;
        delete binding.retainedContent;
        delete binding.removalActionId;
        delete binding.restoreDirection;
        setDeletedBody(null);
      } else {
        if (!binding.retainedContent) {
          // The readonly panel retains what the user was seeing at deletion,
          // independently from ACK retirement of the original save request.
          // This is a local projection, never a new authoritative Body version.
          const retained = structuredClone(binding.card);
          const input = [unconfirmed.current, ...closedDrafts.current, ...Object.values(drafts.current)]
            .filter((draft): draft is Draft => !!draft && draft.projectId === binding.projectId && draft.cardId === binding.card.id)
            .sort((a, b) => b.generation - a.generation);
          const title = input.find(draft => draft.field === "title");
          const body = input.find(draft => draft.field === "body");
          if (title) retained.title = title.value;
          if (body) retained.body.blocks = structuredClone(body.blocks ?? [{ ...retained.body.blocks[0]!, text: body.value }]);
          binding.retainedContent = retained;
        }
        // Filtering a deleted item out of a multi-selection is a system
        // cleanup, not an explicit selection of the surviving single card.
        if (!binding.wasDeleted) awaitBodySelection.current = true;
        binding.wasDeleted = true;
        const deletion = timeline && [...timeline.undo].reverse().find(a => a.target.id === binding.card.id && a.label === "thought.delete");
        const removed = deletion ?? timeline?.redo.at(-1);
        if (
          !binding.removalActionId &&
          timeline?.revision === value.project.revision &&
          removed && ["thought.create", "thought.delete"].includes(removed.label) &&
          removed.target.id === binding.card.id
        )
          { binding.removalActionId = removed.id; binding.restoreDirection = deletion ? "undo" : "redo"; }
        if (composition.current) compose(false);
        setEditing(previous => previous === binding.card.id ? null : previous);
        setDeletedBody({
          projectId: binding.projectId,
          card: binding.retainedContent,
          ...(binding.removalActionId
            ? { actionId: binding.removalActionId }
            : {}),
          canRestore:
            !!binding.removalActionId &&
            (binding.restoreDirection === "undo" ? timeline?.undo : timeline?.redo)?.at(-1)?.id === binding.removalActionId,
          direction: binding.restoreDirection ?? "redo",
        });
      }
    }
    authority.current = value;
    setSelectedConnectors(previous => current?.project.id === value.project.id ? previous.filter(id => value.connectors?.some(line => line.id === id)) : []);
    canvasSelection.reconcile(value, current?.project.id === value.project.id);
    setState(value);
  };
  const [strokeJournal] = useState(() => new StrokeCreateRecovery());
  const [strokeRecoveries, setStrokeRecoveries] = useState<ReturnType<StrokeCreateRecovery["list"]>>([]);
  const [strokeRecoveryError, setStrokeRecoveryError] = useState("");
  const strokeRecoveryRunning = useRef(false);
  function scanStrokeRecoveries() {
    try { setStrokeRecoveries(strokeJournal.list()); setStrokeRecoveryError(""); }
    catch { setStrokeRecoveryError("未确认笔迹恢复区无法读取，原始记录仍保留"); }
  }
  useEffect(() => { if (state?.project.id) scanStrokeRecoveries(); }, [state?.project.id]);
  const [shapeJournal] = useState(() => new ShapeAppearanceRecovery());
  const shapeRecoveryRunning = useRef(false);
  const [shapeRecoveries, setShapeRecoveries] = useState<ReturnType<ShapeAppearanceRecovery["list"]>>([]);
  const [shapeRecoveryError, setShapeRecoveryError] = useState("");
  const [shapeAppearance, setShapeAppearance] = useState<ShapeAppearanceBinding | null>(null);
  const shapeAppearanceOwner = useRef<ShapeAppearanceBinding | null>(null);
  useEffect(() => {
    if (!state?.project.id) return;
    try {
      setShapeRecoveries(shapeJournal.list());
      setShapeRecoveryError(shapeJournal.damaged ? "部分形状外观恢复记录损坏，原件已保留" : "");
    } catch { setShapeRecoveryError("形状外观恢复区无法读取，原始草稿已保留"); }
  }, [state?.project.id, shapeAppearance]);
  const shapeText = useShapeTextSave(value => {
    if (authority.current?.project.id === value.project.id) updateState(value);
  });
  const connectorLabel = useConnectorLabelEdit(value => {
    if (authority.current?.project.id === value.project.id) updateState(value);
  }, () => authority.current);
  async function travelConnectorLabel(direction: 'undo' | 'redo') {
    if (connectorLabelHistoryBusy || !connectorLabel.currentSession() || connectorLabel.isComposing()) return;
    setConnectorLabelHistoryBusy(true);
    try { await travel(direction, undefined, true); }
    finally { setConnectorLabelHistoryBusy(!!connectorLabelHistory.current && !!historyCommand.current); }
  }
  const connectorLabelOrigin = useRef<{ projectId: string; id: string; element: HTMLElement | SVGElement } | null>(null);
  async function finishConnectorLabel() {
    const session = connectorLabel.currentSession(), origin = connectorLabelOrigin.current;
    const focused = document.activeElement, epoch = editorEpoch.current;
    if (!session || !(await connectorLabel.finish())) return;
    requestAnimationFrame(() => {
      if (authority.current?.project.id !== session.projectId || editorEpoch.current !== epoch || connectorLabel.currentSession() ||
        document.activeElement !== focused && document.activeElement !== document.body) return;
      if (origin?.projectId === session.projectId && origin.id === session.value.id && origin.element.isConnected) origin.element.focus();
      else document.querySelector<SVGSVGElement>(`.canvas-connector[data-connector-id="${CSS.escape(session.value.id)}"]`)?.focus();
    });
  }
  async function beginConnectorLabel(id: string, origin: HTMLElement | SVGElement) {
    if (busy || historyBlocked || composition.current || pendingAction.current || connectorEdit.hasPending() || connectorCreate.hasPending()) return;
    const projectId = authority.current?.project.id, epoch = editorEpoch.current;
    if (!(await connectorLabel.finish()) || !(await shapeMove.flush()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    const current = authority.current, value = current?.connectors?.find(line => line.id === id);
    if (!current || !value || current.project.id !== projectId || editorEpoch.current !== epoch) return;
    connectorLabelOrigin.current = { projectId: current.project.id, id, element: origin };
    setSelection([]); setSelectedConnector(id); connectorLabel.begin(current.project.id, value);
  }
  async function recoverConnectorLabel(key: string, targetId: string) {
    const projectId = authority.current?.project.id;
    if (!projectId || busy || historyBlocked || composition.current || pendingAction.current ||
      shapeAppearanceOwner.current || shapeRecoveryRunning.current || connectorCreate.hasPending() || connectorEdit.hasPending()) return;
    const record = connectorLabel.recoveries.find(record => record.key === key && record.value.session.projectId === projectId && record.value.session.value.id === targetId);
    if (!record) return;
    const epoch = ++editorEpoch.current;
    const stillCurrent = () => authority.current?.project.id === projectId && editorEpoch.current === epoch &&
      !historyLock.current && !historyCommand.current && !pendingAction.current && !composition.current && !connectorLabel.isComposing() &&
      !shapeAppearanceOwner.current && !shapeRecoveryRunning.current && !connectorCreate.hasPending() && !connectorEdit.hasPending();
    try {
      for (const finish of [shapeMove.flush, connectorLabel.finish, shapeText.finish, texts.finish, appearance.flush, cardLayout.flush, pose.flush, flush]) {
        if (!stillCurrent() || !(await finish()) || !stillCurrent()) return;
      }
      const latest = await api.project(projectId);
      if (!stillCurrent() || connectorLabel.currentSession() || shapeText.currentSession()) return;
      updateState(latest); // Refresh comparison only; recovery keeps its original request and expected version.
      if (connectorLabel.restore(key, targetId)) { connectorLabelOrigin.current = null; setSelection([]); setSelectedConnector(targetId); }
    } catch (failure) { fail(failure); }
  }
  async function recoverCanvasText(key: string, kind: 'draft' | 'conflict' | 'create' | 'format') {
    const projectId = authority.current?.project.id;
    if (!projectId || busy || historyBlocked || composition.current || pendingAction.current ||
      shapeAppearanceOwner.current || shapeRecoveryRunning.current || connectorCreate.hasPending() || connectorEdit.hasPending()) return;
    const found = kind === 'draft' ? texts.recoveries.some(record => record.key === key && record.value.session.projectId === projectId)
      : kind === 'conflict' ? texts.conflictRecoveries.some(record => record.key === key && record.value.projectId === projectId)
        : kind === 'create' ? texts.createRecoveries.some(record => record.key === key && record.command.projectId === projectId)
          : texts.formatRecoveries.some(record => record.key === key && record.projectId === projectId);
    if (!found) return;
    const epoch = ++editorEpoch.current;
    const stillCurrent = () => authority.current?.project.id === projectId && editorEpoch.current === epoch &&
      !historyLock.current && !historyCommand.current && !pendingAction.current && !composition.current && !connectorLabel.isComposing() &&
      !shapeAppearanceOwner.current && !shapeRecoveryRunning.current && !connectorCreate.hasPending() && !connectorEdit.hasPending();
    try {
      for (const finish of [shapeMove.flush, connectorLabel.finish, shapeText.finish, texts.finish, appearance.flush, cardLayout.flush, pose.flush, flush]) {
        if (!stillCurrent() || !(await finish()) || !stillCurrent()) return;
      }
      const latest = await api.project(projectId);
      if (!stillCurrent() || connectorLabel.currentSession() || shapeText.currentSession()) return;
      updateState(latest); // Authorization and display only; each recovery retains its original command.
      if (kind === 'draft') await texts.recover(key);
      else if (kind === 'conflict') texts.recoverConflict(key);
      else if (kind === 'create') await texts.recoverCreate(key);
      else texts.recoverFormat(key);
    } catch (failure) { fail(failure); }
  }
  async function afterConnectorLabel(value: Connector, perform: (prepared: Connector) => void) {
    const projectId = authority.current?.project.id, own = connectorLabel.currentSession();
    if (!projectId) return;
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== projectId) return;
    if (own && own.projectId === projectId && own.value.id === value.id) {
      const acknowledged = connectorLabel.confirmed();
      if (!acknowledged || acknowledged.projectId !== projectId || acknowledged.value.id !== value.id) return;
      perform(acknowledged.value);
    } else perform(value);
  }
  async function leaveConnectorLabel(itemId: string | null, lineId: string | null, extend: boolean) {
    if (connectorLabelHistoryBusy) return;
    const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== projectId || epoch !== editorEpoch.current) return;
    if (lineId && authority.current?.connectors?.some(line => line.id === lineId)) {
      setSelection([]); setSelectedConnectors(previous => extend ? previous.includes(lineId) ? previous.filter(id => id !== lineId) : [...previous, lineId] : [lineId]); return;
    }
    if (!itemId) { marqueeSelection.current = null; if (extend) return; }
    clearConnectorSelection(); setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    setSelection(previous => itemId ? extend ? [...new Set([...previous, itemId])] : [itemId] : extend ? previous : []);
  }
  const [shapeTextRecoveries, setShapeTextRecoveries] = useState<ReturnType<typeof shapeText.journal.list>>([]);
  const [shapeTextRecoveryError, setShapeTextRecoveryError] = useState("");
  useEffect(() => {
    if (!state?.project.id) return;
    try {
      setShapeTextRecoveries(shapeText.journal.list());
      setShapeTextRecoveryError(shapeText.journal.damaged ? "部分形状文字恢复记录损坏，原件已保留" : "");
    } catch { setShapeTextRecoveryError("形状文字恢复区无法读取，原始草稿已保留"); }
  }, [state?.project.id, shapeText.session?.value.id]);
  const refresh = async (id: string) => {
    const capturedProject = authority.current?.project.id;
    const value = await api.project(id);
    const timeline = await api.history(id);
    if (capturedProject === id && authority.current?.project.id === id) {
      updateState(value, timeline);
      const all = await api.projects();
      if (authority.current?.project.id === id) setProjects(all);
    }
    return value;
  };
  useEffect(() => {
    const id = state?.project.id;
    if (!id) return;
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const synchronize = async () => {
      if (!active || running) return;
      const captured = authority.current;
      if (!captured || captured.project.id !== id) return;
      const inputGeneration = generation.current;
      const inputEpoch = editorEpoch.current;
      const stillCurrent = () =>
        active &&
        authority.current === captured &&
        generation.current === inputGeneration &&
        editorEpoch.current === inputEpoch;
      running = true;
      clearTimeout(timer);
      try {
        const latest = await api.synchronize(captured);
        if (!stillCurrent()) return;
        if (latest !== captured) {
          const timeline = await api.history(id);
          if (!stillCurrent()) return;
          const all = await api.projects();
          if (!stillCurrent()) return;
          updateState(latest, timeline);
          setProjects(all);
        }
        if (active) setSyncNotice("");
      } catch (error) {
        if (!active || authority.current?.project.id !== id) return;
        if (
          error instanceof MappingError &&
          ["UNAUTHORIZED", "PROJECT_FORBIDDEN", "UNTRUSTED_PRINCIPAL"].includes(
            error.code,
          )
        ) {
          persistDrafts();
          authority.current = null;
          setState(null);
          setProjects([]);
          setSyncNotice(
            "授权已失效，请从本机启动入口重新打开；未确认草稿已保留",
          );
        } else setSyncNotice("地图同步暂时中断，正在重试；未确认草稿已保留");
      } finally {
        running = false;
        if (active) timer = setTimeout(() => void synchronize(), 1000);
      }
    };
    const resume = () => void synchronize();
    timer = setTimeout(resume, 1000);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
    };
  }, [state?.project.id]);
  const pose = usePoseSave(refresh,
    (command, receipt) => cardDeletion.current?.acknowledge(command, receipt));
  const cardLayout = useCardLayoutSave(refresh, () => authority.current,
    (command, receipt) => cardDeletion.current?.acknowledge(command, receipt));
  const appearance = useAppearanceSave(
    () => authority.current,
    refresh,
    async () => {
      breakBodyGroup();
      return await connectorLabel.finish() && await shapeText.finish() && await flush();
    },
    (command, receipt) => cardDeletion.current?.acknowledge(command, receipt),
  );
  const imageGeometry = useImageGeometry(() => authority.current, action, refresh,
    () => historyLock.current || !!historyCommand.current);
  const shapeMove = useShapeMove(() => authority.current, value => {
    if (authority.current?.project.id === value.project.id) updateState(value);
  }, async () => await connectorLabel.finish() && await shapeText.finish() && await texts.finish() && await appearance.flush() &&
    await cardLayout.flush() && await pose.flush() && await flush());
  const strokeDraw = useStrokeDraw({
    projectId: () => authority.current?.project.id,
    blocked: () => busy || historyBlocked || composition.current || !!pendingAction.current ||
      shapeMove.hasPending() || !!shapeText.session || texts.hasPending() || appearance.hasPending() ||
      cardLayout.hasPending() || pose.hasPending(),
    point: client => flow.screenToFlowPosition(client), commit: action,
  });
  const connectorTargets = useConnectorTargets(state, client => flow.screenToFlowPosition(client, { snapToGrid: false }));
  function connectorCreationBlocked() {
    return busy || historyBusy || !!historyCommand.current || composition.current || !!pendingAction.current || strokeDraw.hasPending() ||
      shapeMove.hasPending() || !!shapeText.session || texts.hasPending() || appearance.hasPending() || cardLayout.hasPending() || pose.hasPending();
  }
  const connectorCreate = useConnectorCreate({
    current: () => authority.current,
    blocked: () => connectorCreationBlocked() || connectorEdit.hasPending(),
    prepare: async projectId => {
      const epoch = ++editorEpoch.current;
      if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
        !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return false;
      if (authority.current?.project.id !== projectId || editorEpoch.current !== epoch) return false;
      strokeDraw.setMode(null); setSelection([]); setSelectedConnector(null); setPlacing(false); setShapePreset(null); texts.setPlacing(false); setPanTool(false);
      return true;
    },
    point: client => flow.screenToFlowPosition(client, { snapToGrid: false }),
    center: () => {
      const element = document.querySelector('.canvas .react-flow');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, { snapToGrid: false });
    },
    origin: client => connectorTargets.origin(client),
    execute: command => api.execute(command), read: projectId => api.project(projectId),
    publish: (value, id) => {
      if (authority.current?.project.id !== value.project.id) return;
      updateState(value); setSelection([]); setSelectedConnector(value.connectors?.some(line => line.id === id) ? id : null);
      setStatus('已保存到本机'); setError('');
    },
  });
  connectorPending.current = connectorCreate.hasPending;
  const connectorEdit = useConnectorEdit({
    current: () => authority.current,
    blocked: () => busy || historyBlocked || composition.current || !!pendingAction.current || connectorCreate.hasPending() || strokeDraw.hasPending(),
    point: client => flow.screenToFlowPosition(client, { snapToGrid: false }), origin: connectorTargets.origin,
    resolve: connectorTargets.resolve,
    commit: async (command, done) => {
      let submitted = false, confirmed = false;
      try { confirmed = (await action(command, done, () => { submitted = true; return true; })) === true; }
      catch (error) { fail(error); }
      return { submitted, confirmed };
    },
  });
  function clearConnectorSelection() {
    connectorEdit.cancel({ restoreFocus: false });
    setSelectedConnector(null);
  }
  async function reverseConnectors() {
    const current = authority.current;
    if (!current || busy || historyBlocked || composition.current || pendingAction.current || connectorEdit.hasPending()) return;
    const lines = (current.connectors ?? []).filter(line => selectedConnectors.includes(line.id));
    if (!lines.length) return;
    const own = connectorLabel.currentSession();
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== current.project.id) return;
    const acknowledged = connectorLabel.confirmed();
    const prepared = lines.map(line => own?.projectId === current.project.id && own.value.id === line.id && acknowledged?.value.id === line.id ? acknowledged.value : line);
    void action({ commandId: crypto.randomUUID(), projectId: current.project.id, type: 'connector.reverse',
      expected: Object.fromEntries(prepared.map(line => [line.id, line.versionId])), payload: { ids: prepared.map(line => line.id) } });
  }
  function beginCreationToolChoice() {
    const epoch = ++editorEpoch.current;
    connectorEdit.cancel();
    connectorCreate.deactivate();
    return epoch;
  }
  async function chooseStroke(kind: PenKind) {
    const projectId = authority.current?.project.id;
    if (!projectId || busy || historyBlocked || composition.current || pendingAction.current ||
      shapeAppearance || shapeRecoveryRunning.current || strokeDraw.hasPending()) return;
    const epoch = beginCreationToolChoice();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) ||
      !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    if (authority.current?.project.id !== projectId || editorEpoch.current !== epoch || historyLock.current || historyCommand.current ||
      composition.current || pendingAction.current) return;
    setSelection([]); setPlacing(false); setShapePreset(null); texts.setPlacing(false); setPanTool(false);
    strokeDraw.setMode(kind);
  }
  function startMove(projectId: string, card: Card, resizing = false) {
    if (strokeSelected) return false;
    // Geometry remains interactive while the prefix of input waits for ACK.
    // Reserve this boundary so later typing cannot overtake the move either.
    breakBodyGroup();
    const barrier = {
      cutoff: composition.current
        ? compositionPrefixCutoff.current
        : generation.current,
    };
    const cards =
      !resizing && selection.includes(card.item.id)
        ? [
            card,
            ...authority.current!.cards.filter(
              (c) => c.id !== card.id && selection.includes(c.item.id),
            ),
          ]
        : [card];
    if (
      !pose.start(
        projectId,
        cards,
        {
          beforeSubmit: async () =>
            (await drainCompletedPrefix(barrier.cutoff)) !== "unknown",
          afterAttempt: () => {
            if (layoutBarrier.current === barrier) layoutBarrier.current = null;
            void flush();
          },
        },
        resizing,
      )
    )
      return false;
    layoutBarrier.current = barrier;
    moving.current = resizing ? null : { cards, anchor: card };
    return true;
  }
  const resize = useCardResize({
    start: (card) =>
      !!authority.current &&
      startMove(authority.current.project.id, card, true),
    preview: pose.preview,
    finish: () => pose.finish(),
    cancel: pose.cancel,
    zoom: () => flow.getZoom(),
  });
  function cancelGesture() {
    connectorEdit.cancel();
    connectorCreate.cancelDraft();
    strokeDraw.cancel();
    pose.cancel();
    texts.cancelMove();
    canvasMove.cancel();
    canvasSelection.cancelDrag();
    shapeMove.cancel();
    imageGeometry.cancel();
    resize.cancel();
    moving.current = null;
    bypass.current = false;
    setGuides([]);
    const session = marqueeSelection.current;
    if (session) {
      canvasSelection.set(session.previous);
      marqueeSelection.current = null;
      // The engine releases capture on cancel but leaves its transient marquee.
      // Reset only these UI fields through its exported store Interface.
      canvasStore.setState({
        userSelectionRect: null,
        userSelectionActive: false,
        nodesSelectionActive: false,
      });
    }
  }
  useEffect(() => {
    const cancel = () => cancelGesture();
    const lostCapture = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.image-crop')) return;
      cancel();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        composition.current ||
        (event.target as HTMLElement).closest(
          "input, textarea, [contenteditable=true]",
        )
      )
        return;
      setShapePreset(null);
      if (connectorEdit.hasGesture() || connectorCreate.hasGesture() || strokeDraw.hasGesture() || pose.dragging || texts.hasMove() || canvasMove.dragging || shapeMove.dragging || marqueeSelection.current) {
        event.preventDefault();
        cancel();
      } else if (selectedConnectors.length) {
        event.preventDefault();
        setSelectedConnector(null);
      }
    };
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("lostpointercapture", lostCapture, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("lostpointercapture", lostCapture, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", hidden);
    };
  });
  function previewMove(position: Position, temporaryBypass = bypass.current) {
    const current = moving.current;
    if (!current) return;
    current.raw = position;
    const result =
      snap && !temporaryBypass
        ? alignMove(
            current.cards,
            current.anchor,
            position,
            authority.current?.cards ?? [],
            flow.getZoom(),
          )
        : { position, guides: [] };
    current.aligned = result.position;
    setGuides(result.guides);
    const dx = result.position.x - current.anchor.item.pose.x,
      dy = result.position.y - current.anchor.item.pose.y;
    for (const c of current.cards)
      pose.preview(c.item.id, { x: c.item.pose.x + dx, y: c.item.pose.y + dy });
  }
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.isComposing) return;
      bypass.current = event.type === "keydown";
      if (moving.current?.raw) previewMove(moving.current.raw);
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
    };
  });
  const handoff = async (id: string) => {
    const value = await api.project(id);
    const all = await api.projects();
    // Keep the old project's authority while the destination is loading: the
    // visible editors may still accept input during those requests.
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await pose.flush()) || !(await flush())) return false;
    updateState(value);
    setProjects(all);
    return true;
  };
  const select = async (id: string) => {
    if (historyLock.current || historyCommand.current || strokeDraw.hasPending()) return;
    if (pendingAction.current) {
      fail(new Error("请先重试未完成的保存"));
      return;
    }
    editorEpoch.current++;
    breakBodyGroup();
    if (
      !(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) ||
      !(await appearance.flush()) ||
      !(await cardLayout.flush()) ||
      !(await pose.flush()) ||
      !(await flush())
    )
      return;
    if (id === authority.current?.project.id) return;
    setBusy(true);
    try {
      if (!(await handoff(id))) return;
      setEditing(null);
      bodyBinding.current = null;
      setDeletedBody(null);
      setBodyCard(null);
      setPlacing(false);
      setShapePreset(null);
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
    excludedCard?: string,
  ): Promise<boolean> {
    limit = Math.min(limit, layoutBarrier.current?.cutoff ?? Infinity);
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
    if ((!completedPrefix && composition.current) || conflictRef.current)
      return false;
    if (saving.current) {
      const target = unconfirmed.current?.cardId;
      if (!(await saving.current) && target !== excludedCard) return false;
      return flush(limit, completedPrefix, excludedCard);
    }
    const current = [unconfirmed.current, ...closedDrafts.current, ...Object.values(drafts.current)].find(d => d && d.cardId !== excludedCard);
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
              ...(current.blocks ? { blocks: current.blocks } : { text: current.value }),
              ...(draftAssetIds(current)
                ? { requiredAssetIds: draftAssetIds(current)! }
                : {}),
            },
          });
    const submitted: Draft = { ...current, command };
    current.command = command;
    for (const projection of [
      ...closedDrafts.current,
      ...Object.values(drafts.current),
    ])
      if (!projection.command && sameDraftInput(projection, submitted))
        projection.command = command;
    unconfirmed.current = current;
    persistDrafts();
    setStatus("正在保存…");
    saving.current = (async () => {
      try {
        const receipt = await api.execute(command);
        cardDeletion.current?.acknowledge(command, receipt);
        await refresh(current.projectId);
        for (const newer of [
          ...closedDrafts.current,
          ...Object.values(drafts.current),
        ]) {
          if (
            newer.projectId === submitted.projectId &&
            newer.cardId === current.cardId &&
            newer.field === current.field &&
            newer.generation !== current.generation &&
            // An existing original request retains its own expected version.
            !newer.command &&
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
          (d) => !draftCoveredBy(d, submitted),
        );
        if (
          unconfirmed.current &&
          draftCoveredBy(unconfirmed.current, submitted)
        )
          unconfirmed.current = null;
        if (
          drafts.current[key] &&
          draftCoveredBy(drafts.current[key], submitted)
        )
          delete drafts.current[key];
        persistDrafts();
        setDraftView({ ...drafts.current });
        setStatus(
          Object.keys(drafts.current).length ? "等待保存…" : "已保存到本机",
        );
        setError("");
        return true;
      } catch (e) {
        // Queued-only input remains visible and recoverable on any failure.
        // An older failure must never replace later complete input.
        const latest = drafts.current[key];
        if (!latest || latest.generation <= current.generation)
          drafts.current[key] = current;
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
          // A definite refusal retires this batch only after its input is
          // retained above or superseded by later complete input.
          unconfirmed.current = null;
          closedDrafts.current = closedDrafts.current.filter(
            (d) => !draftCoveredBy(d, submitted),
          );
        }
        persistDrafts();
        setDraftView({ ...drafts.current });
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
    return result ? flush(limit, completedPrefix, excludedCard) : false;
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
    input?: { inputType: string; start: number; end: number; blockId?: string },
    blocks?: Block[],
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
            group.blockId !== input?.blockId ||
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
          ...(input?.blockId ? { blockId: input.blockId } : {}),
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
      ...(blocks ? { blocks } : {}),
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
        draft.field === "title" ? remote.title : bodyText(remote.body);
      recovery.current ??= new DraftRecovery();
      // A choice may discard many local groups. Preserve the complete alternative
      // before changing any draft or issuing a version-checked write.
      recovery.current.archive({
        projectId: draft.projectId,
        cardId: draft.cardId,
        field: draft.field,
        value: choice === "mine" ? remoteValue : latest.value,
        ...(draft.field === "body" ? (choice === "mine" ? { blocks: remote.body.blocks } : latest.blocks ? { blocks: latest.blocks } : {}) : {}),
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
        ...(draft.field === "body" ? (choice === "remote" ? { blocks: remote.body.blocks } : latest.blocks ? { blocks: latest.blocks } : {}) : {}),
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
  async function action(command: Command, onDone?: () => void, beforeSubmit?: () => boolean) {
    if (connectorCreate.hasPending()) return false;
    const imageCommand = command.type.startsWith('image.');
    const backgroundImage = () => imageCommand && command.projectId !== authority.current?.project.id;
    const finishImage = async () => {
      try { await api.execute(command); }
      catch (failure) {
        if (failure instanceof MappingError && ['image.transform', 'image.rotate', 'image.delete', 'image.crop'].includes(command.type) &&
          ['VERSION_CONFLICT', 'NOT_FOUND'].includes(failure.code)) throw new ImageWriteRejected(failure.message);
        throw failure;
      }
      if (command.projectId === authority.current?.project.id) await refresh(command.projectId);
      else await api.project(command.projectId);
      onDone?.();
      return true;
    };
    if (backgroundImage()) return finishImage();
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
    if (
      !(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) ||
      !(await appearance.flush()) ||
      !(await cardLayout.flush()) ||
      !(await pose.flush()) ||
      !(await flush())
    )
      return;
    if (imageCommand) return finishImage();
    if (command.type === "stroke.create" && command.projectId !== authority.current?.project.id) {
      fail(new Error("笔迹所属项目已变化，请在原项目明确恢复")); return false;
    }
    if (beforeSubmit && !beforeSubmit()) return false;
    pendingAction.current = { command, ...(onDone ? { onDone } : {}) };
    setBusy(true);
    setStatus("正在保存…");
    let executed = false;
    try {
      if (command.type === "stroke.create") { strokeJournal.write(command); scanStrokeRecoveries(); }
      await api.execute(command);
      executed = true;
      if (command.projectId !== authority.current?.project.id) {
        if (!(await handoff(command.projectId))) return;
      } else {
        await refresh(command.projectId);
        if (!(await flush())) return;
      }
      if (command.type === "stroke.create") { strokeJournal.confirm(command); scanStrokeRecoveries(); }
      setStatus("已保存到本机");
      setError("");
      pendingAction.current = null;
      onDone?.();
      return true;
    } catch (e) {
      if (!executed && e instanceof MappingError &&
        ((['connector.reconnect', 'connector.path', 'connector.move', 'connector.delete', 'connector.style', 'connector.reverse', 'connector.label'].includes(command.type) && ['VERSION_CONFLICT', 'NOT_FOUND'].includes(e.code)) ||
          (command.type === 'connector.reconnect' && e.code === 'INVALID_ENDPOINT'))) {
        pendingAction.current = null;
        onDone?.();
        try { await refresh(command.projectId); } catch { /* Retain the explicit rejection if the read also fails. */ }
      }
      if ((command.type === "thought.delete" || command.type === "shape.delete" || command.type === "stroke.delete" || command.type.startsWith("tag.") || command.type === "card.tags") && e instanceof MappingError && ["VERSION_CONFLICT", "TAG_NAME_CONFLICT", "NOT_FOUND", "UNAUTHORIZED", "PROJECT_FORBIDDEN", "UNTRUSTED_PRINCIPAL"].includes(e.code)) {
        pendingAction.current = null;
        try { await refresh(command.projectId); } catch { /* Keep the unconfirmed view; authorization polling owns retraction. */ }
      }
      fail(e);
      return false;
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
  const mediaQueue = useMediaQueue(state?.project.id, state?.cards ?? [], async (command) => {
    if (
      connectorPending.current() ||
      composition.current ||
      historyLock.current ||
      historyCommand.current ||
      busy ||
      pendingAction.current ||
      conflictRef.current
    )
      return "wait";
    if (!(await flush())) return "wait";
    if (
      connectorPending.current() ||
      composition.current ||
      historyLock.current ||
      historyCommand.current ||
      pendingAction.current ||
      Object.keys(drafts.current).length
    )
      return "wait";
    historyLock.current = true;
    setHistoryBusy(true);
    try {
      await api.execute(command);
      await refresh(command.projectId);
      const retained =
        !!unconfirmed.current ||
        closedDrafts.current.length > 0 ||
        Object.keys(drafts.current).length > 0;
      setStatus(retained ? "等待保存…" : "已保存到本机");
      setError("");
      return "done";
    } catch (error) {
      if (
        error instanceof MappingError &&
        ["MEDIA_TASK_STALE", "MEDIA_TICKET_CONFLICT", "NOT_FOUND"].includes(error.code)
      ) {
        try {
          await refresh(command.projectId);
        } catch {}
        return "done";
      }
      fail(new Error("媒体结果尚未确认，请使用图片重试；原请求与原内容已保留"));
      return "unknown";
    } finally {
      historyLock.current = false;
      setHistoryBusy(false);
    }
  });
  const mediaTasks = (state?.cards ?? []).flatMap((card) =>
    card.body.blocks.flatMap((block) => {
      const task = imageTask(block);
      return task ? [task] : [];
    }),
  );
  const imageFile = useRef<HTMLInputElement>(null);
  const imageInput = useCanvasImageInput(() => {
    const current = authority.current, element = document.querySelector('.canvas .react-flow');
    if (!current || !element) return null;
    const rect = element.getBoundingClientRect(), zoom = flow.getZoom();
    const point = flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    return { projectId: current.project.id, ...point, maxWidth: rect.width * 0.6 / zoom, maxHeight: rect.height * 0.6 / zoom };
  }, action, () => historyLock.current || !!historyCommand.current);
  const saveStatus = connectorLabel.status || (connectorLabel.recoveryError ? '部分连线文字恢复记录未确认'
    : connectorLabel.recoveries.some(record => record.value.session.projectId === state?.project.id && record.value.purpose !== 'preserved-remote') ? '连线文字草稿待处理'
    : imageGeometry.rejected ? '图片调整未保存' : imageGeometry.pending ? '图片布局尚未确认' : imageInput.pending ? (imageInput.error ? '图片保存失败 · 原输入保留' : '图片处理中 · 尚未保存') : imageInput.recoveryError ? '部分图片恢复记录未确认' : mediaQueue.hasUnconfirmed
    ? "媒体结果尚未确认 · 重试确认"
    : status === "已保存到本机" && mediaTasks.length
      ? mediaTasks.some((task) => task.status === "failed")
        ? "媒体保存失败 · 重试或移除"
        : "媒体处理中 · 尚未保存"
      : status);
  async function copyOriginalBody(cardId: string, before: Block[], after: Block[]) {
    const projectId=authority.current?.project.id;
    if (!projectId || !(await flush())) return;
    const current=authority.current;
    const card=current?.cards.find(card=>card.id===cardId);
    if (!card || current!.project.id!==projectId || JSON.stringify(card.body.blocks)!==JSON.stringify(before)) {
      fail(new Error('原正文已变化，复制操作已取消')); return;
    }
    await action({commandId:crypto.randomUUID(),projectId,type:'body.edit',expected:card.body.versionId,payload:{id:cardId,blocks:after,copyOriginals:true}});
  }
  async function removeCard(id: string) {
    if (composition.current || busy || historyBlocked || strokeSelected || cardDeletion.current || pendingAction.current) return;
    const ownerProject = authority.current?.project.id;
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== ownerProject) return;
    const snapshot = authority.current, visible = snapshot?.cards.find(card => card.id === id);
    if (!snapshot || !visible) return;
    const intent = captureCardDeletion(snapshot, id);
    if (!intent) { fail(new Error('请等待完整连线投影后重试删除')); return; }
    cardDeletion.current = intent;
    try {
      breakBodyGroup();
      if (!(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      if (cardDeletion.current !== intent || authority.current?.project.id !== intent.projectId ||
        !authority.current.cards.some(card => card.id === id && card.item.id === intent.itemId)) return;
      await action(intent.command(), undefined, () => {
        if (cardDeletion.current !== intent || pendingAction.current || historyLock.current || historyCommand.current ||
          authority.current?.project.id !== intent.projectId ||
          !authority.current.cards.some(card => card.id === id && card.item.id === intent.itemId)) return false;
        if (intent.seal()) return true;
        fail(new Error('本次删除的自身保存依据未能确认，请重新明确删除'));
        return false;
      });
    } finally {
      if (cardDeletion.current === intent) cardDeletion.current = null;
    }
  }
  async function chooseCanvasItem(itemId: string, extend: boolean) {
    if (busy || historyLock.current || historyCommand.current || composition.current || pendingAction.current) return;
    const projectId = authority.current?.project.id;
    if (!projectId) return;
    const epoch = ++editorEpoch.current;
    breakBodyGroup();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    if (epoch !== editorEpoch.current || authority.current?.project.id !== projectId ||
      ![...(authority.current.shapes ?? []), ...(authority.current.images ?? [])].some(item => item.item.id === itemId)) return;
    clearConnectorSelection();
    setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    setSelection(previous => extend ? [...new Set([...previous, itemId])]
      : previous.includes(itemId) && previous.length > 1 ? previous : [itemId]);
  }
  async function recoverStrokeCreate(key: string) {
    if (busy || historyBlocked || composition.current || pendingAction.current || strokeDraw.hasPending() || strokeRecoveryRunning.current) return;
    const projectId = authority.current?.project.id;
    if (!projectId) return;
    strokeRecoveryRunning.current = true;
    try {
      const record = strokeJournal.list().find(record => record.key === key);
      if (!record || record.command.projectId !== projectId) return;
      const command = strokeJournal.adopt(key);
      scanStrokeRecoveries();
      if (authority.current?.project.id !== projectId) return;
      await action(command);
    } catch { setStrokeRecoveryError("无法接管未确认笔迹，原始记录仍保留，请重试"); }
    finally { strokeRecoveryRunning.current = false; }
  }
  async function chooseStrokeItem(itemId: string, extend: boolean) {
    if (busy || historyBlocked || composition.current || pendingAction.current || strokeDraw.hasPending()) return;
    const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
    breakBodyGroup();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
      !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    if (!projectId || editorEpoch.current !== epoch || authority.current?.project.id !== projectId ||
      !authority.current.strokes?.some(stroke => stroke.item.id === itemId)) return;
    clearConnectorSelection();
    setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    setSelection(previous => extend ? [...new Set([...previous, itemId])] : [itemId]);
  }
  const strokeDeleteRunning = useRef(false);
  async function removeStroke(value: CanvasStroke) {
    if (busy || historyBlocked || composition.current || pendingAction.current || strokeDeleteRunning.current ||
      strokeDraw.hasPending() || selection.length !== 1 || selection[0] !== value.item.id) return;
    const projectId = authority.current?.project.id, captured = structuredClone(value), epoch = ++editorEpoch.current;
    if (!projectId) return;
    strokeDeleteRunning.current = true;
    try {
      if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
        !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      if (editorEpoch.current !== epoch || authority.current?.project.id !== projectId ||
        !authority.current.strokes?.some(stroke => stroke.id === captured.id && stroke.item.id === captured.item.id)) return;
      await action({ commandId: crypto.randomUUID(), projectId, type: "stroke.delete",
        expected: { stroke: captured.versionId, pose: captured.item.versionId }, payload: { id: captured.id } });
    } finally { strokeDeleteRunning.current = false; }
  }
  const shapeDeleteRunning = useRef(false);
  async function removeShape(value: CanvasShape) {
    if (busy || historyBlocked || composition.current || pendingAction.current || shapeRecoveryRunning.current ||
      shapeDeleteRunning.current || selection.length !== 1 || selection[0] !== value.item.id) return;
    const ownerProject = authority.current?.project.id;
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== ownerProject) return;
    const snapshot = authority.current, visible = snapshot?.shapes?.find(shape => shape.id === value.id && shape.item.id === value.item.id);
    if (!snapshot || !visible || visible.versionId !== value.versionId || visible.item.versionId !== value.item.versionId) return;
    const projectId = snapshot.project.id, connectors = incidentConnectorVersions(snapshot, value.item.id);
    if (!connectors) { fail(new Error('请等待完整连线投影后重试删除')); return; }
    const captured = structuredClone(value), epoch = ++editorEpoch.current;
    const ownText = shapeText.currentSession()?.projectId === projectId && shapeText.currentSession()?.value.id === value.id;
    const ownGeometry = shapeMove.hasPending();
    shapeDeleteRunning.current = true;
    try {
      if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
        !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      if (editorEpoch.current !== epoch || authority.current?.project.id !== projectId ||
        !authority.current.shapes?.some(shape => shape.id === captured.id && shape.item.id === captured.item.id)) return;
      const textAck = ownText ? shapeText.confirmed() : null, poseAck = ownGeometry ? shapeMove.confirmed() : null;
      if (ownText && (textAck?.projectId !== projectId || textAck.value.id !== captured.id || textAck.value.item.id !== captured.item.id)) return;
      if (ownGeometry && (poseAck?.projectId !== projectId || poseAck.value.id !== captured.id || poseAck.value.item.id !== captured.item.id)) return;
      // Waiting may reveal peer changes. Only this visible snapshot and our
      // own intervening ACKs authorize deletion; a fresh read never does.
      await action({ commandId: crypto.randomUUID(), projectId, type: "shape.delete",
        expected: { shape: textAck?.value.versionId ?? captured.versionId, pose: poseAck?.value.item.versionId ?? captured.item.versionId, connectors },
        payload: { id: captured.id } });
    } finally { shapeDeleteRunning.current = false; }
  }
  async function beginShapeAppearance(id: string, trigger: HTMLButtonElement) {
    if (busy || historyBlocked || composition.current || pendingAction.current || shapeAppearanceOwner.current || shapeRecoveryRunning.current) return;
    const current = authority.current, visible = current?.shapes?.find(shape => shape.id === id);
    if (!current || !visible) return;
    const editingIdentity = editorEpoch.current;
    // Opening and recovery acquire the same transition before either can wait.
    shapeRecoveryRunning.current = true;
    try {
      const ownText = shapeText.session?.projectId === current.project.id && shapeText.session.value.id === id;
      if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      const live = authority.current;
      if (editorEpoch.current !== editingIdentity || shapeAppearanceOwner.current || live?.project.id !== current.project.id ||
        !live.shapes?.some(shape => shape.id === id && shape.item.id === visible.item.id)) return;
      const acknowledged = ownText ? shapeText.confirmed() : null;
      const value = acknowledged?.projectId === current.project.id && acknowledged.value.id === id ? acknowledged.value : visible;
      const binding = { projectId: current.project.id, value: structuredClone(value), trigger };
      shapeAppearanceOwner.current = binding; setShapeAppearance(binding);
    } finally { shapeRecoveryRunning.current = false; }
  }
  async function recoverShapeAppearance(key: string) {
    if (busy || historyBlocked || shapeAppearanceOwner.current || shapeRecoveryRunning.current) return;
    const projectId = authority.current?.project.id;
    if (!projectId) return;
    const editingIdentity = editorEpoch.current;
    shapeRecoveryRunning.current = true;
    try {
      const record = shapeJournal.list().find(value => value.key === key && value.value.projectId === projectId);
      if (!record || !(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      await api.project(projectId); // Recheck current authorization; never use this read as the draft's expected version.
      if (authority.current?.project.id !== projectId || editorEpoch.current !== editingIdentity || shapeAppearanceOwner.current) return;
      shapeJournal.write(record.value); // Adopt durably before retiring the selected old record.
      shapeJournal.remove(record.key);
      const binding = { projectId, value: record.value.original, journal: shapeJournal, record: record.value };
      shapeAppearanceOwner.current = binding; setShapeAppearance(binding);
    } catch { setShapeRecoveryError("无法接管形状外观恢复记录，原始草稿已保留"); }
    finally { shapeRecoveryRunning.current = false; }
  }
  function closeShapeAppearance() {
    const binding = shapeAppearanceOwner.current;
    shapeAppearanceOwner.current = null; setShapeAppearance(null);
    requestAnimationFrame(() => {
      if (binding?.trigger?.isConnected) binding.trigger.focus();
      else if (binding) document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(binding.value.item.id)}"] [role="img"]`)?.focus();
    });
  }
  async function beginShapeText(id: string) {
    if (busy || historyBlocked || composition.current || pendingAction.current || shapeRecoveryRunning.current) return;
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    const current = authority.current, value = current?.shapes?.find(shape => shape.id === id);
    if (!current || !value) return;
    setSelection([value.item.id]); setEditing(null); titleGroup.current = null;
    shapeText.begin(current.project.id, value);
  }
  async function recoverShapeText(key: string) {
    if (busy || historyBlocked || shapeAppearance || shapeRecoveryRunning.current) return;
    const projectId = authority.current?.project.id;
    if (!projectId) return;
    shapeRecoveryRunning.current = true;
    try {
      const record = shapeText.journal.list().find(value => value.key === key && value.value.session.projectId === projectId);
      if (!record || !(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      const editingIdentity = editorEpoch.current;
      await api.project(projectId); // Authorization only; the journal retains its own expected versions.
      if (authority.current?.project.id !== projectId || editorEpoch.current !== editingIdentity || shapeText.currentSession()) return;
      if (!shapeText.restore(record)) return;
      setSelection([record.value.session.value.item.id]); setEditing(null); titleGroup.current = null;
      setShapeTextRecoveries(shapeText.journal.list()); setShapeTextRecoveryError("");
    } catch { setShapeTextRecoveryError("无法接管形状文字恢复记录，原始草稿已保留"); }
    finally { shapeRecoveryRunning.current = false; }
  }
  async function leaveShapeSelection(itemId: string | null, extend: boolean) {
    const projectId = authority.current?.project.id;
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || authority.current?.project.id !== projectId) return;
    const current = authority.current;
    if (itemId && current && [...current.cards, ...(current.texts ?? []), ...(current.shapes ?? [])].some(value => value.item.id === itemId)) {
      setSelection(previous => extend ? [...new Set([...previous, itemId])] : [itemId]);
    } else if (!extend) setSelection([]);
  }
  async function createShape(x: number, y: number) {
    if (!state || !shapePreset || shapeCreating.current) return;
    shapeCreating.current = true;
    try {
      await action({
        commandId: crypto.randomUUID(), projectId: state.project.id, type: "shape.create", expected: null,
        payload: { id: crypto.randomUUID(), content: { shapeType: shapePreset, shortText: "" },
          pose: { x, y, width: 180, height: 120 } },
      }, () => setShapePreset(null));
    } finally { shapeCreating.current = false; }
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
        const card = authority.current?.cards.find((c) => c.id === id);
        if (card) { awaitBodySelection.current = false; setSelection([card.item.id]); }
        titleGroup.current = { cardId: id, id: editGroup };
        setEditing(id);
      },
    );
  }
  async function editCard(id: string, field: "title" | "body", valid = () => true, followingSelection = false) {
    if (historyLock.current || historyCommand.current) return;
    if (composition.current) return;
    const epoch = ++editorEpoch.current;
    const projectId = authority.current?.project.id;
    breakBodyGroup();
    await flush();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish())) return;
    if (authority.current?.project.id !== projectId || (field === "body" && epoch !== editorEpoch.current) || !valid()) return;
    // A failed save belongs to the old card; switching the visible editor
    // never changes that draft's target or its pending command.
    if (!followingSelection) {
      titleGroup.current = field === "title" ? { cardId: id, id: crypto.randomUUID() } : null;
      setEditing(field === "title" ? id : null);
    }
    if (field === "body") {
      const card = authority.current?.cards.find((c) => c.id === id);
      if (!card || !authority.current) return;
      bodyBinding.current = { projectId: authority.current.project.id, card };
      // Explicit navigation owns the panel until the next canvas selection.
      awaitBodySelection.current = !followingSelection;
      setDeletedBody(null);
      setSearchSeed(null); setBodySearchReading(null);
      setBodyCard(id);
      setBodyOpened(value => value + 1);
    }
    return true;
  }
  async function openSearch(reading: SearchReading, valid: () => boolean) {
    const projectId = authority.current?.project.id;
    if (!valid() || !projectId || composition.current || historyLock.current) return false;
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish())) return false;
    const identity = await api.cardIdentity(projectId, reading.result.cardId);
    if (!valid() || authority.current?.project.id !== projectId || identity.availability !== 'available' || identity.card.body.versionId !== reading.result.bodyVersion || identity.card.versionId !== reading.result.thoughtVersion) return false;
    const card = identity.card;
    if (bodyCard) { if (!(await editCard(card.id, 'body', valid))) return false; setSearchSeed(reading); setBodySearchReading(reading); }
    if (!valid() || authority.current?.project.id !== projectId) return false;
    awaitBodySelection.current = true;
    clearConnectorSelection();
    setSelection([card.item.id]);
    setPlacing(false); setPanTool(false);
    requestAnimationFrame(() => {
      const pose = card.item.pose;
      void flow.setCenter(pose.x + pose.width / 2, pose.y + pose.height / 2, { zoom: flow.getZoom(), duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180 });
      requestAnimationFrame(() => {
        const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => node.dataset.id === card.item.id);
        node?.querySelector<HTMLElement>('article')?.focus({ preventScroll: true });
      });
    });
    return true;
  }
  const following = useRef<string | null>(null);
  const selectedCards = useRef(selection);
  selectedCards.current = selection;
  useEffect(() => {
    if (!bodyCard || awaitBodySelection.current || selection.length !== 1 || composition.current || historyBlocked) return;
    const card = authority.current?.cards.find((c) => c.item.id === selection[0]);
    if (!card || card.id === bodyCard || following.current === card.id) return;
    const frame = requestAnimationFrame(() => {
      const valid = () => !awaitBodySelection.current && selectedCards.current.length === 1 && selectedCards.current[0] === card.item.id;
      if (!valid()) return;
      following.current = card.id;
      void editCard(card.id, "body", valid, true).finally(() => {
        if (following.current === card.id) following.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection, bodyCard, historyBlocked, status]);
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
          setStatus(scanRecovery() ? "有待恢复的未确认草稿" : "已保存到本机");
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
        appearance.hasPending() ||
        cardLayout.hasPending() ||
        pose.hasPending()
        || texts.hasPending() || shapeText.hasPending() || shapeMove.hasPending() || strokeDraw.hasPending() || imageGeometry.hasPending() || imageInput.hasPending()
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
  const texts = useCanvasTexts(state, selection, ids => { void shapeMove.flush().then(ok => ok && connectorLabel.finish()).then(ok => ok && shapeText.finish()).then(ok => { if (ok) { clearConnectorSelection(); setSelection(ids); } }); }, updateState, async () => await connectorLabel.finish() && await shapeText.finish() && await flush());
  const canvasMove = useCanvasMove(state, canvasSelection.value, (prepare, done) => texts.enqueueGeometry(async () => {
    if (!(await shapeMove.flush())) throw new Error("请先确认形状布局保存，整组移动意图仍保留");
    return prepare();
  }, done));
  function canvasDragPoint(event: MouseEvent | TouchEvent) {
    const pointer = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
    return pointer ? flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }, { snapToGrid: false }) : undefined;
  }
  async function createSelectedGroup() {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current) return;
    const intent = createGroupCommand(snapshot, canvasSelection.current());
    const generation = canvasSelection.generation();
    await action(intent, () => {
      if (authority.current?.project.id === intent.projectId && canvasSelection.generation() === generation)
        canvasSelection.set({ targets: [{ kind: 'group', id: intent.payload.id }], enteredGroupId: null });
    });
  }
  const textNodes = texts.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      edit: () => {
        const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
        const stillCurrent = () => authority.current?.project.id === projectId && editorEpoch.current === epoch;
        void shapeMove.flush().then(ok => ok && stillCurrent() && connectorLabel.finish())
          .then(ok => ok && stillCurrent() && shapeText.finish()).then(ok => { if (ok && stillCurrent()) node.data.edit(); });
      },
      moveDisabled: strokeSelected || node.data.moveDisabled || busy || historyBlocked || pose.pending || shapeMove.pending || shapeMove.dragging || !!shapeText.session,
      move: (dx: number, dy: number) => {
        if (strokeSelected || busy || historyBlocked || pose.pending || node.data.moveDisabled) return;
        if (canvasMove.start(node.id)) {
          canvasMove.finish({ x: node.data.value.item.pose.x + dx, y: node.data.value.item.pose.y + dy });
        } else node.data.move(dx, dy);
      },
    },
  }));
  const cardOnlySelection = selection.length > 0 && selection.every((id) =>
    state?.cards.some((card) => card.item.id === id),
  );
  const nodes: Node<CardData>[] = (state?.cards ?? []).map((card) => ({
    id: card.item.id,
    selected: selection.includes(card.item.id),
    style: {
      width: pose.positions[card.item.id]?.width ?? card.item.pose.width,
      height: pose.positions[card.item.id]?.height ?? card.item.pose.height,
    },
    type: "thought",
    // Flow uses these before its first node measurement; keep that fallback
    // on the same Pose/gesture projection as the rendered dimensions.
    initialWidth: pose.positions[card.item.id]?.width ?? card.item.pose.width,
    initialHeight: pose.positions[card.item.id]?.height ?? card.item.pose.height,
    ...(dimensions[card.item.id]
      ? { measured: dimensions[card.item.id]! }
      : {}),
    position: pose.positions[card.item.id] ?? {
      x: card.item.pose.x,
      y: card.item.pose.y,
    },
    draggable:
      !busy && !historyBlocked && !pose.pending && !placing && !panTool,
    data: {
      cardOnlySelection,
      card,
      previewBody: (() => {
        const draft = draftView[draftKey(state!.project.id, card.id, "body")];
        return draft ? { ...card.body, blocks: draft.blocks ?? [{ ...card.body.blocks[0]!, text: draft.value }] } : card.body;
      })(),
      tags: state!.tags ?? [],
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
      onCanvasChoice: () => { editorEpoch.current++; },
      onDelete: () => void removeCard(card.id),
      onMeasure: cardLayout.measure,
      measurable: !busy && !historyBlocked && !pose.pending && !pose.dragging && !shapeMove.hasPending(),
      onAppearance: (value) => {
        const current = authority.current;
        const target = current?.cards.find((c) => c.id === card.id);
        if (!current || !target || current.project.id !== state?.project.id)
          return;
        appearance.change(current.project.id, target.id, value);
      },
      appearanceValue: appearance.value(state!.project.id, card.id) ?? {
        titleColor:
          card.appearance?.titleColor ?? DEFAULT_APPEARANCE.titleColor,
        showPreview:
          card.appearance?.showPreview ?? DEFAULT_APPEARANCE.showPreview,
      },
      onComposition: compose,
      movingDisabled: strokeSelected || busy || historyBlocked || pose.pending || shapeMove.pending || shapeMove.dragging || texts.geometryBlocked || !!shapeText.session,
      historyBlocked,
      resizable: selection.length === 1 && selection.includes(card.item.id),
      onResize: (event, direction) => resize.start(event, card, direction),
      onResizeKey: (event, direction) => resize.key(event, card, direction),
      onMove: (dx, dy) => {
        if (canvasMove.start(card.item.id)) { canvasMove.finish({ x: card.item.pose.x + dx, y: card.item.pose.y + dy }); return; }
        if (startMove(state!.project.id, card)) {
          pose.finish({ x: card.item.pose.x + dx, y: card.item.pose.y + dy });
          moving.current = null;
        }
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
  const hasRecovery = recoveries.some(
    (r) => r.value.projectId === state?.project.id,
  );
  const recoveryAlert = (recoveryNotice || recoveryError) && (
    <div
      className="recovery-error"
      role="alert"
      style={hasRecovery ? { position: "static" } : undefined}
    >
      {recoveryNotice && <p style={{ margin: 0 }}>{recoveryNotice}</p>}
      {recoveryError && <p style={{ margin: 0 }}>{recoveryError}</p>}
    </div>
  );
  return (
    <div
      className="workspace"
      data-snapshot={state?.snapshot}
      data-revision={state?.project.revision}
      onClickCapture={event => {
        const target = event.target as Element;
        if (connectorLabel.currentSession() && !connectorLabelHistoryBusy && !target.closest('.connector-label-session') &&
          (!target.closest('.connector-tools') || target.closest('.connector-label-position input')) &&
          (target.closest('.react-flow__controls') || !target.closest('.react-flow__node, .react-flow__pane, .canvas-connector, .connector-label'))) {
          void connectorLabel.finish();
        }
      }}
    >
      {syncNotice && (
        <div className="recovery-error" aria-live="polite">
          {syncNotice}
        </div>
      )}
      <header className="topbar">
        {state && <ProjectSearch key={state.project.id} projectId={state.project.id} revision={state.project.revision} tags={state.tags ?? []} cards={state.cards} onOpen={openSearch} disabled={busy || historyBlocked} />}
        <button
          disabled={!state || busy || historyBlocked || imageGeometry.hasPending(state.project.id) || imageInput.hasPending(state.project.id)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void travel("undo")}
        >
          撤销
        </button>
        <button
          disabled={!state || busy || historyBlocked || imageGeometry.hasPending(state.project.id) || imageInput.hasPending(state.project.id)}
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
      <main
        className={panelCard ? "canvas with-editor" : "canvas"}
        tabIndex={0}
        onPaste={event => {
          if (busy || historyBlocked || composition.current || pendingAction.current || !state) return;
          if (imageInput.paste(event)) return;
          const text = canvasPlainText(event);
          if (text === null) return;
          event.preventDefault();
          const rect = event.currentTarget.querySelector('.react-flow')!.getBoundingClientRect();
          const point = flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: 'thought.create', expected: null,
            payload: { id: crypto.randomUUID(), title: '', text, x: point.x - 140, y: point.y - 80 } });
        }}
        onClickCapture={(event) => {
          if (connectorCreate.consumeClick({ x: event.clientX, y: event.clientY })) { event.preventDefault(); event.stopPropagation(); return; }
          if (connectorLabel.session && !(event.target as Element).closest('.connector-label-session, .connector-tools, .react-flow__controls') &&
            (event.target as Element).closest('.react-flow__node, .react-flow__pane, .canvas-connector, .connector-label')) {
            event.preventDefault(); event.stopPropagation();
            const target = event.target as Element, itemId = target.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? null;
            const lineId = target.closest<HTMLElement | SVGElement>('[data-connector-id]')?.dataset.connectorId ?? null;
            void leaveConnectorLabel(itemId, lineId, event.shiftKey); return;
          }
          if (imageGeometry.cropping?.projectId === state?.project.id && state && !(event.target as Element).closest('.image-crop')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          if (strokeDraw.mode && (event.target as Element).closest('.react-flow__node, .react-flow__pane')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          if (shapeText.session && (event.target as Element).closest('.react-flow__node, .react-flow__pane') && !(event.target as Element).closest('.shape-text-session, .shape-text-actions')) {
            event.preventDefault(); event.stopPropagation();
            const itemId = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id ?? null;
            void leaveShapeSelection(itemId, event.shiftKey); return;
          }
          if (shapePreset && !busy && !historyBlocked && (event.target as Element).closest('.react-flow__node, .react-flow__pane') && !(event.target as Element).closest('.card-actions, .text-actions, .react-flow__controls')) {
            event.preventDefault(); event.stopPropagation();
            const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            void createShape(point.x, point.y); return;
          }
          if (texts.placing && !busy && !historyBlocked && (event.target as Element).closest('.react-flow__node, .react-flow__pane') && !(event.target as Element).closest('.text-actions, .react-flow__controls')) {
            event.preventDefault(); event.stopPropagation(); const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); void texts.create(point.x, point.y); return;
          }
          if (
            placing &&
            !busy &&
            !historyBlocked &&
            (event.target as Element).closest(
              ".react-flow__node, .react-flow__pane",
            ) &&
            !(event.target as Element).closest(
              ".card-actions, .react-flow__controls",
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            const point = flow.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            void createCard(point.x, point.y);
            return;
          }
          const itemId = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id;
          if (itemId && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]') && canvasSelection.consumeClick(itemId, event.shiftKey)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onPointerMoveCapture={event => { if (!connectorEdit.input(event) && !connectorCreate.input(event)) strokeDraw.move(event); }}
        onPointerUpCapture={event => { if (!connectorEdit.input(event) && !connectorCreate.input(event)) strokeDraw.finish(event); }}
        onMouseDownCapture={event => {
          const hit = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id;
          if (hit && event.button === 0 && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]'))
            canvasMove.mouseOrigin(hit, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }));
        }}
        onPointerDownCapture={(event) => {
          if (imageGeometry.cropping?.projectId === state?.project.id && state && event.button === 0 && !(event.target as Element).closest('.image-crop')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          if (connectorCreate.input(event)) return;
          if (strokeDraw.start(event)) return;
          if (shapeText.session && (event.target as Element).closest('.react-flow__node, .react-flow__pane') && !(event.target as Element).closest('.shape-text-session, .shape-text-actions')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          canvasSelection.retirePointer();
          const hit = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id;
          if (hit && event.button === 0 && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]')) {
            const captured = canvasSelection.capture(hit, event.shiftKey);
            if (captured) canvasMove.arm(hit, captured.state, captured.selection,
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }));
          }
          if (
            event.button === 0 &&
            (event.target as HTMLElement).classList.contains(
              "react-flow__pane",
            ) &&
            !(event.target as HTMLElement).classList.contains("draggable") &&
            !placing &&
            !shapePreset &&
            !strokeDraw.mode &&
            !texts.placing &&
            !panTool
          ) {
            editorEpoch.current++;
            awaitBodySelection.current = false;
            marqueeSelection.current = {
              previous: structuredClone(canvasSelection.current()),
              selectedIds: new Set(),
              shift: event.shiftKey,
            };
          }
        }}
      >
        {state ? (
          <ReactFlow
            style={{ '--connector-controls-layer': connectorTargets.controlsLayer } as CSSProperties}
            ariaLabelConfig={{
              "controls.ariaLabel": "画布视图",
              "controls.zoomIn.ariaLabel": "放大",
              "controls.zoomOut.ariaLabel": "缩小",
              "controls.fitView.ariaLabel": "适应画布",
            }}
            nodes={orderCanvas([...nodes, ...textNodes, ...imageNodes(state.images ?? [], state.project.id, selection, (id, extend) => void chooseCanvasItem(id, extend), busy || historyBlocked || composition.current || !!pendingAction.current || placing || !!shapePreset || texts.placing || panTool || !!strokeDraw.mode || !!shapeText.session || texts.geometryBlocked, imageGeometry, (value, dx, dy) => { if (canvasMove.start(value.item.id)) canvasMove.finish({ x: value.item.pose.x + dx, y: value.item.pose.y + dy }); }), ...shapeNodes(state.shapes ?? [], selection, (id, extend) => void chooseCanvasItem(id, extend), busy || historyBlocked || placing || !!shapePreset || texts.placing || panTool, id => void beginShapeText(id), !!shapeText.session, (id, trigger) => void beginShapeAppearance(id, trigger), value => void removeShape(value), shapeMove.positions, shapeMove, composition.current || !!pendingAction.current || pose.pending || pose.dragging || canvasMove.dragging || texts.hasPending() || appearance.pending || cardLayout.pending), ...strokeNodes(state.strokes ?? [], selection, (id, extend) => void chooseStrokeItem(id, extend), value => void removeStroke(value), busy || historyBlocked || !!pendingAction.current || placing || !!shapePreset || texts.placing || panTool || !!strokeDraw.mode || !!shapeText.session)].map(node => ({ ...node, selected: flowSelection.includes(node.id), position: canvasMove.positions[node.id] ?? shapeMove.positions[node.id] ?? node.position, draggable: node.draggable !== false && !strokeSelected && !strokeDraw.mode && !busy && !historyBlocked && !panTool && !placing && !shapePreset && !texts.placing && !texts.geometryBlocked && !shapeText.session && !connectorLabel.session && !shapeMove.pending })), state, selection)}
            onNodeClick={(event, node) => {
              awaitBodySelection.current = false;
              clearConnectorSelection();
              canvasSelection.choose(node.id, event.shiftKey);
            }}
            nodeDragThreshold={3}
            nodeClickDistance={3}
            selectionOnDrag={!placing && !shapePreset && !strokeDraw.mode && !connectorCreate.mode && !panTool && !texts.placing && !shapeText.session && !connectorLabel.session}
            selectionKeyCode={null}
            multiSelectionKeyCode="Shift"
            selectionMode={SelectionMode.Full}
            panOnDrag={panTool ? [0, 1, 2] : [1, 2]}
            zoomOnDoubleClick={false}
            onSelectionEnd={() => {
              marqueeSelection.current = null;
            }}
            onNodeDragStart={(event, node) => {
              if (canvasMove.pointerEnded(node.id)) return;
              canvasSelection.beginDrag(node.id);
              const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
              if (canvasMove.start(node.id, true)) { canvasMove.drag(point); return; }
              if (strokeSelected) return;
              if (node.type === "canvasShape") { shapeMove.start(node.id); shapeMove.preview(node.id, point); return; }
              if (texts.startMove(node.id)) { texts.previewMove(node.id, point); return; }
              const card = authority.current?.cards.find(
                (c) => c.item.id === node.id,
              );
              if (card && startMove(authority.current!.project.id, card)) previewMove(point, 'altKey' in event && event.altKey);
            }}
            onNodeDrag={(event, node) => {
              if (canvasMove.pointerEnded(node.id)) return;
              const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
              if (canvasMove.drag(point)) return;
              if (node.type === "canvasShape") { shapeMove.preview(node.id, point); return; }
              if (!texts.previewMove(node.id, point)) previewMove(point, "altKey" in event && event.altKey);
            }}
            onNodeDragStop={(event, node) => {
              if (canvasMove.pointerEnded(node.id)) return;
              const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
              canvasMove.endPointer();
              canvasSelection.finishDrag();
              if (canvasMove.finish(point)) return;
              if (node.type === "canvasShape") { shapeMove.finish(node.id, point); return; }
              if (texts.finishMove(point)) return;
              previewMove(point, 'altKey' in event && event.altKey);
              pose.finish(moving.current?.aligned ?? point);
              moving.current = null;
              setGuides([]);
            }}
            onNodesChange={(changes) => {
              const selected = changes.filter(
                (change) => change.type === "select",
              );
              const marquee = marqueeSelection.current;
              if (marquee && selected.length && !shapeText.session && !connectorLabel.session) {
                  for (const change of selected)
                    if (change.type === "select") {
                      if (change.selected) marquee.selectedIds.add(change.id);
                      else marquee.selectedIds.delete(change.id);
                    }
                  canvasSelection.marquee([...marquee.selectedIds], marquee.previous, marquee.shift);
              }
              for (const change of changes)
                if (change.type === "position" && change.position) {
                  if (canvasMove.consumesPosition()) continue;
                  if (canvasMove.preview(change.id, change.position)) continue;
                  if (state.shapes?.some(shape => shape.item.id === change.id)) {
                    shapeMove.preview(change.id, change.position); continue;
                  }
                  if (!texts.previewMove(change.id, change.position)) pose.preview(change.id, change.position);
                }
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
            elevateNodesOnSelect={false}
            nodesDraggable
            nodesFocusable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onPaneClick={(event) => {
              if (!event.shiftKey) setSelectedConnector(null);
              if (placing && !busy && !historyBlocked) {
                const point = flow.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                });
                void createCard(point.x, point.y);
              } else if (!event.shiftKey) setSelection([]);
              marqueeSelection.current = null;
            }}
          >
            <Background gap={24} color="#dce0e7" />
            <Controls showInteractive={false} />
            <ViewportPortal>
              <CanvasGroups state={state} selection={canvasSelection.value} positions={canvasMove.positions}
                blocked={busy || historyBlocked || !!pendingAction.current || texts.hasPending()}
                create={() => void createSelectedGroup()}
                enter={id => canvasSelection.set({ targets: [], enteredGroupId: id })} />
              {(state.connectors ?? []).map(value => <CanvasConnector key={value.id} value={value} selected={selectedConnectors.includes(value.id)} resolve={connectorTargets.resolve}
                labelEditor={{ ...connectorLabel, begin: origin => void beginConnectorLabel(value.id, origin), finish: () => void finishConnectorLabel(),
                  history: travelConnectorLabel, locked: connectorLabelHistoryBusy,
                  blocked: busy || historyBlocked || composition.current || !!pendingAction.current || !!connectorLabel.session || connectorEdit.hasPending(),
                  move: (original, position) => { if (original.label) void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: 'connector.label', expected: original.versionId,
                    payload: { id: original.id, label: { ...original.label, position } } }); } }}
                focus={connectorCreate.focusId === value.id || connectorEdit.focusId === value.id}
                focused={() => { if (connectorCreate.focusId === value.id) connectorCreate.focused(); if (connectorEdit.focusId === value.id) connectorEdit.focused(); }}
                drag={event => { if (!connectorLabel.session) connectorEdit.move(value, event); }}
                choose={extend => { if (!connectorCreate.hasPending() && !connectorEdit.hasPending()) { editorEpoch.current++; setSelection([]);
                  setSelectedConnectors(previous => extend ? previous.includes(value.id) ? previous.filter(id => id !== value.id) : [...previous, value.id] : [value.id]); } }} />)}
              {!connectorLabel.session && (state.connectors ?? []).filter(value => value.id === selectedConnector).map(value => <ConnectorHandles key={value.id} value={value}
                resolve={connectorTargets.resolve} blocked={busy || historyBlocked || composition.current || !!pendingAction.current}
                start={(endpoint, event) => connectorEdit.start(value, endpoint, event)} activate={(endpoint, origin) => connectorEdit.startKeyboard(value, endpoint, origin)} />)}
              <ConnectorPreview draft={connectorEdit.draft?.projectId === state.project.id ? connectorEdit.draft : null} />
              <ConnectorPreview draft={connectorCreate.draft?.projectId === state.project.id ? connectorCreate.draft : null} />
              {!connectorEdit.keyboardMoving && (connectorCreate.mode || connectorEdit.keyboardEndpoint) && <ConnectorEntries values={connectorTargets.values}
                choose={connectorEdit.keyboardEndpoint ? connectorEdit.chooseAnchor : connectorCreate.chooseAnchor}
                preview={connectorEdit.keyboardEndpoint ? connectorEdit.previewAnchor : connectorCreate.previewAnchor} />}
              <StrokePreview draft={strokeDraw.draft} />
              {shapeText.session && <ShapeTextEditor key={shapeText.session.projectId + ":" + shapeText.session.value.id}
                session={shapeText.session} locked={shapeText.locked} error={shapeText.error}
                conflict={shapeText.conflict} recovering={shapeText.recovering} recover={() => void shapeText.recover()}
                change={shapeText.change} compose={shapeText.compose} finish={() => void shapeText.finish()}
                appearance={trigger => void beginShapeAppearance(shapeText.session!.value.id, trigger)} />}
              {guides.map((guide, i) => (
                <div
                  key={i}
                  className="alignment-guide"
                  data-axis={guide.axis}
                  style={
                    guide.axis === "x"
                      ? {
                          left: guide.position,
                          top: guide.start,
                          width: 1,
                          height: guide.end - guide.start,
                        }
                      : {
                          left: guide.start,
                          top: guide.position,
                          height: 1,
                          width: guide.end - guide.start,
                        }
                  }
                />
              ))}
            </ViewportPortal>
          </ReactFlow>
        ) : (
          <div className="empty">
            <h1>从一个想法开始</h1>
            <p>新建研究，在画布上记下第一张卡片。</p>
          </div>
        )}
        {state && connectorCreate.mode && <ConnectorCreateControls active={connectorCreate.keyboardActive} focusFree={connectorCreate.draft?.startEndpoint.kind === 'free'}
          blocked={connectorCreate.keyboardBlocked()} composing={() => composition.current} start={connectorCreate.startBlank}
          preview={connectorCreate.previewFree} choose={connectorCreate.chooseFree} cancel={connectorCreate.cancelDraft} />}
        {state && connectorEdit.keyboardEndpoint && <ConnectorEndpointControls endpoint={connectorEdit.keyboardEndpoint}
          blocked={connectorEdit.keyboardBlocked()} composing={() => composition.current} preview={connectorEdit.previewFree}
          choose={connectorEdit.chooseFree} cancel={connectorEdit.cancel} />}
        {state && (!connectorEdit.keyboardActive || connectorEdit.keyboardMoving) && (state.connectors ?? []).filter(value => value.id === selectedConnector).map(value =>
          <ConnectorPathControls key={value.id} value={value} blocked={busy || historyBlocked || composition.current || !!pendingAction.current || connectorEdit.hasPending()}
            appearance={style => void afterConnectorLabel(value, prepared => { void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: 'connector.style', expected: prepared.versionId, payload: { id: prepared.id, style } }); })}
            reverse={reverseConnectors}
            editLabel={origin => void beginConnectorLabel(value.id, origin)}
            labelStyle={patch => void afterConnectorLabel(value, prepared => {
              if (prepared.label) void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: 'connector.label', expected: prepared.versionId,
                payload: { id: prepared.id, label: { ...prepared.label, ...patch } } });
            })}
            choose={(path, origin) => void afterConnectorLabel(value, prepared => connectorEdit.path(prepared, path, origin))} remove={() => void afterConnectorLabel(value, connectorEdit.remove)}
            move={{ active: connectorEdit.keyboardMoving, blocked: connectorEdit.keyboardBlocked(), composing: () => composition.current,
              start: origin => void afterConnectorLabel(value, prepared => connectorEdit.startKeyboard(prepared, 'line', origin)), preview: connectorEdit.previewMove, finish: connectorEdit.chooseMove, cancel: connectorEdit.cancel }} />)}
        {state && selectedConnectors.length > 1 && <div className="creation-tools connector-tools" role="toolbar" aria-label="连线多选">
          <span>已选 {selectedConnectors.length} 条连线</span><button type="button" disabled={busy || historyBlocked || composition.current || !!pendingAction.current || connectorEdit.hasPending()} onClick={reverseConnectors}>反转方向</button>
        </div>}
        {state && (
          <div className="creation-tools" aria-label="创作工具">
            <button
              aria-pressed={!placing && !shapePreset && !strokeDraw.mode && !connectorCreate.mode && !panTool && !texts.placing}
              onClick={() => {
                if (strokeDraw.hasPending() || connectorCreate.hasPending()) return;
                connectorEdit.cancel();
                connectorCreate.deactivate();
                strokeDraw.setMode(null);
                setPlacing(false);
                setShapePreset(null);
                texts.setPlacing(false);
                setPanTool(false);
              }}
            >
              选择
            </button>
            <button
              aria-pressed={panTool}
              onClick={() => {
                if (strokeDraw.hasPending()) return;
                editorEpoch.current++;
                connectorEdit.cancel();
                connectorCreate.deactivate();
                strokeDraw.setMode(null);
                setPlacing(false);
                setShapePreset(null);
                texts.setPlacing(false);
                setPanTool(true);
              }}
            >
              移动
            </button>
            <button
              aria-label="对齐吸附"
              aria-pressed={snap}
              title="拖动时按住 Alt 临时关闭"
              onClick={() => setSnap((value) => !value)}
            >
              对齐吸附：{snap ? "开" : "关"}
            </button>
            <button
              aria-pressed={placing}
              disabled={busy || historyBlocked}
              onClick={() => {
                if (strokeDraw.hasPending()) return;
                beginCreationToolChoice();
                strokeDraw.setMode(null);
                setPanTool(false);
                setShapePreset(null);
                texts.setPlacing(false);
                setPlacing(true);
              }}
            >
              卡片
            </button>
            <button aria-pressed={connectorCreate.mode} disabled={busy || historyBlocked || connectorCreate.hasPending() || strokeDraw.hasPending()}
              onClick={() => {
                if (!authority.current?.project.id || connectorCreationBlocked() || connectorCreate.hasPending()) return;
                connectorEdit.cancel();
                void connectorCreate.activate();
              }}>连线</button>
            <button aria-pressed={texts.placing} disabled={busy || historyBlocked || strokeDraw.drawing} onClick={() => { beginCreationToolChoice(); strokeDraw.setMode(null); setPlacing(false); setShapePreset(null); setPanTool(false); texts.setPlacing(true); }}>文字</button>
            <ShapeTools placing={shapePreset} disabled={busy || historyBlocked || strokeDraw.drawing} choose={type => {
              beginCreationToolChoice();
              strokeDraw.setMode(null); setPlacing(false); texts.setPlacing(false); setPanTool(false); setShapePreset(type);
            }} />
            <StrokeTools active={strokeDraw.mode} disabled={busy || historyBlocked || strokeDraw.drawing} choose={chooseStroke} />
            <button disabled={busy || historyBlocked || imageInput.pending || strokeDraw.drawing} onClick={() => imageFile.current?.click()}>图片</button>
            <input ref={imageFile} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void imageInput.begin(file); }} />
            {imageInput.error && <section aria-label="图片导入失败">
              <p role="alert">{imageInput.error}</p>
              <button onClick={() => void imageInput.retry()}>重试图片保存</button>
            </section>}
            {imageInput.active && <button disabled={!imageInput.cancellable} onClick={imageInput.cancel}>取消图片导入</button>}
            {imageInput.recoveryError && <p role="alert">{imageInput.recoveryError}</p>}
            {imageInput.recoveries.filter(record => record.input.placement.projectId === state.project.id).map(record =>
              <button key={record.key} disabled={busy || historyBlocked} onClick={() => void imageInput.recover(record.key)}>恢复未确认图片</button>)}
            {shapePreset && <span>点击画布放置{shapePreset === "roundedRectangle" ? "圆角矩形" : shapePreset === "rectangle" ? "矩形" : shapePreset === "ellipse" ? "椭圆" : shapePreset === "diamond" ? "菱形" : "三角形"}</span>}
            {texts.error && <span role="alert">{texts.error}</span>}
            {placing && <span>点击画布放置卡片</span>}
          </div>
        )}
      </main>
      {panelCard && (
        <WritingBoard
          key={state!.project.id}
          projectId={state!.project.id} cardId={panelCard.id} opened={bodyOpened}
          title={draftView[draftKey(state!.project.id, panelCard.id, "title")]?.value ?? panelCard.title}
          status={!currentBody ? "已删除 · 内容保留" : saveStatus}
          onClose={() => {
            if (composition.current) return;
            editorEpoch.current++;
            breakBodyGroup(); persistDrafts(); void flush();
            bodyBinding.current = null; setDeletedBody(null); setBodyCard(null); setSearchSeed(null); setBodySearchReading(null);
          }}
        >
          {currentBody && <ProjectTags key={state!.project.id + ':' + currentBody.id} state={state!} card={currentBody} blocked={busy || historyBlocked} execute={action} refresh={refresh} undo={id => void travel('undo', id)} />}
          {currentBody && <BodyFind key={state!.project.id + ":" + currentBody.id + ":" + bodyOpened} projectId={state!.project.id} card={currentBody} updating={!!draftView[draftKey(state!.project.id, currentBody.id, "body")]} seed={searchSeed?.result.cardId === currentBody.id ? searchSeed : null} onReading={setBodySearchReading} />}
          {!currentBody ? (
            <section className="deleted-body" aria-label="已删除卡片">
              <p>这张卡片已删除</p>
              <button
                disabled={historyBlocked || !deletedBody?.canRestore}
                onClick={() => {
                  const actionId = deletedBody?.actionId;
                  if (actionId) void travel(deletedBody!.direction, actionId);
                }}
              >
                撤销删除
              </button>
              {!deletedBody?.canRestore && <p>这次删除的恢复已不可用</p>}
            </section>
          ) : null}
            <>
              <label htmlFor="card-body">卡片正文</label>
              <ParagraphEditor
                key={state!.project.id + ":" + panelCard.id}
                projectId={state!.project.id}
                onMediaRetry={block=>{void mediaQueue.retry(block);}}
                readingIdentity={state!.project.id + ":" + panelCard.id}
                searchReading={bodySearchReading?.result.cardId === panelCard.id ? bodySearchReading : null}
                blocks={(() => {
                  const draft = draftView[draftKey(state!.project.id, panelCard.id, "body")];
                  return draft?.blocks ?? (draft ? [{ ...panelCard.body.blocks[0]!, text: draft.value }] : panelCard.body.blocks);
                })()}
                readOnly={historyBlocked || !currentBody}
                onChange={(blocks, inputType, cursor) => { if (currentBody) change("body", currentBody, bodyText({ blocks }), { inputType, ...cursor }, blocks); }}
                onOriginalCopy={(before,after)=>{ if (currentBody) void copyOriginalBody(currentBody.id,before,after); }}
                onSelect={(cursor: TextCursor) => {
                  const group = bodyGroup.current;
                  if (!composition.current && group && (cursor.start !== group.start || cursor.end !== group.end || cursor.blockId !== group.blockId)) breakBodyGroup();
                }}
                onComposition={compose}
                onHistory={direction => travel(direction)}
                onFinish={() => { breakBodyGroup(); void flush(); }}
              />
            </>
        </WritingBoard>
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
      {shapeMove.conflict && <section className="conflict-panel" aria-label={shapeMove.conflict.type === "shape.transform" ? "形状尺寸保存冲突" : "形状位置保存冲突"}>
        <h2>形状布局已由其他调用者更新</h2>
        <p>本次位置：{shapeMove.conflict.local.x}, {shapeMove.conflict.local.y}</p>
        <p>已保存位置：{shapeMove.conflict.remote.item.pose.x}, {shapeMove.conflict.remote.item.pose.y}</p>
        {shapeMove.conflict.type === "shape.transform" ? <>
          <p>本次尺寸：{shapeMove.conflict.local.width}, {shapeMove.conflict.local.height}</p>
          <p>已保存尺寸：{shapeMove.conflict.remote.item.pose.width}, {shapeMove.conflict.remote.item.pose.height}</p>
          <p>确认后保存本次位置和尺寸，保留当前内容；对方布局仍可从历史回查。</p>
        </> : <p>确认后只保存本次位置，保留当前内容和尺寸；对方位置仍可从历史回查。</p>}
        <button disabled={shapeMove.working} onClick={shapeMove.resolveConflict}>{shapeMove.conflict.type === "shape.transform" ? "确认保留本次尺寸" : "确认保留本次位置"}</button>
      </section>}
      {shapeMove.deleted && <section className="conflict-panel" aria-label="形状调整目标已删除">
        <h2>形状调整目标已删除</h2>
        <p>“{shapeMove.deleted.value.content.shortText || "形状"}”已删除。取消只放弃本次未完成的调整，不恢复形状；已确认的操作仍保留在历史中。</p>
        <button disabled={shapeMove.working} onClick={() => void shapeMove.discardDeleted()}>取消本次调整</button>
      </section>}
      {shapeAppearance && <ShapeAppearance binding={shapeAppearance} close={closeShapeAppearance}
        publish={value => { if (authority.current?.project.id === value.project.id) updateState(value); }} />}
      {texts.conflict && <TextConflictPanel value={texts.conflict} resolve={texts.resolveConflict} />}
      {texts.mixedConflict && <CanvasMoveConflictPanel value={texts.mixedConflict} abandon={texts.abandonMixedMove} />}
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
                  ? bodyText(conflict.remote.body)
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
      {connectorLabel.session?.projectId === state?.project.id && !state?.connectors?.some(line => line.id === connectorLabel.session?.value.id) &&
        <DetachedConnectorLabelEditor editor={{ ...connectorLabel, finish: () => void finishConnectorLabel(), history: travelConnectorLabel, locked: connectorLabelHistoryBusy }} />}
      {(connectorLabel.recoveryError || connectorLabel.recoveries.some(record => record.value.session.projectId === state?.project.id)) &&
        <section className="recovery-panel" aria-label="连线文字恢复">
          {connectorLabel.recoveryError && <p role="alert">{connectorLabel.recoveryError}</p>}
          {connectorLabel.recoveries.filter(record => record.value.session.projectId === state?.project.id).map(record =>
            <button key={record.key} disabled={busy || historyBlocked || !!connectorLabel.session}
              onClick={() => void recoverConnectorLabel(record.key, record.value.session.value.id)}>{record.value.purpose === 'preserved-remote' ? '查看已保存文字副本' : '恢复连线文字'}</button>)}
        </section>}
      {hasRecovery && (
        <section className="recovery-panel" aria-label="草稿恢复">
          <h2>可恢复草稿</h2>
          {recoveryAlert}
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
      {state && deletedRecovery &&
        deletedRecovery.projectId === state.project.id &&
        !state?.cards.some((c) => c.id === deletedRecovery?.cardId) && (
          <aside className="body-editor" aria-label="已删除卡片">
            <h2>这张卡片已删除</h2>
            <p>原草稿仍保留在恢复区。</p>
            <button
              disabled={historyBlocked || !deletedRecovery?.actionId}
              onClick={() => {
                if (deletedRecovery?.actionId)
                  void travel(deletedRecovery.direction ?? "redo", deletedRecovery.actionId);
              }}
            >
              撤销删除
            </button>
            {!deletedRecovery?.actionId && <p>这次删除的恢复已不可用</p>}
            <button onClick={() => setDeletedRecovery(null)}>关闭</button>
          </aside>
        )}
      {!hasRecovery && recoveryAlert}
      {historyNotice && (
        <div className="history-notice" aria-live="polite">
          {historyNotice}
        </div>
      )}
      <div className="save-state">
        {connectorCreate.error && <><span role="alert">{connectorCreate.error}</span>
          {connectorCreate.retryable && <button disabled={connectorCreate.working} onClick={() => void connectorCreate.retry()}>重试保存连线</button>}
          {connectorCreate.rejected && <button disabled={connectorCreate.working} onClick={() => void connectorCreate.abandon()}>放弃本次连线</button>}</>}
        {connectorCreate.recoveries.map(record => <button key={record.key} disabled={connectorCreate.working}
          onClick={() => void connectorCreate.recover(record.key)}>恢复未确认连线</button>)}
        {imageGeometry.error && <><span role="alert">{imageGeometry.error}</span>{imageGeometry.rejected
          ? <button onClick={() => void imageGeometry.abandon()}>放弃本次图片调整，保留已保存状态</button>
          : <button onClick={() => void imageGeometry.retry()}>重试图片调整</button>}</>}
        {!pendingAction.current && strokeRecoveries.filter(record => record.command.projectId === state?.project.id).map(record =>
          <button key={record.key} disabled={busy || historyBlocked} onClick={() => void recoverStrokeCreate(record.key)}>恢复未确认笔迹</button>)}
        {state && strokeRecoveryError && <span role="alert">{strokeRecoveryError}</span>}
        {!shapeAppearance && shapeRecoveries.filter(record => record.value.projectId === state?.project.id).map(record =>
          <button key={record.key} onClick={() => void recoverShapeAppearance(record.key)}>恢复形状外观草稿</button>)}
        {state && shapeRecoveryError && <span role="alert">{shapeRecoveryError}</span>}
        {!shapeAppearance && !shapeText.session && shapeTextRecoveries.filter(record => record.value.session.projectId === state?.project.id).map(record =>
          <button key={record.key} onClick={() => void recoverShapeText(record.key)}>恢复形状文字草稿</button>)}
        {state && shapeTextRecoveryError && <span role="alert">{shapeTextRecoveryError}</span>}
        {shapeMove.error && <><span role="alert">{shapeMove.error}</span><button disabled={shapeMove.working || !!shapeMove.conflict} onClick={() => void shapeMove.retry()}>{shapeMove.transforming ? "重试保存形状尺寸" : "重试保存形状位置"}</button></>}
        {texts.mixedRecoveries.map(record => <button key={record.key} onClick={() => texts.recoverMixedMove(record.key)}>恢复混合移动草稿</button>)}
        {texts.conflictRecoveries.map(record => <button key={record.key} onClick={() => void recoverCanvasText(record.key, 'conflict')}>恢复独立文字草稿</button>)}
        {texts.createRecoveries.map(record => <button key={record.key} onClick={() => void recoverCanvasText(record.key, 'create')}>恢复独立文字草稿</button>)}
        {texts.formatRecoveries.map(record => <button key={record.key} onClick={() => void recoverCanvasText(record.key, 'format')}>恢复独立文字草稿</button>)}
        {texts.recoveries.map(record => <button key={record.key} onClick={() => void recoverCanvasText(record.key, 'draft')}>恢复独立文字草稿</button>)}
        {texts.error && <><span role="alert">{texts.error}</span><button onClick={() => void texts.retry()}>重试{texts.operationScope}保存</button></>}
        {mediaQueue.hasUnconfirmed && <button onClick={mediaQueue.retryUnconfirmed} disabled={historyBlocked}>重试媒体保存确认</button>}
        <span role="status" aria-live="polite">
          {connectorCreate.working ? '正在保存…' : shapeMove.status || shapeText.status || texts.status || (appearance.error
            ? "外观保存未完成"
            : appearance.pending
              ? "外观等待保存…"
              : cardLayout.error
                ? "卡面布局保存未完成"
                : cardLayout.pending
                  ? "卡面布局等待保存…"
                  : pose.error
                    ? "布局保存未完成"
                    : pose.pending || pose.dragging
                      ? "布局等待保存…"
                      : recovery.current?.damaged && status === "已保存到本机"
                        ? "部分恢复记录未确认"
                        : saveStatus)}
        </span>
        {(appearance.error || appearance.pending || cardLayout.error) && (
          <>
            {(appearance.error || cardLayout.error) && (
              <span role="alert">
                {[appearance.error, cardLayout.error]
                  .filter(Boolean)
                  .join("；")}
              </span>
            )}
            {appearance.pending && (
              <button
                onClick={() => void appearance.flush()}
                disabled={!!appearance.conflict}
              >
                重试外观保存
              </button>
            )}
            {appearance.conflict && (
              <button onClick={() => void appearance.reapply()}>
                确认保留我的外观
              </button>
            )}
            {cardLayout.error && (
              <button onClick={() => void cardLayout.flush()}>
                重试卡面布局
              </button>
            )}
          </>
        )}
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
