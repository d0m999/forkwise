import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { openMapping } from '../src/mapping/storage.js';
import type { CommitOptions } from '../src/mapping/mapping.js';
import type { Card } from '../src/mapping/contracts.js';

const fixtures: { mapping: ReturnType<typeof openMapping>; directory: string }[] = [];
function resource(event: string, directory: string) {
  if (process.env.FORKWISE_ISSUE28_RESOURCE_LOG) appendFileSync(process.env.FORKWISE_ISSUE28_RESOURCE_LOG,
    JSON.stringify({ event, directory, pid: process.pid, at: new Date().toISOString() }) + '\n');
}
export function closeGroupFixtures() {
  for (const f of fixtures.splice(0)) {
    f.mapping.close(); rmSync(f.directory, { recursive: true, force: true }); resource('closed-and-removed', f.directory);
  }
}
export function groupFixture(options: CommitOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-group-life-'));
  const host = openMapping(directory, options), token = host.access.issue('human', ['*']);
  const f = {
    directory, mapping: host, human: host.access.authenticate(token),
    execute(command: Record<string, unknown>) { return f.mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, f.human); },
    state() { return f.mapping.read({ type: 'project', projectId: 'p' }, f.human); },
    history() { return f.mapping.read({ type: 'history', projectId: 'p' }, f.human); },
    travel(type: 'history.undo' | 'history.redo') { return f.execute({ type, expected: f.state().project.revision, payload: {} }); },
    reopen() { f.mapping.close(); f.mapping = openMapping(directory, options); f.human = f.mapping.access.authenticate(token); },
    group(ids: string[], id = 'g') {
      const s = f.state();
      f.execute({ type: 'group.create', expected: { groups: { [id]: null }, containment: Object.fromEntries(ids.map(item => [item, s.containment!.find(c => c.id === item)?.versionId ?? null])) }, payload: { id, itemIds: ids } });
      return f.state().groups!.find(value => value.id === id)!;
    },
    structure(id = 'g') {
      const s = f.state(), group = s.groups!.find(value => value.id === id)!;
      return { group: group.versionId, containment: Object.fromEntries(s.containment!.filter(c => c.parent?.id === group.itemId).map(c => [c.id, c.versionId])) };
    },
    membership(itemId: string) {
      const s = f.state(), value = s.containment!.find(c => c.id === itemId);
      if (!value?.parent) return undefined;
      const group = s.groups!.find(g => g.itemId === value.parent!.id)!;
      return { group: { id: group.id, versionId: group.versionId }, containment: value.versionId };
    },
    card(id = 'card') { f.execute({ type: 'thought.create', expected: null, payload: { id, title: id, text: '原始正文', x: 10, y: 20 } }); return f.state().cards.find(c => c.id === id)!; },
    text(id = 'text') { f.execute({ type: 'text.create', expected: null, payload: { id, content: { runs: [{ text: '原文' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 100 }, pose: { x: 100, y: 20, width: 100, height: 27 } } }); return f.state().texts!.find(c => c.id === id)!; },
    shape(id = 'shape') { f.execute({ type: 'shape.create', expected: null, payload: { id, content: { shapeType: 'ellipse', shortText: id }, pose: { x: 300, y: 20, width: 100, height: 60 } } }); return f.state().shapes!.find(c => c.id === id)!; },
    stroke(id = 'stroke', penKind = 'pen') { f.execute({ type: 'stroke.create', expected: null, payload: { id, content: { penKind, path: [{ x: 2, y: 2 }, { x: 18, y: 8 }], width: 4, color: '#123456', opacity: 1 }, pose: { x: 420, y: 20, width: 20, height: 10 } } }); return f.state().strokes!.find(c => c.id === id)!; },
    image(id = 'image') { const assetId = id + '-asset'; f.execute({ type: 'asset.save', expected: null, payload: { id: assetId, name: id + '.png', mime: 'image/png', base64: createCanvas(2, 3).toBuffer('image/png').toString('base64') } }); f.execute({ type: 'image.create', expected: null, payload: { id, content: { assetId, crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 500, y: 20, width: 60, height: 40, rotation: 90 } } }); return f.state().images!.find(c => c.id === id)!; },
  };
  fixtures.push(f); resource('allocated', directory);
  f.execute({ type: 'project.create', expected: null, payload: { name: '组合生命周期' } }); return f;
}
export function cardExpected(card: Card) {
  return { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null };
}

export function groupDeleteExpected(f: ReturnType<typeof groupFixture>, id = 'g') {
  const s = f.state(), group = s.groups!.find(g => g.id === id)!, ids = new Set(group.memberItemIds);
  const items: Record<string, unknown> = {};
  for (const v of s.cards.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'card', ...cardExpected(v) };
  for (const v of s.texts!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'text', text: v.versionId, pose: v.item.versionId };
  for (const v of s.shapes!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'shape', shape: v.versionId, pose: v.item.versionId };
  for (const v of s.images!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'image', image: v.versionId, pose: v.item.versionId };
  for (const v of s.strokes!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'stroke', stroke: v.versionId, pose: v.item.versionId };
  const connectors = Object.fromEntries(s.connectors!.filter(v => v.start.kind === 'bound' && ids.has(v.start.itemId) || v.end.kind === 'bound' && ids.has(v.end.itemId)).map(v => [v.id, v.versionId]));
  return { ...f.structure(id), items, connectors };
}
