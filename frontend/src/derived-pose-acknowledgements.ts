import { spatialItems } from '../../backend/src/mapping/frame-spatial';
import type { Receipt } from '../../backend/src/mapping/contracts';
import { api, type Command, type ProjectState } from './api';

export type DerivedPoseAcknowledgements = ReturnType<typeof createDerivedPoseAcknowledgements>;

export function createDerivedPoseAcknowledgements(current: () => ProjectState | null) {
  // Key by the prior immutable version so a peer write cannot be skipped, even
  // when a later read or a second local receipt has already appeared.
  const byProject = new Map<string, Map<string, Map<string, string>>>();
  const cardDomains = new Map<string, Map<string | null, string>>();
  function domainKey(projectId: string, cardId: string, domain: 'body' | 'appearance') {
    return JSON.stringify([projectId, cardId, domain]);
  }
  function record(command: Command, receipt: Receipt) {
    if ((command.type !== 'body.edit' && command.type !== 'card.appearance') ||
      command.projectId !== receipt.projectId || command.commandId !== receipt.commandId ||
      !receipt.derivedPoseVersions) return;
    const project = byProject.get(command.projectId) ?? new Map<string, Map<string, string>>();
    byProject.set(command.projectId, project);
    let recordedPose = false;
    for (const [id, change] of Object.entries(receipt.derivedPoseVersions)) {
      if (!receipt.changedIds.includes(id) || change.before === change.after) continue;
      const versions = project.get(id) ?? new Map<string, string>();
      versions.set(change.before, change.after);
      project.set(id, versions);
      recordedPose = true;
    }
    const domain = command.type === 'body.edit' ? 'body' : 'appearance';
    const after = receipt.versions?.[domain];
    if (recordedPose && after && after !== command.expected) {
      const key = domainKey(command.projectId, command.payload.id, domain);
      const versions = cardDomains.get(key) ?? new Map<string | null, string>();
      versions.set(command.expected, after);
      cardDomains.set(key, versions);
    }
  }
  function version(projectId: string, itemId: string, before: string): string {
    const changes = byProject.get(projectId)?.get(itemId);
    while (changes?.has(before)) before = changes.get(before)!;
    return before;
  }
  function versions(projectId: string, before: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(before).map(([id, value]) => [id, version(projectId, id, value)]));
  }
  function updateCardDomains(projectId: string, cardId: string, expected: { body: string; appearance: string | null }) {
    const bodies = cardDomains.get(domainKey(projectId, cardId, 'body'));
    while (bodies?.has(expected.body)) expected.body = bodies.get(expected.body)!;
    const appearances = cardDomains.get(domainKey(projectId, cardId, 'appearance'));
    while (appearances?.has(expected.appearance)) expected.appearance = appearances.get(expected.appearance)!;
  }
  function updatePlacement(command: Command) {
    if ('placement' in command && command.placement)
      command.placement = { ...command.placement, expected: { ...command.placement.expected,
        poses: versions(command.projectId, command.placement.expected.poses) } };
  }
  async function read(projectId: string, id: string, versionId: string) {
    const live = current();
    const cached = live?.project.id === projectId
      ? spatialItems(live).find(value => value.item.id === id && value.item.versionId === versionId)?.item : undefined;
    const value = cached ?? await api.poseVersion(projectId, id, versionId);
    if (value.id !== id || value.versionId !== versionId) throw new Error('无法确认本次正文派生的布局版本');
    return value;
  }
  async function item<T extends { id: string; versionId: string; pose: { x: number; y: number; width: number; height: number } }>(
    projectId: string, before: T,
  ): Promise<T> {
    const after = version(projectId, before.id, before.versionId);
    return after === before.versionId ? before : { ...before, ...await read(projectId, before.id, after) };
  }
  async function project(snapshot: ProjectState, itemIds: ReadonlySet<string>): Promise<ProjectState> {
    const projectId = snapshot.project.id;
    const updates = await Promise.all(spatialItems(snapshot).flatMap(({ item: before }) => {
      if (!itemIds.has(before.id) || version(projectId, before.id, before.versionId) === before.versionId) return [];
      return [item(projectId, before)];
    }));
    if (!updates.length) return snapshot;
    const next = structuredClone(snapshot);
    for (const { item } of spatialItems(next)) {
      const follow = updates.find(value => value.id === item.id);
      if (follow) Object.assign(item, follow);
    }
    return next;
  }
  return { record, version, versions, updateCardDomains, updatePlacement, read, item, project };
}
