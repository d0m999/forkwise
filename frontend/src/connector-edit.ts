import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Command } from '../../backend/src/mapping/contracts';
import type { CanvasConnector, ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { ProjectState } from './api';
import type { ConnectorDraft } from './connector-create';
import type { ConnectorPoint } from './connector-geometry';
import type { ConnectorTarget } from './connector-targets';

type Endpoint = 'start' | 'end';
type EditCommand = Extract<Command, { type: 'connector.reconnect' | 'connector.path' | 'connector.move' | 'connector.delete' }>;
type Adapters = {
  current: () => ProjectState | null; blocked: () => boolean;
  point: (client: ConnectorPoint) => ConnectorPoint;
  origin: (client: ConnectorPoint) => { endpoint: ConnectorEndpoint; point: ConnectorPoint } | null;
  resolve: (endpoint: ConnectorEndpoint) => ConnectorPoint | null;
  commit: (command: EditCommand, done: () => void) => Promise<{ submitted: boolean; confirmed: boolean }>;
};
export function useConnectorEdit(adapters: Adapters) {
  const latest = useRef(adapters); latest.current = adapters;
  const [draft, setDraft] = useState<ConnectorDraft | null>(null), saving = useRef(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const keyboard = useRef<{ line: CanvasConnector; endpoint: Endpoint | 'line'; value: ConnectorDraft; initial: ConnectorDraft;
    dx: number; dy: number; origin: HTMLElement } | null>(null);
  const active = useRef<{ line: CanvasConnector; endpoint: Endpoint | 'line'; draft: ConnectorDraft; initial: ConnectorDraft;
    origin: ConnectorPoint; pointerId: number; element: HTMLElement | SVGSVGElement } | null>(null);
  const pathFocusCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => clearPathFocus(), [adapters.current()?.project.id]);
  function clearPathFocus() { pathFocusCleanup.current?.(); }
  function preparePathFocus(projectId: string, line: CanvasConnector, mode: CanvasConnector['path'], origin: HTMLButtonElement) {
    clearPathFocus();
    if (!document.hasFocus() || document.activeElement !== origin) return (_confirmed: boolean) => {};
    let owned = true, frame: number | undefined;
    const focusin = (event: FocusEvent) => {
      // Disabling the submitting button may move focus to the document itself.
      if (event.target !== origin && event.target !== document.body && event.target !== document.documentElement) cleanup();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Tab') cleanup(); };
    const pointerdown = () => cleanup(), blur = () => cleanup();
    function cleanup() {
      owned = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener('focusin', focusin, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', pointerdown, true);
      window.removeEventListener('blur', blur);
      if (pathFocusCleanup.current === cleanup) pathFocusCleanup.current = null;
    }
    pathFocusCleanup.current = cleanup;
    document.addEventListener('focusin', focusin, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    window.addEventListener('blur', blur);
    return (confirmed: boolean) => {
      if (!confirmed || !owned) { cleanup(); return; }
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const current = latest.current.current();
        const saved = current?.project.id === projectId ? current.connectors?.find(value => value.id === line.id) : undefined;
        if (owned && document.hasFocus() && saved && saved.path === mode && saved.versionId !== line.versionId &&
          origin.isConnected && !origin.disabled && (document.activeElement === document.body || document.activeElement === origin)) origin.focus();
        cleanup();
      });
    };
  }
  function cancel(options: { restoreFocus?: boolean } = {}) {
    clearPathFocus();
    const keys = keyboard.current;
    if (keys) {
      keyboard.current = null; setDraft(null);
      if (options.restoreFocus !== false && latest.current.current()?.project.id === keys.value.projectId && keys.origin.isConnected) keys.origin.focus();
    }
    const captured = active.current; if (!captured) return;
    active.current = null; setDraft(null);
    if (captured.element.hasPointerCapture(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId);
  }
  async function submit(command: EditCommand, done: () => void) {
    const result = await latest.current.commit(command, done);
    if (!result.submitted) { saving.current = false; setDraft(null); }
    return result;
  }
  function start(line: CanvasConnector, endpoint: Endpoint | 'line', event: PointerEvent<HTMLElement | SVGSVGElement>) {
    const projectId = latest.current.current()?.project.id, a = latest.current.resolve(line.start), b = latest.current.resolve(line.end);
    if (!projectId || !a || !b || event.button !== 0 || latest.current.blocked() || active.current || keyboard.current || saving.current) return;
    if (endpoint === 'line' && line.start.kind === 'bound' && line.end.kind === 'bound') return;
    clearPathFocus();
    const value = { projectId, start: a, end: b, startEndpoint: line.start, endEndpoint: line.end };
    active.current = { line, endpoint, draft: value, initial: value, origin: latest.current.point({ x: event.clientX, y: event.clientY }), pointerId: event.pointerId, element: event.currentTarget };
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDraft(value);
  }
  function startKeyboard(line: CanvasConnector, endpoint: Endpoint | 'line', origin: HTMLElement) {
    const projectId = latest.current.current()?.project.id, a = latest.current.resolve(line.start), b = latest.current.resolve(line.end);
    if (!projectId || !a || !b || latest.current.blocked() || active.current || keyboard.current || saving.current) return;
    if (endpoint === 'line' && line.start.kind === 'bound' && line.end.kind === 'bound') return;
    clearPathFocus();
    const value = { projectId, start: a, end: b, startEndpoint: line.start, endEndpoint: line.end };
    keyboard.current = { line: structuredClone(line), endpoint, value, initial: value, dx: 0, dy: 0, origin }; setDraft(value);
  }
  function keyboardBlocked() {
    return latest.current.blocked() || saving.current || !!active.current;
  }
  function previewFree(dx = 0, dy = 0) {
    const captured = keyboard.current;
    if (!captured || captured.endpoint === 'line' || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    const previous = dx || dy ? captured.value[captured.endpoint] : latest.current.resolve(captured.line[captured.endpoint]);
    if (!previous) return;
    const point = { x: previous.x + dx, y: previous.y + dy };
    captured.value = { ...captured.value, [captured.endpoint]: point, [captured.endpoint + 'Endpoint']: { kind: 'free', point } };
    setDraft(captured.value);
  }
  function chooseFree() {
    const captured = keyboard.current;
    if (!captured || captured.endpoint === 'line' || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    submitEndpoint(captured, { kind: 'free', point: captured.value[captured.endpoint] });
  }
  function previewAnchor(target: ConnectorTarget) {
    const captured = keyboard.current;
    if (!captured || captured.endpoint === 'line' || captured.value.projectId !== latest.current.current()?.project.id) return;
    captured.value = { ...captured.value, [captured.endpoint]: target.point,
      [captured.endpoint + 'Endpoint']: { kind: 'bound', itemId: target.itemId, side: target.side } };
    setDraft(captured.value);
  }
  function chooseAnchor(target: ConnectorTarget) {
    const captured = keyboard.current;
    if (!captured || captured.endpoint === 'line' || latest.current.blocked() || saving.current || captured.value.projectId !== latest.current.current()?.project.id) return;
    previewAnchor(target);
    submitEndpoint(captured, { kind: 'bound', itemId: target.itemId, side: target.side });
  }
  function submitEndpoint(captured: NonNullable<typeof keyboard.current>, value: ConnectorEndpoint) {
    if (captured.endpoint === 'line') return;
    const command: EditCommand = { commandId: crypto.randomUUID(), projectId: captured.value.projectId,
      type: 'connector.reconnect', expected: captured.line.versionId,
      payload: { id: captured.line.id, endpoint: captured.endpoint, value } };
    submitKeyboard(captured, command);
  }
  function previewMove(dx: number, dy: number) {
    const captured = keyboard.current;
    if (!captured || captured.endpoint !== 'line' || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    captured.dx += dx; captured.dy += dy;
    const start = captured.line.start.kind === 'free' ? { x: captured.initial.start.x + captured.dx, y: captured.initial.start.y + captured.dy } : captured.initial.start;
    const end = captured.line.end.kind === 'free' ? { x: captured.initial.end.x + captured.dx, y: captured.initial.end.y + captured.dy } : captured.initial.end;
    captured.value = { ...captured.initial, start, end,
      startEndpoint: captured.line.start.kind === 'free' ? { kind: 'free', point: start } : captured.line.start,
      endEndpoint: captured.line.end.kind === 'free' ? { kind: 'free', point: end } : captured.line.end };
    setDraft(captured.value);
  }
  function chooseMove() {
    const captured = keyboard.current;
    if (!captured || captured.endpoint !== 'line' || keyboardBlocked() || captured.value.projectId !== latest.current.current()?.project.id) return;
    if (captured.dx === 0 && captured.dy === 0) { cancel(); return; }
    const command: EditCommand = { commandId: crypto.randomUUID(), projectId: captured.value.projectId,
      type: 'connector.move', expected: captured.line.versionId, payload: { id: captured.line.id, dx: captured.dx, dy: captured.dy } };
    submitKeyboard(captured, command);
  }
  function submitKeyboard(captured: NonNullable<typeof keyboard.current>, command: EditCommand) {
    keyboard.current = null; saving.current = true;
    void submit(command, () => { saving.current = false; setDraft(null); setFocusId(captured.line.id); });
  }
  function input(event: PointerEvent<HTMLElement>) {
    const captured = active.current;
    if (!captured || captured.pointerId !== event.pointerId) return false;
    if (latest.current.current()?.project.id !== captured.draft.projectId) { cancel(); return false; }
    event.preventDefault(); event.stopPropagation();
    const client = { x: event.clientX, y: event.clientY }, world = latest.current.point(client);
    const dx = world.x - captured.origin.x, dy = world.y - captured.origin.y;
    let value: ConnectorDraft;
    if (captured.endpoint === 'line') {
      if (event.type === 'pointerup' && dx === 0 && dy === 0) { cancel(); return true; }
      const start = captured.line.start.kind === 'free' ? { x: captured.initial.start.x + dx, y: captured.initial.start.y + dy } : captured.initial.start;
      const end = captured.line.end.kind === 'free' ? { x: captured.initial.end.x + dx, y: captured.initial.end.y + dy } : captured.initial.end;
      value = { ...captured.initial, start, end,
        startEndpoint: captured.line.start.kind === 'free' ? { kind: 'free', point: start } : captured.line.start,
        endEndpoint: captured.line.end.kind === 'free' ? { kind: 'free', point: end } : captured.line.end };
    } else {
      const bound = latest.current.origin(client), point = bound?.point ?? world, endpoint = bound?.endpoint ?? { kind: 'free' as const, point };
      value = { ...captured.draft, [captured.endpoint]: point, [captured.endpoint + 'Endpoint']: endpoint };
    }
    if (event.type === 'pointermove') { captured.draft = value; setDraft(value); return true; }
    if (event.type !== 'pointerup') return false;
    const common = { commandId: crypto.randomUUID(), projectId: value.projectId, expected: captured.line.versionId };
    const command: EditCommand = captured.endpoint === 'line'
      ? { ...common, type: 'connector.move', payload: { id: captured.line.id, dx, dy } }
      : { ...common, type: 'connector.reconnect', payload: { id: captured.line.id, endpoint: captured.endpoint,
        value: captured.endpoint === 'start' ? value.startEndpoint : value.endEndpoint } };
    active.current = null; saving.current = true; setDraft(value);
    if (captured.element.hasPointerCapture(event.pointerId)) captured.element.releasePointerCapture(event.pointerId);
    void submit(command, () => { saving.current = false; setDraft(null); });
    return true;
  }
  function path(line: CanvasConnector, mode: CanvasConnector['path'], origin: HTMLButtonElement) {
    const projectId = latest.current.current()?.project.id;
    if (!projectId || line.path === mode || latest.current.blocked() || active.current || keyboard.current || saving.current) return;
    const command: EditCommand = { commandId: crypto.randomUUID(), projectId, type: 'connector.path', expected: line.versionId,
      payload: { id: line.id, path: mode } };
    const restoreFocus = preparePathFocus(projectId, line, mode, origin);
    saving.current = true;
    void submit(command, () => { saving.current = false; }).then(result => restoreFocus(result.confirmed));
  }
  function remove(line: CanvasConnector) {
    const projectId = latest.current.current()?.project.id;
    if (!projectId || latest.current.blocked() || active.current || keyboard.current || saving.current) return;
    clearPathFocus();
    const command: EditCommand = { commandId: crypto.randomUUID(), projectId, type: 'connector.delete', expected: line.versionId, payload: { id: line.id } };
    saving.current = true;
    void submit(command, () => { saving.current = false; });
  }
  return { draft, start, move: (line: CanvasConnector, event: PointerEvent<SVGSVGElement>) => start(line, 'line', event),
    input, path, remove, cancel, startKeyboard, previewAnchor, chooseAnchor, keyboardActive: !!keyboard.current,
    keyboardEndpoint: keyboard.current && keyboard.current.endpoint !== 'line' ? keyboard.current.endpoint : null, keyboardBlocked, previewFree, chooseFree,
    keyboardMoving: keyboard.current?.endpoint === 'line', previewMove, chooseMove,
    focusId, focused: () => setFocusId(null), hasGesture: () => !!active.current || !!keyboard.current,
    hasPending: () => !!active.current || !!keyboard.current || saving.current };
}
