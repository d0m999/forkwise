import type { ProjectState } from './api';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';
import { captureMemberDeletion } from './canvas-group-commands';

export function incidentConnectorVersions(state: ProjectState, itemId: string): Record<string, string> | null {
  if (!Array.isArray(state.connectors)) return null;
  return Object.fromEntries(state.connectors.filter(line =>
    (line.start.kind === 'bound' && line.start.itemId === itemId) ||
    (line.end.kind === 'bound' && line.end.itemId === itemId)
  ).map(line => [line.id, line.versionId]));
}

type CardDeleteCommand = Extract<Command, { type: 'thought.delete' }>;
export function captureCardDeletion(state: ProjectState, cardId: string) {
  const card = state.cards.find(value => value.id === cardId);
  if (!card) return null;
  const facts = captureMemberDeletion(state, card);
  if (!facts) return null;
  const projectId = state.project.id, itemId = card.item.id;
  const expected: CardDeleteCommand['expected'] = { thought: card.versionId, body: card.body.versionId,
    pose: card.item.versionId, appearance: card.appearance?.versionId ?? null,
    cardTags: card.cardTags?.versionId ?? null, ...facts };
  let request: CardDeleteCommand | null = null;
  let sealed = false, valid = true;
  const acknowledged = new Set<string>();
  function command(): CardDeleteCommand {
    request ??= { commandId: crypto.randomUUID(), projectId, type: 'thought.delete',
      expected: structuredClone(expected), payload: { id: cardId } };
    return request;
  }
  return {
    projectId, cardId, itemId,
    acknowledge(command: Command, receipt: Receipt) {
      if (sealed || acknowledged.has(command.commandId) || command.projectId !== projectId) return;
      if (command.type === 'canvas.move' || command.type === 'group.move' || command.type === 'canvas.move-selection') {
        const poses = command.type === 'canvas.move' ? command.expected : command.expected.poses;
        if (!Object.hasOwn(poses, itemId)) return;
        if (receipt.projectId !== projectId || receipt.commandId !== command.commandId) { valid = false; return; }
        acknowledged.add(command.commandId);
        if (!receipt.changedIds.includes(itemId)) { if (poses[itemId] !== expected.pose) valid = false; return; }
        const version = receipt.itemPoseVersions?.[itemId];
        if (!version || version === poses[itemId]) { valid = false; return; }
        if (expected.pose === version) return;
        if (poses[itemId] !== expected.pose) { valid = false; return; }
        expected.pose = version; return;
      }
      if (command.type === 'pose.batch') {
        const members = command.payload.poses.filter(value => value.id === cardId);
        if (!members.length) return;
        if (members.length !== 1 || !Object.hasOwn(command.expected, cardId) ||
          command.expected[cardId] !== expected.pose || receipt.projectId !== projectId ||
          receipt.commandId !== command.commandId) { valid = false; return; }
        acknowledged.add(command.commandId);
        if (!receipt.changedIds.includes(itemId)) return;
        const versions = receipt.cardPoseVersions;
        const version = versions && Object.hasOwn(versions, itemId) ? versions[itemId] : undefined;
        if (typeof version !== 'string' || !version || version === expected.pose) { valid = false; return; }
        expected.pose = version;
        return;
      }
      if ((command.type !== 'thought.title' && command.type !== 'body.edit' && command.type !== 'card.layout' && command.type !== 'pose.move' && command.type !== 'card.appearance') ||
        command.payload.id !== cardId) return;
      const domain = command.type === 'thought.title' ? 'thought' : command.type === 'body.edit' ? 'body' : command.type === 'card.appearance' ? 'appearance' : 'pose';
      const prior = command.type === 'card.layout' ? command.expected.pose : command.expected;
      if (receipt.projectId !== projectId || receipt.commandId !== command.commandId || prior !== expected[domain]) {
        valid = false; return;
      }
      acknowledged.add(command.commandId);
      if (!receipt.changedIds.length) return;
      const version = receipt.versions?.[domain];
      if (!version || ((command.type === 'card.layout' || command.type === 'pose.move') &&
        (receipt.changedIds.length !== 1 || receipt.changedIds[0] !== itemId))) { valid = false; return; }
      expected[domain] = version;
    },
    command,
    seal() {
      if (!valid) return false;
      if (!sealed) { command().expected = structuredClone(expected); sealed = true; }
      return true;
    },
  };
}
