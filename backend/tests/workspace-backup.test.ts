import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { Card, Project, ProjectHistory, Receipt } from '../src/mapping/contracts.js';
import { openMapping } from '../src/mapping/storage.js';
import { readZip, writeZip } from '../src/mapping/zip-store.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const ageDirectory = process.env.FORKWISE_TEST_AGE_DIR;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const backupEndpoint = '/workspace/backup';
const mappingEndpoint = '/mapping/projects/p';

type Workspace = Awaited<ReturnType<typeof launch>>;

async function json<T>(response: Response, status = 200): Promise<T> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}

async function execute(workspace: Workspace, command: Record<string, unknown>, token = workspace.token) {
  return json<Receipt>(await workspace.request('/mapping/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', expected: null, ...command }),
  }));
}

async function project(workspace: Workspace) {
  return json<{ project: Project; cards: Card[] }>(await workspace.request(mappingEndpoint));
}

function makeKey(root: string, name: string) {
  const ageKeygen = join(ageDirectory!, 'age-keygen');
  const identity = join(root, name);
  execFileSync(ageKeygen, ['-o', identity], { env: {}, stdio: 'pipe' });
  const recipient = execFileSync(ageKeygen, ['-y', identity], { env: {}, encoding: 'utf8' }).trim();
  return { PATH: ageDirectory, FORKWISE_BACKUP_RECIPIENT: recipient, FORKWISE_BACKUP_IDENTITY: identity };
}

function restore(workspace: Workspace, bytes: Buffer) {
  return workspace.request(backupEndpoint + '/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
  });
}

async function launch(directory: string, settings: NodeJS.ProcessEnv = {}, preload?: string) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const interpreterOptions = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const child = spawn(process.execPath, [...interpreterOptions, 'dist/src/workspace-server.js'], {
    cwd,
    env: {
      PATH: process.env.PATH,
      FORKWISE_DATA_DIR: directory,
      FORKWISE_PORT: String(port),
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`工作台启动超时 ${stderr}`)), 5000);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`工作台提前退出 ${code}/${signal} ${stderr}`));
      });
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('见岔开放工作台')) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const { url } = JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8'));
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
    const request = (path: string, options: RequestInit = {}) => {
      const headers = new Headers({ Origin: origin, Authorization: `Bearer ${token}` });
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
      return fetch(origin + '/api' + path, { ...options, headers });
    };
    return { child, directory, origin, token, request };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) await stop(child);
    throw error;
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  expect([child.exitCode, child.signalCode]).toEqual([0, null]);
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

it('正式启动无需模型和 age，工作台给出版本和备份配置说明', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forkwise-workspace-backup-'));
  try {
    const workspace = await launch(join(root, 'source'), { PATH: root });
    try {
      const response = await workspace.request('/workspace/backup');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        version: expect.stringMatching(/^\d+\.\d+\.\d+ \([a-f0-9]{12}\)$/),
        backupBlockedReason: expect.stringContaining('age'),
        restoreBlockedReason: expect.stringContaining('age'),
      });
      expect((await workspace.request('/mapping/projects')).status).toBe(200);
      await execute(workspace, { type: 'project.create', commandId: 'create-project', payload: { name: '无需模型的研究' } });
      await execute(workspace, { type: 'thought.create', commandId: 'create-card', payload: { id: 'card', title: '可用画布', text: '', x: 10, y: 20 } });
      expect((await project(workspace)).cards[0]?.title).toBe('可用画布');
    } finally {
      await stop(workspace.child);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(!ageDirectory)('WAL 在线下载真密文、保留原件与完整历史，隔离恢复后通过正式启动重新打开', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forkwise-workspace-roundtrip-'));
  const children: ChildProcess[] = [];
  try {
    const settings = makeKey(root, 'synthetic-key');
    const other = makeKey(root, 'other-synthetic-key');
    const legacy = join(root, 'research.sqlite');
    writeFileSync(legacy, '独立的合成旧研究原件', { mode: 0o600 });
    const source = await launch(join(root, 'source'), { ...settings, OPENAI_API_KEY: 'sk-synthetic-backup-test' });
    children.push(source.child);
    const ready = await json<{ version: string }>(await source.request(backupEndpoint));
    expect(ready).toMatchObject({ backupBlockedReason: null, restoreBlockedReason: null });

    await execute(source, { type: 'project.create', commandId: 'create-project', payload: { name: '合成工作台' } });
    const createCard = { type: 'thought.create', commandId: 'create-card', payload: { id: 'card', title: '备份前原件', text: '已保存正文', x: 10, y: 20 } };
    const originalReceipt = await execute(source, createCard);
    const attachmentBytes = Buffer.from('可下载的合成附件原件');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>');
    await execute(source, { type: 'asset.save', commandId: 'save-attachment', payload: {
      id: 'attachment', name: '原件.txt', mime: 'text/plain', base64: attachmentBytes.toString('base64'), kind: 'file',
    } });
    await execute(source, { type: 'asset.save', commandId: 'save-image', payload: {
      id: 'image', name: '原图.svg', mime: 'image/svg+xml', base64: svg.toString('base64'),
    } });
    await execute(source, { type: 'card.attachment.add', commandId: 'link-attachment', expected: { attachments: null },
      payload: { id: 'card', assetId: 'attachment', name: '原件.txt' } });
    await execute(source, { type: 'tag.create', commandId: 'create-tag', payload: { id: 'tag', name: '保留标签' } });
    const card = (await project(source)).cards[0]!;
    const bodyImage = { id: 'body-image', type: 'image', assetId: 'image', name: '原图.svg', mime: 'image/svg+xml', naturalWidth: 20, naturalHeight: 10 };
    await execute(source, { type: 'body.edit', commandId: 'save-image-block', expected: card.body.versionId,
      payload: { id: card.id, requiredAssetIds: ['image'], blocks: [...card.body.blocks, bodyImage] } });
    const deepUnknown: unknown = JSON.parse(`${'['.repeat(1100)}"深层未知原文"${']'.repeat(1100)}`);
    const unknown = { id: 'future', type: 'vendor-private-block', tokenHash: 'ordinary design token text', runToken: 'ordinary design runToken text',
      nested: { session: 'name in user text', assetId: 'opaque-custom-resource', original: deepUnknown } };
    const dbFile = join(source.directory, 'workspace.sqlite');
    const writer = new Database(dbFile);
    try {
      const current = (await project(source)).cards[0]!;
      current.body = { ...current.body, versionId: 'body-with-unknown', blocks: [...current.body.blocks, unknown] };
      writer.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(current), current.id);
      writer.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)')
        .run('p', 'body', current.body.id, current.body.versionId, JSON.stringify(current.body));
    } finally {
      writer.close();
    }

    const mapping = openMapping(source.directory);
    const originalBytes = Buffer.from('合成的旧研究原件');
    const wrappedBase64 = (bytes: Buffer) => bytes.toString('base64').match(/.{1,8}/g)!.join('\n');
    const restrictedBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
    const blankCanvas = { canvas: { annotations: { files: {}, elements: [] } } };
    let agent: string;
    let scopedHuman: string;
    let archivedPackage: Buffer;
    try {
      agent = mapping.access.issue('agent', ['p'], 60_000, 'test-only-agent-token', ['p'], [
        { projectId: 'p', operations: ['pose.move'], objectKinds: ['card'], objectIds: ['card'], fields: ['x', 'y'] },
      ]);
      scopedHuman = mapping.access.issue('human', ['p']);
      archivedPackage = mapping.fullPackage('p', mapping.access.authenticate(source.token), '2026-11-22T00:00:00.000Z', {
        format: 'forkwise-project', schemaVersion: 1, project: { id: 'p', name: '合成旧研究' },
        objects: [
          { id: 'source-restricted', kind: 'source', data: { rights: 'restricted' } },
          { id: 'text-restricted', kind: 'source_version', data: { sourceId: 'source-restricted' } },
        ],
        materials: [{ id: 'text-restricted', text: null, omission: '来源权利限制，仅导出索引' }],
        versions: [{ snapshot: { data: { citation: { sourceVersionId: 'text-restricted', quote: '', unavailableReason: 'rights' } } } }],
        tasks: [{ id: 'old-task', type: 'extract', state: 'failed', runToken: 'synthetic-legacy-runtime-token', error: '已归档任务原文' }],
        layout: { data: blankCanvas },
        actionHistory: { entries: [{ layout: { before: blankCanvas, after: blankCanvas } }] },
        files: [
          { id: 'old-file', name: '旧原件.txt', mime: 'text/plain', hash: sha(originalBytes), base64: wrappedBase64(originalBytes) },
          { id: 'restricted-file', sourceId: 'source-restricted', name: '受限文件.txt', mime: 'text/plain',
            hash: sha(restrictedBytes), base64: null, omission: '来源权利限制，仅导出索引' },
        ],
      });
    } finally {
      mapping.close();
    }
    const entries = readZip(archivedPackage);
    const legacyManifest = JSON.parse(entries.get('forkwise-project.json')!.toString()) as {
      resources: { id: string; path: string }[];
      mapping: { assets: { id: string; base64: string }[] };
    };
    const inlineAsset = legacyManifest.resources.find(resource => resource.id === 'attachment')!;
    legacyManifest.resources = legacyManifest.resources.filter(resource => resource !== inlineAsset);
    entries.delete(inlineAsset.path);
    legacyManifest.mapping.assets.find(asset => asset.id === 'attachment')!.base64 = wrappedBase64(attachmentBytes);
    entries.set('forkwise-project.json', Buffer.from(JSON.stringify(legacyManifest)));
    archivedPackage = writeZip([...entries].map(([name, data]) => ({ name, data })));
    await execute(source, { projectId: 'old', type: 'project.import', commandId: 'import-old',
      payload: { name: '旧研究归档', base64: archivedPackage.toString('base64') } });
    const pose = (await project(source)).cards[0]!.item.versionId;
    const agentReceipt = await execute(source, { type: 'pose.move', commandId: 'agent-move', expected: pose,
      payload: { id: 'card', x: 200, y: 300 } }, agent);
    await execute(source, { type: 'history.undo', commandId: 'undo-agent-move', expected: agentReceipt.revision, payload: {} });
    const stateBefore = await project(source);
    const historyBefore = await json<ProjectHistory>(await source.request(mappingEndpoint + '/history'));
    expect(historyBefore.redo.at(-1)).toMatchObject({ id: 'agent-move', actor: { type: 'agent' } });
    await execute(source, { projectId: 'past-media', type: 'project.create', commandId: 'historical-project', payload: { name: '重做可以找回原图' } });
    const pasted = await execute(source, { projectId: 'past-media', type: 'canvas.paste', commandId: 'paste-history', payload: {
      translation: { x: 10, y: 20 },
      library: { tags: [], assets: [{ id: 'image', name: '原图.svg', mime: 'image/svg+xml', base64: svg.toString('base64') }] },
      objects: [{ kind: 'card', copyId: 'historical-card', stack: 0, title: '历史原件',
        blocks: [bodyImage], tagIds: [], appearance: null, pose: stateBefore.cards[0]!.item.pose }],
      connectors: [],
    } });
    const historicalContent = '/mapping/projects/past-media';
    const historical = await json<{ cards: Card[] }>(await source.request(historicalContent));
    const historicAssetId = String(historical.cards[0]?.body.blocks[0]?.assetId);
    const historicalAsset = historicalContent + `/assets/${historicAssetId}/content`;
    const undonePaste = await execute(source, { projectId: 'past-media', type: 'history.undo', commandId: 'undo-paste-history', expected: pasted.revision, payload: {} });
    expect((await source.request(historicalAsset)).status).toBe(404);
    const newProject = await execute(source, { projectId: 'wal-latest', type: 'project.create', commandId: 'wal-latest', payload: { name: '备份读取最后一次 WAL 写入' } });
    expect(statSync(dbFile + '-wal').size).toBeGreaterThan(32);
    const filesBefore = Object.fromEntries([dbFile, dbFile + '-wal', join(source.directory, 'local-access.json'), legacy]
      .map(path => [path, [statSync(path).mode, sha(readFileSync(path))]]));

    for (const [headers, status] of [
      [{ Authorization: '' }, 401],
      [{ Authorization: `Bearer ${agent}` }, 403],
      [{ Authorization: `Bearer ${scopedHuman}` }, 403],
      [{ Origin: 'http://127.0.0.1:1029' }, 403],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
    ] as const) {
      expect((await source.request(backupEndpoint + '/download', { method: 'POST', headers })).status).toBe(status);
      expect((await source.request(backupEndpoint + '/restore', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: 'blocked' })).status).toBe(status);
    }
    // Node fetch rewrites Host to the target authority. Use HTTP directly
    // so the rejected host actually reaches the loopback server.
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(source.origin + '/api' + backupEndpoint + '/download', {
        method: 'POST', headers: { Host: 'untrusted.example', Origin: source.origin, Authorization: `Bearer ${source.token}` },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(foreignHostStatus).toBe(403);

    const response = await source.request(backupEndpoint + '/download', { method: 'POST' });
    expect(response.status, response.ok ? '' : await response.clone().text()).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment; filename="forkwise-workspace-.*\.tar\.age"$/);
    const encrypted = Buffer.from(await response.arrayBuffer());
    expect(encrypted.length).toBe(Number(response.headers.get('Content-Length')));
    expect(encrypted.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(encrypted.includes('SQLite format 3')).toBe(false);
    const sandbox = join(root, 'inspect-encrypted');
    mkdirSync(sandbox, { mode: 0o700 });
    const tar = join(sandbox, 'package.tar');
    const age = join(ageDirectory!, 'age');
    execFileSync(age, ['-d', '-i', settings.FORKWISE_BACKUP_IDENTITY, '-o', tar], { env: {}, input: encrypted });
    const list = execFileSync('/usr/bin/tar', ['-tf', tar], { encoding: 'utf8' });
    expect(list.trim().split('\n')).toEqual(['manifest.json', 'workspace.sqlite']);
    execFileSync('/usr/bin/tar', ['-xf', tar, '-C', sandbox]);
    const manifest = JSON.parse(readFileSync(join(sandbox, 'manifest.json'), 'utf8'));
    const snapshotFile = join(sandbox, 'workspace.sqlite');
    const plaintext = readFileSync(snapshotFile);
    expect(manifest).toMatchObject({ version: 1, sourceVersion: ready.version, database: { sha256: sha(plaintext), bytes: plaintext.length } });
    expect(plaintext.includes(sha(source.token))).toBe(false);
    expect(plaintext.includes(sha(agent))).toBe(false);
    expect(plaintext.includes('sk-synthetic-backup-test')).toBe(false);
    expect(plaintext.includes('synthetic-legacy-runtime-token')).toBe(false);
    expect(plaintext.includes('ordinary design token text')).toBe(true);
    expect(plaintext.includes('ordinary design runToken text')).toBe(true);
    const snapshot = new Database(snapshotFile, { readonly: true });
    try {
      expect(snapshot.prepare('SELECT * FROM sessions').all()).toEqual([]);
      expect(snapshot.pragma('freelist_count', { simple: true })).toBe(0);
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete');
      const saved = snapshot.prepare("SELECT actor_id AS actor,receipt FROM mapping_receipts WHERE command_id='agent-move'").get() as { actor: string; receipt: string };
      expect(saved.actor).toBe(historyBefore.redo.at(-1)?.actor.id);
      expect(JSON.parse(saved.receipt)).toEqual(agentReceipt);
      const row = snapshot.prepare("SELECT value FROM mapping_history WHERE project_id='p'").get() as { value: string };
      expect(JSON.parse(row.value).redo.at(-1).session).toBe('');
    } finally {
      snapshot.close();
    }

    const wrongKey = await launch(join(root, 'wrong-key'), other);
    children.push(wrongKey.child);
    expect(await json(await restore(wrongKey, encrypted), 422)).toMatchObject({ code: 'BACKUP_WRONG_KEY' });
    expect(await json(await restore(source, encrypted.subarray(0, encrypted.length - 17)), 422)).toMatchObject({ code: 'BACKUP_CIPHERTEXT' });
    const forge = (...entries: string[]) => {
      const path = join(sandbox, 'changed.tar');
      execFileSync('/usr/bin/tar', ['--format', 'ustar', '-cf', path, '-C', sandbox, ...entries]);
      return execFileSync(age, ['-r', settings.FORKWISE_BACKUP_RECIPIENT, path], { env: {} });
    };
    writeFileSync(join(sandbox, 'unexpected.txt'), 'extra tar entry');
    expect(await json(await restore(source, forge('manifest.json', 'workspace.sqlite', 'unexpected.txt')), 422))
      .toMatchObject({ code: 'BACKUP_TAR' });
    const changed = Buffer.from(plaintext);
    changed[changed.length - 1]! ^= 1;
    writeFileSync(snapshotFile, changed);
    expect(await json(await restore(source, forge('manifest.json', 'workspace.sqlite')), 422)).toMatchObject({ code: 'BACKUP_HASH' });
    function forgeDatabase(sql: string) {
      writeFileSync(snapshotFile, plaintext);
      const altered = new Database(snapshotFile);
      try {
        altered.exec(sql);
      } finally {
        altered.close();
      }
      const bytes = readFileSync(snapshotFile);
      writeFileSync(join(sandbox, 'manifest.json'), JSON.stringify({
        ...manifest, database: { bytes: bytes.length, sha256: sha(bytes) },
      }));
      return forge('manifest.json', 'workspace.sqlite');
    }
    for (const [sql, code] of [
      ["DELETE FROM mapping_assets WHERE project_id='p' AND id='attachment'", 'BACKUP_ASSET_MISSING'],
      ["UPDATE mapping_import_archive SET research=json_set(research,'$.tasks[0].runToken','forged-legacy-token') WHERE project_id='old'", 'BACKUP_SESSIONS'],
      ["UPDATE mapping_import_archive SET research=json_set(research,'$.versions[0].snapshot.data.citation.quote','未省略的受限原句') WHERE project_id='old'", 'BACKUP_RESTRICTED_RESEARCH'],
      ["UPDATE mapping_tags SET value='invalid-json' WHERE project_id='p' AND id='tag'", 'BACKUP_DATABASE_INTEGRITY'],
      ["UPDATE mapping_tags SET value='null' WHERE project_id='p' AND id='tag'", 'BACKUP_DATABASE_INTEGRITY'],
      ["DELETE FROM mapping_card_ids WHERE project_id='p' AND id='card'", 'BACKUP_DATABASE_INTEGRITY'],
      ["UPDATE mapping_card_ids SET project_id='old' WHERE project_id='p' AND id='card'", 'BACKUP_DATABASE_INTEGRITY'],
    ] as const) {
      expect(await json(await restore(source, forgeDatabase(sql)), 422)).toMatchObject({ code });
    }
    for (const field of ['$.layout.data', '$.actionHistory.entries[0].layout.before', '$.actionHistory.entries[0].layout.after']) {
      const update = `UPDATE mapping_import_archive
        SET research=json_set(research,'${field}.canvas.annotations.files.restricted',
          json_object('dataURL','data:image/png;base64,${restrictedBytes.toString('base64')}'))
        WHERE project_id='old'`;
      expect(await json(await restore(source, forgeDatabase(update)), 422)).toMatchObject({ code: 'BACKUP_RESTRICTED_RESEARCH' });
    }
    expect(readdirSync(root).filter(name => name.startsWith('forkwise-restored-') || name.startsWith('.forkwise-'))).toEqual([]);

    const restrictedParent = join(root, 'read-only-parent');
    mkdirSync(restrictedParent, { mode: 0o700 });
    const insideReadOnlyParent = await launch(join(restrictedParent, 'source'), settings);
    children.push(insideReadOnlyParent.child);
    chmodSync(restrictedParent, 0o500);
    try {
      expect(await json(await insideReadOnlyParent.request(backupEndpoint + '/download', { method: 'POST' }), 503)).toMatchObject({
        code: 'BACKUP_STAGING', message: expect.stringContaining('备份临时目录'),
      });
      expect(await json(await restore(insideReadOnlyParent, encrypted), 503)).toMatchObject({
        code: 'BACKUP_STAGING', message: expect.stringContaining('恢复临时目录'),
      });
    } finally {
      chmodSync(restrictedParent, 0o700);
    }
    const diskFull = await launch(join(root, 'restore-disk-full'), settings, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { Writable } from 'node:stream';
      const createWriteStream = fs.createWriteStream;
      fs.createWriteStream = (path, options) => {
        if (typeof path === 'string' && path.includes('/.forkwise-restore-') && path.endsWith('/workspace.sqlite'))
          return new Writable({
            write(_chunk, _encoding, done) { done(Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' })); },
          });
        return createWriteStream(path, options);
      };
      syncBuiltinESMExports();
    `);
    children.push(diskFull.child);
    expect(await json(await restore(diskFull, encrypted), 503)).toMatchObject({
      code: 'BACKUP_RESTORE_STAGING', message: expect.stringContaining('磁盘空间'),
    });
    expect(readdirSync(root).filter(name => name.startsWith('forkwise-restored-') || name.startsWith('.forkwise-'))).toEqual([]);

    const collision = join(root, `forkwise-restored-${manifest.backupId}`);
    mkdirSync(collision, { mode: 0o700 });
    expect(await json(await restore(source, encrypted), 409)).toMatchObject({ code: 'BACKUP_TARGET_EXISTS' });
    expect(readdirSync(collision)).toEqual([]);
    rmdirSync(collision);
    const restored = await json<{ directory: string; sourceVersion: string }>(await restore(source, encrypted), 201);
    expect(restored.sourceVersion).toBe(ready.version);
    expect(readdirSync(restored.directory)).toEqual(['workspace.sqlite']);
    expect(statSync(restored.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(restored.directory, 'workspace.sqlite')).mode & 0o777).toBe(0o600);
    expect(await json(await restore(source, encrypted), 409)).toMatchObject({ code: 'BACKUP_TARGET_EXISTS' });
    expect(sha(readFileSync(join(restored.directory, 'workspace.sqlite')))).toBe(manifest.database.sha256);
    expect(Object.fromEntries(Object.keys(filesBefore).map(path => [path, [statSync(path).mode, sha(readFileSync(path))]]))).toEqual(filesBefore);
    expect(readdirSync(root).filter(name => name.startsWith('.forkwise-'))).toEqual([]);

    const reopened = await launch(restored.directory, { PATH: root });
    children.push(reopened.child);
    expect(reopened.token).not.toBe(source.token);
    expect((await reopened.request('/mapping/projects', { headers: { Authorization: `Bearer ${source.token}` } })).status).toBe(401);
    expect((await reopened.request('/mapping/projects', { headers: { Authorization: `Bearer ${agent}` } })).status).toBe(401);
    expect((await json<Project[]>(await reopened.request('/mapping/projects'))).find(value => value.id === 'wal-latest')?.revision).toBe(newProject.revision);
    expect(JSON.stringify(await project(reopened))).toBe(JSON.stringify(stateBefore));
    expect(await json(await reopened.request(mappingEndpoint + '/history'))).toEqual(historyBefore);
    expect(await execute(reopened, createCard)).toEqual(originalReceipt);
    expect((await reopened.request(historicalAsset)).status).toBe(404);
    await execute(reopened, { projectId: 'past-media', type: 'history.redo', commandId: 'restore-historical-media', expected: undonePaste.revision, payload: {} });
    const historicalResponse = await reopened.request(historicalAsset);
    expect(historicalResponse.status).toBe(200);
    expect(sha(Buffer.from(await historicalResponse.arrayBuffer()))).toBe(sha(svg));
    const redo = await execute(reopened, { type: 'history.redo', commandId: 'restored-redo', expected: stateBefore.project.revision, payload: {} });
    expect((await project(reopened)).cards[0]?.item.pose).toMatchObject({ x: 200, y: 300 });
    await execute(reopened, { type: 'history.undo', commandId: 'restored-undo', expected: redo.revision, payload: {} });
    expect((await project(reopened)).cards[0]?.item.pose).toMatchObject({ x: 10, y: 20 });
    expect(JSON.stringify((await project(reopened)).cards[0]?.body.blocks.at(-1))).toBe(JSON.stringify(unknown));
    for (const [id, bytes] of [['attachment', attachmentBytes], ['image', svg]] as const) {
      const content = await reopened.request(mappingEndpoint + `/assets/${id}/content?disposition=attachment`);
      expect(content.status).toBe(200);
      expect(sha(Buffer.from(await content.arrayBuffer()))).toBe(sha(bytes));
    }
    const wholeProject = await reopened.request('/mapping/projects/old/export.package');
    expect(wholeProject.status).toBe(200);
    const imported = readZip(Buffer.from(await wholeProject.arrayBuffer()));
    const { research } = JSON.parse(imported.get('forkwise-project.json')!.toString());
    expect(research).toMatchObject({ project: { id: 'old', name: '合成旧研究' }, materials: [{ text: null, omission: '来源权利限制，仅导出索引' }],
      tasks: [{ id: 'old-task', runToken: null, error: '已归档任务原文' }],
      files: [{ base64: wrappedBase64(originalBytes) }, { base64: null, omission: '来源权利限制，仅导出索引' }] });
    const restoredInline = await json<{ base64: string }>(await reopened.request('/mapping/projects/old/assets/attachment'));
    expect(restoredInline.base64).toBe(wrappedBase64(attachmentBytes));
    expect(JSON.stringify(await project(source))).toBe(JSON.stringify(stateBefore));

    const damagedCopy = new Database(join(reopened.directory, 'workspace.sqlite'));
    try {
      damagedCopy.prepare("UPDATE mapping_assets SET value=json_set(value,'$.base64',?) WHERE project_id='p' AND id='attachment'")
        .run(Buffer.from('原件已损坏').toString('base64'));
      damagedCopy.prepare("DELETE FROM mapping_assets WHERE project_id='p' AND id='image'").run();
    } finally {
      damagedCopy.close();
    }
    expect(await json(await reopened.request(mappingEndpoint + '/assets/attachment/content'), 422)).toMatchObject({ code: 'ASSET_CORRUPT' });
    expect(await json(await reopened.request(mappingEndpoint + '/assets/image/content'), 404)).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('原件缺失') });
    expect((await reopened.request(mappingEndpoint + '/assets/attachment/content', { method: 'HEAD' })).status).toBe(422);
    expect((await reopened.request(mappingEndpoint + '/assets/image/content', { method: 'HEAD' })).status).toBe(404);
    await stop(reopened.child);
    await expect(fetch(reopened.origin)).rejects.toThrow();
  } finally {
    for (const child of children.reverse()) await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
