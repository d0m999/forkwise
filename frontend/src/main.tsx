import { captureSpatial, frameCandidate, frameCreationParent, spatialItems } from '../../backend/src/mapping/frame-spatial';
import { canvasPlainText } from "./canvas-paste";
import { CANVAS_CLIPBOARD_TYPE, canCopySelection, canCutSelection, captureClipboard, clipboardAssetIds, clipboardCenter, clipboardLibrary, copiedSelection, duplicatePlan, parseClipboard, pastePlan, restoredCopyRefs } from "./canvas-snapshot";
import { captureCutCommand } from "../../backend/src/mapping/cut-command";
import { cutJournal } from "./cut-recovery";
import { pasteJournal, pasteNotCommitted, type PasteAttempt } from "./paste-recovery";
import type { CopyRef } from "./canvas-snapshot";
import { nextPaste, pasteTranslation, type PasteSequence } from "./canvas-snapshot-geometry";
import { SnapshotMenu } from "./snapshot-menu";
import { CanvasToolButton } from "./canvas-tool-button";
import { ExportMenu } from "./export-menu";
import { WorkspaceBackup } from "./workspace-backup";
import { ImportPackage, importDialogOpen } from "./import-package";
import { WorkspaceProjectDialog } from './workspace-project-dialog';
import { WorkspaceGuide, type GuideAccessResult } from './workspace-guide';
import { renderCanvasPng, type CanvasExportVisual } from "./canvas-export";
import { useCanvasImageInput } from "./canvas-image-input";
import { droppedFilePlan, fileAssetPayload, runDroppedFiles } from "./canvas-drop";
import { openCardAttachment } from "./card-attachments";
import { CardAttachmentList } from "./card-attachment-list";
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
import { selectedItemIds, useCanvasSelection } from './canvas-selection';
import { layerAvailability, layerItemIds, layerItems, type LayerOperation } from './layer-order';
import type { LayerMenuProps } from './layer-menu';
import { captureSelectionDeletion } from './canvas-selection-delete';
import { useCanvasMarquee } from './canvas-selection-boundary';
import { captureMemberDeletion, ungroupSelectionCommand, createGroupCommand, removeMemberCommand, ungroupCommand } from './canvas-group-commands';
import { CanvasGroups } from './canvas-groups';
import { CanvasFrames, useFrameMove } from './canvas-frames';
import { createFrameCommand, createFrameSelectionCommand, deleteFrameCommand, frameItemsInRect, frameSelectionRect, sameFrameResizeMembership, type FrameRect } from './canvas-frame-commands';
import { attachmentPreviewPositions } from './attachment-follow';
import { useGroupGeometry } from './group-geometry';
import { CanvasTextNode } from './canvas-text';
import { CanvasShapeNode, shapeNodes } from './canvas-shape';
import { CanvasStrokeNode, strokeNodes } from './canvas-stroke';
import { StrokeTools, type PenKind } from './stroke-tools';
import { StrokePreview, useStrokeDraw } from './stroke-draw';
import { StrokeCreateRecovery } from './stroke-create-recovery';
import { useConnectorCreate } from './connector-create';
import { useConnectorEdit } from './connector-edit';
import { captureCardDeletion } from './connector-deletion';
import { ConnectorCreateControls, ConnectorEndpointControls, ConnectorHandles, ConnectorPathControls } from './connector-controls';
import { useConnectorTargets } from './connector-targets';
import { CanvasConnector, ConnectorPreview, ConnectorEntries } from './canvas-connector';
import { useConnectorLabelEdit } from './connector-label-edit';
import { DetachedConnectorLabelEditor } from './connector-label';
import { endpointKey, type CanvasConnector as Connector } from '../../backend/src/mapping/connector-contracts';
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
import type { Block, HistoryAction } from "../../backend/src/mapping/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
import "./canvas-toolbar.css";
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
import { createDerivedPoseAcknowledgements } from './derived-pose-acknowledgements';
import { InlineTitle } from "./inline-title";
import { CardMenu } from "./card-menu";
import { OrganizeDialog } from "./organize-dialog";
import { createOrganizeCancellationJournal } from "./organize-cancellation-recovery";
import { bodyPreviewText, useCardPresentation } from "./card-presentation";
import { useCardLayoutSave } from "./card-layout-save";
import { useAppearanceSave, type AppearanceInput } from "./appearance-save";
import { ProjectTags, CardTagSummary } from "./project-tags";
import type { Tag } from "../../backend/src/mapping/contracts";

const brandMark = new URL('../../assets/brand/forkwise-basic-kit/01-logos/logo-mark.svg', import.meta.url).href;

// 结构类命令的读已过期失败靠一次刷新收敛：命令集与错误码集中在这里，新增错误码不必改条件里的长行。
const ATTACHMENT_READ_FAILED = "附件已保存，列表读取失败";
const STALE_READ_COMMANDS = new Set(['attachment.attach', 'attachment.detach', 'connector.reconnect', 'connector.path', 'connector.move', 'connector.delete', 'connector.style', 'connector.reverse', 'connector.label', 'canvas.layer', 'canvas.duplicate', 'canvas.paste', 'canvas.cut', 'canvas.paste-cut']);
const STALE_READ_CODES = new Set(['VERSION_CONFLICT', 'NOT_FOUND', 'ID_CONFLICT', 'CUT_STATE_CONFLICT', 'CUT_NOT_FOUND', 'CUT_RESTORE_MISSING', 'CUT_OUTER_CHANGED', 'CUT_OUTER_UNKNOWN']);
// 一次提交的附加回调集中在具名选项里，避免位置参数与 undefined 占位。
// persist 必须在真正发送前落盘最终命令；重试同一请求时沿用同一份 options，否则成功回执不会清理恢复记录。
type ActionOptions = {
  beforeSubmit?: (attemptStartEpoch: number, actionEpoch: number) => boolean | Promise<boolean>;
  sealed?: boolean;
  onSettled?: () => void;
  persist?: (command: Command) => void;
  onCommitted?: () => void;
  onRejected?: (error: unknown, attempt: PasteAttempt) => void;
};

type CardData = {
  verificationAvailable: boolean;
  showMenu: boolean;
  tags: Tag[];
  card: Card;
  previewBody: Card["body"];
  editing: boolean;
  title: string;
  onTitle: (value: string) => void;
  onFinish: () => void;
  onEdit: (origin?: HTMLButtonElement) => void;
  onBody: () => void;
  onAI: (verification?: true) => void;
  onOpenAttachment: (assetId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onAddAttachment: (file: File) => void;
  attachmentTargets: Card[];
  attachmentWriteBlocked: boolean;
  onCopyAttachment: (targetId: string, item: NonNullable<Card['attachments']>['items'][number]) => void;
  onCanvasChoice: () => void;
  onDelete: () => void;
  onRemoveFromGroup?: (() => void) | undefined;
  onAppearance: (value: AppearanceInput) => void;
  layer?: LayerMenuProps | undefined;
  appearanceValue: AppearanceInput;
  onMeasure: (card: Card, height: number) => void;
  measurable: boolean;
  onComposition: (value: boolean) => void;
  onMove: (dx: number, dy: number) => void;
  strokeSelected: boolean;
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
  const titleButton = useRef<HTMLButtonElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const bodyButton = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const bridgeToolbarFocus = selected && data.showMenu && !data.editing &&
    !data.historyBlocked && !data.strokeSelected && !data.movingDisabled;
  const restoreTitleFocus = useRef(false);
  useLayoutEffect(() => {
    if (!data.editing && restoreTitleFocus.current) {
      restoreTitleFocus.current = false;
      titleButton.current?.focus({ preventScroll: true });
    }
  }, [data.editing]);
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
      onKeyDown={event => {
        if (!bridgeToolbarFocus || event.key !== "Tab" || event.defaultPrevented ||
          event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey ||
          !toolbar.current?.getClientRects().length || getComputedStyle(toolbar.current).visibility !== "visible") return;
        // 浮栏和弹层都挂在 body 下，按触发按钮的位置接入本卡的键盘顺序。
        const target = event.target as HTMLElement;
        const order: (HTMLElement | null)[] = [moveButton.current];
        let sourcePopup: HTMLElement | null = null;
        for (const action of toolbar.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])')) {
          order.push(action);
          const popupId = action.getAttribute("aria-controls");
          const popup = popupId && document.getElementById(popupId);
          if (!popup || getComputedStyle(popup).visibility !== "visible") continue;
          const items = popup.querySelectorAll<HTMLElement>("button:enabled, input:enabled:not([hidden])");
          if (popup.contains(target)) sourcePopup = popup;
          // 层级操作全禁用时，菜单本身接收初始焦点。
          if (items.length) order.push(...items);
          else order.push(popup);
        }
        order.push(bodyButton.current);
        const index = order.indexOf(target);
        if (index === -1) return;
        const next = order[index + (event.shiftKey ? -1 : 1)];
        if (!next) return;
        // 仅在同一弹层内跟随焦点滚动。
        next.focus({ preventScroll: !sourcePopup?.contains(next) });
        if (document.activeElement === next) event.preventDefault();
      }}
      style={
        {
          "--card-title-color": data.appearanceValue.titleColor,
        } as React.CSSProperties
      }
    >
      {selected && data.showMenu && (
        <CardMenu
          anchor={anchor}
          toolbar={toolbar}
          tabIndex={bridgeToolbarFocus ? -1 : undefined}
          card={data.card}
          value={data.appearanceValue}
          blocked={data.historyBlocked}
          attachmentWriteBlocked={data.attachmentWriteBlocked}
          onEdit={data.onEdit}
          onBody={data.onBody}
          onAI={() => data.onAI()}
          onVerification={data.verificationAvailable ? () => data.onAI(true) : undefined}
          onAddAttachment={data.onAddAttachment}
          onDelete={data.onDelete}
          onRemoveFromGroup={data.onRemoveFromGroup}
          onAppearance={data.onAppearance}
          layer={data.layer}
        />
      )}
      <header className="card-heading">
        {data.editing ? (
          <InlineTitle
            blocked={data.historyBlocked}
            value={data.title}
            onChange={data.onTitle}
            onComposition={data.onComposition}
            onFinish={restoreFocus => {
              restoreTitleFocus.current = restoreFocus;
              data.onFinish();
            }}
          />
        ) : (
          <button
            ref={titleButton}
            className="title-button"
            disabled={data.historyBlocked}
            onClick={event => {
              if (event.detail === 0 && !event.shiftKey) data.onEdit(event.currentTarget);
            }}
            onDoubleClick={event => data.onEdit(document.activeElement === event.currentTarget ? event.currentTarget : undefined)}
          >
            {data.title || "未命名卡片"}
          </button>
        )}
        <button
          ref={moveButton}
          className="move-handle nodrag"
          aria-label="移动卡片：方向键调整位置"
          disabled={data.strokeSelected}
          aria-disabled={data.movingDisabled}
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
              if (!data.movingDisabled) data.onMove(delta[0]!, delta[1]!);
            }
          }}
        >
          移动
        </button>
        <button
          ref={bodyButton}
          className="body-button nodrag"
          disabled={data.historyBlocked}
          onClick={data.onBody}
        >
          编辑正文
        </button>
      </header>
      {data.card.verificationOrigin && <button type="button" className="card-ai-origin nodrag nopan"
        onClick={event => { event.stopPropagation(); data.onOpenAttachment(data.card.verificationOrigin!.assetId); }}>
        {data.card.verificationOrigin.fixture ? '模拟查证 · 下载夹具原文' : '下载查证原文'}
      </button>}
      {data.card.aiOrigin && <span className="card-ai-origin">
        {data.card.aiOrigin.mode === 'simulate' ? '模拟整理' : 'AI 候选'}
      </span>}
      <CardAttachmentList card={data.card} projectCards={data.attachmentTargets} blocked={data.historyBlocked}
        writeBlocked={data.attachmentWriteBlocked} onOpen={data.onOpenAttachment} onRemove={data.onRemoveAttachment} onAdd={data.onAddAttachment} onCopy={data.onCopyAttachment} />
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
type SelectionIntent = { projectId: string; generation: number };
function deletesCard(action: HistoryAction, cardId: string) {
  return action.deletedCardIds?.includes(cardId) || action.label === 'thought.delete' && action.target.id === cardId;
}
type CardSaveOwner = Pick<Draft, "projectId" | "cardId" | "field"> & { commandId: string };
type DraftSaveFailure = { message: string; owner: CardSaveOwner; generation: number; commandRejected: boolean };

function matchesFailedDraft(draft: Draft | undefined, failure: DraftSaveFailure) {
  const { owner } = failure;
  return !!draft && draft.projectId === owner.projectId && draft.cardId === owner.cardId &&
    draft.field === owner.field && (draft.command
      ? draft.command.commandId === owner.commandId
      : failure.commandRejected && draft.generation >= failure.generation);
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : "本机服务暂时不可用";
}
function isShapePlacementOrAttachment(command: Command) {
  return command.type === "shape.create" || command.type === "attachment.attach" || command.type === "attachment.detach";
}

function draftKey(projectId: string, cardId: string, field: Draft["field"]) {
  return JSON.stringify([projectId, cardId, field]);
}
function Workspace() {
  const [state, setState] = useState<ProjectState | null>(null);
  const projectTabs = useRef<HTMLDivElement>(null);
  const [workspaceAccess, setWorkspaceAccess] = useState<'loading' | 'ready' | 'revoked'>('loading');
  const workspaceRevoked = useRef(false);
  const [guideAccess, setGuideAccess] = useState<'pending' | 'allowed' | 'retry' | 'denied'>('pending');
  const guideDialog = useRef<HTMLDialogElement>(null);
  const backupDialog = useRef<HTMLDialogElement>(null);
  const navigation = useRef<HTMLButtonElement>(null);
  type AnnotationPick = { projectId: string; itemId: string; trigger: HTMLButtonElement };
  const [annotationPick, setAnnotationPickView] = useState<AnnotationPick | null>(null);
  const annotationPickIntent = useRef<AnnotationPick | null>(null);
  function setAnnotationPick(next: AnnotationPick | null) {
    annotationPickIntent.current = next;
    setAnnotationPickView(next);
  }
  const canvasSelection = useCanvasSelection(state);
  const disabledMovePointer = useRef<{ card: Element; pointerId: number } | null>(null);
  const selection = canvasSelection.directItemIds, setSelection = canvasSelection.setItems;
  const flowSelection = canvasSelection.flowSelectedItemIds;
  const singleTarget = canvasSelection.value.targets.length === 1 ? canvasSelection.value.targets[0] : undefined;
  const singleItemId = singleTarget?.kind === "item" ? singleTarget.itemId : null;
  const [panTool, setPanTool] = useState(false);
  const [frameTool, setFrameTool] = useState(false);
  const [frameSelection, setFrameSelection] = useState<{ projectId: string; ids: string[]; generation: number } | null>(null);
  const [frameEditorEpoch, setFrameEditorEpoch] = useState(0);
  const frameEditorFocus = useRef<{ projectId: string; id: string } | null>(null);
  const [frameDropCandidate, setFrameDropCandidate] = useState<string | null>(null);
  const frameDropSnapshot = useRef<ProjectState | null>(null);
  const [frameDrawMemberIds, setFrameDrawMemberIds] = useState<string[]>([]);
  const [framePreview, setFramePreview] = useState<FrameRect | null>(null);
  const frameDrag = useRef<{ projectId: string; state: ProjectState; start: { x: number; y: number } } | null>(null);
  const [shapePreset, setShapePresetView] = useState<ShapeType | null>(null);
  const shapePlacement = useRef<{ preset: ShapeType } | null>(null);
  function setShapePreset(preset: ShapeType | null) {
    shapePlacement.current = preset ? { preset } : null;
    setShapePresetView(preset);
  }
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
  function publishProjects(all: Project[]) {
    if (!workspaceRevoked.current) setProjects(all);
  }
  const activeProjectId = state?.project.id;
  const activeProjectName = state?.project.name;
  const activeProjectListed = projects.some(project => project.id === activeProjectId);
  const navigationProjects = projects.map(project => project.id === state?.project.id ? state.project : project);
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null);
  const tabStopId = focusedTabId ?? (activeProjectListed ? activeProjectId : projects[0]?.id);
  useEffect(() => {
    projectTabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeProjectId, activeProjectName, activeProjectListed]);
  useEffect(() => {
    const tabs = projectTabs.current;
    if (!tabs) return;
    const observer = new ResizeObserver(() => {
      const focused = document.activeElement;
      const visible = tabs.contains(focused) ? focused : tabs.querySelector('[aria-selected="true"]');
      visible?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    observer.observe(tabs);
    return () => observer.disconnect();
  }, []);
  const [addedCandidate, setAddedCandidate] = useState<{ projectId: string; itemId: string }>();
  const [organizing, setOrganizing] = useState<{ projectId: string; source?: Card; verification?: true } | null>(null);
  const [organizeCancellationJournal] = useState(createOrganizeCancellationJournal);
  const [organizeCancellations, setOrganizeCancellations] = useState(() => organizeCancellationJournal.snapshot);
  const authority = useRef<ProjectState | null>(null);
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);
  const selectedFrameIds = frameSelection?.projectId === state?.project.id && frameSelection?.generation === canvasSelection.generation()
    ? frameSelection.ids.filter(id => state?.frames?.some(frame => frame.id === id)) : [];
  const selectedFrameId = selectedFrameIds.length === 1 && !selectedConnectors.length && !canvasSelection.value.targets.length ? selectedFrameIds[0]! : null;
  useEffect(() => {
    setFrameSelection(current => {
      if (!current || current.projectId !== state?.project.id || current.generation !== canvasSelection.generation()) return null;
      const ids = current.ids.filter(id => state.frames?.some(frame => frame.id === id));
      return ids.length === current.ids.length ? current : ids.length ? { ...current, ids } : null;
    });
  }, [state, canvasSelection.value]);
  const selectedConnector = selectedConnectors.length === 1 ? selectedConnectors[0]! : null;
  const exclusiveConnector = !canvasSelection.value.targets.length && !selectedFrameIds.length ? selectedConnector : null;
  const exclusiveItemId = !selectedConnectors.length && !selectedFrameIds.length ? singleItemId : null;
  const attachmentPick = annotationPick?.projectId === state?.project.id && annotationPick?.itemId === exclusiveItemId ? annotationPick : null;
  useEffect(() => {
    if (!attachmentPick) {
      if (annotationPick) setAnnotationPick(null);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element;
      const canvasTarget = target.id === "project-canvas" || target.closest(".react-flow__node-thought, .react-flow__pane");
      const sourceToolbar = attachmentPick.trigger.closest("[role=toolbar]");
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        !(canvasTarget || sourceToolbar?.contains(target)) ||
        target.closest("input, textarea, [contenteditable=true], dialog, [role=dialog], [role=menu], [aria-expanded=true], .text-color-panel")) return;
      event.preventDefault();
      event.stopPropagation();
      setAnnotationPick(null);
      if (attachmentPick.trigger.isConnected) attachmentPick.trigger.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!attachmentPick.trigger.contains(target) && !target.closest(".react-flow__node-thought, [data-workspace-guide], [data-workspace-backup]")) setAnnotationPick(null);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [annotationPick, attachmentPick]);
  function setSelectedConnector(id: string | null) { setSelectedConnectors(id ? [id] : []); }
  const strokeSelected = selection.some(id => state?.strokes?.some(stroke => stroke.item.id === id));
  const [layerHold, setLayerHold] = useState<{ projectId: string; generation: number } | null>(null);
  const layerHoldActive = !!state && layerHold?.projectId === state.project.id && layerHold.generation === canvasSelection.generation();
  const [syncNotice, setSyncNotice] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exportVisual, setExportVisual] = useState<CanvasExportVisual | null>(null);
  const frameDraft = useRef(false);
  const [frameDrafting, setFrameDrafting] = useState(false);
  const labelPositionPreview = useRef(new Set<string>());
  function noteFrameDraft(dirty: boolean) {
    frameDraft.current = dirty;
    setFrameDrafting(current => current === dirty ? current : dirty);
  }
  function noteLabelPositionPreview(id: string, active: boolean) {
    if (active) labelPositionPreview.current.add(id);
    else labelPositionPreview.current.delete(id);
  }
  const [nav, setNav] = useState(false),
    [pinned, setPinned] = useState(false);
  const projectNavList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nav) projectNavList.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [nav, activeProjectId, activeProjectName, activeProjectListed]);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState("");
  const renameTrigger = useRef<HTMLButtonElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  function closeRename() {
    if (renameDialog.current?.open) {
      renameDialog.current.close();
      renameTrigger.current?.focus({ preventScroll: true });
    }
    setRenaming(null);
  }
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
        const deletion = [...timeline.undo].reverse().find(a => deletesCard(a, saved.cardId));
        const target = deletion ?? timeline.redo.at(-1);
        const eligible = timeline.revision === latest.project.revision && target &&
          (deletion ? timeline.undo.at(-1)?.id === target.id : target.target.id === saved.cardId && ["thought.create", "organize.add", "thought.delete"].includes(target.label));
        setDeletedRecovery({
          projectId: saved.projectId,
          cardId: saved.cardId,
          ...(eligible
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
  const [draftFailure, setDraftFailure] = useState<DraftSaveFailure | null>(null);
  const [savingDraft, setSavingDraft] = useState<CardSaveOwner | null>(null);
  const [savingBodyAction, setSavingBodyAction] = useState<CardSaveOwner | null>(null);
  const [previousProjectFeedback, setPreviousProjectFeedback] = useState<{ commandId: string; message: string } | null>(null);
  const [attachmentResult, setAttachmentResult] = useState<{
    projectId: string;
    outcome: "saved" | "rejected";
    message: string;
  } | null>(null);
  const [attachmentProjectSwitches, setAttachmentProjectSwitches] = useState(0);
  const pendingAction = useRef<{
    command: Command;
    onDone?: () => void;
    onSettled?: () => void;
    selectionIntent?: SelectionIntent;
    receipt?: Awaited<ReturnType<typeof api.execute>>;
    attachmentReadFailed?: true;
    rejected?: string;
    bodyFailure?: { message: string; owner: CardSaveOwner };
    options?: ActionOptions;
  } | null>(null);
  const preparingActions = useRef(0);
  const cardDeletion = useRef<ReturnType<typeof captureCardDeletion>>(null);
  const selectionDeletion = useRef<ReturnType<typeof captureSelectionDeletion>>(null);
  const previewPoseAcks = useRef(createDerivedPoseAcknowledgements(() => authority.current)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composition = useRef(false),
    compositionPrefixCutoff = useRef(0),
    generation = useRef(0),
    saving = useRef<Promise<boolean> | null>(null);
  const layoutBarrier = useRef<{ cutoff: number } | null>(null);
  const flow = useReactFlow();
  const canvasStore = useStoreApi();
  useLayoutEffect(() => {
    if (!addedCandidate) return;
    if (addedCandidate.projectId !== state?.project.id) {
      setAddedCandidate(undefined);
      return;
    }
    const card = state.cards.find(value => value.item.id === addedCandidate.itemId);
    if (!card) {
      setAddedCandidate(undefined);
      return;
    }
    const measured = dimensions[card.item.id];
    if (!measured) return;
    const { width, height, minZoom } = canvasStore.getState();
    if (!width || !height) return;
    const { x, y } = card.item.pose;
    const viewport = flow.getViewport();
    const inset = 24;
    const right = width - inset;
    const bottom = height - Math.min(96, height / 3);
    const zoom = Math.max(minZoom, Math.min(viewport.zoom, (right - inset) / measured.width,
      (bottom - inset) / measured.height));
    const next = zoom === viewport.zoom
      ? { x: Math.max(inset - x * zoom, Math.min(viewport.x, right - (x + measured.width) * zoom)),
          y: Math.max(inset - y * zoom, Math.min(viewport.y, bottom - (y + measured.height) * zoom)), zoom }
      : { x: (inset + right - measured.width * zoom) / 2 - x * zoom,
          y: (inset + bottom - measured.height * zoom) / 2 - y * zoom, zoom };
    if (next.x !== viewport.x || next.y !== viewport.y || next.zoom !== viewport.zoom) void flow.setViewport(next);
    setAddedCandidate(undefined);
  }, [addedCandidate, state, dimensions, canvasStore, flow]);
  const marqueeSelection = useCanvasMarquee(canvasStore, state, canvasSelection);
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
  const [groupGeometryLocked, setGroupGeometryLocked] = useState(false);
  const historyBlocked = historyBusy || !!historyCommand.current || connectorPending.current() || groupGeometryLocked;
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
      if (target.closest("dialog.project-search, dialog.shape-appearance-dialog, dialog.organize-dialog, dialog.attachment-copy-dialog")) return;
      // 导入和改名是模态表单：打开期间画布动作历史一律不动。
      // 这里直接返回、不 preventDefault，名称输入框的原生撤销照常生效。
      if (importDialogOpen() || renameDialog.current?.open || backupDialog.current?.open) return;
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
    if (workspaceRevoked.current) return;
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
        const deletion = timeline && [...timeline.undo].reverse().find(a => deletesCard(a, binding.card.id));
        const removed = deletion ?? timeline?.redo.at(-1);
        if (
          !binding.removalActionId &&
          timeline?.revision === value.project.revision &&
          removed && (deletion || ["thought.create", "organize.add", "thought.delete"].includes(removed.label) && removed.target.id === binding.card.id)
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
            timeline?.revision === value.project.revision &&
            (binding.restoreDirection === "undo" ? timeline?.undo : timeline?.redo)?.at(-1)?.id === binding.removalActionId,
          direction: binding.restoreDirection ?? "redo",
        });
      }
    }
    authority.current = value;
    setSelectedConnectors(previous => current?.project.id === value.project.id ? previous.filter(id => value.connectors?.some(line => line.id === id)) : []);
    const intent = pendingAction.current?.selectionIntent;
    const ownsSelection = intent?.projectId === value.project.id && intent.generation === canvasSelection.generation();
    canvasSelection.reconcile(value, current?.project.id === value.project.id);
    if (ownsSelection) intent.generation = canvasSelection.generation();
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
    const generation = canvasSelection.generation();
    if (!(await connectorLabel.finish()) || authority.current?.project.id !== projectId || epoch !== editorEpoch.current ||
      canvasSelection.generation() !== generation) return;
    if (lineId && authority.current?.connectors?.some(line => line.id === lineId)) {
      setFrameSelection(null);
      if (!extend) setSelection([]);
      setSelectedConnectors(previous => extend ? previous.includes(lineId) ? previous.filter(id => id !== lineId) : [...previous, lineId] : [lineId]); return;
    }
    if (!itemId) { marqueeSelection.retire(); if (extend) return; }
    clearConnectorSelection(extend); setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    if (itemId && authority.current?.groups?.some(group => group.memberItemIds.includes(itemId))) canvasSelection.choose(itemId, extend);
    else setSelection(previous => itemId ? extend ? [...new Set([...previous, itemId])] : [itemId] : extend ? previous : []);
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
  const refresh = async (id: string, selectionIntent?: SelectionIntent) => {
    const capturedProject = authority.current?.project.id;
    const value = await api.project(id);
    const timeline = await api.history(id);
    if (capturedProject === id && authority.current?.project.id === id) {
      const ownsSelection = selectionIntent?.projectId === id && selectionIntent.generation === canvasSelection.generation();
      updateState(value, timeline);
      if (ownsSelection) selectionIntent.generation = canvasSelection.generation();
      const all = await api.projects();
      if (authority.current?.project.id === id) publishProjects(all);
    }
    return value;
  };
  function hideGuide() {
    const dialog = guideDialog.current;
    const wasOpen = dialog?.open;
    dialog?.close();
    const focus = document.activeElement;
    if (focus?.closest('.workspace-guide-invitation, .project-nav [data-workspace-guide]') ||
      (wasOpen && focus === document.body)) {
      navigation.current?.focus({ preventScroll: true });
    }
    setGuideAccess('denied');
  }
  function revokeWorkspaceView() {
    workspaceRevoked.current = true;
    persistDrafts();
    authority.current = null;
    const focused = document.activeElement;
    const rename = renameDialog.current;
    const guide = guideDialog.current;
    const focusInRename = rename?.open && (rename.contains(focused) || focused === document.body);
    const focusInGuide = guide?.open && (guide.contains(focused) || focused === document.body);
    rename?.close();
    hideGuide();
    setWorkspaceAccess('revoked');
    setRenaming(null);
    setName('');
    if (focusInRename || focusInGuide || projectTabs.current?.contains(focused) || projectNavList.current?.contains(focused) ||
      focused?.closest('.workspace-empty')) navigation.current?.focus({ preventScroll: true });
    setState(null);
    setProjects([]);
    setSyncNotice("授权已失效，请从本机启动入口重新打开；未确认草稿已保留");
  }
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
          publishProjects(all);
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
          revokeWorkspaceView();
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
    (command, receipt) => { cardDeletion.current?.acknowledge(command, receipt); selectionDeletion.current?.acknowledge(command, receipt); },
    () => authority.current, previewPoseAcks);
  const cardLayout = useCardLayoutSave(refresh, () => authority.current,
    (command, receipt) => { cardDeletion.current?.acknowledge(command, receipt); selectionDeletion.current?.acknowledge(command, receipt); });
  const appearance = useAppearanceSave(
    () => authority.current,
    refresh,
    async () => {
      breakBodyGroup();
      return await connectorLabel.finish() && await shapeText.finish() && await flush();
    },
    (command, receipt) => { previewPoseAcks.record(command, receipt); cardDeletion.current?.acknowledge(command, receipt); selectionDeletion.current?.acknowledge(command, receipt); },
  );
  const imageGeometry = useImageGeometry(() => authority.current,
    (command, done, prepare) => action(command, done, prepare ? { beforeSubmit: prepare } : {}), refresh,
    () => historyLock.current || !!historyCommand.current, previewPoseAcks);
  const shapeMove = useShapeMove(() => authority.current, value => {
    if (authority.current?.project.id === value.project.id) updateState(value);
  }, async () => await connectorLabel.finish() && await shapeText.finish() && await texts.finish() && await appearance.flush() &&
    await cardLayout.flush() && await pose.flush() && await flush(),
    (command, receipt) => selectionDeletion.current?.acknowledge(command, receipt), previewPoseAcks);
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
      strokeDraw.setMode(null); setSelection([]); setSelectedConnector(null); setPlacing(false); setShapePreset(null); texts.setPlacing(false); setPanTool(false); setFrameTool(false);
      return true;
    },
    point: client => flow.screenToFlowPosition(client, { snapToGrid: false }),
    center: () => {
      const element = document.querySelector('.canvas .react-flow');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, { snapToGrid: false });
    },
    origin: connectorTargets.origin,
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
      try { confirmed = (await action(command, done, { beforeSubmit: () => { submitted = true; return true; } })) === true; }
      catch (error) { fail(error); }
      return { submitted, confirmed };
    },
  });
  function clearConnectorSelection(keepSelected = false) {
    connectorEdit.cancel({ restoreFocus: false });
    if (!keepSelected) setSelectedConnector(null);
  }
  function chooseFrame(id: string | null, extend = false) {
    if (id === null) { setFrameSelection(null); return; }
    const projectId = authority.current?.project.id;
    if (!projectId || selectedFrameId === id) return;
    if (!extend || !selectedFrameIds.includes(id)) editorEpoch.current++;
    if (!extend) { canvasSelection.set({ targets: [], enteredGroupId: null }); clearConnectorSelection(); }
    setFrameSelection({ projectId, ids: extend ? [...new Set([...selectedFrameIds, id])] : [id], generation: canvasSelection.generation() });
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
  function chooseSelectionTool() {
    if (strokeDraw.hasPending() || connectorCreate.hasPending()) return false;
    setAnnotationPick(null);
    connectorEdit.cancel();
    connectorCreate.deactivate();
    strokeDraw.setMode(null);
    setPlacing(false);
    setShapePreset(null);
    texts.setPlacing(false);
    setPanTool(false);
    setFrameTool(false);
    return true;
  }
  function beginCreationToolChoice() {
    setAnnotationPick(null);
    const epoch = ++editorEpoch.current;
    connectorEdit.cancel();
    connectorCreate.deactivate();
    setFrameTool(false);
    setFrameSelection(null);
    frameDrag.current = null;
    setFramePreview(null);
    return epoch;
  }
  function chooseCardPlacement() {
    if (strokeDraw.hasPending()) return false;
    beginCreationToolChoice();
    strokeDraw.setMode(null);
    setPanTool(false);
    setShapePreset(null);
    texts.setPlacing(false);
    setPlacing(true);
    return true;
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
    setSelection([]); setPlacing(false); setShapePreset(null); texts.setPlacing(false); setPanTool(false); setFrameTool(false);
    strokeDraw.setMode(kind);
  }
  function startMove(projectId: string, card: Card, resizing = false) {
    if (canvasSelection.hasDirectStroke()) return false;
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
          ...(!resizing && authority.current ? { placement: captureSpatial(authority.current) } : {}),
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
    finish: resize => pose.finish(undefined, undefined, resize),
    cancel: pose.cancel,
    zoom: () => flow.getZoom(),
  });
  function cancelGesture() {
    groupGeometry.cancel();
    connectorEdit.cancel();
    connectorCreate.cancelDraft();
    strokeDraw.cancel();
    pose.cancel();
    texts.cancelMove();
    canvasMove.cancel();
    frameMove.cancel();
    canvasSelection.cancelDrag();
    shapeMove.cancel();
    imageGeometry.cancel();
    resize.cancel();
    moving.current = null;
    bypass.current = false;
    setGuides([]);
    marqueeSelection.cancel();
    frameDrag.current = null;
    setFramePreview(null); setFrameDropCandidate(null); setFrameDrawMemberIds([]);
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = frameDrag.current;
      if (!current || authority.current?.project.id !== current.projectId) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
      const rect = { x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y),
        width: Math.abs(point.x - current.start.x), height: Math.abs(point.y - current.start.y) };
      setFramePreview(rect);
      setFrameDropCandidate(frameCreationParent(current.state, rect)?.id ?? null);
      setFrameDrawMemberIds(frameItemsInRect(current.state, rect));
    };
    const up = (event: PointerEvent) => {
      const current = frameDrag.current;
      frameDrag.current = null;
      setFramePreview(null); setFrameDropCandidate(null); setFrameDrawMemberIds([]);
      const snapshot = current?.state;
      if (!current || !snapshot || snapshot.project.id !== current.projectId) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
      const pose = { x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y),
        width: Math.abs(point.x - current.start.x), height: Math.abs(point.y - current.start.y) };
      if (pose.width > 0 && pose.height > 0) {
        const command = createFrameCommand(snapshot, frameItemsInRect(snapshot, pose), pose);
        void action(command, () => { chooseFrame(command.payload.id); setFrameTool(false); });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });
  useEffect(() => {
    const cancel = () => cancelGesture();
    const released = () => canvasMove.endArmedPointer();
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
        backupDialog.current?.open ||
        event.isComposing ||
        event.keyCode === 229 ||
        composition.current ||
        (event.target as HTMLElement).closest(
          "input, textarea, [contenteditable=true], dialog.organize-dialog, dialog.workspace-project-dialog",
        )
      )
        return;
      setShapePreset(null);
      if (frameDrag.current || groupGeometry.hasGesture() || connectorEdit.hasGesture() || connectorCreate.hasGesture() || strokeDraw.hasGesture() || pose.dragging || texts.hasMove() || canvasMove.dragging || canvasMove.hasPointerGesture() || frameMove.hasGesture() || shapeMove.dragging || imageGeometry.dragging || marqueeSelection.hasGesture()) {
        event.preventDefault();
        cancel();
        return;
      }
      if (shapeText.session || connectorLabel.session || texts.nodes.some(node => node.data.editing)) return;
      chooseSelectionTool();
      event.preventDefault();
      canvasSelection.set({ targets: [], enteredGroupId: null });
      setFrameSelection(null);
      clearConnectorSelection();
    };
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("lostpointercapture", lostCapture, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointerup", released, true);
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
    if (workspaceRevoked.current) return false;
    const value = await api.project(id);
    const all = await api.projects();
    // Keep the old project's authority while the destination is loading: the
    // visible editors may still accept input during those requests.
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await pose.flush()) || !(await flush())) return false;
    if (workspaceRevoked.current) return false;
    updateState(value);
    publishProjects(all);
    setWorkspaceAccess('ready');
    return true;
  };
  function belongsToPreviousProject(command: Command) {
    return (command.type === "card.attachment.add" || isShapePlacementOrAttachment(command)) &&
      command.projectId !== authority.current?.project.id;
  }
  function blocksNewAction(commandId?: string) {
    const pending = pendingAction.current;
    if (!pending || pending.command.commandId === commandId) return false;
    if (!pending.attachmentReadFailed && !belongsToPreviousProject(pending.command)) fail(new Error("请先重试未完成的保存"));
    return true;
  }
  const select = async (id: string, navigationRow?: HTMLButtonElement) => {
    if (historyLock.current || historyCommand.current || strokeDraw.hasPending()) return;
    if (blocksNewAction()) return;
    const switchingProjects = id !== authority.current?.project.id;
    if (switchingProjects) setAttachmentProjectSwitches(count => count + 1);
    try {
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
        const pending = pendingAction.current;
        if (pending?.attachmentReadFailed && pending.command.projectId !== id) {
          pendingAction.current = null;
          recordAttachmentResult(pending.command.projectId, "saved");
        }
        setEditing(null);
        bodyBinding.current = null;
        setDeletedBody(null);
        setBodyCard(null);
        setPlacing(false);
        setShapePreset(null);
        if (!pinned) {
          if (navigationRow && document.activeElement === navigationRow) navigation.current?.focus();
          setNav(false);
        }
        history.replaceState(null, "", "?project=" + encodeURIComponent(id));
        setStatus("已保存到本机");
        setError("");
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    } finally {
      if (switchingProjects) setAttachmentProjectSwitches(count => count - 1);
    }
  };
  function fail(e: unknown) {
    setError(failureMessage(e));
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
  function nextSaveDraft(excludedCard?: string) {
    return [unconfirmed.current, ...closedDrafts.current, ...Object.values(drafts.current)]
      .find(draft => draft && draft.cardId !== excludedCard) ?? undefined;
  }
  function hasActiveCardDraft() {
    const projectId = authority.current?.project.id, draft = nextSaveDraft();
    return !!projectId && !!draft && draft.projectId === projectId;
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
    const current = nextSaveDraft(excludedCard);
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
    const savingOwner = {
      projectId: submitted.projectId, cardId: submitted.cardId, field: submitted.field, commandId: command.commandId,
    };
    setSavingDraft(savingOwner);
    setStatus("正在保存…");
    saving.current = (async () => {
      try {
        const receipt = await api.execute(command);
        previewPoseAcks.record(command, receipt);
        cardDeletion.current?.acknowledge(command, receipt);
        selectionDeletion.current?.acknowledge(command, receipt);
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
        setDraftFailure(previous => previous && previous.owner.projectId === submitted.projectId &&
          previous.owner.cardId === submitted.cardId && previous.owner.field === submitted.field &&
          previous.generation <= submitted.generation ? null : previous);
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
        const commandRejected = e instanceof MappingError &&
          ["INVALID_COMMAND", "TOO_LARGE", "MEDIA_NOT_PERSISTED"].includes(e.code);
        if (commandRejected) {
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
        if (submitted.field === "body") {
          // After rejection, retry the unsealed input if it is now this owner's queue head.
          const next = commandRejected ? nextSaveDraft() : undefined;
          const retryGeneration = next && !next.command && next.projectId === submitted.projectId &&
            next.cardId === submitted.cardId && next.field === submitted.field
            ? next.generation : submitted.generation;
          setDraftFailure({ message: failureMessage(e), owner: savingOwner, generation: retryGeneration, commandRejected });
          setStatus("保存未完成");
        } else fail(e);
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    setSavingDraft(null);
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
  function recordAttachmentResult(projectId: string, outcome: "saved" | "rejected", message = "") {
    setAttachmentResult({ projectId, outcome, message });
  }
  async function action(command: Command, onDone?: () => void, options: ActionOptions = {}) {
    // 同一 commandId 的页面内重试不是首次发送：权限类拒绝仍须按结果未知保留恢复记录（D467）。
    const retrying = !!pendingAction.current || !!options.sealed;
    const previousProject = () => belongsToPreviousProject(command);
    const previousAttachmentAdd = () => command.type === "card.attachment.add" && previousProject();
    const replayingSameCommand = pendingAction.current?.command === command;
    const rereadingAttachment = command.type === "card.attachment.add" && replayingSameCommand && !!pendingAction.current?.receipt;
    // A retained command or an attachment selected before switching owns its source, not the active draft.
    const previousProjectRetry = previousProject() && replayingSameCommand;
    const attemptStartEpoch = editorEpoch.current;
    let actionEpoch = attemptStartEpoch;
    if (connectorCreate.hasPending()) return false;
    if (!retrying && ['thought.create', 'shape.create', 'stroke.create', 'canvas.duplicate', 'canvas.paste'].includes(command.type) && !('placement' in command && command.placement) && authority.current?.project.id === command.projectId)
      Object.assign(command, { placement: { expected: captureSpatial(authority.current) } });
    const imageCommand = command.type.startsWith('image.');
    const backgroundImage = () => imageCommand && command.projectId !== authority.current?.project.id;
    const finishImage = async () => {
      if (options.beforeSubmit && !(await options.beforeSubmit(attemptStartEpoch, actionEpoch))) return false;
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
    if (blocksNewAction(command.commandId)) return;
    const structural = command.type.startsWith('group.') || command.type.startsWith('frame.') || command.type === 'canvas.delete-selection' || command.type === 'text.delete';
    const resumingStructure = structural && !!pendingAction.current;
    if (!resumingStructure && !previousProjectRetry && !previousAttachmentAdd() && !rereadingAttachment) {
      preparingActions.current++;
      try {
        actionEpoch = ++editorEpoch.current;
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
        if (options.beforeSubmit && !(await options.beforeSubmit(attemptStartEpoch, actionEpoch))) return false;
        if (!retrying) {
          previewPoseAcks.updatePlacement(command);
          if (command.type === 'frame.create' || command.type === 'frame.move')
            command.expected.poses = previewPoseAcks.versions(command.projectId, command.expected.poses);
          if (command.type === 'attachment.attach' || command.type === 'attachment.detach') {
            const target = command.expected.target;
            target.versionId = previewPoseAcks.version(command.projectId, target.itemId, target.versionId);
          }
          if (command.type === 'frame.move') {
            if (command.followers && command.expectedFollowers) {
              const expected = command.expectedFollowers;
              const { dx, dy } = command.payload;
              try {
                command.followers = await Promise.all(command.followers.map(async follower => {
                  const version = previewPoseAcks.version(command.projectId, follower.itemId, expected[follower.itemId]!);
                  if (version === expected[follower.itemId]) return follower;
                  const { pose } = await previewPoseAcks.read(command.projectId, follower.itemId, version);
                  return { ...follower, x: pose.x + dx, y: pose.y + dy };
                }));
              } catch (failure) { fail(failure); return false; }
              command.expectedFollowers = previewPoseAcks.versions(command.projectId, expected);
            }
          }
        }
      } finally {
        preparingActions.current--;
      }
    }
    // 落盘发生在发送之前：保存失败就中止，目标不产生任何写入，源内容仍可由源历史恢复。
    if (options?.persist && !pendingAction.current?.receipt) {
      try { options.persist(command); }
      catch (error) {
        fail(error instanceof Error ? error : new Error("无法保存粘贴恢复记录，未提交本次粘贴"));
        return false;
      }
    }
    const pending: NonNullable<typeof pendingAction.current> = pendingAction.current ?? { command, ...(onDone ? { onDone } : {}), ...(options.onSettled ? { onSettled: options.onSettled } : {}), options,
      ...(structural
        ? { selectionIntent: { projectId: command.projectId, generation: canvasSelection.generation() } } : {}) };
    pendingAction.current = pending;
    delete pending.attachmentReadFailed;
    const pendingCommand = pending.command;
    const savingOwner: CardSaveOwner | null = pendingCommand.type === "body.edit"
      ? { projectId: pendingCommand.projectId, cardId: pendingCommand.payload.id, field: "body", commandId: pendingCommand.commandId }
      : null;
    if (savingOwner) setSavingBodyAction(savingOwner);
    setBusy(true);
    if (!previousProject() && !rereadingAttachment) setStatus("正在保存…");
    let executed = !!pending.receipt;
    const settlePreviousSave = () => {
      pendingAction.current = null;
      setPreviousProjectFeedback(current => current?.commandId === command.commandId ? null : current);
      if (command.type === "card.attachment.add") {
        recordAttachmentResult(command.projectId, "saved");
        if (!previousProject()) {
          setStatus("已保存到本机");
          setError("");
        }
      }
      return true;
    };
    try {
      if (pending.rejected) {
        await refresh(command.projectId);
        if (previousProject()) setPreviousProjectFeedback({ commandId: command.commandId, message: pending.rejected });
        else fail(new Error(pending.rejected));
        return false;
      }
      if (command.type === "stroke.create") { strokeJournal.write(command); scanStrokeRecoveries(); }
      if (!executed) {
        const receipt = await api.execute(command);
        // 服务端已受理：先清恢复记录；随后画面读取失败只需重读，不再重放请求。
        try { options?.onCommitted?.(); } catch { /* 清理失败时保留记录，下次按原 commandId 幂等重放 */ }
        if (structural || command.type === "card.attachment.add") pending.receipt = receipt;
        executed = true;
      }
      if (command.projectId !== authority.current?.project.id) {
        if (previousProject()) return settlePreviousSave();
        if (!(await handoff(command.projectId))) return;
      } else {
        await refresh(command.projectId, pending.selectionIntent);
        if (previousAttachmentAdd()) return settlePreviousSave();
        if (!rereadingAttachment && !(await flush())) return;
      }
      if (command.type === "stroke.create") { strokeJournal.confirm(command); scanStrokeRecoveries(); }
      if (rereadingAttachment) {
        setStatus(current => current === ATTACHMENT_READ_FAILED ? "已保存到本机" : current);
      } else {
        setStatus("已保存到本机");
        setError("");
      }
      pendingAction.current = null;
      if (command.type === "card.attachment.add") {
        setAttachmentResult(current => current?.projectId === command.projectId ? null : current);
        setPreviousProjectFeedback(current => current?.commandId === command.commandId ? null : current);
      }
      pending.onSettled?.();
      if (!pending.selectionIntent || authority.current?.project.id === pending.selectionIntent.projectId &&
        canvasSelection.generation() === pending.selectionIntent.generation) pending.onDone?.();
      return true;
    } catch (e) {
      // 只有“还没拿到回执”的拒绝才是提交侧结果；之后的读取失败已经不代表没提交。
      if (!executed) options?.onRejected?.(e, retrying ? 'replay' : 'first');
      if (command.type === "card.attachment.add") {
        if (executed) {
          if (previousAttachmentAdd()) return settlePreviousSave();
          pending.attachmentReadFailed = true;
          if (!rereadingAttachment) setStatus(ATTACHMENT_READ_FAILED);
          return false;
        }
        const permissionDenied = e instanceof MappingError &&
          ["UNAUTHORIZED", "PROJECT_FORBIDDEN", "UNTRUSTED_PRINCIPAL"].includes(e.code);
        // 授权先于幂等回执读取。重放时的权限拒绝不能确认首次写入结果。
        const rejected = e instanceof MappingError &&
          (["VERSION_CONFLICT", "INVALID_ATTACHMENT", "NOT_FOUND"].includes(e.code) ||
            (permissionDenied && !replayingSameCommand));
        if (rejected) {
          if (!previousAttachmentAdd()) {
            try { await refresh(command.projectId); } catch { /* 读回失败不改变已明确的拒绝。 */ }
          }
          pendingAction.current = null;
          setPreviousProjectFeedback(current => current?.commandId === command.commandId ? null : current);
          recordAttachmentResult(command.projectId, "rejected", failureMessage(e));
        } else {
          setPreviousProjectFeedback({
            commandId: command.commandId,
            message: `上一项目附件保存结果待确认 · ${failureMessage(e)}`,
          });
        }
        if (!previousAttachmentAdd()) fail(e);
        return false;
      }
      if ((structural || ['thought.create', 'shape.create', 'stroke.create'].includes(command.type)) && !executed && !pending.rejected && e instanceof MappingError &&
        ['VERSION_CONFLICT', 'NOT_FOUND', 'UNAUTHORIZED', 'PROJECT_FORBIDDEN', 'UNTRUSTED_PRINCIPAL'].includes(e.code)) {
        pending.rejected = e.message;
        try { await refresh(command.projectId); } catch { /* Comparison retries retain the definite rejection and original request. */ }
        pending.onSettled?.();
      }
      if (!executed && e instanceof MappingError &&
        ((STALE_READ_COMMANDS.has(command.type) && STALE_READ_CODES.has(e.code)) ||
          (command.type === 'connector.reconnect' && e.code === 'INVALID_ENDPOINT') ||
          (command.type === 'attachment.attach' && e.status === 400 && e.code === 'INVALID_COMMAND'))) {
        pendingAction.current = null;
        onDone?.();
        if (authority.current?.project.id === command.projectId) {
          try { await refresh(command.projectId); } catch { /* Retain the explicit rejection if the read also fails. */ }
        }
      }
      if ((command.type === "thought.delete" || command.type === "shape.delete" || command.type === "stroke.delete" || command.type.startsWith("tag.") || command.type === "card.tags" || command.type === "card.attachment.remove") && e instanceof MappingError && ["VERSION_CONFLICT", "INVALID_ATTACHMENT", "TAG_NAME_CONFLICT", "NOT_FOUND", "UNAUTHORIZED", "PROJECT_FORBIDDEN", "UNTRUSTED_PRINCIPAL"].includes(e.code)) {
        pendingAction.current = null;
        try { await refresh(command.projectId); } catch { /* Keep the unconfirmed view; authorization polling owns retraction. */ }
      }
      if (savingOwner) {
        pending.bodyFailure = { message: failureMessage(e), owner: savingOwner };
        setStatus("保存未完成");
      } else if (previousProject()) {
        setPreviousProjectFeedback(current => pendingAction.current === pending
          ? { commandId: command.commandId, message: failureMessage(e) }
          : current?.commandId === command.commandId ? null : current);
      } else fail(e);
      return false;
    } finally {
      if (savingOwner) setSavingBodyAction(null);
      setBusy(false);
    }
  }
  async function abandonStructure(pending: NonNullable<typeof pendingAction.current>) {
    if (pendingAction.current !== pending || !pending.rejected || busy) return;
    setBusy(true);
    const previousProject = belongsToPreviousProject(pending.command);
    try {
      await refresh(pending.command.projectId);
      if (pendingAction.current !== pending) return;
      if (pending.command.type === 'stroke.create') { strokeJournal.confirm(pending.command); scanStrokeRecoveries(); }
      pendingAction.current = null;
      pending.onSettled?.();
      if (pending.command.type === 'stroke.create') pending.onDone?.();
      if (pending.command.type === 'thought.create') setPlacing(false);
      if (pending.command.type === 'shape.create') pending.onDone?.();
      if (pending.command.type === 'frame.edit' && authority.current?.project.id === pending.command.projectId) {
        frameEditorFocus.current = { projectId: pending.command.projectId, id: pending.command.payload.id };
        setFrameEditorEpoch(value => value + 1);
      }
      if (pending.command.type === 'group.scale' || pending.command.type === 'group.rotate90') groupGeometry.discard();
      if (previousProject) {
        setPreviousProjectFeedback(current => current?.commandId === pending.command.commandId ? null : current);
        return;
      }
      setError('');
      setStatus(['thought.create', 'shape.create', 'stroke.create'].includes(pending.command.type)
        ? '已放弃本次创建，可重新放置' : pending.command.type === 'text.delete'
        ? '已保留当前保存状态，请重新明确删除' : pending.command.type.startsWith('frame.')
          ? '已保留当前保存状态，请重新明确分区操作' : '已保留当前保存状态，请重新明确组合操作');
    } catch (failure) {
      if (previousProject) setPreviousProjectFeedback({ commandId: pending.command.commandId, message: failureMessage(failure) });
      else fail(failure);
    }
    finally { setBusy(false); }
  }
  async function createProject() {
    if (workspaceRevoked.current || projectCreationBlocked) return;
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
        if (!pinned) setNav(false);
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
    return { projectId: current.project.id, spatial: captureSpatial(current), ...point, maxWidth: rect.width * 0.6 / zoom, maxHeight: rect.height * 0.6 / zoom };
  }, action, () => historyLock.current || !!historyCommand.current, refresh);
  const saveStatus = connectorLabel.status || (connectorLabel.recoveryError ? '部分连线文字恢复记录未确认'
    : connectorLabel.recoveries.some(record => record.value.session.projectId === state?.project.id && record.value.purpose !== 'preserved-remote') ? '连线文字草稿待处理'
    : imageGeometry.rejected ? '图片调整未保存' : imageGeometry.pending ? '图片布局尚未确认' : imageInput.pending ? (imageInput.error ? '图片保存失败 · 原输入保留' : '图片处理中 · 尚未保存') : imageInput.recoveryError ? '部分图片恢复记录未确认' : mediaQueue.hasUnconfirmed
    ? "媒体结果尚未确认 · 重试确认"
    : status === "已保存到本机" && mediaTasks.length
      ? mediaTasks.some((task) => task.status === "failed")
        ? "媒体保存失败 · 重试或移除"
        : "媒体处理中 · 尚未保存"
      : status);
  useEffect(() => {
    setExportStatus('');
  }, [state?.project.id, state?.project.revision, saveStatus]);
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
    const snapshot = authority.current, visible = snapshot?.cards.find(card => card.id === id);
    if (!snapshot || !visible) return;
    const intent = captureCardDeletion(snapshot, id, previewPoseAcks);
    if (!intent) { fail(new Error('请等待完整连线投影后重试删除')); return; }
    cardDeletion.current = intent;
    try {
      breakBodyGroup();
      if (!(await connectorLabel.finish()) || authority.current?.project.id !== intent.projectId ||
        !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      if (cardDeletion.current !== intent || authority.current?.project.id !== intent.projectId ||
        !authority.current.cards.some(card => card.id === id && card.item.id === intent.itemId)) return;
      await action(intent.command(), undefined, { beforeSubmit: () => {
        // 重试按钮直接重放同一个 pending；此时 cardDeletion 已在 finally 里清空，不能再拿它做前置。
        // 别的未完成请求由 action 开头的 commandId 比较拦截，这里只确认删除依据仍然成立。
        if (historyLock.current || historyCommand.current ||
          authority.current?.project.id !== intent.projectId ||
          !authority.current.cards.some(card => card.id === id && card.item.id === intent.itemId)) return false;
        if (intent.seal()) return true;
        fail(new Error('本次删除的自身保存依据未能确认，请重新明确删除'));
        return false;
      } });
    } finally {
      if (cardDeletion.current === intent) cardDeletion.current = null;
    }
  }
  async function chooseCanvasItem(itemId: string, extend: boolean) {
    if (busy || historyLock.current || historyCommand.current || composition.current || pendingAction.current) return;
    const projectId = authority.current?.project.id;
    if (!projectId) return;
    const epoch = ++editorEpoch.current;
    const generation = canvasSelection.generation();
    breakBodyGroup();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    if (epoch !== editorEpoch.current || canvasSelection.generation() !== generation || authority.current?.project.id !== projectId ||
      ![...(authority.current.shapes ?? []), ...(authority.current.images ?? [])].some(item => item.item.id === itemId)) return;
    clearConnectorSelection(extend);
    setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    if (extend || authority.current.groups?.some(group => group.memberItemIds.includes(itemId))) canvasSelection.choose(itemId, extend);
    else setSelection(previous => previous.includes(itemId) && previous.length > 1 ? previous : [itemId]);
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
      await action(command, undefined, { sealed: true });
    } catch { setStrokeRecoveryError("无法接管未确认笔迹，原始记录仍保留，请重试"); }
    finally { strokeRecoveryRunning.current = false; }
  }
  async function chooseStrokeItem(itemId: string, extend: boolean, focus?: HTMLElement) {
    if (busy || historyBlocked || composition.current || pendingAction.current || strokeDraw.hasPending()) return;
    const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
    const generation = canvasSelection.generation();
    breakBodyGroup();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
      !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    if (!projectId || editorEpoch.current !== epoch || canvasSelection.generation() !== generation || authority.current?.project.id !== projectId ||
      !authority.current.strokes?.some(stroke => stroke.item.id === itemId)) return;
    clearConnectorSelection(extend);
    setEditing(null); titleGroup.current = null; awaitBodySelection.current = false;
    canvasSelection.choose(itemId, extend);
    focus?.focus({ preventScroll: true });
  }
  const strokeDeleteRunning = useRef(false);
  async function removeStroke(value: CanvasStroke) {
    if (busy || historyBlocked || composition.current || pendingAction.current || strokeDeleteRunning.current ||
      strokeDraw.hasPending() || !isDirectItem(value.item.id)) return;
    const projectId = authority.current?.project.id, captured = structuredClone(value), epoch = ++editorEpoch.current;
    if (!projectId) return;
    const facts = authority.current && captureMemberDeletion(authority.current, captured, projectId);
    if (!facts) return;
    strokeDeleteRunning.current = true;
    try {
      if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) ||
        !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
      if (editorEpoch.current !== epoch || authority.current?.project.id !== projectId ||
        !authority.current.strokes?.some(stroke => stroke.id === captured.id && stroke.item.id === captured.item.id)) return;
      await action({ commandId: crypto.randomUUID(), projectId, type: "stroke.delete",
        expected: { stroke: captured.versionId, pose: previewPoseAcks.version(projectId, captured.item.id, captured.item.versionId), membership: facts.membership }, payload: { id: captured.id } });
    } finally { strokeDeleteRunning.current = false; }
  }
  const shapeDeleteRunning = useRef(false);
  async function removeShape(value: CanvasShape) {
    if (busy || historyBlocked || composition.current || pendingAction.current || shapeRecoveryRunning.current ||
      shapeDeleteRunning.current || !isDirectItem(value.item.id)) return;
    const snapshot = authority.current, visible = snapshot?.shapes?.find(shape => shape.id === value.id && shape.item.id === value.item.id);
    if (!snapshot || !visible || visible.versionId !== value.versionId || visible.item.versionId !== value.item.versionId) return;
    const projectId = snapshot.project.id, facts = captureMemberDeletion(snapshot, value);
    if (!facts) { fail(new Error('请等待完整对象和连线投影后重试删除')); return; }
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
        expected: { shape: textAck?.value.versionId ?? captured.versionId,
          pose: previewPoseAcks.version(projectId, captured.item.id, poseAck?.value.item.versionId ?? captured.item.versionId), ...facts },
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
    const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
    const generation = canvasSelection.generation();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || !(await texts.finish()) || !(await appearance.flush()) || !(await cardLayout.flush()) || !(await pose.flush()) || !(await flush())) return;
    const current = authority.current, value = current?.shapes?.find(shape => shape.id === id);
    if (!current || !value || current.project.id !== projectId || editorEpoch.current !== epoch || canvasSelection.generation() !== generation) return;
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
    const projectId = authority.current?.project.id, epoch = ++editorEpoch.current;
    const generation = canvasSelection.generation();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish()) || authority.current?.project.id !== projectId ||
      editorEpoch.current !== epoch || canvasSelection.generation() !== generation) return;
    const current = authority.current;
    if (itemId && current && [...current.cards, ...(current.texts ?? []), ...(current.shapes ?? []), ...(current.images ?? []), ...(current.strokes ?? [])].some(value => value.item.id === itemId)) {
      if (current.groups?.some(group => group.memberItemIds.includes(itemId))) canvasSelection.choose(itemId, extend);
      else setSelection(previous => extend ? [...new Set([...previous, itemId])] : [itemId]);
    } else if (!extend) setSelection([]);
  }
  async function createShape(x: number, y: number) {
    const placement = shapePlacement.current;
    if (!state || !placement || shapeCreating.current) return;
    shapeCreating.current = true;
    const projectId = state.project.id, id = crypto.randomUUID();
    const selectionGeneration = canvasSelection.generation();
    let submitted = false, epoch: number | undefined;
    try {
      await action({
        commandId: crypto.randomUUID(), projectId, type: "shape.create", expected: null,
        payload: { id, content: { shapeType: placement.preset, shortText: "" },
          pose: { x, y, width: 180, height: 120 } },
      }, () => {
        const current = authority.current;
        if (workspaceRevoked.current || current?.project.id !== projectId || shapePlacement.current !== placement) return;
        setShapePreset(null);
        const shape = current.shapes?.find(value => value.id === id);
        if (!shape || editorEpoch.current !== epoch || canvasSelection.generation() !== selectionGeneration) return;
        awaitBodySelection.current = false;
        clearConnectorSelection();
        setFrameSelection(null);
        canvasSelection.set({ targets: [{ kind: "item", itemId: shape.item.id }], enteredGroupId: null });
      }, { beforeSubmit: (attemptStart, actionEpoch) => {
        if (submitted) {
          if (epoch === attemptStart) epoch = actionEpoch;
          return true; // Settle this command even if a newer UI intent owns the canvas.
        }
        if (workspaceRevoked.current || authority.current?.project.id !== projectId ||
          shapePlacement.current !== placement || editorEpoch.current !== actionEpoch) return false;
        submitted = true;
        epoch = actionEpoch;
        return true;
      } });
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
  async function editCard(id: string, field: "title" | "body", {
    valid = () => true,
    followingSelection = false,
    origin,
  }: { valid?: () => boolean; followingSelection?: boolean; origin?: HTMLButtonElement | undefined } = {}) {
    if (historyLock.current || historyCommand.current) return;
    if (composition.current) return;
    const epoch = followingSelection ? editorEpoch.current : ++editorEpoch.current;
    const projectId = authority.current?.project.id;
    breakBodyGroup();
    await flush();
    if (!(await shapeMove.flush()) || !(await connectorLabel.finish()) || !(await shapeText.finish())) return;
    if (authority.current?.project.id !== projectId || epoch !== editorEpoch.current || !valid()) return;
    if (field === "title") {
      const card = authority.current?.cards.find(value => value.id === id);
      const { targets } = canvasSelection.current();
      const target = targets[0];
      if (!card || targets.length !== 1 || target?.kind !== "item" || target.itemId !== card.item.id ||
        (origin && document.activeElement !== origin)) return;
    }
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
    if (bodyCard) { if (!(await editCard(card.id, 'body', { valid }))) return false; setSearchSeed(reading); setBodySearchReading(reading); }
    if (!valid() || authority.current?.project.id !== projectId) return false;
    awaitBodySelection.current = true;
    clearConnectorSelection();
    setSelection([card.item.id]);
    setPlacing(false); setPanTool(false); setFrameTool(false);
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
  const following = useRef<{ projectId: string; generation: number; itemId: string } | null>(null);
  const keepBoard = useRef<number | null>(null);
  useEffect(() => {
    const selected = canvasSelection.current(), target = selected.targets[0], projectId = authority.current?.project.id;
    if (keepBoard.current === canvasSelection.generation()) return;
    if (!bodyCard || awaitBodySelection.current || canvasSelection.changeSource() === 'projection' ||
      selected.targets.length !== 1 || target?.kind !== 'item' || !projectId || composition.current || historyBlocked) return;
    const card = authority.current?.cards.find((c) => c.item.id === target.itemId);
    const generation = canvasSelection.generation(), epoch = editorEpoch.current;
    if (!card || card.id === bodyCard || (following.current?.projectId === projectId &&
      following.current.generation === generation && following.current.itemId === card.item.id)) return;
    const request = { projectId, generation, itemId: card.item.id };
    const valid = () => {
      const current = canvasSelection.current(), actual = current.targets[0];
      return authority.current?.project.id === request.projectId && canvasSelection.generation() === request.generation &&
        canvasSelection.changeSource() !== 'projection' && current.targets.length === 1 && actual?.kind === 'item' &&
        actual.itemId === request.itemId && !awaitBodySelection.current && !composition.current && !historyLock.current && !historyCommand.current;
    };
    const frame = requestAnimationFrame(() => {
      if (editorEpoch.current !== epoch || !valid()) return;
      following.current = request;
      void editCard(card.id, "body", { valid, followingSelection: true }).finally(() => {
        if (following.current === request) following.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasSelection.value, bodyCard, historyBlocked, status]);
  useEffect(() => {
    let active = true;
    void authorizeLocalSession()
      .then(() => api.projects())
      .then(async (all) => {
        if (!active || workspaceRevoked.current) return;
        publishProjects(all);
        const id = new URLSearchParams(location.search).get("project");
        const first = all.find((p) => p.id === id) ?? all[0];
        if (first) {
          const value = await api.project(first.id);
          if (active && !workspaceRevoked.current) updateState(value);
        }
        if (active && !workspaceRevoked.current) {
          setWorkspaceAccess('ready');
          setStatus(scanRecovery() ? "有待恢复的未确认草稿" : "已保存到本机");
        }
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof MappingError && (e.status === 401 || e.status === 403)) revokeWorkspaceView();
        fail(e);
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
  const texts = useCanvasTexts(state, selection, ids => { void shapeMove.flush().then(ok => ok && connectorLabel.finish()).then(ok => ok && shapeText.finish()).then(ok => { if (ok) { clearConnectorSelection(); setSelection(ids); } }); }, updateState, async () => await connectorLabel.finish() && await shapeText.finish() && await flush(),
    (command, receipt) => {
      cardDeletion.current?.acknowledge(command, receipt);
      selectionDeletion.current?.acknowledge(command, receipt);
    }, previewPoseAcks);
  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || composition.current ||
        busy || historyBlocked || pendingAction.current || shapeText.session || connectorLabel.session ||
        texts.nodes.some(node => node.data.editing) || imageGeometry.cropping ||
        !(event.target instanceof Element) || !event.target.closest('.canvas') ||
        event.target.closest('input, textarea, [contenteditable=true], dialog, [role=dialog], [role=menu]')) return;
      // A frame owns Delete only as the sole selection. Several frames have no batch
      // owner, so a selected line or canvas object still receives the key.
      const snapshot = authority.current, frame = snapshot?.frames?.find(value => value.id === selectedFrameId);
      if (snapshot && frame) {
        event.preventDefault(); event.stopPropagation();
        void action(deleteFrameCommand(snapshot, frame), () => setFrameSelection(null));
        return;
      }
      // Explicit line selection owns Delete even while an old member retains focus.
      // Multiple lines have no batch-delete owner; do not fall back to canvas items.
      if (selectedConnectors.length) {
        event.preventDefault(); event.stopPropagation();
        const value = selectedConnectors.length === 1 ? authority.current?.connectors?.find(line => line.id === selectedConnectors[0]) : undefined;
        if (value) void afterConnectorLabel(value, connectorEdit.remove);
        return;
      }
      const selected = canvasSelection.current();
      if (!selected.targets.length) return;
      const target = selected.targets[0];
      if (selected.targets.length === 1 && target?.kind === 'item') {
        const card = authority.current?.cards.find(value => value.item.id === target.itemId);
        const text = authority.current?.texts?.find(value => value.item.id === target.itemId);
        if (!card && !text) return;
        event.preventDefault(); event.stopPropagation();
        if (card) void removeCard(card.id); else if (text) void removeText(text.id);
        return;
      }
      event.preventDefault(); event.stopPropagation(); void deleteSelectedCanvas();
    };
    window.addEventListener('keydown', remove, true);
    return () => window.removeEventListener('keydown', remove, true);
  });
  const pastePointer = useRef<{ inside: boolean; world: { x: number; y: number } }>({ inside: false, world: { x: 0, y: 0 } });
  const pasteSequence = useRef<PasteSequence | null>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const canvas = document.querySelector(".canvas .react-flow");
      if (!(canvas instanceof HTMLElement)) return;
      const box = canvas.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      pastePointer.current = { inside, world: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) };
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [flow]);
  async function prepareSnapshot() {
    return await shapeMove.flush() && await connectorLabel.finish() && await shapeText.finish() && await texts.finish() &&
      await appearance.flush() && await cardLayout.flush() && await pose.flush() && await flush();
  }
  function selectCopies(projectId: string, objectCopyIds: CopyRef[], connectorCopyIds: string[]) {
    const latest = authority.current;
    if (!latest || latest.project.id !== projectId) return;
    canvasSelection.set(copiedSelection(latest, objectCopyIds));
    const frames = objectCopyIds.filter(v => v.kind === "frame").map(v => v.copyId);
    setFrameSelection(frames.length ? { projectId, ids: frames, generation: canvasSelection.generation() } : null);
    keepBoard.current = canvasSelection.generation();
    setSelectedConnectors(connectorCopyIds);
  }
  async function copySelection() {
    if (!(await prepareSnapshot())) return;
    const current = authority.current;
    if (!current) return;
    const captured = captureClipboard(current, canvasSelection.current(), selectedConnectors, selectedFrameIds);
    if (!captured) return;
    let document = captured.document;
    try {
      const assets = await Promise.all(clipboardAssetIds(document).map(id => api.asset(current.project.id, id)));
      const library = clipboardLibrary(current, document, assets);
      if (library) document = { ...document, library };
    } catch (error) {
      fail(error instanceof Error ? error : new Error("无法读取复制所需的标签或媒体，原对象未改变"));
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([captured.text], { type: "text/plain" }),
        [CANVAS_CLIPBOARD_TYPE]: new Blob([JSON.stringify(document)], { type: CANVAS_CLIPBOARD_TYPE }),
      })]);
    } catch {
      fail(new Error("无法写入剪贴板，原对象未改变"));
    }
  }
  // 先写系统剪贴板，成功后才提交剪切；提交失败时把剪贴板降级为普通副本，避免留下无法判定的剪切信封。
  async function writeCanvasClipboard(text: string, document: unknown) {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      [CANVAS_CLIPBOARD_TYPE]: new Blob([JSON.stringify(document)], { type: CANVAS_CLIPBOARD_TYPE }),
    })]);
  }
  async function cutSelection() {
    // 剪贴板一旦写入就代表用户意图；历史或保存未收口时不抢写，避免留下没有服务端记录的剪切信封。
    if (busy || historyBlocked || composition.current || !!pendingAction.current) return;
    if (!(await prepareSnapshot())) return;
    const current = authority.current;
    if (!current) return;
    const captured = captureClipboard(current, canvasSelection.current(), selectedConnectors, selectedFrameIds);
    if (!captured) return;
    let document = captured.document;
    try {
      const assets = await Promise.all(clipboardAssetIds(document).map(id => api.asset(current.project.id, id)));
      const library = clipboardLibrary(current, document, assets);
      if (library) document = { ...document, library };
    } catch (error) {
      fail(error instanceof Error ? error : new Error("无法读取剪切所需的标签或媒体，原对象未改变"));
      return;
    }
    const cutId = crypto.randomUUID();
    let command: Command;
    try {
      command = captureCutCommand(current, { commandId: crypto.randomUUID(), projectId: current.project.id, cutId,
        itemIds: captured.scope.items, groupIds: captured.scope.groups, frameIds: captured.scope.frames });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("无法确定剪切范围，原对象未改变"));
      return;
    }
    const envelope = { ...document, cut: { cutId, sourceProjectId: current.project.id } };
    try {
      await writeCanvasClipboard(captured.text, envelope);
    } catch {
      fail(new Error("无法写入剪贴板，原对象未改变"));
      return;
    }
    cutJournal.write({ projectId: current.project.id, cutId, phase: 'clipboard-written', command });
    const done = await action(command);
    if (done) { cutJournal.clear(); return; }
    // action 可能在失败时重新挂起同一请求；用惰性读取避开上面的空值收窄。
    const stillPending = () => pendingAction.current?.command.commandId === command.commandId;
    if (!stillPending()) {
      // 明确拒绝：原件未动，剪贴板退回普通副本，避免下次粘贴读到不存在的剪切记录。
      cutJournal.clear();
      try { await writeCanvasClipboard(captured.text, document); } catch { /* 原剪贴板保留，粘贴时会明确拒绝 */ }
    }
  }
  async function duplicateSelection() {
    if (!(await prepareSnapshot())) return;
    const current = authority.current;
    if (!current) return;
    const plan = duplicatePlan(current, canvasSelection.current(), selectedConnectors, selectedFrameIds);
    if (!plan) return;
    await action(plan.command, () => selectCopies(current.project.id, plan.objectCopyIds, plan.connectorCopyIds));
  }
  function pasteDrop() {
    const canvas = document.querySelector(".canvas .react-flow");
    const box = canvas instanceof HTMLElement ? canvas.getBoundingClientRect() : null;
    const viewport = flow.getViewport();
    const drop = pastePointer.current.inside || !box
      ? pastePointer.current.world
      : flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    return { drop, dropKey: pastePointer.current.inside ? `${drop.x}:${drop.y}` : "outside", viewportKey: `${viewport.x}:${viewport.y}:${viewport.zoom}` };
  }
  async function pasteSnapshot(raw: string) {
    if (!(await prepareSnapshot())) return;
    const current = authority.current;
    if (!current) return;
    let document: ReturnType<typeof parseClipboard>;
    try { document = parseClipboard(raw); }
    catch (error) { fail(error instanceof Error ? error : new Error("无法读取这份画布剪贴板，原内容未改变")); return; }
    const cut = document.cut;
    // D467 的恢复口径只覆盖跨项目剪切的目标粘贴；普通副本与回源项目的粘贴不写恢复记录。
    const crossProjectCut = !!cut && cut.sourceProjectId !== current.project.id;
    // 按请求类别阻断：未确认的跨项目粘贴不能生成第二个请求，普通粘贴不受影响。
    if (crossProjectCut && pasteJournal.read(current.project.id)) {
      fail(new Error("上一次跨项目粘贴尚未确认，请刷新页面确认后再粘贴"));
      return;
    }
    const target = pasteDrop();
    const step = nextPaste(pasteSequence.current, { clipboard: raw, drop: target.dropKey, viewport: target.viewportKey });
    pasteSequence.current = step.sequence;
    const translation = pasteTranslation(clipboardCenter(document), target.drop, step.index);
    if (cut && cut.sourceProjectId === current.project.id) {
      // 同项目按 D466 读取本项目的剪切资格；仍可首次搬动时恢复原对象身份与有效外线。
      let view: { state: string; revision: number };
      try { view = await api.cutState(current.project.id, cut.cutId); }
      catch (error) {
        fail(error instanceof MappingError && error.code === 'CUT_NOT_FOUND'
          ? new Error("剪切记录已不可用，未粘贴任何内容")
          : error instanceof MappingError && ['PROJECT_FORBIDDEN', 'UNAUTHORIZED', 'UNTRUSTED_PRINCIPAL'].includes(error.code)
            ? new Error("无法确认剪切资格，未粘贴任何内容")
            : error instanceof Error ? error : new Error("无法确认剪切资格"));
        return;
      }
      if (view.state === 'eligible') {
        const command = { commandId: crypto.randomUUID(), projectId: current.project.id, type: "canvas.paste-cut",
          expected: { cut: cut.cutId, cutRevision: view.revision },
          payload: { cutId: cut.cutId, translation } } as Command;
        await action(command, () => selectCopies(current.project.id, restoredCopyRefs(document), []));
        return;
      }
    }
    // 异项目粘贴只读冻结快照，不查询源项目状态：AC1／AC3 要求目标动作与源项目各自独立。
    // 源记录缺失或无权访问都不阻止目标写入；权限由目标项目的 execute 承担。
    const plan = pastePlan(current.project.id, document, translation);
    await action(plan.command, () => selectCopies(current.project.id, plan.objectCopyIds, plan.connectorCopyIds),
      crossProjectCut ? {
        persist: (value: Command) => pasteJournal.write(current.project.id, value),
        onCommitted: () => pasteJournal.clear(current.project.id, plan.command.commandId),
        onRejected: (error: unknown, attempt: PasteAttempt) => {
          if (pasteNotCommitted(error, attempt)) pasteJournal.clear(current.project.id, plan.command.commandId);
        },
      } : undefined);
  }
  async function pastePlainText(text: string) {
    const current = authority.current;
    if (!current || !text) return;
    const canvas = document.querySelector(".canvas .react-flow");
    const box = canvas instanceof HTMLElement ? canvas.getBoundingClientRect() : null;
    const point = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
    await action({ commandId: crypto.randomUUID(), projectId: current.project.id, type: "thought.create", expected: null,
      payload: { id: crypto.randomUUID(), title: "", text, x: point.x - 140, y: point.y - 80 } });
  }
  async function pasteSelection() {
    try {
      const items = await navigator.clipboard.read();
      const item = items.find(value => value.types.includes(CANVAS_CLIPBOARD_TYPE));
      if (!item) { fail(new Error("剪贴板里没有画布副本")); return; }
      await pasteSnapshot(await (await item.getType(CANVAS_CLIPBOARD_TYPE)).text());
    } catch (error) {
      fail(error instanceof Error ? error : new Error("无法读取这份画布剪贴板，原内容未改变"));
    }
  }
  useEffect(() => {
    const editing = (target: EventTarget | null) => target instanceof Element &&
      !!target.closest("input, textarea, [contenteditable=true], dialog, [role=dialog], [role=menu]");
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || event.isComposing || event.keyCode === 229) return;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "d" && key !== "x") return;
      if (backupDialog.current?.open || editing(event.target) || busy || historyBlocked || composition.current || pendingAction.current) return;
      const current = authority.current;
      if (!current) return;
      const canAct = key === "x"
        ? canCutSelection(current, canvasSelection.current(), selectedConnectors, selectedFrameIds)
        : canCopySelection(current, canvasSelection.current(), selectedConnectors, selectedFrameIds);
      if (!canAct) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "x") void cutSelection(); else if (key === "c") void copySelection(); else void duplicateSelection();
    };
    const paste = (event: ClipboardEvent) => {
      if (backupDialog.current?.open || editing(event.target) || busy || historyBlocked || composition.current || pendingAction.current) return;
      const data = event.clipboardData;
      const raw = data?.getData(CANVAS_CLIPBOARD_TYPE);
      if (raw) { event.preventDefault(); event.stopPropagation(); void pasteSnapshot(raw); return; }
      if (!data || data.files.length || data.types.includes("text/html")) return;
      const text = data.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const items = await navigator.clipboard.read();
          const item = items.find(value => value.types.includes(CANVAS_CLIPBOARD_TYPE));
          if (item && await navigator.clipboard.readText() === text) {
            await pasteSnapshot(await (await item.getType(CANVAS_CLIPBOARD_TYPE)).text());
            return;
          }
        } catch { /* The event text remains the plain-text card. */ }
        await pastePlainText(text);
      })();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("paste", paste, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("paste", paste, true);
    };
  });
  // 未确认的剪切在下次加载时用原 commandId 与 expected 重试；粘贴路径不补做剪切。
  const cutRecovery = useRef<string | null>(null);
  useEffect(() => {
    const id = state?.project.id;
    if (!id) return;
    const pending = cutJournal.read();
    if (!pending || pending.projectId !== id || cutRecovery.current === pending.cutId || pendingAction.current) return;
    cutRecovery.current = pending.cutId;
    void (async () => {
      const done = await action(pending.command, undefined, { sealed: true });
      if (done || pendingAction.current?.command.commandId !== pending.command.commandId) cutJournal.clear();
    })();
  }, [state?.project.id]);
  // 目标粘贴的结果未知时，刷新后按原 commandId 与原载荷重放；只有交易内的拒绝才结束尝试。
  const pasteRecovery = useRef<string | null>(null);
  useEffect(() => {
    const id = state?.project.id;
    if (!id) return;
    const pending = pasteJournal.read(id);
    if (!pending || pasteRecovery.current === pending.command.commandId || pendingAction.current) return;
    pasteRecovery.current = pending.command.commandId;
    void (async () => {
      setBusy(true);
      setStatus("正在确认未完成的粘贴…");
      try {
        await api.execute(pending.command);
        // 已确认提交：先清记录；后面只是重新读取画面。
        pasteJournal.clear(id, pending.command.commandId);
        try { await refresh(id); setStatus("已保存到本机"); setError(""); }
        catch (error) { fail(error); }
      } catch (error) {
        if (pasteNotCommitted(error, 'replay')) {
          pasteJournal.clear(id, pending.command.commandId);
          try { await refresh(id); } catch { /* 拒绝已明确，画面读取失败不改变结论 */ }
        }
        fail(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [state?.project.id]);
  const canvasMove = useCanvasMove(state, canvasSelection.value, (prepare, done, intent, discard) => texts.enqueueGeometry(async () => {
    if (!(await shapeMove.flush())) throw new Error("请先确认形状布局保存，整组移动意图仍保留");
    return prepare();
  }, done, intent, discard), previewPoseAcks);
  const frameMove = useFrameMove({ state, blocked: busy || historyBlocked || composition.current || !!pendingAction.current,
    point: client => flow.screenToFlowPosition(client, { snapToGrid: false }),
    execute: async (command, done, snapshot) => {
      const confirmed = await action(command, undefined, { onSettled: done, ...(command.type === 'frame.resize' ? {
        beforeSubmit: async () => {
          try {
            const projected = await previewPoseAcks.project(snapshot, new Set(spatialItems(snapshot).map(value => value.item.id)));
            if (authority.current?.project.id !== command.projectId) return false;
            if (projected !== snapshot && !sameFrameResizeMembership(snapshot, projected, command.payload.id, command.payload.pose)) {
              fail(new Error('卡片布局已更新，请重新预览分区范围'));
              return false;
            }
            return true;
          } catch (failure) { fail(failure); return false; }
        },
      } : {}) });
      if (!confirmed && pendingAction.current?.command.commandId !== command.commandId) done();
    } });
  const groupGeometry = useGroupGeometry({ state, selection: canvasSelection.value, current: () => authority.current,
    generation: canvasSelection.generation, zoom: () => flow.getZoom(), lock: setGroupGeometryLocked, fail,
    blocked: busy || historyBlocked || composition.current || !!pendingAction.current || canvasMove.dragging || pose.dragging ||
      shapeMove.dragging || imageGeometry.dragging || imageGeometry.hasPending(state?.project.id) || texts.hasMove() || !!shapeText.session || !!connectorLabel.session,
    flush: async () => await shapeMove.flush() && await connectorLabel.finish() && await shapeText.finish() && await texts.finish() &&
      await appearance.flush() && await cardLayout.flush() && await pose.flush() && await flush(),
    execute: (command, done, guard) => action(command, done, { beforeSubmit: guard }) });
  function canvasDragPoint(event: MouseEvent | TouchEvent) {
    const pointer = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
    return pointer ? flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }, { snapToGrid: false }) : undefined;
  }
  function beginCanvasNodeDrag(event: MouseEvent | TouchEvent, node: { id: string; position: Position; type?: string | undefined }) {
    canvasSelection.beginDrag(node.id);
    const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
    if (canvasMove.start(node.id, true)) { canvasMove.drag(point); return; }
    if (canvasSelection.hasDirectStroke()) return;
    if (node.type === 'canvasShape') { shapeMove.start(node.id); shapeMove.preview(node.id, point); return; }
    if (texts.startMove(node.id)) { texts.previewMove(node.id, point); return; }
    const card = authority.current?.cards.find(value => value.item.id === node.id);
    if (card && startMove(authority.current!.project.id, card)) previewMove(point, 'altKey' in event && event.altKey);
  }
  async function createSelectedGroup() {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current) return;
    const intent = createGroupCommand(snapshot, canvasSelection.current());
    const generation = canvasSelection.generation();
    await action(intent, () => {
      canvasSelection.set({ targets: [{ kind: 'group', id: intent.payload.id }], enteredGroupId: null });
      clearConnectorSelection();
    }, { beforeSubmit: () => authority.current?.project.id === intent.projectId && canvasSelection.generation() === generation });
  }
  async function ungroupSelectedGroups() {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current) return;
    const selected = canvasSelection.current(), members = selectedItemIds(snapshot, selected);
    const command = ungroupSelectionCommand(snapshot, selected), generation = canvasSelection.generation();
    if (!command) return;
    await action(command, () => canvasSelection.set({ targets: members.map(itemId => ({ kind: 'item', itemId })), enteredGroupId: null }),
      { beforeSubmit: () => authority.current?.project.id === command.projectId && canvasSelection.generation() === generation });
  }
  async function createSelectedFrame() {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current) return;
    const command = createFrameSelectionCommand(snapshot, canvasSelection.current());
    if (!command) return;
    const generation = canvasSelection.generation();
    await action(command, () => { chooseFrame(command.payload.id); setFrameTool(false); },
      { beforeSubmit: async () => {
        const itemIds = new Set(Object.keys(command.expected.poses));
        try {
          const projected = await previewPoseAcks.project(snapshot, itemIds);
          if (authority.current?.project.id !== command.projectId || canvasSelection.generation() !== generation) return false;
          const pose = frameSelectionRect(projected, itemIds);
          if (!pose) return false;
          command.payload.pose = pose;
          return true;
        } catch (failure) { fail(failure); return false; }
      } });
  }
  async function deleteSelectedCanvas(groupId?: string) {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current || selectionDeletion.current) return;
    const selected = canvasSelection.current(), target = selected.targets[0];
    if (groupId && (selected.targets.length !== 1 || target?.kind !== 'group' || target.id !== groupId)) return;
    const intent = captureSelectionDeletion(snapshot, selected, previewPoseAcks), generation = canvasSelection.generation();
    if (!intent) { fail(new Error('请等待完整对象与归属投影，再明确删除选区')); return; }
    selectionDeletion.current = intent;
    const command: Command = groupId ? { commandId: intent.command.commandId, projectId: intent.command.projectId, type: 'group.delete', payload: { id: groupId },
      expected: { group: intent.command.expected.groups[groupId]!, parentContainment: intent.command.expected.containment[snapshot.groups!.find(group => group.id === groupId)!.itemId],
        containment: Object.fromEntries(Object.entries(intent.command.expected.containment).filter(([id]) => snapshot.groups!.find(group => group.id === groupId)!.memberItemIds.includes(id)).map(([id, version]) => [id, version!])),
        endpoints: intent.command.expected.endpoints, items: intent.command.expected.items, connectors: intent.command.expected.connectors } } : intent.command;
    try {
      await action(command, undefined, { beforeSubmit: () => {
        if (selectionDeletion.current !== intent || authority.current?.project.id !== intent.command.projectId || canvasSelection.generation() !== generation) return false;
        if (!intent.seal()) { fail(new Error('删除依据缺少确切保存确认，请重新明确删除选区')); return false; }
        return true;
      } });
    } finally { if (selectionDeletion.current === intent) selectionDeletion.current = null; }
  }
  async function applyLayer(operation: LayerOperation) {
    const snapshot = authority.current;
    if (!snapshot || busy || historyBlocked || composition.current || pendingAction.current || selectionDeletion.current ||
      shapeText.session || connectorLabel.session || texts.hasPending() || imageGeometry.cropping) return;
    const ids = layerItemIds(snapshot, selectedItemIds(snapshot, canvasSelection.current()));
    if (!ids.length) return;
    const items = layerItems(snapshot);
    if (ids.some(id => !items.some(value => value.itemId === id))) return;
    const command: Extract<Command, { type: 'canvas.layer' }> = {
      commandId: crypto.randomUUID(),
      projectId: snapshot.project.id,
      type: 'canvas.layer',
      expected: Object.fromEntries(items.map(value => [value.itemId, value.item.versionId])),
      payload: { itemIds: ids, operation },
    };
    const generation = canvasSelection.generation(), hold = { projectId: command.projectId, generation };
    // 属性容器：闭包写入须在 await 之后仍按声明类型读取。
    const before = { ids: undefined as string[] | undefined };
    setLayerHold(hold);
    const applied = await action(command, undefined, { beforeSubmit: () => {
      const current = authority.current;
      if (!current || current.project.id !== command.projectId || canvasSelection.generation() !== generation) return false;
      const fresh = layerItems(current),
        freshIds = layerItemIds(current, selectedItemIds(current, canvasSelection.current()));
      if (freshIds.length !== ids.length || freshIds.some((id, index) => id !== ids[index])) return false;
      command.expected = Object.fromEntries(fresh.map(value => [value.itemId, value.item.versionId]));
      before.ids = fresh.map(value => value.itemId);
      return true;
    } });
    const current = authority.current,
      after = applied && current ? layerItems(current).map(value => value.itemId) : null,
      beforeIds = before.ids;
    const reordered = !!beforeIds && !!after &&
      (after.length !== beforeIds.length || after.some((id, index) => id !== beforeIds[index]));
    if (!reordered) setLayerHold(value => value === hold ? null : value);
  }
  function isDirectItem(itemId: string) {
    const selected = canvasSelection.current(), target = selected.targets[0];
    return selected.targets.length === 1 && target?.kind === 'item' && target.itemId === itemId;
  }
  async function removeText(id: string) {
    const snapshot = authority.current, text = snapshot?.texts?.find(value => value.id === id);
    if (!snapshot || !text || !isDirectItem(text.item.id) || busy || historyBlocked || composition.current || pendingAction.current || selectionDeletion.current) return;
    const facts = captureMemberDeletion(snapshot, text), intent = captureSelectionDeletion(snapshot, { targets: [{ kind: 'item', itemId: text.item.id }], enteredGroupId: null }, previewPoseAcks);
    if (!facts || !intent) return;
    const generation = canvasSelection.generation();
    const command: Extract<Command, { type: 'text.delete' }> = { commandId: intent.command.commandId, projectId: snapshot.project.id, type: 'text.delete',
      expected: { text: text.versionId, pose: text.item.versionId, ...facts }, payload: { id } };
    selectionDeletion.current = intent;
    try {
      await action(command, undefined, { beforeSubmit: () => {
        if (selectionDeletion.current !== intent || authority.current?.project.id !== command.projectId || canvasSelection.generation() !== generation || !intent.seal()) return false;
        const expected = intent.command.expected.items[text.item.id]!;
        if (expected.kind !== 'text') return false;
        command.expected.text = expected.text; command.expected.pose = expected.pose; return true;
      } });
    } finally { if (selectionDeletion.current === intent) selectionDeletion.current = null; }
  }
  function memberAction(itemId: string) {
    return singleItemId === itemId && state?.containment?.some(value => value.id === itemId && value.parent?.kind === 'group')
      ? () => { void releaseSelectedMember(itemId); } : undefined;
  }
  async function releaseSelectedMember(itemId: string) {
    const snapshot = authority.current, selected = canvasSelection.current(), target = selected.targets[0];
    if (!snapshot || selected.targets.length !== 1 || target?.kind !== 'item' || target.itemId !== itemId) return;
    const command = removeMemberCommand(snapshot, itemId), generation = canvasSelection.generation();
    if (command) await action(command, undefined, { beforeSubmit: () => authority.current?.project.id === command.projectId && canvasSelection.generation() === generation });
  }
  async function ungroupSelected(id: string) {
    const snapshot = authority.current, selected = canvasSelection.current(), target = selected.targets[0];
    if (!snapshot || selected.targets.length !== 1 || target?.kind !== 'group' || target.id !== id) return;
    const command = ungroupCommand(snapshot, id), members = snapshot.groups!.find(group => group.id === id)!.memberItemIds;
    const generation = canvasSelection.generation();
    if (command) await action(command, () => canvasSelection.set({ targets: members.map(itemId => ({ kind: 'item', itemId })), enteredGroupId: null }),
      { beforeSubmit: () => authority.current?.project.id === command.projectId && canvasSelection.generation() === generation });
  }
  useEffect(() => {
    const groupShortcut = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'g' ||
        event.defaultPrevented || event.isComposing || event.keyCode === 229 || composition.current ||
        busy || historyBlocked || pendingAction.current || texts.hasPending() || shapeText.session || connectorLabel.session ||
        texts.nodes.some(node => node.data.editing) || imageGeometry.cropping ||
        !(event.target instanceof Element) || !event.target.closest('.canvas') ||
        event.target.closest('input, textarea, [contenteditable=true], dialog, [role=dialog], [role=menu]')) return;
      if (!authority.current) return;
      const selected = canvasSelection.current(), target = selected.targets[0];
      if (event.shiftKey) {
        if (selected.targets.length !== 1 || target?.kind !== 'group') return;
        event.preventDefault(); event.stopPropagation(); void ungroupSelected(target.id);
      } else {
        if (selected.targets.length < 2) return;
        event.preventDefault(); event.stopPropagation(); void createSelectedGroup();
      }
    };
    window.addEventListener('keydown', groupShortcut, true);
    return () => window.removeEventListener('keydown', groupShortcut, true);
  });
  const layerSelection = state ? layerItemIds(state, flowSelection) : [];
  const pureCardSelection = canvasSelection.value.targets.length > 0 && canvasSelection.value.targets.every(target =>
    target.kind === 'item' && !!state?.cards.some(card => card.item.id === target.itemId));
  const layerProps: LayerMenuProps | undefined = state && layerSelection.length ? {
    availability: layerAvailability(state, layerSelection),
    blocked: busy || historyBlocked || !!pendingAction.current || composition.current || !!shapeText.session ||
      !!connectorLabel.session || !!imageGeometry.cropping || texts.hasPending(),
    apply: (operation: LayerOperation) => { void applyLayer(operation); },
  } : undefined;
  function annotationTargetAvailable() {
    return authority.current?.project.id === attachmentPick?.projectId && !busy && !historyBlocked &&
      !historyLock.current && !historyCommand.current && !composition.current && !pendingAction.current &&
      !connectorCreate.hasPending();
  }
  function annotationAction(itemId: string) {
    if (!state || exclusiveItemId !== itemId) return;
    const row = state.attachments?.find(value => value.id === itemId);
    const blocked = busy || historyBlocked || composition.current || !!pendingAction.current;
    if (row?.target) {
      const target = state.cards.find(card => card.item.id === row.target?.itemId);
      if (!target) return;
      return <button disabled={blocked} title={`附着到：${target.title || "未命名卡片"}`} onClick={() => {
        void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: "attachment.detach",
          expected: { attachment: row.versionId, target: { itemId: target.item.id, versionId: target.item.versionId } },
          payload: { itemId } });
      }}>解除附着</button>;
    }
    return <button disabled={blocked} aria-pressed={attachmentPick?.itemId === itemId} onClick={event => {
      if (attachmentPick) { setAnnotationPick(null); return; }
      if (state.containment?.find(value => value.id === itemId)?.parent) {
        setError("该批注在框架或组合内，需先移出");
        return;
      }
      if (!chooseSelectionTool()) return;
      setError("");
      setAnnotationPick({ projectId: state.project.id, itemId, trigger: event.currentTarget });
    }}>附着到卡片</button>;
  }
  const attachmentPreview = state ? attachmentPreviewPositions(state, { pose: pose.positions, canvas: canvasMove.positions, frame: frameMove.positions, geometry: groupGeometry.poses }) : {};
  const textNodes = texts.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      singleSelection: node.data.singleSelection && singleItemId === node.id,
      annotation: annotationAction(node.id),
      removeFromGroup: memberAction(node.id),
      remove: singleItemId === node.id ? () => { void removeText(node.data.value.id); } : undefined,
      layer: layerProps,
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
  function closeWritingBoard() {
    if (composition.current) return;
    editorEpoch.current++;
    breakBodyGroup(); persistDrafts(); void flush();
    bodyBinding.current = null; setDeletedBody(null); setBodyCard(null); setSearchSeed(null); setBodySearchReading(null);
  }
  const attachmentWriteBlocked = busy || historyBlocked || !!pendingAction.current || attachmentProjectSwitches > 0;
  function addAttachment(projectId: string, targetId: string, assetId: string, name: string, uploadTarget?: Card) {
    const current = authority.current;
    const target = current?.project.id === projectId ? current.cards.find(value => value.id === targetId) : uploadTarget;
    if (!target) return;
    return action({ commandId: crypto.randomUUID(), projectId, type: 'card.attachment.add',
      expected: { attachments: target.attachments?.versionId ?? null },
      payload: { id: target.id, assetId, name } });
  }
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
      showMenu: exclusiveItemId === card.item.id,
      layer: layerProps,
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
      onEdit: origin => void editCard(card.id, "title", { origin }),
      onBody: () => void editCard(card.id, "body"),
      verificationAvailable: canvasSelection.value.targets.length === 1,
      onAI: (verification) => {
        const current = authority.current;
        const source = current?.cards.find(item => item.id === card.id);
        if (!current || !source || composition.current || busy || historyBlocked) return;
        void (async () => {
          if (!(await flush())) return;
          const saved = authority.current?.cards.find(item => item.id === source.id);
          if (saved && authority.current?.project.id === current.project.id) {
            setOrganizing({ projectId: current.project.id, source: saved, ...(verification ? { verification } : {}) });
          }
        })();
      },
      onOpenAttachment: (assetId) => {
        const projectId = authority.current?.project.id;
        if (!projectId) return;
        // 空白标签必须在这次点击里打开。等预检返回再 window.open，无头浏览器会丢掉句柄，却仍然弹出一个空页。
        const opened = window.open('', '_blank');
        void openCardAttachment({ origin: location.origin, projectId, assetId, opened }).then(result => {
          if (!result.ok) setStatus(result.message);
        });
      },
      onRemoveAttachment: (attachmentId) => {
        const current = authority.current;
        const target = current?.cards.find(value => value.id === card.id);
        if (!current || current.project.id !== state?.project.id || !target?.attachments || attachmentWriteBlocked) return;
        void action({ commandId: crypto.randomUUID(), projectId: current.project.id, type: 'card.attachment.remove',
          expected: { attachments: target.attachments.versionId },
          payload: { id: target.id, attachmentId } });
      },
      attachmentTargets: state!.cards,
      attachmentWriteBlocked,
      onCopyAttachment: (targetId, item) => {
        if (!attachmentWriteBlocked) void addAttachment(state!.project.id, targetId, item.assetId, item.name);
      },
      onAddAttachment: (file) => {
        const current = authority.current;
        const target = current?.cards.find(value => value.id === card.id);
        if (!current || current.project.id !== state?.project.id || !target || attachmentWriteBlocked) return;
        const projectId = current.project.id, uploadId = crypto.randomUUID();
        void (async () => {
          try {
            const payload = await fileAssetPayload(file);
            const assetId = crypto.randomUUID();
            await api.execute({ commandId: uploadId, projectId, type: 'asset.save', expected: null, payload: { id: assetId, ...payload, kind: 'file' } });
            if (workspaceRevoked.current) return;
            if (authority.current?.project.id !== projectId &&
              (preparingActions.current || pendingAction.current || historyLock.current || historyCommand.current || connectorCreate.hasPending())) {
              recordAttachmentResult(projectId, "rejected", "请先完成当前项目的保存，再回原卡重新添加附件");
              return;
            }
            await addAttachment(projectId, target.id, assetId, payload.name, target);
          } catch (error) {
            if (workspaceRevoked.current) return;
            recordAttachmentResult(projectId, "rejected", failureMessage(error));
            if (authority.current?.project.id === projectId) fail(error);
          }
        })();
      },
      onCanvasChoice: () => { editorEpoch.current++; },
      onDelete: () => void removeCard(card.id),
      onRemoveFromGroup: memberAction(card.item.id),
      onMeasure: cardLayout.measure,
      measurable: !groupGeometry.active && !busy && !historyBlocked && !pose.pending && !pose.dragging && !shapeMove.hasPending(),
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
      strokeSelected,
      movingDisabled: strokeSelected || busy || historyBlocked || pose.pending || shapeMove.pending || shapeMove.dragging || texts.geometryBlocked || !!shapeText.session,
      historyBlocked,
      resizable: exclusiveItemId === card.item.id,
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
  const currentBodyData = nodes.find(node => node.data.card.id === bodyCard)?.data;
  const currentBody = currentBodyData?.card;
  const panelCard =
    currentBody ??
    (deletedBody &&
    deletedBody.projectId === state?.project.id &&
    deletedBody.card.id === bodyCard
      ? deletedBody.card
      : undefined);
  const currentBodyDraft = state && currentBody && draftView[draftKey(state.project.id, currentBody.id, "body")];
  const ownsCurrentBody = (owner: CardSaveOwner | null | undefined) =>
    owner?.field === "body" && owner.projectId === state?.project.id && owner.cardId === currentBody?.id;
  const currentBodySaving = ownsCurrentBody(savingDraft) || ownsCurrentBody(savingBodyAction);
  const failedDraft = draftFailure && draftFailure.owner.projectId === state?.project.id &&
    matchesFailedDraft(nextSaveDraft(), draftFailure) ? draftFailure : null;
  const pending = pendingAction.current;
  const previousProjectPending = pending && belongsToPreviousProject(pending.command) ? pending : null;
  const currentProjectPending = previousProjectPending ? null : pending;
  const attachmentReadPending = currentProjectPending?.attachmentReadFailed ? currentProjectPending : null;
  const pendingBodyFailure = currentProjectPending?.bodyFailure;
  const retryFailure = pendingBodyFailure
    ? pendingBodyFailure.owner.projectId === state?.project.id ? pendingBodyFailure : null
    : failedDraft;
  const currentBodyFailed = !currentBodySaving &&
    (ownsCurrentBody(failedDraft?.owner) || ownsCurrentBody(pendingBodyFailure?.owner));
  const previousProjectSave = previousProjectFeedback && previousProjectFeedback.commandId === previousProjectPending?.command.commandId
    ? previousProjectPending : null;
  const bodyRetryAvailable = !pose.error && !conflict && !historyCommand.current;
  const blockingBodyDraft = bodyRetryAvailable && failedDraft?.owner.field === "body" &&
    pendingBodyFailure?.owner.projectId === failedDraft.owner.projectId ? failedDraft : null;
  const boardDraftFailure = currentBodyFailed && ownsCurrentBody(blockingBodyDraft?.owner);
  const boardSaveFailure = currentBodyFailed && bodyRetryAvailable && !boardDraftFailure && ownsCurrentBody(retryFailure?.owner) &&
    (!currentProjectPending || retryFailure === pendingBodyFailure);
  const boardStatus = !currentBody ? "已删除 · 内容保留"
    : currentBodyFailed ? "保存未完成"
    : currentBodySaving ? "正在保存…"
    : currentBodyDraft ? "等待保存…"
    : mediaQueue.unconfirmedCardIds.has(currentBody.id) ? "媒体结果尚未确认 · 重试确认"
    : currentBody.body.blocks.some(block => imageTask(block)?.status === "failed") ? "媒体保存失败 · 重试或移除"
    : currentBody.body.blocks.some(block => imageTask(block)) ? "媒体处理中 · 尚未保存"
    : bodyPreviewText(currentBody.body).trim() ? "正文已保存" : "已保存到本机";
  const retryOwner = retryFailure?.owner;
  const retryingFailure = retryOwner &&
    (savingDraft?.commandId === retryOwner.commandId || savingBodyAction?.commandId === retryOwner.commandId);
  const visibleError = conflict && error ? error
    : retryingFailure ? "" : retryFailure?.message ?? (pendingBodyFailure ? "" : error);
  const saveFailure = (visibleError || pose.error) ? (
    <>
      <span role="alert">
        {[visibleError, pose.error].filter(Boolean).join("；")}
      </span>
      {blockingBodyDraft && <span>请先处理未完成的正文保存，再重试本次操作</span>}
      {(!previousProjectPending || historyCommand.current || pose.error || hasActiveCardDraft()) && <button
        disabled={busy || !!pose.conflict || (!!conflict && !pose.error) || !!blockingBodyDraft}
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
          if (pending && !pending.attachmentReadFailed && !belongsToPreviousProject(pending.command)) void action(pending.command, pending.onDone, pending.options);
          else if (hasActiveCardDraft() || !pending && Object.keys(drafts.current).length) void flush();
          else if (!pending) location.reload();
        }}
      >
        {historyCommand.current
          ? historyCommand.current.type === "history.undo"
            ? "重试撤销"
            : "重试重做"
          : "重试保存"}
      </button>}
    </>
  ) : null;
  const draftSaveFailure = blockingBodyDraft ? (
    <>
      <span role="alert">{blockingBodyDraft.message}</span>
      <button disabled={busy || historyBlocked || !!pose.conflict || !!savingDraft}
        onClick={() => {
          if (!saving.current && !historyLock.current && matchesFailedDraft(nextSaveDraft(), blockingBodyDraft)) void flush();
        }}>重试正文保存</button>
    </>
  ) : null;
  const boardFailure = boardDraftFailure ? draftSaveFailure : boardSaveFailure ? saveFailure : undefined;
  // 按钮禁用与捕获中止是两套条件。并集会让框选、草稿等额外禁用导出，这里保持分开。
  // 内联编辑会话要在捕获侧单独把关：导出已开始后再双击进入编辑时，会话刚建立还没有未保存内容，
  // 只查 hasPending() 会把编辑框（textarea 与所选样式）连同白底烘进图像。
  // 这里必须用 currentSession() 读当场状态：session 是渲染快照，闭包里会停在导出开始那一刻。
  function exportCaptureIntact(snapshotId: string) {
    const current = authority.current;
    if (!current || current.snapshot !== snapshotId) return false;
    if (pendingAction.current || saving.current || unconfirmed.current || closedDrafts.current.length || Object.keys(drafts.current).length || composition.current || frameDrag.current) return false;
    if (pose.hasPending() || shapeMove.hasPending() || texts.hasPending() || texts.hasMove() || shapeText.hasPending() || !!shapeText.currentSession()) return false;
    if (appearance.hasPending() || cardLayout.hasPending() || canvasMove.hasPointerGesture() || frameMove.hasGesture() || groupGeometry.hasGesture() || marqueeSelection.hasGesture()) return false;
    if (strokeDraw.hasPending() || connectorCreate.hasPending() || connectorEdit.hasPending() || connectorLabel.hasPending() || !!connectorLabel.currentSession() || frameDraft.current || labelPositionPreview.current.size > 0) return false;
    return !imageGeometry.hasPending(current.project.id) && !imageInput.hasPending(current.project.id) && imageGeometry.cropping?.projectId !== current.project.id;
  }
  const exportBlocked = !state || busy || historyBlocked || saveStatus !== '已保存到本机' || !!pendingAction.current ||
    shapeMove.pending || shapeMove.dragging || !!shapeText.session || texts.hasPending() || pose.pending || pose.dragging ||
    appearance.pending || cardLayout.pending || canvasMove.dragging || frameMove.hasGesture() || frameDrafting || strokeDraw.hasPending() ||
    connectorCreate.hasPending() || connectorEdit.hasPending() || imageGeometry.hasPending(state.project.id) ||
    imageInput.hasPending(state.project.id) || imageGeometry.cropping?.projectId === state.project.id || mediaQueue.hasUnconfirmed;
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
  const pendingOrganizeCancellations = organizing
    ? [...organizeCancellations.pending.values()].filter(({ projectId, request }) =>
      projectId === organizing.projectId && !!request.verification === !!organizing.verification && (!organizing.source || request.cardId === organizing.source.id)).map(({ request }) => request)
    : [];
  const canOpenGuide = workspaceAccess === 'ready' && (guideAccess === 'allowed' || guideAccess === 'retry');
  const projectCreationUnavailable = workspaceAccess === 'revoked' || guideAccess === 'denied';
  const projectCreationBlocked = busy || historyBlocked || projectCreationUnavailable;
  const showNoProjects = workspaceAccess === 'ready' && !state && !projects.length && guideAccess !== 'denied';
  const showEmptyCanvas = state && !spatialItems(state).length && !state.frames?.length &&
    !state.groups?.length && !state.connectors?.length && !textNodes.length;
  const showingPlacement = placing || texts.placing || frameTool || shapePreset || strokeDraw.mode || connectorCreate.mode;
  const selectedCardCanConnect = !showingPlacement && !panTool && !editing && !attachmentPick && !connectorLabel.session &&
    !imageGeometry.cropping && !connectorCreationBlocked() && !historyBlocked &&
    state?.cards.some(card => card.item.id === exclusiveItemId);
  const connectorEntries = exportVisual || connectorEdit.keyboardMoving ? [] :
    connectorCreate.mode || connectorCreate.keyboardActive || connectorEdit.keyboardEndpoint ? connectorTargets.values :
    selectedCardCanConnect ? connectorTargets.values.filter(value => !value.targetKind && value.itemId === exclusiveItemId) : [];
  const connectorDraft = connectorCreate.draft?.projectId === state?.project.id ? connectorCreate.draft : null;
  const draftEnd = connectorDraft?.endEndpoint;
  const draftStart = connectorDraft?.startEndpoint;
  const connectorSnap = draftEnd?.kind === 'bound' && (draftStart?.kind !== 'bound' || endpointKey(draftStart) !== endpointKey(draftEnd))
    ? connectorTargets.values.find(value => value.itemId === draftEnd.itemId && value.targetKind === draftEnd.targetKind && value.side === draftEnd.side)
    : undefined;
  // Opening a modal shifts focus, which would end these editing rounds.
  const guideEditInProgress = !!editing || !!connectorLabel.session || frameMove.hasKeyboardResize() ||
    texts.nodes.some(node => node.data.editing) ||
    !!(state && currentBody && draftView[draftKey(state.project.id, currentBody.id, 'body')]);
  function handleGuideAccess(result: GuideAccessResult) {
    if (workspaceRevoked.current) return;
    if (result === 401) revokeWorkspaceView();
    else if (result === 403) hideGuide();
    else setGuideAccess(current => current === 'denied' ? current : result);
  }
  function openGuide() {
    if (canOpenGuide && !guideEditInProgress && !composition.current) guideDialog.current?.showModal();
  }
  return (
    <div
      className="workspace"
      data-snapshot={state?.snapshot}
      data-revision={state?.project.revision}
      onClickCapture={event => {
        const target = event.target as Element;
        if (target.closest('[data-workspace-guide], [data-workspace-backup]')) return;
        if (connectorLabel.currentSession() && !connectorLabelHistoryBusy && !target.closest('.connector-label-session') &&
          (!target.closest('.connector-tools') || target.closest('.connector-label-position input')) &&
          (target.closest('.react-flow__controls') || !target.closest('.react-flow__node, .react-flow__pane, .canvas-connector, .connector-label'))) {
          void connectorLabel.finish();
        }
      }}
    >
      <WorkspaceGuide ready={workspaceAccess === 'ready'} showInvitation={canOpenGuide && showNoProjects && !nav}
        editInProgress={guideEditInProgress} open={openGuide} dialog={guideDialog} navigation={navigation}
        onAccess={handleGuideAccess} />
      {syncNotice && (
        <div className="recovery-error" aria-live="polite">
          {syncNotice}
        </div>
      )}
      {organizing && organizing.projectId === state?.project.id &&
        <OrganizeDialog projectId={organizing.projectId} {...(organizing.source ? { source: organizing.source } : {})}
          cards={state.cards}
          verification={!!organizing.verification}
          pendingCancellations={pendingOrganizeCancellations}
          isCancellationSaved={id => organizeCancellations.saved?.has(id) ?? false}
          onPendingCancellationChange={(request, status) => {
            const written = organizeCancellationJournal.update(organizing.projectId, request, status);
            setOrganizeCancellations(organizeCancellationJournal.snapshot);
            return written;
          }}
          close={() => setOrganizing(null)}
          onAdded={async candidateId => {
            const projectId = organizing.projectId;
            const fresh = await refresh(projectId);
            const candidate = fresh.cards.find(card => card.id === candidateId);
            if (candidate && authority.current?.project.id === projectId) {
              setNav(false);
              if (document.querySelector('.workspace[data-board-full="true"]')) closeWritingBoard();
              setAddedCandidate({ projectId, itemId: candidate.item.id });
            }
          }} />}
      <header className="topbar">
        <button
          ref={navigation}
          className="workspace-brand"
          aria-label="项目导航"
          aria-expanded={nav}
          aria-controls={nav ? 'project-navigation' : undefined}
          title="项目导航"
          data-workspace-guide
          onMouseDown={event => event.preventDefault()}
          onClick={() => setNav(!nav)}
        >
          <img src={brandMark} width="36" height="36" alt="" />
          <strong>见岔</strong><span>Forkwise</span>
        </button>
        <div className="project-tabs" ref={projectTabs} role="tablist" aria-label="研究项目" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTabId(null);
        }} onKeyDown={event => {
          const key = event.key;
          if (key !== 'Home' && key !== 'End' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.defaultPrevented || busy || historyBlocked) return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const current = tabs.indexOf(event.target as HTMLButtonElement);
          if (current === -1) return;
          const next = { Home: 0, End: tabs.length - 1, ArrowLeft: (current + tabs.length - 1) % tabs.length, ArrowRight: (current + 1) % tabs.length }[key];
          event.preventDefault();
          tabs[next]?.focus({ preventScroll: true });
          tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}>
          {navigationProjects.map(project => {
            const selected = project.id === activeProjectId;
            const duplicate = navigationProjects.some(other => other.id !== project.id && other.name === project.name);
            return (
              <button
                role="tab"
                key={project.id}
                aria-selected={selected}
                aria-controls="project-canvas"
                aria-disabled={busy || historyBlocked || undefined}
                tabIndex={project.id === tabStopId ? 0 : -1}
                onFocus={() => setFocusedTabId(project.id)}
                onClick={() => { if (!busy && !historyBlocked) void select(project.id); }}
                title={project.id}
              >
                <span className="project-name" title={project.name}>{project.name}</span>
                {(duplicate || project.name.length > 10) && <small aria-hidden={!duplicate}>{project.id.slice(0, 6)}</small>}
              </button>
            );
          })}
        </div>
        <button
          className="project-create"
          aria-label="新建研究"
          title="新建研究"
          onClick={() => void createProject()}
          aria-disabled={projectCreationUnavailable || undefined}
          disabled={busy || historyBlocked}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <div className="workspace-actions">
          <div className="canvas-history-tools" role="group" aria-label="项目历史">
            <CanvasToolButton label="撤销"
              disabled={!state || busy || historyBlocked || imageGeometry.hasPending(state.project.id) || imageInput.hasPending(state.project.id)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => void travel("undo")}
            />
            <CanvasToolButton label="重做"
              disabled={!state || busy || historyBlocked || imageGeometry.hasPending(state.project.id) || imageInput.hasPending(state.project.id)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => void travel("redo")}
            />
          </div>
          {state && <ProjectSearch key={state.project.id} projectId={state.project.id} revision={state.project.revision} tags={state.tags ?? []} cards={state.cards} onOpen={openSearch} disabled={busy || historyBlocked} />}
          <ImportPackage
            disabled={busy || historyBlocked}
            onImported={(id) => select(id).finally(() => {
              if (!workspaceRevoked.current) void api.projects().then(publishProjects).catch(() => { /* 保留当前可见项目 */ });
            })}
          />
          {state && (
            <button
              ref={renameTrigger}
              aria-label="重命名当前项目"
              aria-disabled={busy || historyBlocked || undefined}
              onClick={() => {
                if (busy || historyBlocked) return;
                setRenaming(state.project.id);
                setName(state.project.name);
              }}
            >
              重命名
            </button>
          )}
          {state && <ExportMenu project={state.project} disabled={exportBlocked} report={setExportStatus} image={async () => {
            const snapshot = state;
            const root = document.querySelector<HTMLElement>('.canvas .react-flow');
            if (!root) throw new Error('画布尚未完成绘制，无法导出');
            return renderCanvasPng(root, setExportVisual, () => exportCaptureIntact(snapshot.snapshot));
          }} />}
        </div>
      </header>
      {nav && (
        <aside className="project-nav" id="project-navigation" aria-label="项目导航">
          <div className="nav-heading">
            研究项目{" "}
            <button aria-pressed={pinned} onClick={() => setPinned(!pinned)}>
              {pinned ? "取消固定" : "固定"}
            </button>
          </div>
          {canOpenGuide && <button type="button" aria-haspopup="dialog" data-workspace-guide aria-disabled={guideEditInProgress}
            title={guideEditInProgress ? '结束当前操作后可查看引导' : undefined}
            onMouseDown={event => event.preventDefault()} onClick={openGuide}>画布引导</button>}
          {workspaceAccess === 'ready' && <WorkspaceBackup dialog={backupDialog} disabled={!!attachmentPick || guideEditInProgress} />}
          {state && <button onClick={() => setOrganizing({ projectId: state.project.id })}
            disabled={busy || historyBlocked} aria-haspopup="dialog">AI 整理记录</button>}
          {state && <button onClick={() => setOrganizing({ projectId: state.project.id, verification: true })}
            disabled={busy || historyBlocked} aria-haspopup="dialog">公开查证记录</button>}
          <div className="project-nav-list" ref={projectNavList}>
            {navigationProjects.map((project) => (
              <button
                key={project.id}
                aria-disabled={busy || historyBlocked || undefined}
                aria-current={project.id === activeProjectId}
                onClick={event => { if (!busy && !historyBlocked) void select(project.id, event.currentTarget); }}
              >
                <span className="project-name" title={project.name}>{project.name}</span>
                <small>{project.id.slice(0, 6)}</small>
              </button>
            ))}
          </div>
        </aside>
      )}
      <main
        id="project-canvas"
        aria-label={state ? `${state.project.name}画布` : '画布'}
        className={panelCard ? "canvas with-editor" : "canvas"}
        data-exporting={exportVisual ? 'true' : undefined}
        data-no-projects={showNoProjects || undefined}
        data-attachment-pick={attachmentPick ? true : undefined}
        data-drawing-tool={texts.placing ? "text" : shapePreset ? "shape" : strokeDraw.mode || undefined}
        tabIndex={0}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
        }}
        onDrop={event => {
          const files = Array.from(event.dataTransfer.files);
          if (!files.length) return;
          event.preventDefault();
          if (!(event.target as Element).closest('.react-flow__pane') || busy || historyBlocked || !state) return;
          const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const plan = droppedFilePlan(files, point);
          const projectId = state.project.id;
          void (async () => {
            let failures: string[] = [];
            setBusy(true);
            try {
              failures = await runDroppedFiles(plan, {
                claimDraft: flush,
                saveFile: async (file) => {
                  const payload = await fileAssetPayload(file);
                  const assetId = crypto.randomUUID();
                  await api.execute({ commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null, payload: { id: assetId, ...payload, kind: 'file' } });
                  return { assetId, name: payload.name };
                },
                createCard: async ({ title, x, y, assetId, name }) => {
                  const cardId = crypto.randomUUID();
                  await api.execute({ commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null, payload: { id: cardId, title, text: '', x, y, attachment: { assetId, name } } });
                },
                importImage: async (file) => { await imageInput.begin(file); },
              });
              try { await refresh(projectId); } catch (error) { failures.push(error instanceof Error ? error.message : '拖入后未能重新读取'); }
            } finally {
              setBusy(false);
            }
            setStatus(failures.length ? failures.join('；') : '已保存到本机');
            setError('');
          })();
        }}
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
          if (attachmentPick && state?.project.id === attachmentPick.projectId && annotationTargetAvailable()) {
            const item = (event.target as Element).closest<HTMLElement>(".react-flow__node-thought");
            const card = state.cards.find(value => value.item.id === item?.dataset.id);
            if (card) {
              event.preventDefault();
              event.stopPropagation();
              const { itemId, projectId } = attachmentPick;
              let submitted = false;
              void action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: "attachment.attach",
                expected: { attachment: state.attachments?.find(row => row.id === itemId)?.versionId ?? null,
                  target: { itemId: card.item.id, versionId: card.item.versionId },
                  containment: state.containment?.find(row => row.id === itemId)?.versionId ?? null },
                payload: { itemId, targetItemId: card.item.id } }, undefined, { beforeSubmit: (_, actionEpoch) => {
                if (submitted) return true;
                if (annotationPickIntent.current !== attachmentPick || authority.current?.project.id !== projectId ||
                  editorEpoch.current !== actionEpoch) return false;
                setAnnotationPick(null);
                submitted = true;
                return true;
              } });
              return;
            }
          }
          const disabledMove = disabledMovePointer.current;
          // A release on the preview can retarget Chrome's click to the whole card.
          if (event.detail > 0 && disabledMove && (event.target as Element).closest(".thought-card") === disabledMove.card &&
            (!(event.nativeEvent instanceof PointerEvent) || event.nativeEvent.pointerId === disabledMove.pointerId)) {
            disabledMovePointer.current = null;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if ((event.target as Element).closest('.react-flow__node, .react-flow__pane') && canvasMove.consumeCancelledClick()) {
            event.preventDefault(); event.stopPropagation(); return;
          }
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
          if (itemId && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]') && canvasSelection.consumeClick(itemId, event.shiftKey, (id, extend) => {
            if (state?.strokes?.some(stroke => stroke.item.id === id)) void chooseStrokeItem(id, extend, (event.target as Element).closest<HTMLElement>('[tabindex]') ?? undefined);
            else { awaitBodySelection.current = false; clearConnectorSelection(true); canvasSelection.choose(id, extend); }
          })) { event.preventDefault(); event.stopPropagation(); }
        }}
        onPointerMoveCapture={event => { if (!connectorEdit.input(event) && !connectorCreate.input(event)) strokeDraw.move(event); }}
        onPointerUpCapture={event => { if (!connectorEdit.input(event) && !connectorCreate.input(event)) strokeDraw.finish(event); }}
        onPointerCancelCapture={event => {
          if (disabledMovePointer.current?.pointerId === event.pointerId) disabledMovePointer.current = null;
        }}
        onMouseDownCapture={event => {
          const hit = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id;
          if (hit && event.button === 0 && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]'))
            canvasMove.mouseOrigin(hit, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
              { x: event.clientX, y: event.clientY });
        }}
        onTouchStartCapture={event => {
          const hit = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id, touch = event.touches[0];
          if (hit && touch && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]'))
            canvasMove.touchOrigin(hit, flow.screenToFlowPosition({ x: touch.clientX, y: touch.clientY }, { snapToGrid: false }),
              { x: touch.clientX, y: touch.clientY });
        }}
        onPointerDownCapture={(event) => {
          if (attachmentPick && annotationTargetAvailable() && event.button === 0 && (event.target as Element).closest(".react-flow__node-thought")) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const disabledCard = event.isPrimary && event.button === 0
            ? (event.target as Element).closest('.move-handle[aria-disabled="true"]')?.closest(".thought-card")
            : null;
          disabledMovePointer.current = disabledCard ? { card: disabledCard, pointerId: event.pointerId } : null;
          if (frameTool && event.button === 0 && (event.target as Element).classList.contains('react-flow__pane') && state) {
            event.preventDefault(); event.stopPropagation();
            frameDrag.current = { projectId: state.project.id, state,
              start: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }) };
            setFramePreview({ ...frameDrag.current.start, width: 0, height: 0 });
            return;
          }
          if (imageGeometry.cropping?.projectId === state?.project.id && state && event.button === 0 && !(event.target as Element).closest('.image-crop')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          if (connectorCreate.input(event, connectorEntries)) return;
          if (strokeDraw.start(event)) return;
          if (shapeText.session && (event.target as Element).closest('.react-flow__node, .react-flow__pane') && !(event.target as Element).closest('.shape-text-session, .shape-text-actions')) {
            event.preventDefault(); event.stopPropagation(); return;
          }
          canvasSelection.retirePointer();
          canvasMove.retirePointer();
          const hit = (event.target as Element).closest<HTMLElement>('.react-flow__node')?.dataset.id;
          if (hit && event.button === 0 && !(event.target as Element).closest('.nodrag, input, textarea, [contenteditable=true]')) {
            const captured = canvasSelection.capture(hit, event.shiftKey);
            if (captured) {
              const member = captured.state.containment?.find(v => v.id === hit)?.parent?.kind === 'group';
              frameDropSnapshot.current = member && !captured.selection.targets.some(v => v.kind === 'group') ? null : captured.state;
              canvasMove.arm(hit, captured.state, captured.selection,
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
              { x: event.clientX, y: event.clientY });
            }
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
            marqueeSelection.begin(event.shiftKey);
          }
        }}
      >
        {state ? (
          <ReactFlow
            style={{ '--connector-controls-layer': connectorTargets.controlsLayer, '--export-viewport-transform': exportVisual?.transform } as CSSProperties}
            ariaLabelConfig={{
              "controls.ariaLabel": "画布视图",
              "controls.zoomIn.ariaLabel": "放大",
              "controls.zoomOut.ariaLabel": "缩小",
              "controls.fitView.ariaLabel": "适应画布",
            }}
            nodes={orderCanvas([...nodes, ...textNodes, ...imageNodes(state.images ?? [], state.project.id, selection, (id, extend) => void chooseCanvasItem(id, extend), busy || historyBlocked || composition.current || !!pendingAction.current || placing || !!shapePreset || texts.placing || panTool || !!strokeDraw.mode || !!shapeText.session || texts.geometryBlocked, imageGeometry, (value, dx, dy) => { if (canvasMove.start(value.item.id)) canvasMove.finish({ x: value.item.pose.x + dx, y: value.item.pose.y + dy }); }, singleItemId, memberAction, annotationAction, layerProps), ...shapeNodes(state.shapes ?? [], selection, (id, extend) => void chooseCanvasItem(id, extend), busy || historyBlocked || placing || !!shapePreset || texts.placing || panTool, id => void beginShapeText(id), !!shapeText.session, (id, trigger) => void beginShapeAppearance(id, trigger), value => void removeShape(value), shapeMove.positions, shapeMove, composition.current || !!pendingAction.current || pose.pending || pose.dragging || canvasMove.dragging || texts.hasPending() || appearance.pending || cardLayout.pending, singleItemId, memberAction, annotationAction, layerProps), ...strokeNodes(state.strokes ?? [], selection, (id, extend) => void chooseStrokeItem(id, extend), value => void removeStroke(value), busy || historyBlocked || !!pendingAction.current || placing || !!shapePreset || texts.placing || panTool || !!strokeDraw.mode, singleItemId, memberAction, annotationAction, itemId => !!state.groups?.some(group => group.memberItemIds.includes(itemId)) || (flowSelection.includes(itemId) && flowSelection.length > 1))].map(node => groupGeometry.project({ ...node,
              // A captured connector keeps shape interaction locked, but its hit test must still see foreground shapes.
              ...(connectorCreate.pointerActive && node.type === 'canvasShape' && { style: { ...node.style, pointerEvents: 'auto' } }),
              selected: exportVisual ? false : flowSelection.includes(node.id), position: frameMove.positions[node.id] ?? canvasMove.positions[node.id] ?? shapeMove.positions[node.id] ?? attachmentPreview[node.id] ?? node.position, draggable: node.draggable !== false && !groupGeometry.active && !strokeDraw.mode && !busy && !historyBlocked && !panTool && !placing && !shapePreset && !texts.placing && !texts.geometryBlocked && !shapeText.session && !connectorLabel.session && !shapeMove.pending })), state, selection, { temporaryRaise: !exportVisual && pureCardSelection && !layerHoldActive })}
            onNodeClick={(event, node) => {
              awaitBodySelection.current = false;
              clearConnectorSelection(event.shiftKey);
              canvasSelection.choose(node.id, event.shiftKey);
            }}
            nodeDragThreshold={0}
            nodeClickDistance={3}
            selectionOnDrag={!placing && !shapePreset && !strokeDraw.mode && !connectorCreate.mode && !panTool && !texts.placing && !shapeText.session && !connectorLabel.session}
            selectionKeyCode={null}
            multiSelectionKeyCode="Shift"
            selectionMode={SelectionMode.Full}
            panOnDrag={panTool ? [0, 1, 2] : [1, 2]}
            zoomOnDoubleClick={false}
            onSelectionEnd={event => marqueeSelection.finish(event)}
            onNodeDragStart={(event, node) => {
              if (canvasMove.pointerEnded(node.id)) return;
              if (canvasMove.pointerGate(node.id, event) === 'armed') return;
              beginCanvasNodeDrag(event, node);
            }}
            onNodeDrag={(event, node) => {
              const dropPoint = canvasDragPoint(event);
              if (frameDropSnapshot.current && dropPoint) setFrameDropCandidate(frameCandidate(frameDropSnapshot.current, dropPoint)?.id ?? null);
              if (canvasMove.pointerEnded(node.id)) return;
              const gate = canvasMove.pointerGate(node.id, event);
              if (gate === 'armed') return;
              if (gate === 'activate') { beginCanvasNodeDrag(event, node); return; }
              const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
              if (canvasMove.drag(point)) return;
              if (node.type === "canvasShape") { shapeMove.preview(node.id, point); return; }
              if (!texts.previewMove(node.id, point)) previewMove(point, "altKey" in event && event.altKey);
            }}
            onNodeDragStop={(event, node) => {
              frameDropSnapshot.current = null; setFrameDropCandidate(null);
              if (canvasMove.pointerEnded(node.id)) return;
              if (canvasMove.pointerArmed(node.id)) { canvasMove.endPointer(); return; }
              const point = canvasMove.point(node.id, node.position, canvasDragPoint(event), 'touches' in event);
              canvasMove.endPointer();
              canvasSelection.finishDrag();
              if (canvasMove.finish(point, canvasDragPoint(event))) return;
              if (node.type === "canvasShape") { shapeMove.finish(node.id, point, canvasDragPoint(event)); return; }
              if (texts.finishMove(point, canvasDragPoint(event))) return;
              previewMove(point, 'altKey' in event && event.altKey);
              pose.finish(moving.current?.aligned ?? point, canvasDragPoint(event));
              moving.current = null;
              setGuides([]);
            }}
            onNodesChange={(changes) => {
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
              setFrameSelection(null);
              if (!event.shiftKey) setSelectedConnector(null);
              if (placing && !busy && !historyBlocked) {
                const point = flow.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                });
                void createCard(point.x, point.y);
              } else if (!event.shiftKey) setSelection([]);
              marqueeSelection.retire();
            }}
          >
            <Background gap={24} size={1.5} color="var(--canvas-grid-color)" bgColor="var(--canvas-grid-surface)" />
            <Controls className="canvas-zoom-tools" position="bottom-right" orientation="horizontal" showInteractive={false} />
            <ViewportPortal>
              <CanvasFrames drawMemberIds={frameDrawMemberIds} dropCandidateId={frameDropCandidate} key={`${state.project.id}:${frameEditorEpoch}`} state={state} preview={framePreview} selectedId={exportVisual ? null : selectedFrameId} selectedIds={exportVisual ? [] : selectedFrameIds} choose={chooseFrame}
                focusId={frameEditorFocus.current?.projectId === state.project.id ? frameEditorFocus.current.id : null}
                onFocusRestored={id => { if (frameEditorFocus.current?.projectId === state.project.id && frameEditorFocus.current.id === id) frameEditorFocus.current = null; }}
                blocked={busy || historyBlocked || !!pendingAction.current} onDraft={noteFrameDraft}
                execute={(command, done, endEditing) => void action(command, done, { onSettled: () => {
                  if (!pendingAction.current && authority.current?.project.id === command.projectId) endEditing?.();
                } })} move={frameMove} />
              <CanvasGroups state={state} selection={exportVisual ? { targets: [], enteredGroupId: null } : canvasSelection.value} positions={{ ...pose.positions, ...canvasMove.positions, ...frameMove.positions, ...groupGeometry.poses }} geometry={groupGeometry}
                blocked={busy || historyBlocked || !!pendingAction.current || texts.hasPending()}
                create={() => void createSelectedGroup()}
                createFrame={() => void createSelectedFrame()}
                ungroupSelected={() => void ungroupSelectedGroups()} ungroup={id => void ungroupSelected(id)}
                remove={id => void deleteSelectedCanvas(id)}
                enter={id => canvasSelection.set({ targets: [], enteredGroupId: id })}
                layer={layerProps} />
              {(state.connectors ?? []).map(value => <CanvasConnector key={value.id} value={value} selected={!exportVisual && selectedConnectors.includes(value.id)} resolve={connectorTargets.resolve}
                labelEditor={{ ...connectorLabel, begin: origin => void beginConnectorLabel(value.id, origin), finish: () => void finishConnectorLabel(),
                  history: travelConnectorLabel, locked: connectorLabelHistoryBusy,
                  blocked: busy || historyBlocked || composition.current || !!pendingAction.current || !!connectorLabel.session || connectorEdit.hasPending(),
                  move: (original, position) => original.label ? action({ commandId: crypto.randomUUID(), projectId: state.project.id, type: 'connector.label', expected: original.versionId,
                    payload: { id: original.id, label: { ...original.label, position } } }) : Promise.resolve(false) }}
                focus={connectorCreate.focusId === value.id || connectorEdit.focusId === value.id}
                focused={() => { if (connectorCreate.focusId === value.id) connectorCreate.focused(); if (connectorEdit.focusId === value.id) connectorEdit.focused(); }}
                onPositionPreview={noteLabelPositionPreview}
                drag={event => { if (!connectorLabel.session) connectorEdit.move(value, event); }}
                choose={extend => { if (!connectorCreate.hasPending() && !connectorEdit.hasPending()) { editorEpoch.current++; setFrameSelection(null); if (!extend) setSelection([]);
                  setSelectedConnectors(previous => extend ? previous.includes(value.id) ? previous.filter(id => id !== value.id) : [...previous, value.id] : [value.id]); } }} />)}
              {!connectorLabel.session && (state.connectors ?? []).filter(value => value.id === exclusiveConnector).map(value => <ConnectorHandles key={value.id} value={value}
                resolve={connectorTargets.resolve} blocked={busy || historyBlocked || composition.current || !!pendingAction.current}
                start={(endpoint, event) => connectorEdit.start(value, endpoint, event)} activate={(endpoint, origin) => connectorEdit.startKeyboard(value, endpoint, origin)} />)}
              <ConnectorPreview draft={connectorEdit.draft?.projectId === state.project.id ? connectorEdit.draft : null} />
              <ConnectorPreview draft={connectorDraft} snap={connectorSnap} />
              <ConnectorEntries values={connectorEntries} direct={!connectorCreate.mode && !connectorEdit.keyboardEndpoint && !connectorCreate.keyboardActive}
                choose={connectorEdit.keyboardEndpoint ? connectorEdit.chooseAnchor : connectorCreate.chooseAnchor}
                preview={connectorEdit.keyboardEndpoint ? connectorEdit.previewAnchor : connectorCreate.previewAnchor} />
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
        ) : null}
        {(showNoProjects || showEmptyCanvas) && (
          <section className="workspace-empty" aria-labelledby="workspace-empty-title">
            <img src={brandMark} width="55" height="55" alt="" />
            <h2 id="workspace-empty-title">{showNoProjects ? '尚无研究' : '从一个想法开始'}</h2>
            {(showNoProjects || !showingPlacement) && <button type="button" aria-disabled={showNoProjects ? projectCreationBlocked : busy || historyBlocked}
              onClick={event => {
                if (showNoProjects ? projectCreationBlocked : busy || historyBlocked) return;
                if (showNoProjects) void createProject();
                else if (chooseCardPlacement()) event.currentTarget.closest('main')?.focus({ preventScroll: true });
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {showNoProjects ? '创建研究' : '新建卡片'}
            </button>}
            {!showNoProjects && <p>粘贴纯文字可新建带正文的卡片，粘贴单张图片可添加独立图片</p>}
          </section>
        )}
        {state && (connectorCreate.mode || connectorCreate.keyboardActive) && <ConnectorCreateControls active={connectorCreate.keyboardActive}
          allowBlank={connectorCreate.mode} focusFree={connectorCreate.draft?.startEndpoint.kind === 'free'}
          blocked={connectorCreate.keyboardBlocked()} composing={() => composition.current} start={connectorCreate.startBlank}
          preview={connectorCreate.previewFree} choose={connectorCreate.chooseFree} cancel={connectorCreate.cancelDraft} />}
        {state && connectorEdit.keyboardEndpoint && <ConnectorEndpointControls endpoint={connectorEdit.keyboardEndpoint}
          blocked={connectorEdit.keyboardBlocked()} composing={() => composition.current} preview={connectorEdit.previewFree}
          choose={connectorEdit.chooseFree} cancel={connectorEdit.cancel} />}
        {state && (!connectorEdit.keyboardActive || connectorEdit.keyboardMoving) && (state.connectors ?? []).filter(value => value.id === exclusiveConnector).map(value =>
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
          <div className="canvas-tool-dock" role="group" aria-label="创作工具">
            <SnapshotMenu canCopy={canCopySelection(state, canvasSelection.value, selectedConnectors, selectedFrameIds)}
              canCut={canCutSelection(state, canvasSelection.value, selectedConnectors, selectedFrameIds)}
              blocked={busy || historyBlocked || composition.current || !!pendingAction.current}
              cut={() => void cutSelection()} copy={() => void copySelection()} paste={() => void pasteSelection()} duplicate={() => void duplicateSelection()} />
            <CanvasToolButton label="选择"
              aria-disabled={strokeDraw.hasPending() || connectorCreate.hasPending() || undefined}
              aria-pressed={!placing && !shapePreset && !strokeDraw.mode && !connectorCreate.mode && !panTool && !texts.placing && !frameTool && !attachmentPick}
              onClick={chooseSelectionTool}
            />
            <CanvasToolButton label="移动"
              aria-disabled={strokeDraw.hasPending() || undefined}
              aria-pressed={panTool}
              onClick={() => {
                if (strokeDraw.hasPending()) return;
                setAnnotationPick(null);
                editorEpoch.current++;
                connectorEdit.cancel();
                connectorCreate.deactivate();
                strokeDraw.setMode(null);
                setPlacing(false);
                setShapePreset(null);
                texts.setPlacing(false);
                setFrameTool(false);
                setPanTool(true);
              }}
            />
            <CanvasToolButton label="对齐吸附" aria-pressed={snap}
              hint={snap ? "对齐吸附：开（拖动时按 Alt 临时关闭）" : "对齐吸附：关"}
              onClick={() => setSnap(value => !value)}
            />
            <CanvasToolButton label="分区" aria-pressed={frameTool} disabled={busy || historyBlocked || strokeDraw.drawing}
              onClick={() => {
                beginCreationToolChoice();
                strokeDraw.setMode(null); setPlacing(false); setShapePreset(null); texts.setPlacing(false); setPanTool(false); setFrameTool(false);
                setFrameTool(true);
              }} />
            <span className="canvas-tool-divider" aria-hidden="true" />
            <CanvasToolButton label="卡片" hint="新建卡片"
              aria-pressed={placing}
              disabled={busy || historyBlocked}
              onClick={chooseCardPlacement}
            >
              <span className="canvas-tool-label">卡片</span>
            </CanvasToolButton>
            <CanvasToolButton label="连线" aria-pressed={connectorCreate.mode} disabled={busy || historyBlocked || connectorCreate.hasPending() || strokeDraw.hasPending()}
              onClick={() => {
                if (!authority.current?.project.id || connectorCreationBlocked() || connectorCreate.hasPending()) return;
                setAnnotationPick(null);
                connectorEdit.cancel();
                void connectorCreate.activate();
              }} />
            <CanvasToolButton label="文字" aria-pressed={texts.placing} disabled={busy || historyBlocked || strokeDraw.drawing} onClick={() => { beginCreationToolChoice(); strokeDraw.setMode(null); setPlacing(false); setShapePreset(null); setPanTool(false); setFrameTool(false); texts.setPlacing(true); }} />
            <ShapeTools placing={shapePreset} disabled={busy || historyBlocked || strokeDraw.drawing} choose={type => {
              beginCreationToolChoice();
              strokeDraw.setMode(null); setPlacing(false); texts.setPlacing(false); setPanTool(false); setFrameTool(false); setShapePreset(type);
            }} />
            <StrokeTools active={strokeDraw.mode} disabled={busy || historyBlocked || strokeDraw.drawing} choose={chooseStroke} />
            <CanvasToolButton label="图片" disabled={busy || historyBlocked || imageInput.pending || strokeDraw.drawing} onClick={() => imageFile.current?.click()} />
            <input ref={imageFile} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void imageInput.begin(file); }} />
            <div className="canvas-tool-feedback">
              {imageInput.error && <section aria-label="图片导入失败">
                <p role="alert">{imageInput.error}</p>
                <button onClick={() => void imageInput.retry()}>重试图片保存</button>
              </section>}
              {imageInput.active && <button disabled={!imageInput.cancellable} onClick={imageInput.cancel}>取消图片导入</button>}
              {imageInput.recoveryError && <p role="alert">{imageInput.recoveryError}</p>}
              {imageInput.recoveries.filter(record => record.input.placement.projectId === state.project.id).map(record =>
                <button key={record.key} disabled={busy || historyBlocked} onClick={() => void imageInput.recover(record.key)}>恢复未确认图片</button>)}
              {shapePreset && <span>点击画布放置{shapePreset === "roundedRectangle" ? "圆角矩形" : shapePreset === "rectangle" ? "矩形" : shapePreset === "ellipse" ? "椭圆" : shapePreset === "diamond" ? "菱形" : "三角形"}</span>}
              {texts.placing && <span>点击画布开始输入</span>}
              {strokeDraw.mode && <span>{strokeDraw.mode === "pen" ? "拖动绘制普通笔迹" : "拖动绘制荧光笔迹"}</span>}
              {frameTool && <span>拖动画出分区</span>}
              {attachmentPick && <span aria-live="polite">点击要附着的卡片</span>}
              {texts.error && <span role="alert">{texts.error}</span>}
              {placing && <span>点击画布放置卡片</span>}
            </div>
          </div>
        )}
      </main>
      {panelCard && (
        <WritingBoard
          key={state!.project.id}
          projectId={state!.project.id} cardId={panelCard.id} opened={bodyOpened}
          title={draftView[draftKey(state!.project.id, panelCard.id, "title")]?.value ?? panelCard.title}
          status={boardStatus}
          identifyCard={!!currentBody && (singleItemId !== currentBody.item.id || selectedConnectors.length > 0 || selectedFrameIds.length > 0)}
          saveFailure={boardFailure}
          onClose={closeWritingBoard}
        >
          {currentBody && <ProjectTags key={state!.project.id + ':' + currentBody.id} state={state!} card={currentBody} blocked={busy || historyBlocked} execute={action} refresh={refresh} undo={id => void travel('undo', id)} />}
          {currentBodyData && <CardAttachmentList key={currentBodyData.card.id}
            card={currentBodyData.card} projectCards={currentBodyData.attachmentTargets} blocked={currentBodyData.historyBlocked} writeBlocked={currentBodyData.attachmentWriteBlocked}
            onOpen={currentBodyData.onOpenAttachment} onRemove={currentBodyData.onRemoveAttachment}
            onAdd={currentBodyData.onAddAttachment} onCopy={currentBodyData.onCopyAttachment} showAddWhenEmpty />}
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
          <ParagraphEditor
            key={"body-editor:" + state!.project.id + ":" + panelCard.id}
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
        </WritingBoard>
      )}
      {pose.conflict && !conflict && (
        <section className="conflict-panel" aria-label="布局冲突">
          <h2>布局已由其他调用者更新</h2>
          <p>
            已保存位置：{pose.conflict.pose.x}, {pose.conflict.pose.y}
          </p>
          {pose.conflict.placements.map(value => <p key={value.id}>{value.label}</p>)}
          <p>画布保留你本次移动的位置，确认后保存；对方版本保留在历史中。</p>
          <button onClick={pose.resolveConflict}>确认保留本次位置</button>
        </section>
      )}
      {shapeMove.conflict && <section className="conflict-panel" aria-label={shapeMove.conflict.type === "shape.transform" ? "形状尺寸保存冲突" : "形状位置保存冲突"}>
        <h2>形状布局已由其他调用者更新</h2>
        <p>本次位置：{shapeMove.conflict.local.x}, {shapeMove.conflict.local.y}</p>
        <p>已保存位置：{shapeMove.conflict.remote.item.pose.x}, {shapeMove.conflict.remote.item.pose.y}</p>
        {shapeMove.conflict.parentName && <p>本次位置的分区：{shapeMove.conflict.parentName}</p>}
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
                <button disabled={historyBlocked} onClick={() => void restoreDraft(entry)}>
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
        {attachmentReadPending && <>
          {saveStatus !== ATTACHMENT_READ_FAILED && <span role="alert">{ATTACHMENT_READ_FAILED}</span>}
          <button type="button" disabled={busy || historyBlocked}
            onClick={() => void action(attachmentReadPending.command, attachmentReadPending.onDone, attachmentReadPending.options)}>
            重新读取附件
          </button>
        </>}
        {state && attachmentResult && attachmentResult.projectId !== state.project.id && <>
          <span role={attachmentResult.outcome === "rejected" ? "alert" : undefined} aria-live="polite">
            {attachmentResult.outcome === "saved" ? "上一项目附件已保存" : `上一项目附件未添加 · ${attachmentResult.message}`}
          </span>
          <button onClick={() => setAttachmentResult(null)}>关闭附件提示</button>
        </>}
        {previousProjectSave && previousProjectFeedback && <>
          <span role="alert">{previousProjectFeedback.message}</span>
          <span data-previous-project-save-controls onMouseDown={event => event.preventDefault()}>
            <button disabled={busy || historyBlocked || previousProjectSave.rejected !== undefined}
              onClick={() => void action(previousProjectSave.command, previousProjectSave.onDone, previousProjectSave.options)}>重试上一项目保存</button>
            {previousProjectSave.rejected && <button disabled={busy} onClick={() => void abandonStructure(previousProjectSave)}>放弃本次创建</button>}
          </span>
        </>}
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
        {texts.createRejected && <button onClick={texts.abandonCreate}>放弃本次文字创建</button>}
        {mediaQueue.hasUnconfirmed && <button onClick={mediaQueue.retryUnconfirmed} disabled={historyBlocked}>重试媒体保存确认</button>}
        <span role="status" aria-live="polite">
          {exportStatus || (connectorCreate.working ? '正在保存…' : shapeMove.status || shapeText.status || texts.status || (appearance.error
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
                        : saveStatus))}
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
        {!!visibleError && retryFailure === pendingBodyFailure && error && error !== visibleError && <span role="alert">{error}</span>}
        {!boardDraftFailure && draftSaveFailure}
        {saveFailure && !boardSaveFailure && saveFailure}
        {saveFailure && currentProjectPending?.rejected && <button disabled={busy} onClick={() => void abandonStructure(currentProjectPending)}>
          {['thought.create', 'shape.create', 'stroke.create'].includes(currentProjectPending.command.type) ? '放弃本次创建' : currentProjectPending.command.type === 'text.delete' ? '放弃本次删除' : currentProjectPending.command.type.startsWith('frame.') ? '放弃本次分区操作' : '放弃本次组合操作'}
        </button>}
      </div>
      {renaming && (
        <WorkspaceProjectDialog dialog={renameDialog} label="重命名项目" dismiss={() => { if (!busy) closeRename(); }}>
          <form
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) {
                if (event.key === 'Enter') event.preventDefault();
                return;
              }
              if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
              const controls = event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)');
              const first = controls[0], last = controls[controls.length - 1];
              if (event.shiftKey ? event.target === first : event.target === last) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (state && name.trim() && !busy && !historyBlocked)
                void action(
                  {
                    commandId: crypto.randomUUID(),
                    projectId: renaming,
                    type: "project.rename",
                    expected: state.project.versionId,
                    payload: { name },
                  },
                  closeRename,
                );
            }}
          >
            <h2>重命名项目</h2>
            <label htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              maxLength={240}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div>
              <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) closeRename(); }}>
                取消
              </button>
              <button
                type="submit"
                aria-disabled={busy || historyBlocked || !name.trim() || undefined}
              >
                保存名称
              </button>
            </div>
          </form>
        </WorkspaceProjectDialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <Workspace />
  </ReactFlowProvider>,
);
