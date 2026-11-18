import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ImageContentImportCheck } from './image-contracts.js';
import { SECRET_KEYS } from './secret-keys.js';
import { ShapeContentImportCheck } from './shape-contracts.js';
import { StrokeContentImportCheck } from './stroke-contracts.js';
import { TextContentImportCheck } from './text-contracts.js';
import { readZip } from './zip-store.js';

export interface PackageFailure {
  code: string;
  path: string;
  expected: string;
  actual: string;
}

export interface VerifiedPackage {
  manifest: Record<string, unknown>;
  files: Map<string, Buffer>;
}

export type PackageInspection =
  | ({ ok: true; failures: PackageFailure[] } & VerifiedPackage)
  | { ok: false; failures: PackageFailure[] };

function fail(failures: PackageFailure[], code: string, path: string, expected: unknown, actual: unknown) {
  if (failures.length >= 200) return;
  const clip = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  };
  failures.push({ code, path, expected: clip(expected), actual: clip(actual) });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right as object).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function list(map: Record<string, unknown>, name: string): unknown[] {
  const value = map[name];
  return Array.isArray(value) ? value : [];
}

function stackOf(mapping: Record<string, unknown>) {
  const rows: { kind: string; id: string; createdOrder: number | null }[] = [];
  const take = (kind: string) => {
    const values = mapping[kind === 'card' ? 'cards' : `${kind}s`];
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (!isRecord(value) || !isRecord(value.item) || typeof value.item.id !== 'string') continue;
      const order = value.item.createdOrder;
      rows.push({ kind, id: String(value.id), createdOrder: typeof order === 'number' ? order : null });
    }
  };
  for (const kind of ['card', 'text', 'shape', 'stroke', 'image']) take(kind);
  rows.sort((left, right) => {
    const leftOrder = left.createdOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.createdOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows;
}

function membershipOf(mapping: Record<string, unknown>) {
  const containment = list(mapping, 'containment');
  const members = (kind: string, id: string) =>
    containment
      .filter((row) => {
        if (!isRecord(row) || !isRecord(row.parent)) return false;
        return row.parent.kind === kind && row.parent.id === id;
      })
      .map((row) => String((row as Record<string, unknown>).id));
  return {
    frames: list(mapping, 'frames').map((frame) => ({ id: String(isRecord(frame) ? frame.id : ''), memberItemIds: members('frame', String(isRecord(frame) ? frame.id : '')) })),
    groups: list(mapping, 'groups').map((group) => ({ id: String(isRecord(group) ? group.id : ''), memberItemIds: members('group', String(isRecord(group) ? group.itemId : '')) })),
  };
}

function scanSecrets(value: unknown, path: string, failures: PackageFailure[]) {
  if (path === '$.research' || path === '$.extensions' || path.endsWith('.body.blocks') || path.endsWith('.value.blocks')) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`, failures));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key) && child != null && child !== '')
      fail(failures, 'SECRET', `${path}.${key}`, null, typeof child === 'string' ? '<redacted>' : typeof child);
    else scanSecrets(child, `${path}.${key}`, failures);
  }
}

function requireString(failures: PackageFailure[], path: string, value: unknown) {
  if (typeof value !== 'string' || !value) fail(failures, 'RECORD_FIELD', path, 'non-empty string', value);
}

function requirePose(failures: PackageFailure[], path: string, value: unknown) {
  if (!isRecord(value)) {
    fail(failures, 'RECORD_FIELD', path, 'pose object', value);
    return;
  }
  for (const field of ['x', 'y'] as const)
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field] as number))
      fail(failures, 'RECORD_FIELD', `${path}.${field}`, 'finite number', value[field]);
  for (const field of ['width', 'height'] as const)
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field] as number) || (value[field] as number) <= 0)
      fail(failures, 'RECORD_FIELD', `${path}.${field}`, 'positive number', value[field]);
}

function requireContent(failures: PackageFailure[], path: string, value: unknown, check: z.ZodType) {
  if (!isRecord(value)) {
    fail(failures, 'RECORD_FIELD', path, 'content object', value);
    return;
  }
  const parsed = check.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues.slice(0, 20)) {
    const at = issue.path.reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[String(key)] : undefined),
      value,
    );
    fail(failures, 'CONTENT_FIELD', `${path}${issue.path.length ? `.${issue.path.join('.')}` : ''}`, issue.message, at);
  }
}

function requireItem(failures: PackageFailure[], path: string, value: unknown, rotation = false) {
  if (!isRecord(value)) {
    fail(failures, 'RECORD_FIELD', path, 'item object', value);
    return;
  }
  requireString(failures, `${path}.id`, value.id);
  requireString(failures, `${path}.versionId`, value.versionId);
  requirePose(failures, `${path}.pose`, value.pose);
  if (rotation && isRecord(value.pose) && ![0, 90, 180, 270].includes(value.pose.rotation as number))
    fail(failures, 'RECORD_FIELD', `${path}.pose.rotation`, '0/90/180/270', value.pose.rotation);
}

function verifyRecords(mapping: Record<string, unknown>, failures: PackageFailure[]) {
  list(mapping, 'cards').forEach((value, index) => {
    const path = `mapping.cards[${index}]`;
    if (!isRecord(value)) {
      fail(failures, 'RECORD_FIELD', path, 'card object', value);
      return;
    }
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (typeof value.title !== 'string') fail(failures, 'RECORD_FIELD', `${path}.title`, 'string', value.title);
    if (!isRecord(value.body)) fail(failures, 'RECORD_FIELD', `${path}.body`, 'body object', value.body);
    else {
      requireString(failures, `${path}.body.id`, value.body.id);
      requireString(failures, `${path}.body.versionId`, value.body.versionId);
      if (!Array.isArray(value.body.blocks)) fail(failures, 'RECORD_FIELD', `${path}.body.blocks`, 'array', value.body.blocks);
    }
    requireItem(failures, `${path}.item`, value.item);
    if (value.appearance !== undefined) {
      if (!isRecord(value.appearance)) fail(failures, 'RECORD_FIELD', `${path}.appearance`, 'object', value.appearance);
      else {
        requireString(failures, `${path}.appearance.id`, value.appearance.id);
        requireString(failures, `${path}.appearance.versionId`, value.appearance.versionId);
        if (typeof value.appearance.titleColor !== 'string') fail(failures, 'RECORD_FIELD', `${path}.appearance.titleColor`, 'string', value.appearance.titleColor);
        if (typeof value.appearance.showPreview !== 'boolean') fail(failures, 'RECORD_FIELD', `${path}.appearance.showPreview`, 'boolean', value.appearance.showPreview);
        if (typeof value.id === 'string' && value.appearance.id !== `appearance:${value.id}`)
          fail(failures, 'RECORD_FIELD', `${path}.appearance.id`, `appearance:${value.id}`, value.appearance.id);
      }
    }
    if (value.cardTags !== undefined) {
      if (!isRecord(value.cardTags)) fail(failures, 'RECORD_FIELD', `${path}.cardTags`, 'object', value.cardTags);
      else {
        requireString(failures, `${path}.cardTags.id`, value.cardTags.id);
        requireString(failures, `${path}.cardTags.versionId`, value.cardTags.versionId);
        if (!Array.isArray(value.cardTags.tagIds)) fail(failures, 'RECORD_FIELD', `${path}.cardTags.tagIds`, 'array', value.cardTags.tagIds);
        if (typeof value.id === 'string' && value.cardTags.id !== `cardTags:${value.id}`)
          fail(failures, 'RECORD_FIELD', `${path}.cardTags.id`, `cardTags:${value.id}`, value.cardTags.id);
      }
    }
    if (value.attachments !== undefined) {
      if (!isRecord(value.attachments)) fail(failures, 'RECORD_FIELD', `${path}.attachments`, 'object', value.attachments);
      else {
        requireString(failures, `${path}.attachments.id`, value.attachments.id);
        requireString(failures, `${path}.attachments.versionId`, value.attachments.versionId);
        if (!Array.isArray(value.attachments.items)) fail(failures, 'RECORD_FIELD', `${path}.attachments.items`, 'array', value.attachments.items);
        else value.attachments.items.forEach((item, order) => {
          const itemPath = `${path}.attachments.items[${order}]`;
          if (!isRecord(item)) return fail(failures, 'RECORD_FIELD', itemPath, 'object', item);
          requireString(failures, `${itemPath}.id`, item.id);
          requireString(failures, `${itemPath}.assetId`, item.assetId);
          requireString(failures, `${itemPath}.name`, item.name);
        });
        if (typeof value.id === 'string' && value.attachments.id !== `attachments:${value.id}`)
          fail(failures, 'RECORD_FIELD', `${path}.attachments.id`, `attachments:${value.id}`, value.attachments.id);
      }
    }
  });

  for (const [name, kind, check] of [
    ['texts', 'text', TextContentImportCheck],
    ['shapes', 'shape', ShapeContentImportCheck],
    ['strokes', 'stroke', StrokeContentImportCheck],
    ['images', 'image', ImageContentImportCheck],
  ] as const) {
    list(mapping, name).forEach((value, index) => {
      const path = `mapping.${name}[${index}]`;
      if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, `${kind} object`, value);
      requireString(failures, `${path}.id`, value.id);
      requireString(failures, `${path}.versionId`, value.versionId);
      requireContent(failures, `${path}.content`, value.content, check);
      requireItem(failures, `${path}.item`, value.item, kind === 'image');
    });
  }

  list(mapping, 'connectors').forEach((value, index) => {
    const path = `mapping.connectors[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'connector object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (!['straight', 'elbow', 'curve'].includes(value.path as string)) fail(failures, 'RECORD_FIELD', `${path}.path`, 'straight/elbow/curve', value.path);
    for (const end of ['start', 'end'] as const) {
      const endpoint = value[end];
      if (!isRecord(endpoint) || !['free', 'bound'].includes(endpoint.kind as string)) {
        fail(failures, 'RECORD_FIELD', `${path}.${end}`, 'endpoint object', endpoint);
        continue;
      }
      if (endpoint.kind === 'bound') {
        requireString(failures, `${path}.${end}.itemId`, endpoint.itemId);
        if (!['top', 'right', 'bottom', 'left'].includes(endpoint.side as string))
          fail(failures, 'RECORD_FIELD', `${path}.${end}.side`, 'top/right/bottom/left', endpoint.side);
        if (endpoint.targetKind !== undefined && !['item', 'group', 'frame'].includes(endpoint.targetKind as string))
          fail(failures, 'RECORD_FIELD', `${path}.${end}.targetKind`, 'item/group/frame', endpoint.targetKind);
      }
    }
  });

  list(mapping, 'frames').forEach((value, index) => {
    const path = `mapping.frames[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'frame object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (typeof value.name !== 'string' || !value.name) fail(failures, 'RECORD_FIELD', `${path}.name`, 'non-empty string', value.name);
    if (value.background !== null && typeof value.background !== 'string') fail(failures, 'RECORD_FIELD', `${path}.background`, 'string or null', value.background);
    requirePose(failures, `${path}.pose`, value.pose);
  });

  list(mapping, 'groups').forEach((value, index) => {
    const path = `mapping.groups[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'group object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.itemId`, value.itemId);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (typeof value.createdOrder !== 'number' || !Number.isFinite(value.createdOrder)) fail(failures, 'RECORD_FIELD', `${path}.createdOrder`, 'number', value.createdOrder);
  });

  list(mapping, 'containment').forEach((value, index) => {
    const path = `mapping.containment[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'containment object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (value.parent !== null && (!isRecord(value.parent) || !['group', 'frame'].includes(value.parent.kind as string)))
      fail(failures, 'RECORD_FIELD', `${path}.parent`, 'null or container', value.parent);
  });

  list(mapping, 'attachments').forEach((value, index) => {
    const path = `mapping.attachments[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'attachment object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (!isRecord(value.target)) fail(failures, 'RECORD_FIELD', `${path}.target`, 'target object', value.target);
    else requireString(failures, `${path}.target.itemId`, value.target.itemId);
  });

  list(mapping, 'tags').forEach((value, index) => {
    const path = `mapping.tags[${index}]`;
    if (!isRecord(value)) return fail(failures, 'RECORD_FIELD', path, 'tag object', value);
    requireString(failures, `${path}.id`, value.id);
    requireString(failures, `${path}.versionId`, value.versionId);
    if (typeof value.name !== 'string' || !value.name) fail(failures, 'RECORD_FIELD', `${path}.name`, 'non-empty string', value.name);
    if (typeof value.color !== 'string' || !value.color) fail(failures, 'RECORD_FIELD', `${path}.color`, 'non-empty string', value.color);
    if (typeof value.deleted !== 'boolean') fail(failures, 'RECORD_FIELD', `${path}.deleted`, 'boolean', value.deleted);
  });
}

function verifyAssets(mapping: Record<string, unknown>, resources: Record<string, unknown>[], files: Map<string, Buffer>, failures: PackageFailure[]) {
  const assets = list(mapping, 'assets');
  if (!Array.isArray(mapping.assets)) {
    fail(failures, 'REFERENCE', 'mapping.assets', 'array', mapping.assets);
    return;
  }
  const resourceById = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    const id = resource.id;
    if (typeof id === 'string') resourceById.set(id, resource);
  }
  const assetIds = new Set<string>();
  assets.forEach((value, index) => {
    const path = `mapping.assets[${index}]`;
    if (!isRecord(value)) {
      fail(failures, 'ASSET_FIELD', path, 'object', value);
      return;
    }
    for (const field of ['id', 'name', 'mime', 'hash'] as const)
      if (typeof value[field] !== 'string' || !value[field]) fail(failures, 'ASSET_FIELD', `${path}.${field}`, 'non-empty string', value[field]);
    if (typeof value.id !== 'string') return;
    if (assetIds.has(value.id)) fail(failures, 'ASSET_FIELD', `${path}.id`, 'unique', value.id);
    assetIds.add(value.id);
    if (typeof value.mime === 'string' && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value.mime))
      fail(failures, 'ASSET_FIELD', `${path}.mime`, 'mime type', value.mime);
    if (value.kind !== undefined && value.kind !== 'file') fail(failures, 'ASSET_FIELD', `${path}.kind`, 'file or absent', value.kind);
    const resource = resourceById.get(value.id);
    const bytes = typeof value.base64 === 'string' && value.base64 ? Buffer.from(value.base64, 'base64') : resource && typeof resource.path === 'string' ? files.get(resource.path) : undefined;
    if (bytes) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (resource && typeof resource.sha256 === 'string' && hash !== resource.sha256)
        fail(failures, 'ASSET_BYTES', `${path}.base64`, resource.sha256, hash);
      if (typeof value.hash === 'string' && value.hash !== hash)
        fail(failures, 'ASSET_HASH', `${path}.hash`, hash, value.hash);
      const limit = value.kind === 'file' ? 10 * 1024 * 1024 : 512 * 1024;
      if (bytes.length > limit) fail(failures, 'ASSET_FIELD', `${path}.base64`, `<= ${limit} bytes`, bytes.length);
    } else {
      if (value.base64 !== undefined && typeof value.base64 !== 'string') fail(failures, 'ASSET_FIELD', `${path}.base64`, 'string', value.base64);
      fail(failures, 'ASSET_MISSING', path, 'resource bytes or base64', 'missing');
    }
    if (resource && typeof value.hash === 'string' && typeof resource.sha256 === 'string' && value.hash !== resource.sha256)
      fail(failures, 'ASSET_HASH', `${path}.hash`, resource.sha256, value.hash);
    if (value.kind !== 'file' && typeof value.mime === 'string' && value.mime.startsWith('image/'))
      for (const field of ['width', 'height'] as const)
        if (typeof value[field] !== 'number' || !Number.isFinite(value[field] as number) || (value[field] as number) <= 0)
          fail(failures, 'ASSET_FIELD', `${path}.${field}`, 'positive number', value[field]);
  });
}

const VERSION_DOMAINS = new Set([
  'body', 'pose', 'appearance', 'cardTags', 'attachments', 'attachment',
  'tag', 'shape', 'stroke', 'image', 'connector', 'group', 'containment', 'frame', 'text',
]);

function verifyManifest(manifest: Record<string, unknown>, files: Map<string, Buffer>, failures: PackageFailure[]): PackageFailure[] {
  if (manifest.format !== 'forkwise-project') fail(failures, 'FORMAT', 'format', 'forkwise-project', manifest.format);
  if (manifest.schemaVersion !== 2) fail(failures, 'SCHEMA_VERSION', 'schemaVersion', 2, manifest.schemaVersion);
  if (typeof manifest.exportedAt !== 'string' || !manifest.exportedAt) fail(failures, 'EXPORTED_AT', 'exportedAt', 'non-empty string', manifest.exportedAt);
  if (typeof manifest.projectId !== 'string' || !manifest.projectId) fail(failures, 'PROJECT_ID', 'projectId', 'non-empty string', manifest.projectId);
  if (typeof manifest.revision !== 'number') fail(failures, 'REVISION', 'revision', 'number', manifest.revision);
  if (!manifest.extensions || typeof manifest.extensions !== 'object' || Array.isArray(manifest.extensions))
    fail(failures, 'EXTENSIONS', 'extensions', 'object', manifest.extensions);
  const projectId = typeof manifest.projectId === 'string' ? manifest.projectId : '';
  const mapping = manifest.mapping;
  if (!isRecord(mapping)) {
    fail(failures, 'REFERENCE', 'mapping', 'object', mapping);
    return failures;
  }
  const map = mapping;
  const project = map.project;
  if (!isRecord(project) || project.id !== projectId) fail(failures, 'PROJECT_ID', 'mapping.project.id', projectId, isRecord(project) ? project.id : project);
  if (isRecord(project) && project.revision !== manifest.revision) fail(failures, 'REVISION', 'mapping.project.revision', manifest.revision, project.revision);
  const names = ['cards', 'texts', 'shapes', 'strokes', 'images', 'connectors', 'frames', 'groups', 'containment', 'attachments', 'tags'] as const;
  const stored = isRecord(map.stored) ? map.stored as Record<string, unknown> : undefined;
  for (const name of names) {
    const parsed = map[name];
    const raw = stored?.[name];
    if (!Array.isArray(parsed) || !Array.isArray(raw) || parsed.length !== raw.length) {
      fail(failures, 'STORED_MISMATCH', `mapping.stored.${name}`, Array.isArray(parsed) ? parsed.length : 'array', Array.isArray(raw) ? raw.length : raw);
      continue;
    }
    parsed.forEach((item, index) => {
      let actual: unknown;
      try {
        actual = JSON.parse((raw[index] as { json?: string }).json ?? '');
      } catch {
        fail(failures, 'STORED_MISMATCH', `mapping.stored.${name}[${index}]`, 'json', 'invalid');
        return;
      }
      if (!deepEqual(item, actual)) fail(failures, 'STORED_MISMATCH', `mapping.stored.${name}[${index}]`, item, actual);
    });
  }
  const computedMembership = membershipOf(map);
  if (!deepEqual(map.membership, computedMembership)) fail(failures, 'MEMBERSHIP', 'mapping.membership', computedMembership, map.membership);
  const computedStack = stackOf(map);
  if (!deepEqual(map.stack, computedStack)) fail(failures, 'STACK', 'mapping.stack', computedStack, map.stack);
  const versions = list(map, 'versions');
  const versionStored = Array.isArray(stored?.versions) ? stored!.versions as { json?: string; domain?: string; id?: string; versionId?: string }[] : undefined;
  if (!versionStored || versionStored.length !== versions.length)
    fail(failures, 'STORED_MISMATCH', 'mapping.stored.versions', versions.length, Array.isArray(versionStored) ? versionStored.length : versionStored);
  else
    versions.forEach((version, index) => {
      const raw = versionStored[index]!;
      let actual: unknown;
      try {
        actual = JSON.parse(raw.json ?? '');
      } catch {
        fail(failures, 'STORED_MISMATCH', `mapping.stored.versions[${index}]`, 'json', 'invalid');
        return;
      }
      if (!isRecord(version) || version.domain !== raw.domain || version.id !== raw.id || version.versionId !== raw.versionId || !deepEqual(version.value, actual))
        fail(failures, 'STORED_MISMATCH', `mapping.stored.versions[${index}]`, version, { ...raw, value: actual });
    });

  const identities: [string, string][] = [
    ['card', 'cards'], ['text', 'texts'], ['shape', 'shapes'], ['stroke', 'strokes'], ['image', 'images'],
    ['connector', 'connectors'], ['frame', 'frames'], ['group', 'groups'], ['tag', 'tags'],
  ];
  for (const [, name] of identities) {
    const seen = new Set<string>();
    list(map, name).forEach((value, index) => {
      const id = isRecord(value) ? value.id : undefined;
      if (typeof id !== 'string' || !id) {
        fail(failures, 'IDENTITY', `mapping.${name}[${index}].id`, 'non-empty string', id);
        return;
      }
      if (seen.has(id)) fail(failures, 'DUPLICATE_ID', `mapping.${name}[${index}].id`, 'unique', id);
      seen.add(id);
    });
  }
  const itemSeen = new Set<string>();
  for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images'] as const) {
    list(map, name).forEach((value, index) => {
      const id = isRecord(value) && isRecord(value.item) ? value.item.id : undefined;
      if (typeof id !== 'string' || !id) return;
      if (itemSeen.has(id)) fail(failures, 'DUPLICATE_ID', `mapping.${name}[${index}].item.id`, 'unique item id', id);
      itemSeen.add(id);
    });
  }
  const groupItemSeen = new Set<string>();
  list(map, 'groups').forEach((value, index) => {
    const id = isRecord(value) ? value.itemId : undefined;
    if (typeof id !== 'string' || !id) return;
    if (groupItemSeen.has(id)) fail(failures, 'DUPLICATE_ID', `mapping.groups[${index}].itemId`, 'unique group item id', id);
    groupItemSeen.add(id);
  });
  for (const [name, field] of [['containment', 'id'], ['attachments', 'id']] as const) {
    const seen = new Set<string>();
    list(map, name).forEach((value, index) => {
      const id = isRecord(value) ? value[field] : undefined;
      if (typeof id !== 'string' || !id) return;
      if (seen.has(id)) fail(failures, 'DUPLICATE_ID', `mapping.${name}[${index}].${field}`, 'unique', id);
      seen.add(id);
    });
  }

  verifyRecords(map, failures);

  const versionKeys = new Set<string>();
  versions.forEach((value, index) => {
    if (!isRecord(value)) {
      fail(failures, 'RECORD_FIELD', `mapping.versions[${index}]`, 'object', value);
      return;
    }
    requireString(failures, `mapping.versions[${index}].domain`, value.domain);
    requireString(failures, `mapping.versions[${index}].id`, value.id);
    requireString(failures, `mapping.versions[${index}].versionId`, value.versionId);
    if (typeof value.domain !== 'string' || typeof value.id !== 'string' || typeof value.versionId !== 'string') return;
    const path = `mapping.versions[${index}]`;
    if (!VERSION_DOMAINS.has(value.domain)) {
      fail(failures, 'VERSION_FIELD', `${path}.domain`, [...VERSION_DOMAINS].join('/'), value.domain);
      return;
    }
    if (!isRecord(value.value)) {
      fail(failures, 'VERSION_FIELD', `${path}.value`, 'object', value.value);
      return;
    }
    if (typeof value.value.id !== 'string' || !value.value.id) fail(failures, 'VERSION_FIELD', `${path}.value.id`, 'non-empty string', value.value.id);
    else if (value.value.id !== value.id) fail(failures, 'VERSION_FIELD', `${path}.value.id`, value.id, value.value.id);
    const key = `${value.domain}\u0000${value.id}\u0000${value.versionId}`;
    if (versionKeys.has(key)) fail(failures, 'DUPLICATE_ID', path, 'unique (domain,id,versionId)', key.replaceAll('\u0000', '/'));
    versionKeys.add(key);
  });
  const requireVersion = (domain: string, id: unknown, versionId: unknown, path: string) => {
    if (typeof id !== 'string' || typeof versionId !== 'string') return;
    if (!versionKeys.has(`${domain}\u0000${id}\u0000${versionId}`)) fail(failures, 'VERSION_MISSING', path, `${domain} ${id} ${versionId}`, 'missing');
  };
  list(map, 'cards').forEach((value, index) => {
    if (!isRecord(value)) return;
    const body = isRecord(value.body) ? value.body : undefined;
    const item = isRecord(value.item) ? value.item : undefined;
    if (body) requireVersion('body', body.id, body.versionId, `mapping.cards[${index}].body`);
    if (item) requireVersion('pose', item.id, item.versionId, `mapping.cards[${index}].item`);
    if (isRecord(value.appearance)) requireVersion('appearance', value.appearance.id, value.appearance.versionId, `mapping.cards[${index}].appearance`);
    if (isRecord(value.cardTags)) requireVersion('cardTags', value.cardTags.id, value.cardTags.versionId, `mapping.cards[${index}].cardTags`);
    if (isRecord(value.attachments)) requireVersion('attachments', value.attachments.id, value.attachments.versionId, `mapping.cards[${index}].attachments`);
  });
  for (const [name, domain] of [['texts', 'text'], ['shapes', 'shape'], ['strokes', 'stroke'], ['images', 'image']] as const) {
    list(map, name).forEach((value, index) => {
      if (!isRecord(value)) return;
      requireVersion(domain, value.id, value.versionId, `mapping.${name}[${index}].versionId`);
      if (isRecord(value.item)) requireVersion('pose', value.item.id, value.item.versionId, `mapping.${name}[${index}].item`);
    });
  }
  for (const [name, domain] of [['connectors', 'connector'], ['frames', 'frame'], ['groups', 'group'], ['tags', 'tag']] as const) {
    list(map, name).forEach((value, index) => {
      if (!isRecord(value)) return;
      requireVersion(domain, value.id, value.versionId, `mapping.${name}[${index}].versionId`);
    });
  }
  list(map, 'containment').forEach((value, index) => {
    if (isRecord(value)) requireVersion('containment', value.id, value.versionId, `mapping.containment[${index}].versionId`);
  });
  list(map, 'attachments').forEach((value, index) => {
    if (isRecord(value)) requireVersion('attachment', value.id, value.versionId, `mapping.attachments[${index}].versionId`);
  });

  const itemIds = new Set<string>();
  for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images'] as const) {
    for (const value of list(map, name)) {
      const item = isRecord(value) ? value.item : undefined;
      if (isRecord(item) && typeof item.id === 'string') itemIds.add(item.id);
    }
  }
  const frameIds = new Set(list(map, 'frames').flatMap((frame) => (isRecord(frame) && typeof frame.id === 'string' ? [frame.id] : [])));
  const groupItemIds = new Set(list(map, 'groups').flatMap((group) => (isRecord(group) && typeof group.itemId === 'string' ? [group.itemId] : [])));
  const tagIds = new Set(list(map, 'tags').flatMap((tag) => (isRecord(tag) && typeof tag.id === 'string' ? [tag.id] : [])));
  const endpointIds = new Set([...itemIds, ...frameIds, ...groupItemIds]);
  if (!Array.isArray(manifest.resources)) fail(failures, 'RESOURCE_FIELD', 'resources', 'array', manifest.resources);
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const resourceIds = new Set<string>();
  resources.forEach((resource, index) => {
    const path = `resources[${index}]`;
    if (!isRecord(resource)) {
      fail(failures, 'RESOURCE_FIELD', path, 'object', resource);
      return;
    }
    for (const field of ['id', 'mime', 'sha256', 'path'] as const)
      if (typeof resource[field] !== 'string' || !resource[field]) fail(failures, 'RESOURCE_FIELD', `${path}.${field}`, 'non-empty string', resource[field]);
    if (typeof resource.id === 'string') {
      if (resourceIds.has(resource.id)) fail(failures, 'RESOURCE_FIELD', `${path}.id`, 'unique', resource.id);
      resourceIds.add(resource.id);
    }
    if (typeof resource.sha256 === 'string' && !/^[a-f0-9]{64}$/.test(resource.sha256))
      fail(failures, 'RESOURCE_HASH', `${path}.sha256`, '64 hex', resource.sha256);
    if (typeof resource.path !== 'string' || !/^resources\/\d{4,}-[a-f0-9]{64}$/.test(resource.path) || /\s/.test(resource.path))
      fail(failures, 'RESOURCE_PATH', `${path}.path`, 'resources/<序号>-<sha256>', resource.path);
    else if (!files.has(resource.path)) fail(failures, 'RESOURCE_MISSING', resource.path, 'file bytes', 'missing');
    else if (typeof resource.sha256 === 'string') {
      const actual = createHash('sha256').update(files.get(resource.path)!).digest('hex');
      if (actual !== resource.sha256) fail(failures, 'RESOURCE_HASH', resource.path, resource.sha256, actual);
      else if (!resource.path.endsWith(`-${resource.sha256}`)) fail(failures, 'RESOURCE_PATH', `${path}.path`, `resources/<序号>-${resource.sha256}`, resource.path);
    }
  });
  verifyAssets(map, resources.filter(isRecord), files, failures);
  // 引用必须落在 mapping.assets 的行上：导入只为资产行入库，原件字节可以只在 ZIP 里。
  const assetRowIds = new Set(list(map, 'assets').flatMap((value) => (isRecord(value) && typeof value.id === 'string' ? [value.id] : [])));
  const requireAsset = (id: unknown, path: string) => {
    if (typeof id !== 'string' || !id) return;
    if (!assetRowIds.has(id)) fail(failures, 'REFERENCE', path, `asset ${id}`, 'missing');
  };
  list(map, 'cards').forEach((card, index) => {
    if (!isRecord(card)) return;
    const body = isRecord(card.body) ? card.body : undefined;
    if (body) {
      if (Array.isArray(body.requiredAssetIds))
        body.requiredAssetIds.forEach((id, order) => requireAsset(id, `mapping.cards[${index}].body.requiredAssetIds[${order}]`));
      if (Array.isArray(body.blocks))
        body.blocks.forEach((block, order) => {
          if (isRecord(block) && block.type === 'image') requireAsset(block.assetId, `mapping.cards[${index}].body.blocks[${order}].assetId`);
        });
    }
    if (isRecord(card.attachments) && Array.isArray(card.attachments.items))
      card.attachments.items.forEach((item, order) => {
        if (isRecord(item)) requireAsset(item.assetId, `mapping.cards[${index}].attachments.items[${order}].assetId`);
      });
  });
  list(map, 'images').forEach((image, index) => {
    if (isRecord(image) && isRecord(image.content)) requireAsset(image.content.assetId, `mapping.images[${index}].content.assetId`);
  });
  const kindIds: Record<string, Set<string>> = { item: itemIds, frame: frameIds, group: groupItemIds };
  list(map, 'connectors').forEach((value, index) => {
    if (!isRecord(value)) return;
    for (const end of ['start', 'end'] as const) {
      const endpoint = isRecord(value[end]) ? value[end] as Record<string, unknown> : undefined;
      if (endpoint?.kind !== 'bound') continue;
      const kind = typeof endpoint.targetKind === 'string' ? endpoint.targetKind : 'item';
      const ids = kindIds[kind] ?? new Set<string>();
      if (typeof endpoint.itemId !== 'string' || !ids.has(endpoint.itemId))
        fail(failures, 'REFERENCE', `mapping.connectors[${index}].${end}.itemId`, `known ${kind} endpoint`, endpoint.itemId);
    }
  });
  list(map, 'containment').forEach((row, index) => {
    if (!isRecord(row)) return;
    if (typeof row.id === 'string' && !endpointIds.has(row.id)) fail(failures, 'REFERENCE', `mapping.containment[${index}].id`, 'known member', row.id);
    if (!isRecord(row.parent)) return;
    const parent = row.parent;
    const ids = parent.kind === 'frame' ? frameIds : parent.kind === 'group' ? groupItemIds : new Set<string>();
    if (typeof parent.id !== 'string' || !ids.has(parent.id)) fail(failures, 'REFERENCE', `mapping.containment[${index}].parent.id`, parent.kind, parent.id);
  });
  // 归属只能沿容器向外收敛：循环归属能入库，但随后调整分区会在祖先遍历里绕不出去。
  // 这里只约束容器归属，普通连线的几何闭环仍由用户定义（D416、D403）。
  // 分区/组合编号与 item 编号同串时按普通 item 处理（ADR 0032），不当作容器边。
  const isContainerMember = (id: string) => !itemIds.has(id) && (frameIds.has(id) || groupItemIds.has(id));
  const parentOf = new Map<string, string>();
  for (const row of list(map, 'containment'))
    if (isRecord(row) && typeof row.id === 'string' && isRecord(row.parent) && typeof row.parent.id === 'string' && isContainerMember(row.id))
      parentOf.set(row.id, row.parent.id);
  const reportedCycles = new Set<string>();
  for (const start of parentOf.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let id: string | undefined = start;
    while (id && isContainerMember(id)) {
      if (seen.has(id)) {
        // 只按环本身的节点去重：同一环从不同尾巴进入时只报一次。
        const cycle = path.slice(path.indexOf(id));
        const key = cycle.sort().join('\u0000');
        if (!reportedCycles.has(key))
          fail(failures, 'CONTAINMENT_CYCLE', 'mapping.containment', `acyclic chain from ${start}`, [...path, id].join(' → '));
        reportedCycles.add(key);
        break;
      }
      seen.add(id);
      path.push(id);
      id = parentOf.get(id);
    }
  }
  list(map, 'attachments').forEach((attachment, index) => {
    if (!isRecord(attachment)) return;
    if (typeof attachment.id === 'string' && !itemIds.has(attachment.id)) fail(failures, 'REFERENCE', `mapping.attachments[${index}].id`, 'known item', attachment.id);
    const target = isRecord(attachment.target) ? attachment.target : undefined;
    if (target && typeof target.itemId === 'string' && !itemIds.has(target.itemId))
      fail(failures, 'REFERENCE', `mapping.attachments[${index}].target.itemId`, 'known item', target.itemId);
  });
  const membership = isRecord(map.membership) ? map.membership : {};
  for (const name of ['frames', 'groups'] as const) {
    const set = Array.isArray(membership[name]) ? membership[name] as unknown[] : [];
    set.forEach((entry, index) => {
      if (!isRecord(entry) || !Array.isArray(entry.memberItemIds)) return;
      entry.memberItemIds.forEach((id, member) => {
        if (typeof id !== 'string' || !endpointIds.has(id)) fail(failures, 'REFERENCE', `mapping.membership.${name}[${index}].memberItemIds[${member}]`, 'known member', id);
      });
    });
  }
  list(map, 'cards').forEach((card, index) => {
    if (!isRecord(card) || !isRecord(card.cardTags)) return;
    const ids = card.cardTags.tagIds;
    if (!Array.isArray(ids)) return;
    ids.forEach((id, order) => {
      if (typeof id !== 'string' || !tagIds.has(id)) fail(failures, 'TAG_REFERENCE', `mapping.cards[${index}].cardTags.tagIds[${order}]`, 'known tag', id);
    });
  });

  if (manifest.research !== null) {
    const research = manifest.research;
    if (!isRecord(research)) fail(failures, 'RESEARCH_SHAPE', 'research', 'object or null', research);
    else {
      if (research.format !== 'forkwise-project' || research.schemaVersion !== 1)
        fail(failures, 'RESEARCH_SHAPE', 'research.schemaVersion', 'forkwise-project schemaVersion 1', `${String(research.format)} ${String(research.schemaVersion)}`);
      const researchProject = research.project;
      if (!isRecord(researchProject) || typeof researchProject.id !== 'string') fail(failures, 'RESEARCH_SHAPE', 'research.project.id', projectId, isRecord(researchProject) ? researchProject.id : researchProject);
      else if (researchProject.id !== projectId) fail(failures, 'CROSS_PROJECT', 'research.project.id', projectId, researchProject.id);
      if (research.files !== undefined && !Array.isArray(research.files)) fail(failures, 'RESEARCH_SHAPE', 'research.files', 'array', research.files);
      const fileIds = new Set<string>();
      (Array.isArray(research.files) ? research.files : []).forEach((file, index) => {
        if (!isRecord(file)) return fail(failures, 'RESEARCH_SHAPE', `research.files[${index}]`, 'object', file);
        requireString(failures, `research.files[${index}].id`, file.id);
        if (typeof file.id === 'string') {
          if (fileIds.has(file.id)) fail(failures, 'DUPLICATE_ID', `research.files[${index}].id`, 'unique', file.id);
          fileIds.add(file.id);
        }
        if (typeof file.base64 !== 'string' || !file.base64) {
          if (typeof file.omission !== 'string' || !file.omission)
            fail(failures, 'RESEARCH_SHAPE', `research.files[${index}].base64`, 'base64 or omission', file.base64);
          return;
        }
        const id = `research:${String(file.id)}`;
        const resource = resources.find((item) => isRecord(item) && item.id === id) as Record<string, unknown> | undefined;
        if (!resource) fail(failures, 'REFERENCE', `research.files[${index}]`, `resource ${id}`, 'missing');
        else {
          if (typeof file.hash === 'string' && file.hash !== resource.sha256)
            fail(failures, 'RESOURCE_HASH', `research.files[${index}].hash`, file.hash, resource.sha256);
          if (typeof resource.sha256 === 'string') {
            const actual = createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex');
            if (actual !== resource.sha256) fail(failures, 'RESOURCE_HASH', `research.files[${index}].base64`, resource.sha256, actual);
          }
        }
      });
    }
  }
  scanSecrets(manifest, '$', failures);
  list(map, 'changes').forEach((change, index) => {
    if (!isRecord(change) || !isRecord(change.receipt)) return;
    if (typeof change.receipt.projectId === 'string' && change.receipt.projectId !== projectId)
      fail(failures, 'CROSS_PROJECT', `mapping.changes[${index}].receipt.projectId`, projectId, change.receipt.projectId);
  });
  // 旧历史只作为不可执行的归档随包保留；这里只核对形状，不校验旧动作是否可重放。
  if (map.history !== undefined && map.history !== null && !isRecord(map.history))
    fail(failures, 'HISTORY_FIELD', 'mapping.history', 'object or null', map.history);
  if (map.changes !== undefined && map.changes !== null && !Array.isArray(map.changes))
    fail(failures, 'CHANGES_FIELD', 'mapping.changes', 'array or null', map.changes);
  if (map.archive !== undefined && map.archive !== null) {
    const archive = map.archive;
    if (!isRecord(archive) || !isRecord(archive.history) || !Array.isArray(archive.changes))
      fail(failures, 'ARCHIVE_FIELD', 'mapping.archive', '{ history, changes }', archive);
  }
  if (map.editTimes !== undefined) {
    if (!Array.isArray(map.editTimes)) fail(failures, 'EDIT_TIMES', 'mapping.editTimes', 'array', map.editTimes);
    else
      map.editTimes.forEach((value, index) => {
        const path = `mapping.editTimes[${index}]`;
        if (!isRecord(value)) return fail(failures, 'EDIT_TIMES', path, 'object', value);
        requireString(failures, `${path}.cardId`, value.cardId);
        requireString(failures, `${path}.editedAt`, value.editedAt);
        if (typeof value.editedAt === 'string' && Number.isNaN(Date.parse(value.editedAt)))
          fail(failures, 'EDIT_TIMES', `${path}.editedAt`, 'ISO date', value.editedAt);
      });
  }
  return failures;
}

export function inspectPackage(archive: Buffer): PackageInspection {
  let files: Map<string, Buffer>;
  try {
    files = readZip(archive);
  } catch (error) {
    return { ok: false, failures: [{ code: 'FORMAT', path: 'package', expected: 'zip', actual: error instanceof Error ? error.message : 'unreadable' }] };
  }
  const manifestBytes = files.get('forkwise-project.json');
  if (!manifestBytes) return { ok: false, failures: [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'manifest', actual: 'missing' }] };
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { ok: false, failures: [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'json', actual: 'invalid' }] };
  }
  if (!isRecord(manifest)) return { ok: false, failures: [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'object', actual: typeof manifest }] };
  const failures: PackageFailure[] = [];
  try {
    verifyManifest(manifest, files, failures);
  } catch (error) {
    fail(failures, 'MALFORMED', 'package', 'verifiable manifest', error instanceof Error ? error.message : 'unknown');
  }
  return { ok: true, manifest, files, failures };
}

export function verifyPackage(archive: Buffer): PackageFailure[] {
  return inspectPackage(archive).failures;
}
