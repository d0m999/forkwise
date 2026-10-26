import { useRef, useState } from "react";
import { api, MappingError, type ProjectState, type Command } from "./api";
import { incidentConnectorVersions } from "./connector-deletion";
import {
  TextContentSchema,
  TextPoseSchema,
  TextCommands,
  type CanvasText,
  type TextCommand,
  type TextContent,
} from "../../backend/src/mapping/text-contracts";
type Create = Extract<TextCommand, { type: "text.create" }>;
type Replacement = Extract<
  TextCommand,
  { type: "text.edit" | "text.transform" | "text.move" | "text.delete" }
>;
type Conflict = {
  projectId: string;
  local: CanvasText;
  remote: CanvasText | null;
  remoteConnectors?: Record<string, string> | undefined;
  rejected: Command;
  followup?: TextContent;
  replaceContent?: boolean;
  resolution?: { copy: Create; followup?: Create; replace?: Replacement };
};
const prefix = "forkwise:text-conflict-recovery:v1:";
function remoteSnapshot(state: ProjectState, id: string) {
  const remote = state.texts?.find(text => text.id === id) ?? null;
  return { remote, remoteConnectors: remote ? incidentConnectorVersions(state, remote.item.id) ?? undefined : undefined };
}
function validText(value: CanvasText) {
  return (
    value &&
    typeof value.id === "string" &&
    typeof value.versionId === "string" &&
    value.item &&
    typeof value.item.id === "string" &&
    typeof value.item.versionId === "string" &&
    TextContentSchema.safeParse(value.content).success &&
    TextPoseSchema.safeParse(value.item.pose).success
  );
}
export function useTextConflicts(publish: (value: ProjectState) => void) {
  const [key] = useState(() => prefix + crypto.randomUUID());
  const current = useRef<Conflict | null>(null),
    running = useRef<Promise<boolean> | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null),
    [error, setError] = useState("");
  function list() {
    const records: { key: string; value: Conflict }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      if (!name.startsWith(prefix) || name === key) continue;
      try {
        const v = JSON.parse(localStorage.getItem(name)!);
        const c = v.value as Conflict;
        if (
          v.schema !== 1 ||
          typeof c.projectId !== "string" ||
          !validText(c.local) ||
          (c.remote !== null && !validText(c.remote))
        )
          continue;
        if (c.remoteConnectors !== undefined && (!c.remoteConnectors || typeof c.remoteConnectors !== 'object' ||
          Array.isArray(c.remoteConnectors) || !Object.entries(c.remoteConnectors).every(([id, version]) =>
            id.length > 0 && id.length <= 160 && typeof version === 'string' && version.length > 0 && version.length <= 160))) continue;
        if (
          !TextCommands.safeParse(c.rejected).success ||
          c.rejected.projectId !== c.projectId ||
          !("id" in c.rejected.payload) ||
          c.rejected.payload.id !== c.local.id
        )
          continue;
        if (c.followup && (c.rejected.type !== "text.copy" || !TextContentSchema.safeParse(c.followup).success)) continue;
        if (c.replaceContent !== undefined && (typeof c.replaceContent !== "boolean" || c.rejected.type !== "text.move")) continue;
        if (c.resolution && (Boolean(c.followup) !== Boolean(c.resolution.followup) ||
          (c.resolution.followup && (!TextCommands.safeParse(c.resolution.followup).success ||
            c.resolution.followup.type !== "text.create" || c.resolution.followup.projectId !== c.projectId)))) continue;
        if (
          c.resolution &&
          (!TextCommands.safeParse(c.resolution.copy).success ||
            c.resolution.copy.type !== "text.create" ||
            c.resolution.copy.projectId !== c.projectId ||
            (c.resolution.replace &&
              (!TextCommands.safeParse(c.resolution.replace).success ||
                ![
                  "text.edit",
                  "text.transform",
                  "text.move",
                  "text.delete",
                ].includes(c.resolution.replace.type) ||
                c.resolution.replace.projectId !== c.projectId ||
                c.resolution.replace.payload.id !== c.local.id)))
        )
          continue;
        records.push({ key: name, value: c });
      } catch {
        /* Unknown records are never consumed. */
      }
    }
    return records;
  }
  const [recoveries, setRecoveries] = useState(list);
  function store(value: Conflict) {
    localStorage.setItem(key, JSON.stringify({ schema: 1, value }));
    current.current = value;
    setConflict(value);
  }
  async function open(projectId: string, local: CanvasText, rejected: Command, authority?: ProjectState, followup?: TextContent, replaceContent = false) {
    const latest = authority ?? await api.project(projectId);
    store({
      projectId,
      local,
      ...remoteSnapshot(latest, local.id),
      rejected,
      ...(followup ? { followup } : {}),
      ...(replaceContent ? { replaceContent } : {}),
    });
    setError("");
    if (authority) publish(latest);
  }
  async function flush(): Promise<boolean> {
    if (running.current) return running.current;
    const value = current.current;
    if (!value) return true;
    if (!value.resolution) return false;
    running.current = (async () => {
      try {
        // The losing complete version is persisted first under its original
        // request identity. An unknown ACK retries this exact resolution.
        await api.execute(value.resolution!.copy);
        if (value.resolution!.followup)
          await api.execute(value.resolution!.followup);
        if (value.resolution!.replace)
          await api.execute(value.resolution!.replace);
        const latest = await api.project(value.projectId);
        localStorage.removeItem(key);
        current.current = null;
        setConflict(null);
        setError("");
        publish(latest);
        return true;
      } catch (failure) {
        if (
          failure instanceof MappingError &&
          (failure.code === "VERSION_CONFLICT" || failure.code === "NOT_FOUND")
        ) {
          const { resolution: rejectedResolution, ...retained } = value;
          store(retained);
          const latest = await api.project(value.projectId);
          store({
            ...retained,
            ...remoteSnapshot(latest, value.local.id),
          });
          setError("对方再次更新，请重新比较两份文字");
        } else
          setError(
            failure instanceof Error ? failure.message : "文字冲突处理未确认",
          );
        return false;
      }
    })();
    const result = await running.current;
    running.current = null;
    return result;
  }
  async function resolve(choice: "mine" | "remote") {
    if (running.current) return;
    const value = current.current;
    if (!value) return;
    if (value.resolution) {
      await flush();
      return;
    }
    if (value.rejected.type === "text.copy") choice = "remote";
    if (choice === 'mine' && value.remote && value.rejected.type === 'text.delete' && value.remoteConnectors === undefined) {
      try {
        const latest = await api.project(value.projectId);
        store({ ...value, ...remoteSnapshot(latest, value.local.id) });
        setError('已重新读取，请再次明确确认保留我的文字');
      } catch { setError('无法重新比较原文字和关联线，请保留原记录后重试'); }
      return;
    }
    const losing =
      choice === "mine" && value.remote ? value.remote : value.local;
    const pose = losing.item.pose;
    let replace: Replacement | undefined;
    if (choice === "mine" && value.remote) {
      const common = {
        commandId: crypto.randomUUID(),
        projectId: value.projectId,
      };
      const expected = {
        text: value.remote.versionId,
        pose: value.remote.item.versionId,
      };
      replace =
        value.rejected.type === "text.transform" || (value.rejected.type === "text.move" && value.replaceContent)
          ? {
              ...common,
              type: "text.transform",
              expected,
              payload: {
                id: value.local.id,
                content: value.local.content,
                pose: value.local.item.pose,
              },
            }
          : value.rejected.type === "text.move"
            ? {
                ...common,
                type: "text.move",
                expected: expected.pose,
                payload: {
                  id: value.local.id,
                  x: value.local.item.pose.x,
                  y: value.local.item.pose.y,
                },
              }
            : value.rejected.type === "text.delete"
              ? {
                  ...common,
                  type: "text.delete",
                  expected: { ...expected, connectors: value.remoteConnectors },
                  payload: { id: value.local.id },
                }
              : {
                  ...common,
                  type: "text.edit",
                  expected: expected.text,
                  payload: { id: value.local.id, content: value.local.content },
                };
    }
    try {
      store({
        ...value,
        resolution: {
          copy: {
            commandId: crypto.randomUUID(),
            projectId: value.projectId,
            type: "text.create",
            expected: null,
            payload: {
              id: crypto.randomUUID(),
              content: losing.content,
              pose: { ...pose, x: pose.x + 24, y: pose.y + 24 },
            },
          },
          ...(value.followup ? { followup: {
            commandId: crypto.randomUUID(),
            projectId: value.projectId,
            type: "text.create" as const,
            expected: null,
            payload: {
              id: crypto.randomUUID(), content: value.followup,
              pose: { ...value.local.item.pose, x: value.local.item.pose.x + 48, y: value.local.item.pose.y + 48 },
            },
          } } : {}),
          ...(replace ? { replace } : {}),
        },
      });
      await flush();
    } catch {
      setError("冲突选择无法写入本机恢复记录，请保留两份内容");
    }
  }
  function recover(name: string) {
    if (current.current) return;
    const record = list().find((r) => r.key === name);
    if (!record) return;
    try {
      store(record.value);
      localStorage.removeItem(name);
      setRecoveries(list());
    } catch {
      setError("无法接管文字冲突恢复记录，请保留原记录");
    }
  }
  return {
    conflict,
    open,
    resolve,
    recoveries,
    recover,
    flush,
    error,
    hasPending: () => !!current.current,
    status: conflict
      ? error
        ? "文字保存未完成"
        : "文字存在保存冲突"
      : recoveries.length
        ? "有待恢复的独立文字草稿"
        : "",
  };
}
export function TextConflictPanel({
  value,
  resolve,
}: {
  value: Conflict;
  resolve: (choice: "mine" | "remote") => Promise<void>;
}) {
  return (
    <section className="conflict-panel" aria-label="独立文字保存冲突">
      <h2>独立文字已由其他调用者更新</h2>
      <p>
        比较两份文字。确认选择前，先将另一份完整内容和样式保存为独立恢复副本。
      </p>
      <label>
        已保存的独立文字
        <textarea
          aria-label="已保存的独立文字"
          readOnly
          value={
            value.remote?.content.runs.map((r) => r.text).join("") ??
            "原文字已删除"
          }
        />
      </label>
      {value.remote && (
        <TextConflictPreview
          value={value.remote}
          label="已保存的独立文字预览"
        />
      )}
      <label>
        我的独立文字
        <textarea
          aria-label="我的独立文字"
          readOnly
          value={value.local.content.runs.map((r) => r.text).join("")}
        />
      </label>
      <TextConflictPreview value={value.local} label="我的独立文字预览" />
      {value.followup && <>
        <p>本次副本保留点击时的快照；后续原文字样式另存为第二个独立恢复副本。</p>
        <TextConflictPreview value={{ ...value.local, content: value.followup }} label="后续原文字样式预览" />
      </>}
      {value.remote && value.rejected.type !== "text.copy" && (
        <button onClick={() => void resolve("mine")}>确认保留我的文字</button>
      )}
      <button onClick={() => void resolve("remote")}>
        {value.followup ? "恢复副本快照与后续样式" : value.remote ? "确认保留已保存的文字" : "将我的文字恢复为副本"}
      </button>
    </section>
  );
}

function TextConflictPreview({
  value,
  label,
}: {
  value: CanvasText;
  label: string;
}) {
  return (
    <>
      <p>
        字号 {value.content.fontSize}；
        {value.content.widthMode === "auto" ? "自动宽" : "固定宽"}{" "}
        {value.content.width}；位置 {value.item.pose.x}, {value.item.pose.y}
      </p>
      <div
        aria-label={label}
        style={{
          fontSize: value.content.fontSize,
          lineHeight: value.content.lineHeight,
          textAlign: value.content.align,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {value.content.runs.map((run, i) => (
          <span
            key={i}
            style={{ fontWeight: run.bold ? 700 : 400, color: run.color }}
          >
            {run.text}
          </span>
        ))}
      </div>
    </>
  );
}
