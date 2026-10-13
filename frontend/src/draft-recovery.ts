import type { Command } from "./api";

export interface Draft {
  projectId: string;
  cardId: string;
  field: "title" | "body";
  value: string;
  generation: number;
  expected: string;
  command?: Command;
  editGroup?: string;
  rejected?: boolean;
  requiredAssetIds?: string[];
}
export interface Recovery {
  schema: 1;
  projectId: string;
  cardId: string;
  drafts: Draft[];
  pending: Draft | null;
  closed: Draft[];
}
const prefix = "forkwise:recovery:v1:";
// Each mounted editor owns its own journal. Another tab's drafts cannot be
// overwritten or removed by this tab's ACK. This is recovery, never authority.
export class DraftRecovery {
  readonly session = crypto.randomUUID();
  private keys = new Set<string>();
  damaged = false;
  constructor(private readonly storage: Storage = localStorage) {}
  write(drafts: Draft[], closed: Draft[], pending: Draft | null) {
    const groups = new Map<string, Recovery>();
    for (const d of [...drafts, ...closed, ...(pending ? [pending] : [])]) {
      const key =
        prefix + JSON.stringify([this.session, d.projectId, d.cardId]);
      if (!groups.has(key))
        groups.set(key, {
          schema: 1,
          projectId: d.projectId,
          cardId: d.cardId,
          drafts: drafts.filter(
            (x) => x.projectId === d.projectId && x.cardId === d.cardId,
          ),
          closed: closed.filter(
            (x) => x.projectId === d.projectId && x.cardId === d.cardId,
          ),
          pending:
            pending?.projectId === d.projectId && pending.cardId === d.cardId
              ? pending
              : null,
        });
    }
    for (const [key, value] of groups) {
      this.storage.setItem(key, JSON.stringify(value));
      this.keys.add(key);
    }
    for (const key of this.keys)
      if (!groups.has(key)) {
        this.storage.removeItem(key);
        this.keys.delete(key);
      }
  }
  list(): { key: string; value: Recovery }[] {
    const result = [];
    this.damaged = false;
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)!;
      if (key.startsWith(prefix) && !this.keys.has(key)) {
        try {
          const value: unknown = JSON.parse(this.storage.getItem(key)!);
          if (!validRecovery(value)) throw new Error("Invalid recovery");
          // Schema 1 journals may carry requirements only in the original
          // command. Keep that request intact and retain its resource state
          // independently for subsequent edits and definite rejections.
          for (const draft of [
            ...value.drafts,
            ...value.closed,
            ...(value.pending ? [value.pending] : []),
          ]) {
            const assets = draftAssetIds(draft);
            if (assets) draft.requiredAssetIds = assets;
          }
          result.push({ key, value });
        } catch {
          this.damaged = true;
        }
      }
    }
    return result;
  }
  archive(draft: Draft) {
    const value: Recovery = {
      schema: 1,
      projectId: draft.projectId,
      cardId: draft.cardId,
      drafts: [draft],
      closed: [],
      pending: null,
    };
    const key =
      prefix +
      JSON.stringify([
        "copy",
        crypto.randomUUID(),
        draft.projectId,
        draft.cardId,
      ]);
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      throw new Error("无法保存另一份恢复副本，请释放本机空间后重试");
    }
    return key;
  }
  remove(key: string) {
    this.storage.removeItem(key);
  }
}

function validRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== "object") return false;
  const r = value as Recovery;
  if (
    r.schema !== 1 ||
    typeof r.projectId !== "string" ||
    typeof r.cardId !== "string" ||
    !Array.isArray(r.drafts) ||
    !Array.isArray(r.closed) ||
    !(r.pending === null || typeof r.pending === "object")
  )
    return false;
  return [...r.drafts, ...r.closed, ...(r.pending ? [r.pending] : [])].every(
    (d) => {
      if (
        !d ||
        d.projectId !== r.projectId ||
        d.cardId !== r.cardId ||
        !["title", "body"].includes(d.field) ||
        typeof d.value !== "string" ||
        typeof d.expected !== "string" ||
        !d.expected ||
        !Number.isSafeInteger(d.generation) ||
        d.generation < 1 ||
        (d.editGroup !== undefined && typeof d.editGroup !== "string") ||
        (d.requiredAssetIds !== undefined &&
          (d.field !== "body" || !validAssetIds(d.requiredAssetIds)))
      )
        return false;
      if (!d.command) return true;
      const c = d.command;
      return (
        c.projectId === d.projectId &&
        c.expected === d.expected &&
        typeof c.commandId === "string" &&
        !!c.commandId &&
        ((c.type === "body.edit" &&
          d.field === "body" &&
          c.payload.id === d.cardId &&
          c.payload.text === d.value &&
          (c.payload.requiredAssetIds === undefined ||
            validAssetIds(c.payload.requiredAssetIds))) ||
          (c.type === "thought.title" &&
            d.field === "title" &&
            c.payload.id === d.cardId &&
            c.payload.title === d.value))
      );
    },
  );
}

function validAssetIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 160,
    )
  );
}
export function draftAssetIds(draft: Draft): string[] | undefined {
  const fromCommand =
    draft.command?.type === "body.edit"
      ? draft.command.payload.requiredAssetIds
      : undefined;
  if (draft.requiredAssetIds === undefined && fromCommand === undefined)
    return undefined;
  return [
    ...new Set([...(draft.requiredAssetIds ?? []), ...(fromCommand ?? [])]),
  ];
}
