import { useTextConflicts } from "./text-conflict";
import { useCanvasMoveConflict } from "./canvas-move-conflict";
import { useTextCreate } from "./text-create";
import { useTextFormats } from "./text-format-save";
import { useEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import type {
  CanvasText,
  TextContent,
} from "../../backend/src/mapping/text-contracts";
import { api, type Command, type ProjectState } from "./api";
import type { TextData } from "./canvas-text";
import { useTextSave } from "./text-save";
import { TextPrepareConflict, useTextOperations } from "./text-operations";
export function useCanvasTexts(
  state: ProjectState | null,
  selection: string[],
  select: (ids: string[]) => void,
  publish: (value: ProjectState) => void,
  before: () => Promise<boolean>,
) {
  const [placing, setPlacing] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mixedConflict = useCanvasMoveConflict((value) => {
    if (stateRef.current?.project.id === value.project.id) publish(value);
  });
  const conflicts = useTextConflicts((value) => {
    if (stateRef.current?.project.id === value.project.id) publish(value);
  });
  const operations = useTextOperations(
    (value) => {
      if (stateRef.current?.project.id === value.project.id) publish(value);
    },
    async (command, preparation) => {
      if (command.type === "canvas.move") {
        await mixedConflict.open(command);
        return true;
      }
      if (command.type === "text.layout") return true;
      if (
        !["text.edit", "text.transform", "text.move", "text.copy"].includes(
          command.type,
        ) ||
        !("id" in command.payload)
      )
        return false;
      // Read before capturing descendants: later formatting may arrive while
      // the authority request is pending. Only this captured boundary retires.
      const authority = preparation?.latest ?? await api.project(command.projectId);
      const through = operations.checkpoint();
      const id = command.payload.id;
      const origin = preparation?.local ?? stateRef.current?.texts?.find((text) => text.id === id);
      if (!origin) throw new Error("文字目标已删除，原操作仍保留，请重试读取");
      let local = origin;
      if (command.type === "text.edit")
        local = {
          ...origin,
          content: command.payload.content,
        };
      if (command.type === "text.transform")
        local = {
          ...origin,
          content: command.payload.content,
          item: { ...origin.item, pose: command.payload.pose },
        };
      if (command.type === "text.move")
        local = {
          ...origin,
          item: {
            ...origin.item,
            pose: {
              ...origin.item.pose,
              x: command.payload.x,
              y: command.payload.y,
            },
          },
        };
      const later = formats.pendingContent(command.projectId, id, local.content);
      const followup = command.type === "text.copy" && later && JSON.stringify(later) !== JSON.stringify(local.content) ? later : undefined;
      if (command.type !== "text.copy" && later) local = { ...local, content: later };
      await conflicts.open(command.projectId, local, command, authority, followup, command.type === "text.move" && !!later);
      return { through };
    },
  );
  const save = useTextSave(
    (value) => {
      if (stateRef.current?.project.id === value.project.id) publish(value);
    },
    (session, command) =>
      conflicts.open(
        session.projectId,
        { ...session.value, content: session.content },
        command,
      ),
  );
  const { session, current } = save;
  const creation = useTextCreate((latest, command) => {
    if (stateRef.current?.project.id !== command.projectId) return;
    const value = latest.texts!.find((text) => text.id === command.payload.id)!;
    publish(latest);
    select([value.item.id]);
    save.begin({
      projectId: command.projectId,
      value,
      content: value.content,
      group: command.editGroup!,
    });
    setPlacing(false);
  });
  const formats = useTextFormats(
    operations.enqueue,
    async () =>
      !conflicts.hasPending() && (await before()) && (await save.flush(true)),
    operations.confirmedContent,
  );
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const moving = useRef<CanvasText | null>(null);
  function enqueueGeometry(prepare: () => Promise<Command>, done: () => void) {
    operations.enqueue(async () => {
      if (mixedConflict.hasPending()) throw new Error("请先处理混合移动冲突");
      if (!(await before()) || !(await save.flush(true)))
        throw new Error("请先确认文字或正文保存");
      return prepare();
    }, done, { projectId: state!.project.id, id: crypto.randomUUID(), discard: done });
  }
  function transform(value: CanvasText, next: CanvasText) {
    const projectId = state!.project.id;
    operations.enqueue(
      async () => {
        if (!(await before()) || !(await save.flush(true)))
          throw new Error("请先确认文字或正文保存");
        const textVersion = operations.textVersion(projectId, value.id, value.versionId, value.content);
        return {
          commandId: crypto.randomUUID(),
          projectId,
          type: "text.transform",
          expected: {
            text: textVersion,
            pose: operations.poseVersion(projectId, value.id, textVersion, value.item.versionId),
          },
          payload: {
            id: value.id,
            content: next.content,
            pose: next.item.pose,
          },
        };
      },
      undefined,
      { projectId, id: value.id },
    );
  }
  function startMove(id: string) {
    moving.current = state?.texts?.find((text) => text.item.id === id) ?? null;
    return !!moving.current;
  }
  function previewMove(id: string, point: { x: number; y: number }) {
    if (!state?.texts?.some((text) => text.item.id === id)) return false;
    setPositions((previous) => ({ ...previous, [id]: point }));
    return true;
  }
  function finishMove(point: { x: number; y: number }) {
    const value = moving.current;
    moving.current = null;
    if (!value) return false;
    if (point.x === value.item.pose.x && point.y === value.item.pose.y) {
      setPositions((previous) => {
        const next = { ...previous };
        delete next[value.item.id];
        return next;
      });
      return true;
    }
    const projectId = state!.project.id;
    const clear = () =>
      setPositions((previous) => {
        const next = { ...previous };
        delete next[value.item.id];
        return next;
      });
    operations.enqueue(
      async () => {
        if (!(await before()) || !(await save.flush(true)))
          throw new Error("请先确认文字或正文保存");
        const latest = await api.project(projectId);
        const target = latest.texts?.find(
          (text) => text.id === value.id,
        );
        if (!target ||
          target.item.pose.x !== value.item.pose.x ||
          target.item.pose.y !== value.item.pose.y)
          throw new TextPrepareConflict(
            {
              commandId: crypto.randomUUID(), projectId, type: "text.move",
              expected: value.item.versionId,
              payload: { id: value.id, x: point.x, y: point.y },
            },
            { ...value, item: { ...value.item, pose: { ...value.item.pose, x: point.x, y: point.y } } },
            latest,
          );
        return {
          commandId: crypto.randomUUID(),
          projectId,
          type: "text.move",
          expected: target.item.versionId,
          payload: { id: target.id, x: point.x, y: point.y },
        };
      },
      clear,
      { projectId, id: value.id, discard: clear },
    );
    return true;
  }
  async function finish(): Promise<boolean> {
    if (mixedConflict.hasPending()) return false;
    if (
      !(await conflicts.flush()) ||
      !(await creation.flush()) ||
      !(await operations.flush())
    )
      return false;
    const result = await save.flush(true);
    if (result) setPlacing(false);
    return result && (await operations.flush());
  }
  function copy(value: CanvasText) {
    const projectId = state!.project.id,
      copyId = crypto.randomUUID(),
      captured = structuredClone(value);
    operations.enqueue(
      async () => {
        if (!(await before()) || !(await save.flush(true)))
          throw new Error("请先确认文字或正文保存");
        const local = operations.confirmedText(projectId, captured);
        const command: Command = {
          commandId: crypto.randomUUID(),
          projectId,
          type: "text.copy",
          expected: { text: local.versionId, pose: local.item.versionId },
          payload: { id: local.id, copyId },
        };
        const latest = await api.project(projectId);
        const target = latest.texts?.find((text) => text.id === local.id);
        if (
          !target ||
          target.item.id !== local.item.id ||
          target.versionId !== local.versionId ||
          target.item.versionId !== local.item.versionId
        )
          throw new TextPrepareConflict(command, local, latest);
        return command;
      },
      (latest) => {
        if (stateRef.current?.project.id === projectId)
          select([latest.texts!.find((text) => text.id === copyId)!.item.id]);
      },
      { projectId, id: value.id },
    );
  }
  async function create(x: number, y: number) {
    if (!state || !(await before()) || !(await finish())) return;
    const id = crypto.randomUUID(),
      group = crypto.randomUUID(),
      projectId = state.project.id;
    const content: TextContent = {
      runs: [{ text: "" }],
      fontSize: 18,
      lineHeight: 1.5,
      align: "left",
      widthMode: "auto",
      width: 320,
    };
    await creation.send({
      commandId: crypto.randomUUID(),
      projectId,
      type: "text.create",
      expected: null,
      editGroup: group,
      payload: { id, content, pose: { x, y, width: 20, height: 27 } },
    });
  }

  async function edit(value: CanvasText) {
    const projectId = state?.project.id;
    if (!projectId || !(await finish())) return;
    if (stateRef.current?.project.id !== projectId ||
      !stateRef.current.texts?.some((text) => text.id === value.id && text.item.id === value.item.id)) return;
    const confirmed = operations.confirmedText(projectId, value);
    const next = {
      projectId,
      value: confirmed,
      content: confirmed.content,
      group: crypto.randomUUID(),
    };
    save.begin(next);
  }
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.button !== 0 || !current.current) return;
      if (
        !(event.target as Element).closest(".canvas-text-input, .text-actions")
      )
        void finish();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  });
  function format(value: CanvasText, patch: Partial<TextContent>) {
    if (state) formats.format(state.project.id, value, patch);
  }
  function measure(
    value: CanvasText,
    width: number,
    height: number,
    editing: boolean,
  ) {
    if (
      editing ||
      save.isSaving() ||
      formats.hasDraft(value.id) ||
      !state ||
      width <= 0 ||
      height <= 0 ||
      (Math.abs(value.item.pose.width - width) < 0.01 &&
        Math.abs(value.item.pose.height - height) < 0.01)
    )
      return;
    const projectId = state.project.id,
      signature = JSON.stringify(value.content);
    operations.enqueue(async () => {
      const latest = await api.project(projectId),
        target = latest.texts?.find((text) => text.id === value.id);
      if (
        !target ||
        JSON.stringify(target.content) !== signature ||
        (Math.abs(target.item.pose.width - width) < 0.01 &&
          Math.abs(target.item.pose.height - height) < 0.01)
      )
        return null;
      return {
        commandId: crypto.randomUUID(),
        projectId,
        type: "text.layout",
        expected: { text: target.versionId, pose: target.item.versionId },
        payload: { id: value.id, width, height },
      };
    });
  }
  const nodes: Node<TextData>[] = (state?.texts ?? []).map((value) => {
    const active =
      session?.projectId === state?.project.id && session?.value.id === value.id
        ? session
        : null;
    return {
      id: value.item.id,
      type: "canvasText",
      position: positions[value.item.id] ?? value.item.pose,
      selected: selection.includes(value.item.id),
      draggable: !active,
      measured: { width: value.item.pose.width, height: value.item.pose.height },
      data: {
        value: active
          ? { ...value, content: active.content }
          : formats.styles[value.id]
            ? { ...value, content: formats.styles[value.id]! }
            : value,
        editing: !!active,
        ending: save.ending,
        measurable: !active && !save.isSaving() && !formats.hasDraft(value.id),
        singleSelection:
          selection.length === 1 &&
          !conflicts.hasPending() &&
          !creation.hasPending(),
        moveDisabled: operations.pending || mixedConflict.hasPending() || conflicts.hasPending() || creation.hasPending(),
        focus: () => {
          if (!selection.includes(value.item.id)) select([value.item.id]);
        },
        move: (dx, dy) => {
          if (startMove(value.item.id))
            finishMove({ x: value.item.pose.x + dx, y: value.item.pose.y + dy });
        },
        copy: () => {
          void copy(value);
        },
        compose: save.compose,
        transform: (next, origin) => transform(origin, next),
        measure: (width, height) => measure(value, width, height, !!active),
        format: (patch) => format(value, patch),
        edit: () => edit(value),
        finish: () => {
          void finish();
        },
        change: (content) => {
          save.change(content);
        },
      },
    };
  });
  return {
    placing,
    setPlacing,
    create,
    finish,
    nodes,
    error:
      mixedConflict.error ||
      conflicts.error ||
      creation.error ||
      save.error ||
      operations.error ||
      formats.error,
    status:
      mixedConflict.status ||
      conflicts.status ||
      creation.status ||
      (operations.error
        ? `${operations.scope}保存未完成`
        : operations.pending
          ? `${operations.scope}操作等待保存…`
          : save.status),
    operationScope: operations.pending || operations.error ? operations.scope : mixedConflict.hasPending() || mixedConflict.error ? '画布' : '文字',
    hasPending: () =>
      mixedConflict.hasPending() ||
      conflicts.hasPending() ||
      creation.hasPending() ||
      operations.hasPending() ||
      save.hasPending(),
    recoveries: save.recoveries.filter(
      (record) => record.value.session.projectId === state?.project.id,
    ),
    recover: save.recover,
    mixedConflict: mixedConflict.value,
    abandonMixedMove: mixedConflict.abandon,
    mixedRecoveries: mixedConflict.recoveries.filter((record) => record.value.command.projectId === state?.project.id),
    recoverMixedMove: mixedConflict.recover,
    conflict: conflicts.conflict,
    resolveConflict: conflicts.resolve,
    conflictRecoveries: conflicts.recoveries.filter(
      (record) => record.value.projectId === state?.project.id,
    ),
    recoverConflict: conflicts.recover,
    createRecoveries: creation.recoveries.filter(
      (record) => record.command.projectId === state?.project.id,
    ),
    recoverCreate: creation.recover,
    formatRecoveries: formats.recoveries.filter(
      (record) => record.projectId === state?.project.id,
    ),
    recoverFormat: formats.recover,
    retry: async () =>
      !mixedConflict.hasPending() &&
      (await conflicts.flush()) &&
      (await creation.flush()) &&
      (await operations.flush()) &&
      (await save.flush()),
    enqueueGeometry,
    geometryBlocked: operations.pending || mixedConflict.hasPending(),
    startMove,
    previewMove,
    finishMove,
  };
}
