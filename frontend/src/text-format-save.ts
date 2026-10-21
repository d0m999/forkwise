import type { TextOperationTarget } from "./text-operations";
import { useRef, useState } from "react";
import { api, type Command, type ProjectState } from "./api";
import {
  TextCommands,
  TextContentSchema,
  type CanvasText,
  type TextContent,
} from "../../backend/src/mapping/text-contracts";
type Edit = Extract<Command, { type: "text.edit" }>;
type Intent = {
  projectId: string;
  id: string;
  content: TextContent;
  patch: Partial<TextContent>;
  expected?: string;
  command?: Edit;
};
type Enqueue = (
  prepare: () => Promise<Command | null>,
  done?: (state: ProjectState, receipt: Awaited<ReturnType<typeof api.execute>>) => void,
  target?: TextOperationTarget,
) => void;
const prefix = "forkwise:text-format-recovery:v1:";
class FormatRecovery {
  private key = prefix + crypto.randomUUID();
  write(intents: Intent[]) {
    if (intents.length)
      localStorage.setItem(this.key, JSON.stringify({ schema: 1, intents }));
    else localStorage.removeItem(this.key);
  }
  remove(key: string) {
    localStorage.removeItem(key);
  }
  list(): { key: string; projectId: string; intents: Intent[] }[] {
    const records = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (!key.startsWith(prefix) || key === this.key) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key)!);
        if (
          value.schema !== 1 ||
          !Array.isArray(value.intents) ||
          !value.intents.length
        )
          continue;
        const intents = value.intents as Intent[],
          projectId = intents[0]!.projectId;
        if (
          !intents.every(
            (intent) =>
              typeof intent.id === "string" &&
              intent.projectId === projectId &&
              typeof projectId === "string" &&
              !!intent.patch &&
              typeof intent.patch === "object" &&
              TextContentSchema.safeParse(intent.content).success &&
              TextContentSchema.safeParse({
                ...intent.content,
                ...intent.patch,
              }).success &&
              (!intent.command ||
                (TextCommands.safeParse(intent.command).success &&
                  intent.command.type === "text.edit" &&
                  intent.command.projectId === projectId &&
                  intent.command.payload.id === intent.id)),
          )
        )
          continue;
        records.push({ key, projectId, intents });
      } catch {
        /* Unrecognized local records remain unchanged. */
      }
    }
    return records;
  }
}
// Object formatting has its own durable inputs, while sharing the ordered
// operation boundary with pose changes. Both original requests and later
// full styles survive a lost ACK and reload; recovery is always explicit.
export function useTextFormats(
  enqueue: Enqueue,
  before: () => Promise<boolean>,
  confirm: (projectId: string, id: string, version: string, content: TextContent) => { version: string; content: TextContent },
) {
  const [journal] = useState(() => new FormatRecovery());
  const [recoveries, setRecoveries] = useState(() => journal.list());
  const intents = useRef<Intent[]>([]),
    drafts = useRef<Record<string, TextContent>>({});
  const [styles, setStyles] = useState<Record<string, TextContent>>({}),
    [error, setError] = useState("");
  function persist() {
    journal.write(intents.current);
    setError("");
  }
  function updateContent(intent: Intent, content: TextContent) {
    const previous = intent.content;
    intent.content = content;
    if (drafts.current[intent.id] === previous) {
      drafts.current[intent.id] = content;
      setStyles({ ...drafts.current });
    }
  }
  function queue(intent: Intent) {
    const retire = () => {
      intents.current = intents.current.filter((value) => value !== intent);
      persist();
      if (drafts.current[intent.id] === intent.content) {
        delete drafts.current[intent.id];
        setStyles({ ...drafts.current });
      }
    };
    enqueue(
      async () => {
        if (!(await before())) throw new Error("请先确认文字或正文保存");
        if (!intent.command) {
          if (!intent.expected)
            throw new Error("无法确认旧样式草稿的显示版本，请保留恢复记录");
          const acknowledged = confirm(intent.projectId, intent.id, intent.expected, intent.content);
          intent.expected = acknowledged.version;
          updateContent(intent, { ...acknowledged.content, ...intent.patch });
          intent.command = {
            commandId: crypto.randomUUID(),
            projectId: intent.projectId,
            type: "text.edit",
            expected: intent.expected,
            payload: {
              id: intent.id,
              content: intent.content,
            },
          };
        }
        persist();
        return intent.command;
      },
      (_state, receipt) => {
        // Only our acknowledged request advances a queued descendant. A fresh
        // read may already include someone else's edit and cannot endorse it.
        const next = intents.current.slice(intents.current.indexOf(intent) + 1)
          .find((value) => value.projectId === intent.projectId && value.id === intent.id);
        if (next && !next.command && receipt.textVersions?.text) {
          next.expected = receipt.textVersions.text;
          updateContent(next, { ...intent.command!.payload.content, ...next.patch });
        }
        retire();
      },
      { projectId: intent.projectId, id: intent.id, discard: retire },
    );
  }
  function format(
    projectId: string,
    value: CanvasText,
    patch: Partial<TextContent>,
  ) {
    const content = {
      ...(drafts.current[value.id] ?? value.content),
      ...patch,
    };
    const intent = { projectId, id: value.id, content, patch, expected: value.versionId };
    drafts.current[value.id] = content;
    setStyles({ ...drafts.current });
    intents.current.push(intent);
    try {
      persist();
    } catch {
      setError("文字样式草稿无法写入本机恢复记录，请保留输入并重试");
    }
    queue(intent);
  }
  function recover(key: string) {
    if (intents.current.length) return;
    const record = journal.list().find((record) => record.key === key);
    if (!record) return;
    intents.current = record.intents;
    try {
      persist();
      journal.remove(key);
    } catch {
      setError("无法接管文字样式恢复记录，请保留原草稿");
      return;
    }
    for (const intent of record.intents) {
      drafts.current[intent.id] = intent.content;
      queue(intent);
    }
    setStyles({ ...drafts.current });
    setRecoveries(journal.list());
  }
  return {
    format,
    styles,
    recoveries,
    recover,
    error,
    localContent: (id: string) => drafts.current[id],
    pendingContent: (projectId: string, id: string, base: TextContent) => {
      const pending = intents.current.filter((intent) => intent.projectId === projectId && intent.id === id);
      // Apply the actual later formatting choices to this gesture's complete
      // content, preserving geometry fields absent from those choices.
      return pending.length ? pending.reduce((content, intent) => ({ ...content, ...intent.patch }), base) : undefined;
    },
    hasDraft: (id: string) => !!drafts.current[id],
  };
}
