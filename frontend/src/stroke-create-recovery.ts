import { StrokeCreateCommand } from "../../backend/src/mapping/stroke-contracts";

type Create = ReturnType<typeof StrokeCreateCommand.parse>;
const prefix = "forkwise:stroke-create-recovery:v1:";

function parse(raw: string): Create | null {
  try {
    const record = JSON.parse(raw), command = StrokeCreateCommand.safeParse(record.command);
    return record.schema === 1 && command.success ? command.data : null;
  } catch { return null; }
}

export class StrokeCreateRecovery {
  private key = prefix + crypto.randomUUID();
  constructor(private storage: Storage = localStorage) {}
  list(): { key: string; command: Create }[] {
    const records = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)!;
      if (!key.startsWith(prefix)) continue;
      // Storage read failures propagate; malformed records remain untouched.
      const raw = this.storage.getItem(key), command = raw === null ? null : parse(raw);
      if (command) records.push({ key, command });
    }
    return records;
  }
  write(value: Create) {
    const command = StrokeCreateCommand.parse(value), raw = this.storage.getItem(this.key);
    if (raw !== null) {
      const existing = parse(raw);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(command))
        throw new Error("另一笔未确认笔迹仍保留，请先恢复原请求");
    }
    this.storage.setItem(this.key, JSON.stringify({ schema: 1, command }));
  }
  adopt(key: string) {
    const record = this.list().find(record => record.key === key);
    if (!record) throw new Error("未确认笔迹记录无法读取，原记录仍保留");
    this.write(record.command);
    if (key !== this.key) this.storage.removeItem(key);
    return record.command;
  }
  confirm(value: Create) {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return;
    const command = parse(raw);
    if (!command || JSON.stringify(command) !== JSON.stringify(StrokeCreateCommand.parse(value)))
      throw new Error("笔迹确认与恢复记录不匹配，原记录仍保留");
    this.storage.removeItem(this.key);
  }
}
