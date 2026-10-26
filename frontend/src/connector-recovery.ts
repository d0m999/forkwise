import { ConnectorCreateCommand } from '../../backend/src/mapping/connector-contracts';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';

type Create = Extract<Command, { type: 'connector.create' }>;
type Saved = { command: Create; receipt?: Receipt };
const prefix = 'forkwise:connector-create-recovery:v1:';

function matches(receipt: Receipt, command: Create) {
  return !!receipt && receipt.commandId === command.commandId && receipt.projectId === command.projectId &&
    Number.isSafeInteger(receipt.revision) && receipt.revision >= 0 && Array.isArray(receipt.changedIds) &&
    receipt.changedIds.every(id => typeof id === 'string') && receipt.changedIds.includes(command.payload.id) &&
    typeof receipt.connectorVersions?.[command.payload.id] === 'string';
}
function parse(raw: string): Saved | null {
  try {
    const record = JSON.parse(raw);
    if (record.schema !== 1 || !ConnectorCreateCommand.safeParse(record.command).success ||
      (record.receipt !== undefined && !matches(record.receipt, record.command))) return null;
    return { command: record.command, ...(record.receipt === undefined ? {} : { receipt: record.receipt }) };
  } catch { return null; }
}

export class ConnectorCreateRecovery {
  private key = prefix + crypto.randomUUID();
  constructor(private storage: Storage = localStorage) {}
  list() {
    const records: (Saved & { key: string })[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = this.storage.getItem(key), saved = raw === null ? null : parse(raw);
      if (saved) records.push({ key, ...saved });
    }
    return records;
  }
  adopt(key: string) {
    const raw = key.startsWith(prefix) ? this.storage.getItem(key) : null;
    const saved = raw === null ? null : parse(raw);
    if (!saved) throw new Error('未确认连线记录无法读取，原记录仍保留');
    if (key !== this.key && this.storage.getItem(this.key) !== null)
      throw new Error('另一笔未确认连线仍保留，请先恢复原请求');
    this.key = key;
    return saved;
  }
  write(command: Create, receipt?: Receipt) {
    if (!ConnectorCreateCommand.safeParse(command).success) throw new Error('连线原请求无法校验，原记录仍保留');
    const raw = this.storage.getItem(this.key), existing = raw === null ? null : parse(raw);
    if (raw !== null && (!existing || JSON.stringify(existing.command) !== JSON.stringify(command)))
      throw new Error('另一笔未确认连线仍保留，请先恢复原请求');
    if (receipt && (!matches(receipt, command) || (existing?.receipt && JSON.stringify(existing.receipt) !== JSON.stringify(receipt))))
      throw new Error('连线保存确认与原请求不一致，原记录仍保留');
    const retainedReceipt = receipt ?? existing?.receipt;
    const encoded = JSON.stringify({ schema: 1, command, ...(retainedReceipt ? { receipt: retainedReceipt } : {}) });
    this.storage.setItem(this.key, encoded);
    if (this.storage.getItem(this.key) !== encoded) throw new Error('连线恢复记录尚未可靠保存，原请求仍保留');
  }
  confirm(command: Create) {
    const raw = this.storage.getItem(this.key);
    if (raw === null || JSON.stringify(parse(raw)?.command) !== JSON.stringify(command))
      throw new Error('连线确认与恢复记录不匹配，原请求仍保留');
    this.storage.removeItem(this.key);
    if (this.storage.getItem(this.key) !== null) throw new Error('连线恢复记录尚未确认清理，原请求仍保留');
    return this.key;
  }
}
