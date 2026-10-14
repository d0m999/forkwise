import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('外观从同一Mapping保存、独立于正文与Pose，撤销和重开仍保持原文', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-appearance-'));
  let mapping: ReturnType<typeof openMapping> | undefined;
  try {
    mapping = openMapping(directory);
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const run = (command: Record<string, unknown>) =>
      mapping!.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '外观' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '完整标题', text: '完整正文\n第二行原文', x: 10, y: 20 },
    });
    const before = state().cards[0]!;
    run({
      type: 'card.appearance',
      expected: null,
      payload: { id: 'a', titleColor: '#f7e9bd', showPreview: false },
    });
    const colored = state().cards[0]!;
    expect(colored).toMatchObject({
      appearance: { titleColor: '#f7e9bd', showPreview: false },
      body: before.body,
      item: before.item,
    });
    run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    const undone = state().cards[0]!.appearance!;
    expect(undone).toMatchObject({ titleColor: '#edf1fa', showPreview: true });
    expect(undone.versionId).not.toBe(colored.appearance!.versionId);
    run({ type: 'history.redo', expected: state().project.revision, payload: {} });
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    const reopened = state().cards[0]!;
    expect(reopened.appearance?.titleColor).toBe('#f7e9bd');
    expect(reopened.body).toEqual(before.body);
    expect(reopened.item).toEqual(before.item);
  } finally {
    mapping?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('外观独立版本固定快照、observe和原请求重启重试，拒绝过时外观不覆盖新正文', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-appearance-'));
  let mapping: ReturnType<typeof openMapping> | undefined;
  try {
    mapping = openMapping(directory);
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const run = (command: Record<string, unknown>) =>
      mapping!.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '版本' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '标题', text: '原文', x: 10, y: 20 },
    });
    const original = state().cards[0]!;
    const command = {
      commandId: 'style-original',
      type: 'card.appearance',
      expected: null,
      payload: { id: 'a', titleColor: '#f7e9bd', showPreview: true },
    };
    const receipt = run(command),
      colored = state().cards[0]!;
    const snapshot = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
    expect(snapshot.items[0]!.appearance).toEqual(colored.appearance);
    const delta = mapping.observe({ projectId: 'p', afterRevision: receipt.revision - 1 }, human);
    expect(delta.changes[0]!.domains).toEqual([{ domain: 'appearance', id: 'appearance:a' }]);
    const version = mapping.read(
      {
        type: 'version',
        domain: 'appearance',
        id: 'appearance:a',
        versionId: colored.appearance!.versionId,
        projectId: 'p',
      },
      human,
    );
    expect(version).toEqual(colored.appearance);
    run({
      type: 'body.edit',
      expected: original.body.versionId,
      payload: { id: 'a', text: '较新完整原文' },
    });
    run({
      type: 'card.appearance',
      expected: colored.appearance!.versionId,
      payload: { id: 'a', titleColor: '#dceee2', showPreview: false },
    });
    const current = state();
    expect(() => run({ ...command, commandId: 'stale-new-key' })).toThrow('外观已更新');
    expect(state()).toEqual(current);
    expect(
      mapping.read(
        { type: 'map', view: 'index', projectId: 'p', snapshot: snapshot.snapshot },
        human,
      ).items[0]!.appearance,
    ).toEqual(colored.appearance);
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    expect(run(command)).toEqual(receipt);
    expect(state()).toEqual(current);
    run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    expect(state().cards[0]!.body.blocks[0]!.text).toBe('较新完整原文');
    expect(state().cards[0]!.appearance!.titleColor).toBe('#f7e9bd');
  } finally {
    mapping?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('必要高度与最近实际手调参照分离：增高缩回不移动，重开/版本/撤销保留手调floor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-appearance-height-'));
  let mapping: ReturnType<typeof openMapping> | undefined;
  try {
    mapping = openMapping(directory);
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const run = (command: Record<string, unknown>) =>
      mapping!.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '必要高度' } });
    run({
      type: 'thought.create',
      editGroup: 'creation',
      expected: null,
      payload: { id: 'a', title: '', text: '', x: 10, y: 20 },
    });
    function measure(necessaryHeight: number) {
      const card = state().cards[0]!;
      return run({
        type: 'card.layout',
        expected: {
          thought: card.versionId,
          body: card.body.versionId,
          pose: card.item.versionId,
          appearance: card.appearance?.versionId ?? null,
        },
        payload: { id: card.id, necessaryHeight },
      });
    }
    measure(57);
    expect(state().cards[0]!.item).toMatchObject({
      pose: { x: 10, y: 20, width: 280, height: 57 },
      heightPolicy: { manualHeight: null, necessaryHeight: 57 },
    });
    run({
      type: 'thought.title',
      editGroup: 'creation',
      expected: state().cards[0]!.versionId,
      payload: { id: 'a', title: '长标题' },
    });
    measure(220);
    expect(mapping.read({ type: 'history', projectId: 'p' }, human).undo).toHaveLength(1);
    measure(57);
    const compact = state().cards[0]!;
    run({
      type: 'pose.batch',
      expected: { a: compact.item.versionId },
      payload: { poses: [{ id: 'a', ...compact.item.pose, height: 100 }] },
    });
    const manual = state().cards[0]!;
    expect(manual.item.heightPolicy?.manualHeight).toBe(100);
    measure(240);
    measure(80);
    expect(state().cards[0]!.item.pose).toEqual({ x: 10, y: 20, width: 280, height: 100 });
    const current = state().cards[0]!;
    expect(
      mapping.read(
        {
          type: 'version',
          domain: 'pose',
          id: current.item.id,
          versionId: current.item.versionId,
          projectId: 'p',
        },
        human,
      ),
    ).toEqual(current.item);
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    expect(state().cards[0]!.item).toEqual(current.item);
    run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    expect(state().cards[0]!.item.heightPolicy?.manualHeight).toBeNull();
    run({ type: 'history.redo', expected: state().project.revision, payload: {} });
    expect(state().cards[0]!.item.heightPolicy?.manualHeight).toBe(100);
    expect(state().cards[0]!.body.blocks[0]!.text).toBe('');
  } finally {
    mapping?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('外观撤销回默认和创建删除/重做均写新版本，初始null expected不能跨历史ABA重写', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-appearance-aba-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) =>
      mapping.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const travel = (type: string) => run({ type, expected: state().project.revision, payload: {} });
    run({ type: 'project.create', expected: null, payload: { name: '外观版本时钟' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '标题', text: '', x: 10, y: 20 },
    });
    const original = {
      type: 'card.appearance',
      expected: null,
      payload: { id: 'a', titleColor: '#f7e9bd', showPreview: true },
    };
    run(original);
    const version = state().cards[0]!.appearance!.versionId;
    travel('history.undo');
    expect(() => run(original)).toThrow('外观已更新');
    const defaults = state().cards[0]!.appearance!;
    expect(defaults).toMatchObject({ titleColor: '#edf1fa', showPreview: true });
    expect(defaults.versionId).not.toBe(version);
    travel('history.undo');
    expect(state().cards).toEqual([]);
    travel('history.redo');
    expect(state().cards[0]!.appearance!.versionId).not.toBe(defaults.versionId);
    expect(() => run(original)).toThrow('外观已更新');
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('创建历史保留实际测量投影，删除重做不恢复未测高度或额外推进revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-measured-create-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '测量创建' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '短', text: '', x: 10, y: 20 },
    });
    function measure() {
      const c = state().cards[0]!;
      return run({
        type: 'card.layout',
        expected: {
          thought: c.versionId,
          body: c.body.versionId,
          pose: c.item.versionId,
          appearance: c.appearance?.versionId ?? null,
        },
        payload: { id: c.id, necessaryHeight: 59 },
      });
    }
    measure();
    const measured = state().cards[0]!;
    run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    expect(state().cards).toEqual([]);
    run({ type: 'history.redo', expected: state().project.revision, payload: {} });
    expect(state().cards[0]!.item.pose).toEqual(measured.item.pose);
    expect(state().cards[0]!.item.heightPolicy).toEqual(measured.item.heightPolicy);
    const revision = state().project.revision;
    expect(measure().revision).toBe(revision);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
