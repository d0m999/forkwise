import {
  TextCommands,
  TextContentSchema,
  TextPoseSchema,
} from "../../backend/src/mapping/text-contracts";
import type { TextSession, TextSubmitted } from "./text-save";
export type TextRecoveryRecord = {
  schema: 1;
  session: TextSession;
  pending: TextSubmitted | null;
};
const prefix = "forkwise:text-recovery:v1:";
function validSession(value: TextSession): boolean {
  return (
    !!value &&
    typeof value.projectId === "string" &&
    typeof value.group === "string" &&
    Number.isSafeInteger(value.generation) &&
    Number.isSafeInteger(value.confirmed) &&
    value.generation >= value.confirmed &&
    value.confirmed >= 0 &&
    !!value.value &&
    typeof value.value.id === "string" &&
    typeof value.value.versionId === "string" &&
    !!value.value.item &&
    typeof value.value.item.id === "string" &&
    typeof value.value.item.versionId === "string" &&
    TextPoseSchema.safeParse(value.value.item.pose).success &&
    TextContentSchema.safeParse(value.value.content).success &&
    TextContentSchema.safeParse(value.content).success
  );
}
export class TextRecovery {
  private key = prefix + crypto.randomUUID();
  constructor(private storage: Storage = localStorage) {}
  write(session: TextSession | null, pending: TextSubmitted | null) {
    if (
      !session ||
      (!pending &&
        session.generation === session.confirmed &&
        session.content.runs.some((run) => run.text.trim()))
    )
      this.storage.removeItem(this.key);
    else
      this.storage.setItem(
        this.key,
        JSON.stringify({ schema: 1, session, pending }),
      );
  }
  list(): { key: string; value: TextRecoveryRecord }[] {
    const result = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)!;
      if (!key.startsWith(prefix) || key === this.key) continue;
      try {
        const value = JSON.parse(
          this.storage.getItem(key)!,
        ) as TextRecoveryRecord;
        if (value.schema !== 1 || !validSession(value.session)) continue;
        if (value.pending) {
          const pending = value.pending;
          if (
            !validSession(pending.session) ||
            !TextCommands.safeParse(pending.command).success ||
            pending.command.projectId !== value.session.projectId ||
            pending.command.payload.id !== value.session.value.id ||
            !["text.edit", "text.delete"].includes(pending.command.type) ||
            pending.session.value.id !== value.session.value.id ||
            pending.session.projectId !== value.session.projectId ||
            pending.session.generation > value.session.generation
          )
            continue;
        }
        result.push({ key, value });
      } catch {
        /* Unrecognized journals remain untouched for explicit recovery. */
      }
    }
    return result;
  }
  remove(key: string) {
    this.storage.removeItem(key);
  }
}
