import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface Failure {
  code: string;
  path: string;
  expected: string;
  actual: string;
}

const SECRET_KEYS = new Set(['session', 'token', 'tokenHash', 'runToken', 'authorization', 'secret', 'password', 'cookie']);

function fail(failures: Failure[], code: string, path: string, expected: unknown, actual: unknown) {
  const clip = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  };
  failures.push({ code, path, expected: clip(expected), actual: clip(actual) });
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

function readZip(archive: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 22 - 65535); index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP 缺少目录');
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (archive.readUInt16LE(cursor + 10) !== 0) throw new Error(`ZIP 压缩方法不受支持: ${name}`);
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const size = archive.readUInt32LE(local + 22);
    files.set(name, Buffer.from(archive.subarray(dataStart, dataStart + size)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function stackOf(mapping: Record<string, unknown>) {
  const rows: { kind: string; id: string; createdOrder: number | null }[] = [];
  const take = (kind: string) => {
    const values = mapping[kind === 'card' ? 'cards' : `${kind}s`];
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const item = record.item;
      if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).id !== 'string') continue;
      const order = (item as Record<string, unknown>).createdOrder;
      rows.push({ kind, id: String(record.id), createdOrder: typeof order === 'number' ? order : null });
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
  const containment = Array.isArray(mapping.containment) ? mapping.containment : [];
  const members = (kind: string, id: string) =>
    containment
      .filter((row) => {
        if (!row || typeof row !== 'object') return false;
        const parent = (row as Record<string, unknown>).parent;
        return !!parent && typeof parent === 'object' && (parent as Record<string, unknown>).kind === kind && (parent as Record<string, unknown>).id === id;
      })
      .map((row) => String((row as Record<string, unknown>).id));
  const frames = Array.isArray(mapping.frames) ? mapping.frames : [];
  const groups = Array.isArray(mapping.groups) ? mapping.groups : [];
  return {
    frames: frames.map((frame) => ({ id: String((frame as Record<string, unknown>).id), memberItemIds: members('frame', String((frame as Record<string, unknown>).id)) })),
    groups: groups.map((group) => ({ id: String((group as Record<string, unknown>).id), memberItemIds: members('group', String((group as Record<string, unknown>).itemId)) })),
  };
}

function scanSecrets(value: unknown, path: string, failures: Failure[]) {
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

function scanProjectIds(value: unknown, path: string, projectId: string, failures: Failure[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanProjectIds(item, `${path}[${index}]`, projectId, failures));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key === 'projectId' && typeof child === 'string' && child !== projectId) fail(failures, 'CROSS_PROJECT', childPath, projectId, child);
    else if (key === 'id' && path.endsWith('.project') && typeof child === 'string' && child !== projectId) fail(failures, 'CROSS_PROJECT', childPath, projectId, child);
    else scanProjectIds(child, childPath, projectId, failures);
  }
}

function verifyManifest(manifest: Record<string, unknown>, files: Map<string, Buffer>): Failure[] {
  const failures: Failure[] = [];
  if (manifest.format !== 'forkwise-project') fail(failures, 'FORMAT', 'format', 'forkwise-project', manifest.format);
  if (manifest.schemaVersion !== 2) fail(failures, 'SCHEMA_VERSION', 'schemaVersion', 2, manifest.schemaVersion);
  if (typeof manifest.exportedAt !== 'string' || !manifest.exportedAt) fail(failures, 'EXPORTED_AT', 'exportedAt', 'non-empty string', manifest.exportedAt);
  if (typeof manifest.projectId !== 'string' || !manifest.projectId) fail(failures, 'PROJECT_ID', 'projectId', 'non-empty string', manifest.projectId);
  if (typeof manifest.revision !== 'number') fail(failures, 'REVISION', 'revision', 'number', manifest.revision);
  if (!manifest.extensions || typeof manifest.extensions !== 'object' || Array.isArray(manifest.extensions))
    fail(failures, 'EXTENSIONS', 'extensions', 'object', manifest.extensions);
  const projectId = typeof manifest.projectId === 'string' ? manifest.projectId : '';
  const mapping = manifest.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail(failures, 'REFERENCE', 'mapping', 'object', mapping);
    return failures;
  }
  const map = mapping as Record<string, unknown>;
  const project = map.project as Record<string, unknown> | undefined;
  if (!project || project.id !== projectId) fail(failures, 'PROJECT_ID', 'mapping.project.id', projectId, project?.id);
  if (project && project.revision !== manifest.revision) fail(failures, 'REVISION', 'mapping.project.revision', manifest.revision, project.revision);
  const names = ['cards', 'texts', 'shapes', 'strokes', 'images', 'connectors', 'frames', 'groups', 'containment', 'attachments', 'tags'] as const;
  const stored = map.stored as Record<string, { json: string }[]> | undefined;
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
        actual = JSON.parse(raw[index]!.json);
      } catch {
        fail(failures, 'STORED_MISMATCH', `mapping.stored.${name}[${index}]`, 'json', 'invalid');
        return;
      }
      if (!deepEqual(item, actual)) fail(failures, 'STORED_MISMATCH', `mapping.stored.${name}[${index}]`, item, actual);
    });
  }
  if (!deepEqual(map.membership, membershipOf(map))) fail(failures, 'MEMBERSHIP', 'mapping.membership', membershipOf(map), map.membership);
  if (!deepEqual(map.stack, stackOf(map))) fail(failures, 'STACK', 'mapping.stack', stackOf(map), map.stack);
  const versions = Array.isArray(map.versions) ? map.versions : [];
  const versionStored = stored?.versions;
  if (!Array.isArray(versionStored) || versionStored.length !== versions.length)
    fail(failures, 'STORED_MISMATCH', 'mapping.stored.versions', versions.length, Array.isArray(versionStored) ? versionStored.length : versionStored);
  else
    versions.forEach((version, index) => {
      const raw = versionStored[index]!;
      let actual: unknown;
      try {
        actual = JSON.parse(raw.json);
      } catch {
        fail(failures, 'STORED_MISMATCH', `mapping.stored.versions[${index}]`, 'json', 'invalid');
        return;
      }
      const record = version as Record<string, unknown>;
      if (record.domain !== raw.domain || record.id !== raw.id || record.versionId !== raw.versionId || !deepEqual(record.value, actual))
        fail(failures, 'STORED_MISMATCH', `mapping.stored.versions[${index}]`, version, { ...raw, value: actual });
    });

  const itemIds = new Set<string>();
  for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images'] as const) {
    for (const value of (map[name] as unknown[]) ?? []) {
      const item = value && typeof value === 'object' ? (value as Record<string, unknown>).item : undefined;
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') itemIds.add((item as Record<string, unknown>).id as string);
    }
  }
  const frameIds = new Set(((map.frames as { id?: string }[]) ?? []).map((frame) => frame.id).filter((id): id is string => !!id));
  const groupItemIds = new Set(((map.groups as { itemId?: string }[]) ?? []).map((group) => group.itemId).filter((id): id is string => !!id));
  const endpointIds = new Set([...itemIds, ...frameIds, ...groupItemIds]);
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const resourceIds = new Set<string>();
  resources.forEach((resource, index) => {
    const path = `resources[${index}]`;
    if (!resource || typeof resource !== 'object') {
      fail(failures, 'RESOURCE_FIELD', path, 'object', resource);
      return;
    }
    const record = resource as Record<string, unknown>;
    for (const field of ['id', 'mime', 'sha256', 'path'] as const)
      if (typeof record[field] !== 'string' || !record[field]) fail(failures, 'RESOURCE_FIELD', `${path}.${field}`, 'non-empty string', record[field]);
    if (typeof record.id === 'string') {
      if (resourceIds.has(record.id)) fail(failures, 'RESOURCE_FIELD', `${path}.id`, 'unique', record.id);
      resourceIds.add(record.id);
    }
    if (typeof record.sha256 === 'string' && !/^[a-f0-9]{64}$/.test(record.sha256))
      fail(failures, 'RESOURCE_HASH', `${path}.sha256`, '64 hex', record.sha256);
    if (typeof record.path !== 'string' || record.path.startsWith('/') || record.path.includes('\\') || record.path.split('/').includes('..'))
      fail(failures, 'RESOURCE_PATH', `${path}.path`, 'relative path', record.path);
    else if (!files.has(record.path)) fail(failures, 'RESOURCE_MISSING', record.path, 'file bytes', 'missing');
    else if (typeof record.sha256 === 'string') {
      const actual = createHash('sha256').update(files.get(record.path)!).digest('hex');
      if (actual !== record.sha256) fail(failures, 'RESOURCE_HASH', record.path, record.sha256, actual);
    }
  });
  const requireAsset = (id: unknown, path: string) => {
    if (typeof id !== 'string' || !id) return;
    if (!resourceIds.has(id)) fail(failures, 'REFERENCE', path, `resource ${id}`, 'missing');
  };
  const walkAssets = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walkAssets(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'assetId') requireAsset(child, `${path}.assetId`);
      else if (key !== 'stored' && key !== 'versions' && key !== 'history' && key !== 'changes') walkAssets(child, `${path}.${key}`);
    }
  };
  for (const name of ['cards', 'texts', 'shapes', 'strokes', 'images', 'attachments'] as const) walkAssets(map[name], `mapping.${name}`);
  ((map.connectors as Record<string, unknown>[]) ?? []).forEach((connector, index) => {
    for (const end of ['start', 'end'] as const) {
      const endpoint = connector?.[end] as Record<string, unknown> | undefined;
      if (endpoint?.kind === 'bound' && typeof endpoint.itemId === 'string' && !endpointIds.has(endpoint.itemId))
        fail(failures, 'REFERENCE', `mapping.connectors[${index}].${end}.itemId`, 'known endpoint', endpoint.itemId);
    }
  });
  ((map.containment as Record<string, unknown>[]) ?? []).forEach((row, index) => {
    if (typeof row?.id !== 'string' || !endpointIds.has(row.id))
      fail(failures, 'REFERENCE', `mapping.containment[${index}].id`, 'known member', row?.id);
    const parent = row?.parent as Record<string, unknown> | null | undefined;
    if (!parent) return;
    const ids = parent.kind === 'frame' ? frameIds : parent.kind === 'group' ? groupItemIds : new Set<string>();
    if (typeof parent.id !== 'string' || !ids.has(parent.id)) fail(failures, 'REFERENCE', `mapping.containment[${index}].parent.id`, parent.kind, parent.id);
  });
  ((map.attachments as Record<string, unknown>[]) ?? []).forEach((attachment, index) => {
    if (typeof attachment?.id === 'string' && !itemIds.has(attachment.id)) fail(failures, 'REFERENCE', `mapping.attachments[${index}].id`, 'known item', attachment.id);
    const target = attachment?.target as Record<string, unknown> | null | undefined;
    if (target && typeof target.itemId === 'string' && !itemIds.has(target.itemId))
      fail(failures, 'REFERENCE', `mapping.attachments[${index}].target.itemId`, 'known item', target.itemId);
  });
  ((map.membership as { frames?: { memberItemIds: string[] }[]; groups?: { memberItemIds: string[] }[] })?.frames ?? []).forEach((frame, index) => {
    frame.memberItemIds.forEach((id, member) => {
      if (!endpointIds.has(id)) fail(failures, 'REFERENCE', `mapping.membership.frames[${index}].memberItemIds[${member}]`, 'known member', id);
    });
  });
  ((map.membership as { groups?: { memberItemIds: string[] }[] })?.groups ?? []).forEach((group, index) => {
    group.memberItemIds.forEach((id, member) => {
      if (!endpointIds.has(id)) fail(failures, 'REFERENCE', `mapping.membership.groups[${index}].memberItemIds[${member}]`, 'known member', id);
    });
  });

  if (manifest.research !== null) {
    const research = manifest.research;
    if (!research || typeof research !== 'object' || Array.isArray(research)) fail(failures, 'RESEARCH_SHAPE', 'research', 'object or null', research);
    else {
      const archive = research as Record<string, unknown>;
      if (archive.format !== 'forkwise-project' || archive.schemaVersion !== 1)
        fail(failures, 'RESEARCH_SHAPE', 'research.schemaVersion', 'forkwise-project schemaVersion 1', `${String(archive.format)} ${String(archive.schemaVersion)}`);
      const researchProject = archive.project as Record<string, unknown> | undefined;
      if (!researchProject || typeof researchProject.id !== 'string') fail(failures, 'RESEARCH_SHAPE', 'research.project.id', projectId, researchProject?.id);
      else if (researchProject.id !== projectId) fail(failures, 'CROSS_PROJECT', 'research.project.id', projectId, researchProject.id);
      if (archive.files !== undefined && !Array.isArray(archive.files)) fail(failures, 'RESEARCH_SHAPE', 'research.files', 'array', archive.files);
      (Array.isArray(archive.files) ? archive.files : []).forEach((file, index) => {
        if (!file || typeof file !== 'object') return;
        const record = file as Record<string, unknown>;
        if (typeof record.base64 !== 'string' || !record.base64) return;
        const id = `research:${String(record.id)}`;
        const resource = resources.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
        if (!resource) fail(failures, 'REFERENCE', `research.files[${index}]`, `resource ${id}`, 'missing');
        else if (typeof record.hash === 'string' && record.hash !== resource.sha256)
          fail(failures, 'RESOURCE_HASH', `research.files[${index}].hash`, record.hash, resource.sha256);
      });
    }
  }
  scanSecrets(manifest, '$', failures);
  scanProjectIds(manifest.research, 'research', projectId, failures);
  scanProjectIds(map, 'mapping', projectId, failures);
  return failures;
}

function verify(archive: Buffer): Failure[] {
  let files: Map<string, Buffer>;
  try {
    files = readZip(archive);
  } catch (error) {
    return [{ code: 'FORMAT', path: 'package', expected: 'zip', actual: error instanceof Error ? error.message : 'unreadable' }];
  }
  const manifestBytes = files.get('forkwise-project.json');
  if (!manifestBytes) return [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'manifest', actual: 'missing' }];
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'json', actual: 'invalid' }];
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return [{ code: 'FORMAT', path: 'forkwise-project.json', expected: 'object', actual: typeof manifest }];
  return verifyManifest(manifest as Record<string, unknown>, files);
}

const packagePath = process.argv[2];
if (!packagePath) {
  console.log('USAGE path expected=package actual=missing');
  process.exit(2);
}
const failures = verify(readFileSync(packagePath));
for (const failure of failures) console.log(`${failure.code} ${failure.path} expected=${failure.expected} actual=${failure.actual}`);
process.exit(failures.length === 0 ? 0 : 1);
