import type { Command } from "./api";
import type { Block } from "../../backend/src/mapping/contracts";
import { bodyText, validBlocks } from "../../backend/src/mapping/body-text";

export interface Draft {
  projectId: string;
  cardId: string;
  field: "title" | "body";
  value: string;
  blocks?: Block[];
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
          const projections = [
            ...value.drafts,
            ...value.closed,
            ...(value.pending ? [value.pending] : []),
          ];
          const originals = new Map(
            projections
              .filter((draft) => draft.command)
              .map((draft) => [draftInputKey(draft), draft.command!] as const),
          );
          const resources = new Map<string, string[]>();
          for (const draft of projections) {
            // A compatible bare projection shares the existing original request;
            // never generate a replacement key for an execution still unknown.
            const original = originals.get(draftInputKey(draft));
            if (!draft.command && original) draft.command = original;
            const assets = draftAssetIds(draft);
            if (assets)
              resources.set(draftInputKey(draft), [
                ...new Set([
                  ...(resources.get(draftInputKey(draft)) ?? []),
                  ...assets,
                ]),
              ]);
          }
          for (const draft of projections) {
            const assets = resources.get(draftInputKey(draft));
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
  const projections = [
    ...r.drafts,
    ...r.closed,
    ...(r.pending ? [r.pending] : []),
  ];
  if (
    !projections.every((d) => {
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
      if (d.blocks !== undefined && (d.field !== "body" || !validBlocks(d.blocks) || bodyText({ blocks: d.blocks }) !== d.value)) return false;
      if (d.command === undefined) return true;
      const c = d.command;
      if (
        !c ||
        typeof c !== "object" ||
        !c.payload ||
        typeof c.payload !== "object"
      )
        return false;
      const commandAssets =
        c.type === "body.edit" ? c.payload.requiredAssetIds : undefined;
      return (
        c.projectId === d.projectId &&
        c.expected === d.expected &&
        typeof c.commandId === "string" &&
        !!c.commandId &&
        ((c.type === "body.edit" &&
          d.field === "body" &&
          c.payload.id === d.cardId &&
          (d.blocks ? c.payload.text === undefined && requestIdentity(c.payload.blocks) === requestIdentity(d.blocks) : c.payload.blocks === undefined && c.payload.text === d.value) &&
          (commandAssets === undefined || validAssetIds(commandAssets)) &&
          // Never repair a weaker original request: it may already have run.
          // Legacy command-only requirements remain valid; order is irrelevant.
          (d.requiredAssetIds ?? []).every((id) =>
            commandAssets?.includes(id),
          )) ||
          (c.type === "thought.title" &&
            d.field === "title" &&
            c.payload.id === d.cardId &&
            c.payload.title === d.value &&
            !("requiredAssetIds" in c.payload)))
      );
    })
  )
    return false;
  // The editor's Record persists one logical active generation per field on
  // this card. Compatible same-generation projections may share that input;
  // closed/pending batches can legitimately retain earlier generations.
  const activeGenerations = new Map<Draft["field"], number>();
  for (const draft of r.drafts) {
    const previous = activeGenerations.get(draft.field);
    if (previous !== undefined && previous !== draft.generation) return false;
    activeGenerations.set(draft.field, draft.generation);
  }
  const inputs = new Map<string, Draft>();
  const requests = new Map<string, string>();
  for (const draft of projections) {
    const key = draftInputKey(draft);
    if (draft.command) {
      const identity = requestIdentity(draft.command);
      const previousRequest = requests.get(draft.command.commandId);
      if (previousRequest !== undefined && previousRequest !== identity)
        return false;
      requests.set(draft.command.commandId, identity);
    }
    const previous = inputs.get(key);
    if (
      previous &&
      (!sameDraftInput(previous, draft) ||
        (previous.command &&
          draft.command &&
          requestIdentity(previous.command) !== requestIdentity(draft.command)))
    )
      return false;
    inputs.set(key, previous?.command ? previous : draft);
  }
  const requirements = new Map<string, string>();
  for (const draft of projections) {
    const key = draftInputKey(draft);
    const original = inputs.get(key)?.command;
    if (original) {
      const assets =
        original.type === "body.edit"
          ? original.payload.requiredAssetIds
          : undefined;
      if (!(draft.requiredAssetIds ?? []).every((id) => assets?.includes(id)))
        return false;
    } else if (draft.requiredAssetIds !== undefined) {
      const ids = JSON.stringify([...new Set(draft.requiredAssetIds)].sort());
      if (requirements.has(key) && requirements.get(key) !== ids) return false;
      requirements.set(key, ids);
    }
  }
  return true;
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

// JSON object property order is not request identity; array order and all values
// remain intact. Never normalize or replace a request that may already have run.
function requestIdentity(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(requestIdentity).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + requestIdentity(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

export function sameDraftInput(a: Draft, b: Draft): boolean {
  return (
    a.projectId === b.projectId &&
    a.cardId === b.cardId &&
    a.field === b.field &&
    a.generation === b.generation &&
    a.value === b.value &&
    requestIdentity(a.blocks ?? null) === requestIdentity(b.blocks ?? null) &&
    a.expected === b.expected
  );
}
// A receipt covers its exact input and original request, including resources.
// A projection that has not generated a command can share that same receipt.
export function draftCoveredBy(draft: Draft, submitted: Draft): boolean {
  return (
    sameDraftInput(draft, submitted) &&
    (!draft.command ||
      (!!submitted.command &&
        requestIdentity(draft.command) ===
          requestIdentity(submitted.command))) &&
    (draftAssetIds(draft) ?? []).every(
      (id) =>
        submitted.command?.type === "body.edit" &&
        submitted.command.payload.requiredAssetIds?.includes(id),
    )
  );
}

function draftInputKey(draft: Draft): string {
  return JSON.stringify([
    draft.projectId,
    draft.cardId,
    draft.field,
    draft.generation,
  ]);
}
