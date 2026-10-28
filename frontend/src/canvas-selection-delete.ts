import type { Command, ProjectState } from './api';
import { selectedItemIds, type CanvasSelection } from './canvas-selection';
import { captureCardDeletion } from './connector-deletion';
import type { Receipt } from '../../backend/src/mapping/contracts';

type DeleteSelection = Extract<Command, { type: 'canvas.delete-selection' }>;

// Capture the complete deletion facts once. Later reads may update the view,
// but cannot authorize a different group, member set, or incident line set.
export function captureSelectionDeletion(state: ProjectState, selection: CanvasSelection) {
  if (!state.groups || !state.containment || !state.connectors) return null;
  const groupIds = selection.targets.flatMap(target => target.kind === 'group' ? [target.id] : []);
  const directItemIds = selection.targets.flatMap(target => target.kind === 'item' ? [target.itemId] : []);
  const ids = new Set(selectedItemIds(state, selection)), affected = new Set(groupIds);
  if (!ids.size) return null;
  for (const membership of state.containment.filter(value => ids.has(value.id) && value.parent)) {
    const group = state.groups.find(value => value.itemId === membership.parent!.id);
    if (!group) return null;
    affected.add(group.id);
  }
  const items: DeleteSelection['expected']['items'] = {};
  for (const value of state.cards.filter(value => ids.has(value.item.id))) items[value.item.id] = {
    kind: 'card', thought: value.versionId, body: value.body.versionId, pose: value.item.versionId,
    appearance: value.appearance?.versionId ?? null, cardTags: value.cardTags?.versionId ?? null,
  };
  for (const value of state.texts ?? []) if (ids.has(value.item.id))
    items[value.item.id] = { kind: 'text', text: value.versionId, pose: value.item.versionId };
  for (const value of state.shapes ?? []) if (ids.has(value.item.id))
    items[value.item.id] = { kind: 'shape', shape: value.versionId, pose: value.item.versionId };
  for (const value of state.images ?? []) if (ids.has(value.item.id))
    items[value.item.id] = { kind: 'image', image: value.versionId, pose: value.item.versionId };
  for (const value of state.strokes ?? []) if (ids.has(value.item.id))
    items[value.item.id] = { kind: 'stroke', stroke: value.versionId, pose: value.item.versionId };
  if (Object.keys(items).length !== ids.size || [...affected].some(id => !state.groups!.some(group => group.id === id))) return null;
  const command: DeleteSelection = { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'canvas.delete-selection',
    payload: { groupIds, directItemIds }, expected: {
      groups: Object.fromEntries([...affected].map(id => [id, state.groups!.find(group => group.id === id)!.versionId])),
      containment: Object.fromEntries([...ids].map(id => [id, state.containment!.find(value => value.id === id)?.versionId ?? null])),
      items, connectors: Object.fromEntries(state.connectors.filter(line =>
        line.start.kind === 'bound' && ids.has(line.start.itemId) || line.end.kind === 'bound' && ids.has(line.end.itemId),
      ).map(line => [line.id, line.versionId])),
    } };
  const cards = state.cards.filter(value => ids.has(value.item.id)).map(value => ({ value, intent: captureCardDeletion(state, value.id)! }));
  const acknowledgedCommands = new Set<string>();
  let valid = true;
  let sealed = false;
  return { command,
    acknowledge(acknowledged: Command, receipt: Receipt) {
      if (sealed) return;
      for (const card of cards) card.intent.acknowledge(acknowledged, receipt);
      if (acknowledged.projectId !== state.project.id || acknowledgedCommands.has(acknowledged.commandId)) return;
      if (acknowledged.type === 'shape.move' || acknowledged.type === 'shape.transform') {
        const value = state.shapes?.find(shape => shape.id === acknowledged.payload.id), expected = value && command.expected.items[value.item.id];
        if (!value || expected?.kind !== 'shape') return;
        acknowledgedCommands.add(acknowledged.commandId);
        if (receipt.commandId !== acknowledged.commandId || receipt.projectId !== acknowledged.projectId) { valid = false; return; }
        if (!receipt.changedIds.includes(value.item.id)) { if (acknowledged.expected !== expected.pose) valid = false; return; }
        const version = receipt.shapeVersions?.pose;
        if (!version || version === acknowledged.expected) { valid = false; return; }
        if (version === expected.pose) return;
        if (acknowledged.expected !== expected.pose) { valid = false; return; }
        expected.pose = version; return;
      }
      if (acknowledged.type === 'canvas.move' || acknowledged.type === 'group.move' || acknowledged.type === 'canvas.move-selection') {
        const poses = acknowledged.type === 'canvas.move' ? acknowledged.expected : acknowledged.expected.poses;
        for (const [id, expected] of Object.entries(command.expected.items)) {
          if (expected.kind === 'card' || !Object.hasOwn(poses, id)) continue;
          if (receipt.commandId !== acknowledged.commandId || receipt.projectId !== acknowledged.projectId) { valid = false; continue; }
          if (!receipt.changedIds.includes(id)) { if (poses[id] !== expected.pose) valid = false; continue; }
          const version = receipt.itemPoseVersions?.[id];
          if (!version || version === poses[id]) { valid = false; continue; }
          if (expected.pose === version) continue;
          if (poses[id] !== expected.pose) { valid = false; continue; }
          expected.pose = version;
        }
        acknowledgedCommands.add(acknowledged.commandId); return;
      }
      if (
        !['text.edit', 'text.layout', 'text.transform', 'text.move', 'text.delete'].includes(acknowledged.type) || !('id' in acknowledged.payload)) return;
      const id = acknowledged.payload.id, value = state.texts?.find(text => text.id === id), expected = value && command.expected.items[value.item.id];
      if (!value || expected?.kind !== 'text') return;
      if (acknowledged.type === 'text.delete') { valid = false; return; }
      if (acknowledged.type !== 'text.edit' && acknowledged.type !== 'text.layout' && acknowledged.type !== 'text.transform' && acknowledged.type !== 'text.move') return;
      const matches = acknowledged.type === 'text.edit' ? acknowledged.expected === expected.text
        : acknowledged.type === 'text.move' ? acknowledged.expected === expected.pose
          : acknowledged.expected.text === expected.text && acknowledged.expected.pose === expected.pose;
      if (!matches || receipt.commandId !== acknowledged.commandId || receipt.projectId !== acknowledged.projectId) { valid = false; return; }
      acknowledgedCommands.add(acknowledged.commandId);
      if (receipt.changedIds.includes(value.id)) {
        const next = receipt.textVersions?.text;
        if (!next || next === expected.text) { valid = false; return; }
        expected.text = next;
      }
      if (receipt.changedIds.includes(value.item.id)) {
        const next = receipt.textVersions?.pose;
        if (!next || next === expected.pose) { valid = false; return; }
        expected.pose = next;
      }
    },
    seal() {
      if (!valid) return false;
      for (const card of cards) {
        if (!card.intent.seal()) return false;
        const { connectors: _connectors, membership: _membership, ...domains } = card.intent.command().expected;
        command.expected.items[card.value.item.id] = { kind: 'card', ...domains, cardTags: domains.cardTags ?? null };
      }
      sealed = true;
      return true;
    },
  };
}
