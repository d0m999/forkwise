import { useEffect, useRef } from 'react';
import type { useStoreApi } from '@xyflow/react';
import type { ProjectState } from './api';
import { canvasItems, type CanvasSelection, type useCanvasSelection } from './canvas-selection';

type Store = ReturnType<typeof useStoreApi>;
type Selection = Pick<ReturnType<typeof useCanvasSelection>, 'current' | 'set' | 'marquee'>;
type Rect = { x: number; y: number; width: number; height: number };
type Session = { before: CanvasSelection; shift: boolean; start: { x: number; y: number } | null; active: boolean };

// RF 12.12 publishes container-CSS rectangles with a fixed flow-coordinate start.
// Keep this version-sensitive store/coordinate boundary separate from selection folding.
export function useCanvasMarquee(store: Store, state: ProjectState | null, selection: Selection) {
  const latest = useRef({ state, selection });
  latest.current = { state, selection };
  const session = useRef<Session | null>(null);
  function publish(current: Session, rect: Rect, snapshot: ReturnType<Store['getState']>) {
    const project = latest.current.state;
    if (!project) return;
    const [x, y, zoom] = snapshot.transform;
    const left = (rect.x - x) / zoom, top = (rect.y - y) / zoom;
    const right = (rect.x + rect.width - x) / zoom, bottom = (rect.y + rect.height - y) / zoom;
    const ids = canvasItems(project).filter(value => {
      const node = snapshot.nodeLookup.get(value.item.id), pose = value.item.pose;
      return node && !node.hidden && (node.selectable ?? snapshot.elementsSelectable) &&
        pose.x >= left && pose.y >= top && pose.x + pose.width <= right && pose.y + pose.height <= bottom;
    }).map(value => value.item.id);
    latest.current.selection.marquee(ids, current.before, current.shift);
  }
  useEffect(() => {
    const unsubscribe = store.subscribe((next, previous) => {
      const current = session.current, rect = next.userSelectionRect;
      if (!current) return;
      if (!rect) {
        // An active gesture's rect is cleared immediately before onSelectionEnd.
        if (!current.active) session.current = null;
        return;
      }
      if (rect === previous.userSelectionRect) return;
      current.start ??= { x: rect.startX, y: rect.startY };
      // Initial pointerdown publishes a zero rect before the engine's threshold.
      if (!next.userSelectionActive) return;
      current.active = true;
      publish(current, rect, next);
    });
    return () => { session.current = null; unsubscribe(); };
  }, [store]);
  return {
    begin(shift: boolean) {
      session.current = { before: structuredClone(latest.current.selection.current()), shift, start: null, active: false };
    },
    hasGesture: () => !!session.current,
    retire() { session.current = null; },
    finish(event: { clientX: number; clientY: number }) {
      const current = session.current;
      session.current = null;
      if (!current?.active || !current.start) return;
      const snapshot = store.getState(), bounds = snapshot.domNode?.getBoundingClientRect();
      if (!bounds) return;
      const [x, y, zoom] = snapshot.transform;
      const startX = current.start.x * zoom + x, startY = current.start.y * zoom + y;
      const endX = event.clientX - bounds.left, endY = event.clientY - bounds.top;
      publish(current, { x: Math.min(startX, endX), y: Math.min(startY, endY),
        width: Math.abs(endX - startX), height: Math.abs(endY - startY) }, snapshot);
    },
    cancel() {
      const current = session.current;
      session.current = null;
      if (!current) return;
      store.setState({ userSelectionRect: null, userSelectionActive: false, nodesSelectionActive: false });
      latest.current.selection.set(current.before);
    },
  };
}
