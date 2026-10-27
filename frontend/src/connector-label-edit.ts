import { useEffect, useRef, useState } from 'react';
import { ConnectorCreateCommand, ConnectorLabelCommand, ConnectorStyleCommand, DEFAULT_CONNECTOR_STYLE, type CanvasConnector, type ConnectorLabel } from '../../backend/src/mapping/connector-contracts';
import { api, MappingError, type Command, type ProjectState } from './api';

export type ConnectorLabelSession = { projectId: string; value: CanvasConnector; label: ConnectorLabel; editGroup: string };
type Edit = Extract<Command, { type: 'connector.label' }>;
type LabelDraft = { label: ConnectorLabel; editGroup: string };
export type LabelConflict = { remote: CanvasConnector | null };
export function useConnectorLabelEdit(publish: (value: ProjectState) => void, currentProject: () => ProjectState | null) {
  const [journal] = useState(() => new LabelRecovery());
  const [recoveries, setRecoveries] = useState<ReturnType<LabelRecovery['list']>>([]), [recoveryError, setRecoveryError] = useState('');
  const [session, setSession] = useState<ConnectorLabelSession | null>(null), current = useRef<ConnectorLabelSession | null>(null);
  const pending = useRef<Edit | null>(null), running = useRef<Promise<boolean> | null>(null), composing = useRef(false);
  const closedDrafts = useRef<LabelDraft[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastInput = useRef(0), needsRead = useRef(false);
  const confirmed = useRef<{ projectId: string; value: CanvasConnector } | null>(null);
  const [conflict, setConflict] = useState<LabelConflict | null>(null), conflictRef = useRef<LabelConflict | null>(null), resolving = useRef(false);
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  function update(value: ConnectorLabelSession | null) { current.current = value; setSession(value); }
  function showConflict(value: LabelConflict | null) { conflictRef.current = value; setConflict(value); }
  function normalized(label: ConnectorLabel | null | undefined) { return label?.text.trim() ? label : null; }
  function dirty() { const value = current.current; return !!value && JSON.stringify(normalized(value.label)) !== JSON.stringify(normalized(value.value.label)); }
  function sameLabel(a: ConnectorLabel | null | undefined, b: ConnectorLabel | null | undefined) { return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b)); }
  function hasPending() { return dirty() || closedDrafts.current.length > 0 || !!pending.current || needsRead.current || !!conflictRef.current; }
  function persist() {
    if (!current.current || !hasPending()) { journal.remove(); return; }
    journal.write({ schema: 1, session: current.current, pending: pending.current, closed: closedDrafts.current, confirmed: confirmed.current, needsRead: needsRead.current, conflict: conflictRef.current });
  }
  function scan() {
    try { setRecoveries(journal.list()); setRecoveryError(journal.damaged ? '部分连线文字恢复记录损坏，原件仍保留' : ''); }
    catch { setRecoveryError('连线文字恢复记录暂时无法读取'); }
  }
  useEffect(scan, [currentProject()?.project.id, session?.value.id]);
  function clearTimers() { clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = maxTimer.current = undefined; }
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (hasPending()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { clearTimers(); window.removeEventListener('beforeunload', unload); };
  }, []);
  function schedule() {
    clearTimeout(timer.current);
    if (composing.current) return;
    timer.current = setTimeout(() => void flush(), 400);
    maxTimer.current ??= setTimeout(() => void flush(), 2000);
  }
  function begin(projectId: string, value: CanvasConnector) {
    if (current.current || pending.current || closedDrafts.current.length) return;
    if (!validLine(value, projectId)) { setError('连线文字目标数据不完整，未开始编辑'); return; }
    update({ projectId, value: structuredClone(value), editGroup: crypto.randomUUID(), label: structuredClone(value.label ?? { text: '', position: 0.5, fontSize: 16, color: '#252933', bold: false }) });
    lastInput.current = 0;
    confirmed.current = { projectId, value: structuredClone(value) };
    setError('');
  }
  function boundary() {
    const value = current.current;
    if (!value || composing.current) return;
    // Only adjacent equal snapshots are redundant. Returning to an earlier
    // value after another group is still a separate user edit.
    const previous = closedDrafts.current.length ? closedDrafts.current.at(-1)!.label : pending.current ? pending.current.payload.label : value.value.label;
    if (!sameLabel(value.label, previous)) closedDrafts.current.push({ label: structuredClone(value.label), editGroup: value.editGroup });
    update({ ...value, editGroup: crypto.randomUUID() }); lastInput.current = 0;
    try { persist(); } catch { setError('连线文字草稿无法写入本机恢复记录，请保留输入并重试'); }
  }
  function change(text: string) {
    let value = current.current;
    if (!value || text === value.label.text) return;
    const now = Date.now(), split = !composing.current && lastInput.current !== 0 && now - lastInput.current > 1000;
    if (split) { boundary(); value = current.current!; }
    update({ ...value, label: { ...value.label, text } });
    lastInput.current = now;
    try { persist(); } catch { setError('连线文字草稿无法写入本机恢复记录，请保留输入并重试'); }
    schedule();
  }
  async function flush(): Promise<boolean> {
    if (composing.current || conflictRef.current) return false;
    if (running.current) return running.current;
    if (!current.current) return true;
    clearTimers();
    setWorking(true);
    running.current = (async () => {
      try {
        for (;;) {
          const value = current.current;
          if (!value || composing.current) return false;
          while (!pending.current && closedDrafts.current.length && sameLabel(closedDrafts.current[0]!.label, value.value.label)) {
            closedDrafts.current.shift(); persist();
          }
          if (!pending.current && !closedDrafts.current.length && !dirty()) {
            if (needsRead.current) { publish(await api.project(value.projectId)); needsRead.current = false; persist(); continue; }
            persist(); setError(''); return true;
          }
          const draft = closedDrafts.current[0] ?? value;
          const command: Edit = pending.current ?? { commandId: crypto.randomUUID(), projectId: value.projectId, type: 'connector.label',
            expected: value.value.versionId, editGroup: draft.editGroup, payload: { id: value.value.id, label: normalized(draft.label) } };
          pending.current = command;
          persist();
          const receipt = await api.execute(command);
          const receivedVersion = receipt.connectorVersions?.[command.payload.id];
          const version = receivedVersion ?? (receipt.changedIds.length === 0 ? command.expected : undefined);
          if (!version || receivedVersion !== undefined && !ConnectorLabelCommand.shape.expected.safeParse(receivedVersion).success ||
            receipt.commandId !== command.commandId || receipt.projectId !== command.projectId) throw new Error('连线文字保存回执不完整，原输入仍保留');
          const newer = current.current;
          if (!newer || newer.projectId !== command.projectId || newer.value.id !== command.payload.id) throw new Error('连线文字输入目标已变化，原请求仍保留');
          // Only this command's acknowledgement advances the edit base. Keep
          // later input separate from the older payload and project read.
          const saved = { ...newer.value, versionId: version, label: command.payload.label };
          confirmed.current = { projectId: command.projectId, value: saved };
          update({ ...newer, value: saved });
          const first = closedDrafts.current[0];
          if (first && first.editGroup === command.editGroup && sameLabel(first.label, command.payload.label)) closedDrafts.current.shift();
          pending.current = null; needsRead.current = true;
          persist();
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '连线文字保存未确认');
        if (failure instanceof MappingError && ['VERSION_CONFLICT', 'NOT_FOUND'].includes(failure.code) && current.current) {
          try {
            const latest = await api.project(current.current.projectId);
            const remote = latest.connectors?.find(line => line.id === current.current!.value.id) ?? null;
            if (remote && !validLine(remote, current.current.projectId)) throw new Error('对方连线数据不完整');
            showConflict({ remote });
            persist(); publish(latest);
          } catch { setError('无法读取或保全对方版本，原请求与完整输入仍保留'); }
        }
        return false;
      }
    })();
    const result = await running.current; running.current = null; setWorking(false); return result;
  }
  async function finish(): Promise<boolean> {
    if (!(await flush()) || composing.current || hasPending()) return false;
    clearTimers(); update(null); return true;
  }
  function acceptHistory(value: CanvasConnector | null, conflicted: boolean) {
    const active = current.current;
    if (!active) return;
    if (value && !validLine(value, active.projectId)) throw new Error('历史读取的连线数据不完整，当前输入仍保留');
    clearTimers(); lastInput.current = 0;
    if (conflicted || !value || hasPending()) {
      showConflict({ remote: value });
      setError(value ? '历史操作后目标又有变化，当前文字仍保留' : '连线已被历史操作移除，可保留当前文字草稿后结束');
      persist(); return;
    }
    const saved = structuredClone(value);
    confirmed.current = { projectId: active.projectId, value: saved };
    update({ projectId: active.projectId, value: saved, editGroup: crypto.randomUUID(),
      label: structuredClone(saved.label ?? { text: '', position: 0.5, fontSize: 16, color: '#252933', bold: false }) });
    showConflict(null); setError(''); persist();
  }
  function restore(key: string, targetId: string) {
    if (current.current || pending.current || running.current || closedDrafts.current.length) return false;
    try {
      const record = journal.list().find(value => value.key === key);
      if (!record || record.value.session.projectId !== currentProject()?.project.id || record.value.session.value.id !== targetId) return false;
      // Establish this editor's durable ownership before retiring the selected
      // old record. Unknown writes keep their exact command and payload.
      const value = structuredClone(record.value);
      if (value.conflict || value.purpose === 'preserved-remote') {
        const remote = currentProject()?.connectors?.find(line => line.id === value.session.value.id) ?? null;
        if (remote && !validLine(remote, value.session.projectId)) throw new Error('当前连线数据不完整，恢复记录仍保留');
        value.conflict = { remote };
      }
      const previous = value.closed?.length ? value.closed.at(-1)!.label : value.pending ? value.pending.payload.label : value.session.value.label;
      if (!sameLabel(value.session.label, previous)) (value.closed ??= []).push({ label: structuredClone(value.session.label), editGroup: value.session.editGroup });
      value.session.editGroup = crypto.randomUUID();
      journal.write(value); journal.remove(key);
      pending.current = value.pending; confirmed.current = value.confirmed; needsRead.current = value.needsRead;
      closedDrafts.current = value.closed ?? [];
      showConflict(value.conflict ?? null);
      update(value.session); lastInput.current = 0; clearTimers(); scan();
      setError(value.purpose === 'preserved-remote' ? '保留的文字副本尚未应用，请比较后明确选择' : '未确认的连线文字已恢复，请重试原请求'); return true;
    } catch { setRecoveryError('无法接管连线文字恢复记录，原始输入仍保留'); return false; }
  }
  function stash() {
    if (!current.current || running.current || composing.current || resolving.current) return false;
    try {
      persist(); journal.detach(); clearTimers(); pending.current = null; needsRead.current = false; confirmed.current = null;
      closedDrafts.current = [];
      showConflict(null); update(null); setError(''); scan(); return true;
    } catch { setError('草稿尚未保全，完整输入仍保留'); return false; }
  }
  async function resolve(choice: 'mine' | 'remote'): Promise<boolean> {
    const value = current.current, comparison = conflictRef.current;
    if (!value || !comparison || composing.current || running.current || resolving.current) return false;
    resolving.current = true; setWorking(true);
    try {
      if (choice === 'remote') {
        const latest = await api.project(value.projectId);
        persist(); journal.detach(); clearTimers();
        pending.current = null; closedDrafts.current = []; needsRead.current = false; confirmed.current = null;
        showConflict(null); update(null); publish(latest); setError(''); scan(); return true;
      }
      if (!comparison.remote) return false;
      const preserved: ConnectorLabelSession = { projectId: value.projectId, value: structuredClone(comparison.remote), editGroup: crypto.randomUUID(),
        label: structuredClone(comparison.remote.label ?? { text: '', position: 0.5, fontSize: 16, color: '#252933', bold: false }) };
      journal.archive({ schema: 1, purpose: 'preserved-remote', session: preserved, pending: null, closed: [],
        confirmed: { projectId: value.projectId, value: preserved.value }, needsRead: false, conflict: null });
      const next = { ...value, value: comparison.remote, editGroup: crypto.randomUUID() }, own = { projectId: value.projectId, value: comparison.remote };
      // This is an explicit user choice. Merely reading a newer version never
      // rebases the old rejected command or replaces either side's text.
      journal.write({ schema: 1, session: next, pending: null, closed: [], confirmed: own, needsRead: false, conflict: null });
      pending.current = null; closedDrafts.current = []; needsRead.current = false; confirmed.current = own; showConflict(null); update(next); setError(''); scan();
      return await finish();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '冲突处理未确认，双方内容仍保留'); return false; }
    finally { resolving.current = false; setWorking(false); }
  }
  return { session, begin, change, boundary, flush, finish, acceptHistory, error, working, hasPending,
    recoveries, recoveryError, restore, conflict, resolve, stash,
    currentSession: () => current.current, confirmed: () => confirmed.current, isComposing: () => composing.current,
    compose: (active: boolean) => { if (active) boundary(); composing.current = active; if (active) clearTimers(); else { lastInput.current = Date.now(); schedule(); } },
    status: error ? '连线文字保存未完成' : working ? '连线文字正在保存…' : hasPending() ? '连线文字等待保存' : '',
  };
}

type LabelRecord = { schema: 1; purpose?: 'preserved-remote'; session: ConnectorLabelSession; pending: Edit | null;
  confirmed: { projectId: string; value: CanvasConnector } | null; needsRead: boolean; conflict?: LabelConflict | null; closed?: LabelDraft[] };
const recoveryPrefix = 'forkwise:connector-label-recovery:v1:';
function validLine(value: CanvasConnector, projectId: string): boolean {
  if (!value || value.kind !== 'connector' || !ConnectorLabelCommand.shape.expected.safeParse(value.versionId).success || typeof value.path !== 'string') return false;
  const envelope = { commandId: 'validate-record', projectId };
  return ConnectorCreateCommand.safeParse({ ...envelope, type: 'connector.create', expected: null,
    payload: { id: value.id, start: value.start, end: value.end, path: value.path } }).success &&
    (value.style === undefined || !!value.style && Object.keys(DEFAULT_CONNECTOR_STYLE).every(key => key in value.style!) &&
      ConnectorStyleCommand.safeParse({ ...envelope, type: 'connector.style', expected: value.versionId, payload: { id: value.id, style: value.style } }).success) &&
    (value.label === undefined || ConnectorLabelCommand.safeParse({ ...envelope, type: 'connector.label', expected: value.versionId, payload: { id: value.id, label: value.label } }).success);
}
function validRecord(input: unknown): input is LabelRecord {
  const value = input as LabelRecord;
  const session = value?.session, projectId = session?.projectId;
  if (!value || value.schema !== 1 || value.purpose !== undefined && value.purpose !== 'preserved-remote' || !session || typeof projectId !== 'string' || !validLine(session.value, projectId) ||
    !session.label || typeof session.editGroup !== 'string' || !session.editGroup || typeof value.needsRead !== 'boolean') return false;
  if (!ConnectorLabelCommand.safeParse({ commandId: 'validate-label', projectId, type: 'connector.label', expected: session.value.versionId,
    editGroup: session.editGroup, payload: { id: session.value.id, label: session.label } }).success) return false;
  if (value.closed !== undefined && (!Array.isArray(value.closed) || value.closed.some(draft => !draft || !draft.label || typeof draft.editGroup !== 'string' || !draft.editGroup ||
    !ConnectorLabelCommand.safeParse({ commandId: 'validate-closed-label', projectId, type: 'connector.label', expected: session.value.versionId,
      editGroup: draft.editGroup, payload: { id: session.value.id, label: draft.label } }).success))) return false;
  if (value.conflict?.remote && !validLine(value.conflict.remote, projectId)) return false;
  return (value.pending === null || ConnectorLabelCommand.safeParse(value.pending).success) && validRecordLinks(value);
}
function validRecordLinks(value: LabelRecord): boolean {
  const { session, confirmed, conflict, pending } = value;
  return !!confirmed && confirmed.projectId === session.projectId && JSON.stringify(confirmed.value) === JSON.stringify(session.value) &&
    (!conflict || conflict.remote === null || conflict.remote.id === session.value.id) &&
    (pending === null || pending.projectId === session.projectId && pending.payload.id === session.value.id && pending.expected === session.value.versionId);
}
class LabelRecovery {
  private key = recoveryPrefix + crypto.randomUUID();
  damaged = false;
  detach() { this.key = recoveryPrefix + crypto.randomUUID(); }
  write(value: LabelRecord) {
    if (!validRecordLinks(value)) throw new Error('连线文字恢复记录不完整，原输入仍保留');
    localStorage.setItem(this.key, JSON.stringify(value));
  }
  archive(value: LabelRecord) {
    if (!validRecordLinks(value)) throw new Error('连线文字副本不完整，双方内容仍保留');
    localStorage.setItem(recoveryPrefix + crypto.randomUUID(), JSON.stringify(value));
  }
  remove(key = this.key) {
    if (!key.startsWith(recoveryPrefix)) throw new Error('不能移除未知恢复记录');
    localStorage.removeItem(key);
  }
  list(): { key: string; value: LabelRecord }[] {
    const result: { key: string; value: LabelRecord }[] = []; this.damaged = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(recoveryPrefix) || key === this.key) continue;
      const raw = localStorage.getItem(key);
      try {
        const value: unknown = JSON.parse(raw ?? 'null');
        if (validRecord(value)) result.push({ key, value }); else this.damaged = true;
      } catch { this.damaged = true; }
    }
    return result;
  }
}
