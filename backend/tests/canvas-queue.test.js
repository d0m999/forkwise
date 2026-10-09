import { it, expect, vi } from 'vitest';
import { attachCanvas } from '../web/canvas-bridge.js';

it('自己的布局回执被等价重读后仍可继续队列，真正远端新版本保留冲突草稿', async () => {
  let receive,
    busy = false,
    writes = 0,
    events = 0;
  let layout = {
    version: 1,
    data: {
      positions: {},
      drawings: [],
      canvas: { scenes: {}, annotations: { elements: [], files: {} } },
    },
  };
  const state = { project: { id: 'p', revision: 0 }, objects: [] },
    sent = [],
    failures = [];
  const frame = { contentWindow: { postMessage: (message) => sent.push(message) } };
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:8787' });
  vi.stubGlobal('window', {
    addEventListener: (_type, callback) => {
      receive = callback;
    },
  });
  try {
    const bridge = attachCanvas({
      frame,
      getState: () => state,
      getLayout: () => layout,
      getSelected: () => null,
      isBusy: () => busy,
      write: async (_commands, options) => {
        writes++;
        expect(options.layout.expectedVersion).toBe(layout.version);
        layout = { version: layout.version + 1, data: options.layout.data };
        busy = true;
      },
      select: () => {},
      task: () => {},
      message: () => {},
      refresh: async () => {},
      recovery: {
        add: (_id, record) => {
          failures.push(record);
          return { persisted: true };
        },
      },
      recoveryChanged: () => {},
    });
    receive({
      source: frame.contentWindow,
      origin: location.origin,
      data: { channel: 'forkwise-canvas', ready: true },
    });
    const emit = () =>
      receive({
        source: frame.contentWindow,
        origin: location.origin,
        data: {
          channel: 'forkwise-canvas',
          projectId: 'p',
          session: sent.at(-1).snapshot.session,
          event: {
            type: 'canvas-state',
            state: {
              ...structuredClone(layout.data.canvas),
              drafts: { fixture: { text: String(++events) } },
            },
          },
        },
      });
    emit();
    emit();
    await vi.waitFor(() => expect(writes).toBe(1));
    // A workspace read returns a new JavaScript object for the same committed layout.
    layout = structuredClone(layout);
    busy = false;
    await vi.waitFor(() => expect(writes).toBe(2));
    busy = false;
    await vi.waitFor(() => expect(bridge.pending()).toBe(false));
    expect(failures).toEqual([]);
    emit();
    emit();
    await vi.waitFor(() => expect(writes).toBe(3));
    layout = {
      version: layout.version + 1,
      data: { ...layout.data, drawings: [{ external: true }] },
    };
    busy = false;
    await vi.waitFor(() => expect(bridge.pending()).toBe(false));
    expect(writes).toBe(3);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('其他入口');
  } finally {
    busy = false;
    vi.unstubAllGlobals();
  }
});

it('连续绘图只在完成动作时提交内容；撤销排在该次提交之后', async () => {
  let receive;
  const sent = [],
    writes = [],
    order = [];
  let layout = {
    version: 0,
    data: {
      positions: {},
      drawings: [],
      canvas: { scenes: {}, annotations: { elements: [], files: {} } },
    },
  };
  const frame = { contentWindow: { postMessage: (message) => sent.push(message) } };
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:8787' });
  vi.stubGlobal('window', {
    addEventListener: (_type, fn) => {
      receive = fn;
    },
  });
  try {
    const bridge = attachCanvas({
      frame,
      getState: () => ({ project: { id: 'p', revision: 0 }, objects: [] }),
      getLayout: () => layout,
      getSelected: () => null,
      isBusy: () => false,
      write: async (_commands, options) => {
        writes.push(options.layout.data);
        layout = { version: layout.version + 1, data: options.layout.data };
        order.push('save');
      },
      travel: async (direction) => order.push(direction),
      select: () => {},
      task: () => {},
      message: () => {},
      refresh: async () => {},
      recovery: {
        add: () => {
          throw Error('不应产生恢复草稿');
        },
      },
      recoveryChanged: () => {},
    });
    receive({
      source: frame.contentWindow,
      origin: location.origin,
      data: { channel: 'forkwise-canvas', ready: true },
    });
    const emit = (event) =>
      receive({
        source: frame.contentWindow,
        origin: location.origin,
        data: {
          channel: 'forkwise-canvas',
          projectId: 'p',
          session: sent.at(-1).snapshot.session,
          event,
        },
      });
    const state = {
      scenes: {},
      annotations: { elements: [{ id: 'draw', type: 'rectangle', x: 10, y: 20 }], files: {} },
    };
    emit({ type: 'canvas-state', state });
    await vi.waitFor(() => expect(bridge.pending()).toBe(false));
    expect(writes).toHaveLength(0);
    emit({ type: 'canvas-state', state, commit: '绘图' });
    emit({ type: 'history', direction: 'undo' });
    await vi.waitFor(() => expect(bridge.pending()).toBe(false));
    expect(writes).toHaveLength(1);
    expect(writes[0].canvas.annotations.elements[0].id).toBe('draw');
    expect(order).toEqual(['save', 'undo']);
  } finally {
    vi.unstubAllGlobals();
  }
});
