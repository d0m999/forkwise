import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from './writing-board-fixture';
import { seedCanvasExportSample } from './canvas-export-fixture';
import { readZip, writeZip } from '../../backend/src/mapping/zip-store';
import Database from '../../backend/node_modules/better-sqlite3/lib/index.js';

const verifier = resolve('../scripts/verify-package.ts');

function verifyPackage(path: string) {
  try {
    const stdout = execFileSync('npx', ['--no-install', '--prefix', resolve('../backend'), 'tsx', verifier, path], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? '' };
  }
}

function fingerprint(directory: string, projectId: string) {
  const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const revision = (db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get(projectId) as { revision: number }).revision;
    const history = db.prepare('SELECT value FROM mapping_history WHERE project_id=?').get(projectId) as { value: string } | undefined;
    const stack = history ? JSON.parse(history.value) as { undo: unknown[]; redo: unknown[] } : { undo: [], redo: [] };
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const dump = names.map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()));
    return { revision, historyLength: stack.undo.length + stack.redo.length, dumpHash: createHash('sha256').update(dump.join('\n')).digest('hex'), historyJson: history?.value ?? '' };
  } finally {
    db.close();
  }
}

test('官方入口下载的完整项目包可离开数据目录验证，四种破坏会被定位拒绝', async ({ page, workspace }) => {
  await seedCanvasExportSample(page, workspace);
  let state = await workspace.state();
  const projectId = state.project.id;
  const execute = (command: Record<string, unknown>) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, ...command });
  const bottom = state.cards.find((card) => card.title === '底层研究卡')!;
  await execute({
    type: 'body.edit',
    expected: bottom.body.versionId,
    payload: {
      id: bottom.id,
      requiredAssetIds: ['export-image'],
      blocks: [
        ...bottom.body.blocks,
        { id: 'export-table', type: 'table', header: true, rows: [[{ text: '指标' }, { text: '值' }], [{ text: '收入' }, { text: '增长' }]] },
        { id: 'export-code', type: 'code', language: 'ts', wrap: false, text: 'const kept = true;' },
      ],
    },
  });
  await execute({ type: 'shape.create', expected: null, payload: { id: 'export-shape-a', content: { shapeType: 'rectangle', shortText: '分组甲' }, pose: { x: 980, y: 180, width: 140, height: 80 } } });
  await execute({ type: 'shape.create', expected: null, payload: { id: 'export-shape-b', content: { shapeType: 'rectangle', shortText: '分组乙' }, pose: { x: 980, y: 300, width: 140, height: 80 } } });
  state = await workspace.state();
  const members = state.shapes!.filter((shape) => shape.id === 'export-shape-a' || shape.id === 'export-shape-b').map((shape) => shape.item.id);
  await execute({ type: 'group.create', expected: { groups: { 'export-group': null }, containment: Object.fromEntries(members.map((id) => [id, null])) }, payload: { id: 'export-group', itemIds: members } });
  state = await workspace.state();
  const card = state.cards.find((item) => item.id === bottom.id)!;
  const unknown = { id: 'export-unknown', type: 'vendor-block', original: { vendor: 'legacy', bytes: '完整未知内容\u0000中文', nested: [null, { keep: true }] } };
  await workspace.installOriginalBody(card.id, [...card.body.blocks, unknown]);
  await workspace.open(page);

  const saved = await workspace.state();
  const before = fingerprint(workspace.directory, projectId);
  expect(before.revision).toBe(saved.project.revision);
  const access = JSON.parse(readFileSync(join(workspace.directory, 'local-access.json'), 'utf8')) as { url: string };
  const token = new URLSearchParams(new URL(access.url).hash.slice(1)).get('token')!;
  const trigger = page.getByRole('button', { name: '导出', exact: true });
  await trigger.click();
  await expect(page.getByText('完整项目包包含已保存的数据和资源文件，可离开本机读取；它不是加密备份，也不能在这里导入。')).toBeVisible();
  const action = page.getByRole('menuitem', { name: '下载完整项目包（ZIP）', exact: true });
  const downloadPromise = page.waitForEvent('download');
  await action.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`未命名研究-r${saved.project.revision}.zip`);
  await expect(page.getByRole('status')).toHaveText('完整项目包下载已开始');
  const downloaded = await download.path();
  expect(downloaded).toBeTruthy();

  const isolated = mkdtempSync(join(tmpdir(), 'forkwise-ui-package-'));
  try {
    const copied = join(isolated, 'project.zip');
    copyFileSync(downloaded!, copied);
    expect(copied.startsWith(workspace.directory)).toBe(false);
    const passed = verifyPackage(copied);
    expect(passed.status, passed.stdout).toBe(0);
    const after = fingerprint(workspace.directory, projectId);
    expect(after).toEqual(before);
    expect(before.historyJson).toContain('"session"');

    const bytes = readFileSync(copied);
    expect(bytes.includes(token)).toBe(false);
    const manifest = JSON.parse(readZip(bytes).get('forkwise-project.json')!.toString('utf8')) as {
      format: string;
      schemaVersion: number;
      projectId: string;
      revision: number;
      research: unknown;
      extensions: unknown;
      mapping: {
        frames: { id: string }[];
        groups: { id: string }[];
        connectors: { id: string }[];
        attachments: { id: string }[];
        history: unknown;
        stored: { cards: { json: string }[] };
      };
      resources: { id: string; path: string; sha256: string }[];
    };
    expect(manifest.format).toBe('forkwise-project');
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.projectId).toBe(projectId);
    expect(manifest.revision).toBe(before.revision);
    expect(manifest.research).toBeNull();
    expect(manifest.extensions).toEqual({});
    expect(JSON.stringify(manifest.mapping.history)).not.toContain('"session"');
    const stored = manifest.mapping.stored.cards.find((row) => row.json.includes('底层研究卡'))!.json;
    const blocks = JSON.parse(stored).body.blocks as { id: string; type: string; original?: unknown }[];
    expect(blocks.map((block) => block.type)).toEqual(expect.arrayContaining(['text', 'image', 'table', 'code', 'vendor-block']));
    expect(blocks.find((block) => block.id === 'export-unknown')!.original).toEqual(unknown.original);
    expect(manifest.mapping.frames.map((frame) => frame.id).length).toBeGreaterThanOrEqual(2);
    expect(manifest.mapping.groups.map((group) => group.id)).toContain('export-group');
    expect(manifest.mapping.connectors.map((connector) => connector.id)).toContain('export-connector');
    expect(manifest.mapping.attachments.length).toBeGreaterThan(0);
    const files = readZip(bytes);
    for (const resource of manifest.resources) {
      expect(resource.path.startsWith('/') || resource.path.includes('..')).toBe(false);
      expect(createHash('sha256').update(files.get(resource.path)!).digest('hex')).toBe(resource.sha256);
    }

    const good = readZip(bytes);
    const removed = manifest.resources[0]!.path;
    const missing = new Map(good);
    missing.delete(removed);
    const missingPath = join(isolated, 'missing.zip');
    writeFileSync(missingPath, writeZip([...missing].map(([name, data]) => ({ name, data }))));
    const missingResult = verifyPackage(missingPath);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stdout).toContain(`RESOURCE_MISSING ${removed}`);

    const tamperedManifest = structuredClone(manifest);
    tamperedManifest.resources[0]!.sha256 = '0'.repeat(64);
    const tamperedPath = join(isolated, 'tampered.zip');
    writeFileSync(tamperedPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(tamperedManifest)) }, ...[...good].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
    const tampered = verifyPackage(tamperedPath);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stdout).toContain(`RESOURCE_HASH ${removed}`);
    expect(tampered.stdout).toContain(`expected=${'0'.repeat(64)}`);

    const bad = structuredClone(manifest);
    bad.schemaVersion = 99;
    const badPath = join(isolated, 'bad-schema.zip');
    writeFileSync(badPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(bad)) }, ...[...good].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
    const badResult = verifyPackage(badPath);
    expect(badResult.status).not.toBe(0);
    expect(badResult.stdout).toContain('SCHEMA_VERSION schemaVersion expected=2 actual=99');

    const crossed = structuredClone(manifest);
    crossed.research = { format: 'forkwise-project', schemaVersion: 1, project: { id: 'other-project' } };
    const crossedPath = join(isolated, 'crossed.zip');
    writeFileSync(crossedPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(crossed)) }, ...[...good].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
    const crossedResult = verifyPackage(crossedPath);
    expect(crossedResult.status).not.toBe(0);
    expect(crossedResult.stdout).toContain(`CROSS_PROJECT research.project.id expected=${projectId} actual=other-project`);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
