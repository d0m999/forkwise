import { useRef, useState, type PointerEvent } from 'react';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';
import { MappingError, type ProjectState } from './api';
import type { ConnectorPoint } from './connector-geometry';
import type { ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import { ConnectorCreateRecovery } from './connector-recovery';
import type { ConnectorTarget } from './connector-targets';

type Create = Extract<Command, { type: 'connector.create' }>;
export type ConnectorDraft = { projectId: string; start: ConnectorPoint; end: ConnectorPoint; startEndpoint: ConnectorEndpoint; endEndpoint: ConnectorEndpoint };
type Adapters = {
  current: () => ProjectState | null;
  blocked: () => boolean;
  prepare: (projectId: string) => Promise<boolean>;
  point: (client: ConnectorPoint) => ConnectorPoint;
  center: () => ConnectorPoint | null;
  origin: (client: ConnectorPoint) => { endpoint: ConnectorEndpoint; point: ConnectorPoint } | null;
  execute: (command: Create) => Promise<Receipt>;
  read: (projectId: string) => Promise<ProjectState>;
  publish: (state: ProjectState, id: string) => void;
};

export function useConnectorCreate(adapters: Adapters) {
  const latest = useRef(adapters); latest.current = adapters;
  const [recovery] = useState(() => new ConnectorCreateRecovery());
  const [restored, setRestored] = useState<{ records: ReturnType<ConnectorCreateRecovery['list']>; error: string }>(() => {
    try { return { records: recovery.list(), error: '' }; }
    catch { return { records: [], error: '未确认连线恢复区无法读取，原记录仍保留' }; }
  });
  const [mode, setMode] = useState(false), [draft, setDraft] = useState<ConnectorDraft | null>(null);
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const [rejected, setRejected] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const keyboard = useRef<{ value: ConnectorDraft; origin: HTMLElement } | null>(null);
  const active = useRef<{ value: ConnectorDraft; pointerId: number; element: HTMLElement } | null>(null);
  const pending = useRef<Create | null>(null), activation = useRef(0), click = useRef<ConnectorPoint | null>(null);
  const confirmed = useRef<Receipt | null>(null);
  async function activate() {
    const projectId = latest.current.current()?.project.id;
    if (!projectId || latest.current.blocked() || pending.current || active.current) return;
    const epoch = ++activation.current;
    if (!(await latest.current.prepare(projectId))) return;
    if (activation.current !== epoch || latest.current.current()?.project.id !== projectId || latest.current.blocked()) return;
    setError(''); setMode(true);
  }
  function cancelDraft() {
    const keys = keyboard.current;
    if (keys) {
      keyboard.current = null; setDraft(null);
      if (latest.current.current()?.project.id === keys.value.projectId && keys.origin.isConnected) keys.origin.focus();
    }
    const captured = active.current;
    if (!captured) return;
    active.current = null; setDraft(null);
    if (captured.element.hasPointerCapture(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId);
  }
  function deactivate() {
    if (pending.current) return;
    activation.current++; cancelDraft(); setMode(false);
  }
  async function send(command: Create) {
    let executing = false; setRejected(false);
    try {
      recovery.write(command, confirmed.current ?? undefined);
      executing = true;
      const receipt = await latest.current.execute(command);
      executing = false;
      if (receipt.commandId !== command.commandId || receipt.projectId !== command.projectId) throw new Error('连线保存确认与原请求不一致');
      if (confirmed.current && JSON.stringify(confirmed.current) !== JSON.stringify(receipt)) throw new Error('连线重试确认与已保存结果不一致');
      confirmed.current = receipt; recovery.write(command, receipt);
      const state = await latest.current.read(command.projectId);
      if (pending.current !== command || state.project.id !== command.projectId || latest.current.current()?.project.id !== command.projectId)
        throw new Error('连线所属项目已变化，原请求仍保留');
      const key = recovery.confirm(command); latest.current.publish(state, command.payload.id);
      setRestored(value => ({ ...value, records: value.records.filter(record => record.key !== key) }));
      pending.current = null; confirmed.current = null; setDraft(null); setMode(false); setError('');
    } catch (failure) {
      setRejected(executing && !confirmed.current && failure instanceof MappingError && failure.code === 'INVALID_ENDPOINT');
      const message = failure instanceof Error ? failure.message : '连线保存尚未确认，原请求仍保留';
      setError(confirmed.current ? '连线已保存，画布回读未完成：' + message : message);
    } finally { setWorking(false); }
  }
  async function retry() {
    const command = pending.current;
    if (!command || working || latest.current.current()?.project.id !== command.projectId) return;
    setWorking(true); setError(''); await send(command);
  }
  async function recover(key: string) {
    const record = restored.records.find(value => value.key === key);
    if (!record || record.command.projectId !== latest.current.current()?.project.id || working ||
      pending.current || active.current || latest.current.blocked()) return;
    try {
      const saved = recovery.adopt(key), command = saved.command; pending.current = command; confirmed.current = saved.receipt ?? null;
      setWorking(true); setError(''); await send(command);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '未确认连线无法接管，原记录仍保留'); }
  }
  async function abandon() {
    const command = pending.current;
    if (!command || !rejected || confirmed.current || working || latest.current.current()?.project.id !== command.projectId) return;
    setWorking(true);
    try {
      const state = await latest.current.read(command.projectId);
      if (pending.current !== command || state.project.id !== command.projectId || latest.current.current()?.project.id !== command.projectId)
        throw new Error('连线所属项目已变化，原请求仍保留');
      const key = recovery.confirm(command); latest.current.publish(state, command.payload.id);
      setRestored(value => ({ ...value, records: value.records.filter(record => record.key !== key) }));
      pending.current = null; setDraft(null); setMode(false); setRejected(false); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '未能放弃本次连线，原请求仍保留'); }
    finally { setWorking(false); }
  }
  function submit(value: ConnectorDraft, fromKeyboard = false) {
    const command: Create = { commandId: crypto.randomUUID(), projectId: value.projectId, type: 'connector.create', expected: null,
      payload: { id: crypto.randomUUID(), path: 'straight', start: value.startEndpoint, end: value.endEndpoint } };
    pending.current = command; confirmed.current = null;
    setFocusId(fromKeyboard ? command.payload.id : null); setDraft(value); setWorking(true); setError(''); void send(command);
  }
  function keyboardBlocked() {
    return latest.current.blocked() || !!pending.current || !!active.current;
  }
  function startBlank(origin: HTMLElement) {
    const projectId = latest.current.current()?.project.id, point = latest.current.center();
    if (!mode || !projectId || !point || keyboardBlocked() || keyboard.current) return;
    const endpoint: ConnectorEndpoint = { kind: 'free', point };
    const value = { projectId, start: point, end: point, startEndpoint: endpoint, endEndpoint: endpoint };
    keyboard.current = { value, origin }; setDraft(value); setError('');
  }
  function previewFree(dx = 0, dy = 0) {
    const captured = keyboard.current;
    if (!captured || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    const point = { x: captured.value.end.x + dx, y: captured.value.end.y + dy };
    captured.value = { ...captured.value, end: point, endEndpoint: { kind: 'free', point } };
    setDraft(captured.value);
  }
  function chooseFree() {
    const captured = keyboard.current;
    if (!captured || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    const value = { ...captured.value, endEndpoint: { kind: 'free' as const, point: captured.value.end } };
    keyboard.current = null; submit(value, true);
  }
  function previewAnchor(target: ConnectorTarget) {
    const captured = keyboard.current;
    if (!captured || captured.value.projectId !== latest.current.current()?.project.id) return;
    captured.value = { ...captured.value, end: target.point, endEndpoint: { kind: 'bound', itemId: target.itemId, side: target.side } };
    setDraft(captured.value);
  }
  function chooseAnchor(target: ConnectorTarget, origin: HTMLElement) {
    const projectId = latest.current.current()?.project.id;
    if (!mode || !projectId || latest.current.blocked() || pending.current || active.current) return;
    const endpoint: ConnectorEndpoint = { kind: 'bound', itemId: target.itemId, side: target.side };
    const captured = keyboard.current;
    if (!captured) {
      const value = { projectId, start: target.point, end: target.point, startEndpoint: endpoint, endEndpoint: endpoint };
      keyboard.current = { value, origin }; setDraft(value); return;
    }
    if (captured.value.projectId !== projectId) { cancelDraft(); return; }
    if (captured.value.startEndpoint.kind === 'bound' && captured.value.startEndpoint.itemId === target.itemId) {
      setError('普通连线不能连接同一个对象'); return;
    }
    keyboard.current = null; submit({ ...captured.value, end: target.point, endEndpoint: endpoint }, true);
  }
  function input(event: PointerEvent<HTMLElement>) {
    if (event.type === 'pointerdown') {
      if (!mode || event.button !== 0 || latest.current.blocked() || pending.current || active.current || keyboard.current) return false;
      const target = event.target as Element, projectId = latest.current.current()?.project.id;
      const entry = target.closest('.connector-entry');
      if (!projectId || (!entry && (!target.closest('.react-flow__pane') || target.closest('button, input, textarea, [contenteditable=true], .react-flow__controls')))) return false;
      const client = { x: event.clientX, y: event.clientY }, bound = latest.current.origin(client);
      if (entry && !bound) return false;
      const start = bound?.point ?? latest.current.point(client);
      const value = { projectId, start, end: start, startEndpoint: bound?.endpoint ?? { kind: 'free' as const, point: start }, endEndpoint: { kind: 'free' as const, point: start } };
      active.current = { value, pointerId: event.pointerId, element: event.currentTarget };
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDraft(value);
      return true;
    }
    const captured = active.current;
    if (!captured || captured.pointerId !== event.pointerId) return false;
    if (captured.value.projectId !== latest.current.current()?.project.id) { cancelDraft(); return false; }
    event.preventDefault(); event.stopPropagation();
    const client = { x: event.clientX, y: event.clientY }, bound = latest.current.origin(client);
    const end = bound?.point ?? latest.current.point(client);
    const value = { ...captured.value, end, endEndpoint: bound?.endpoint ?? { kind: 'free' as const, point: end } };
    if (event.type === 'pointermove') { captured.value = value; setDraft(value); return true; }
    if (event.type !== 'pointerup') return false;
    if (value.startEndpoint.kind === 'bound' && value.endEndpoint.kind === 'bound' && value.startEndpoint.itemId === value.endEndpoint.itemId) {
      click.current = client; cancelDraft(); setError('普通连线不能连接同一个对象'); return true;
    }
    active.current = null; click.current = { x: event.clientX, y: event.clientY };
    if (captured.element.hasPointerCapture(event.pointerId)) captured.element.releasePointerCapture(event.pointerId);
    submit(value); return true;
  }
  function consumeClick(client: ConnectorPoint) {
    const end = click.current; click.current = null;
    return !!end && end.x === client.x && end.y === client.y;
  }
  return { mode, draft, working, error: error || restored.error, retryable: !!pending.current, retry, rejected, abandon,
    recoveries: pending.current ? [] : restored.records.filter(record => record.command.projectId === latest.current.current()?.project.id), recover,
    activate, deactivate, input, cancelDraft, consumeClick, chooseAnchor, previewAnchor, focusId, focused: () => setFocusId(null),
    keyboardActive: !!keyboard.current, keyboardBlocked, startBlank, previewFree, chooseFree,
    hasGesture: () => !!active.current || !!keyboard.current, hasPending: () => !!active.current || !!keyboard.current || !!pending.current || !!restored.error ||
      restored.records.some(record => record.command.projectId === latest.current.current()?.project.id) };
}
