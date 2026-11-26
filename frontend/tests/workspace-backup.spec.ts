import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import Database from '../../backend/node_modules/better-sqlite3/lib/index.js';
import { place } from './writing-board-fixture';

const ageDirectory = process.env.FORKWISE_TEST_AGE_DIR;

type RecordResource = (event: Record<string, unknown>) => void;

async function start(directory: string, settings: NodeJS.ProcessEnv, record: RecordResource) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['dist/src/workspace-server.js'], {
    cwd: resolve('../backend'),
    env: { PATH: process.env.PATH, FORKWISE_DATA_DIR: directory, FORKWISE_PORT: String(port), ...settings },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  record({ event: 'server-spawn', pid: child.pid, executable: process.execPath, port });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('工作台启动超时')), 10000);
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`工作台启动失败（${code}）`));
      });
      child.stdout.on('data', data => {
        if (!String(data).includes('见岔开放工作台')) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    return {
      child,
      port,
      origin: `http://127.0.0.1:${port}`,
      url: (JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8')) as { url: string }).url,
    };
  } catch (error) {
    await stop({ child, port }, record);
    throw error;
  }
}

async function stop({ child, port }: { child: ChildProcess; port: number }, record: RecordResource) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  }
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  const probe = createServer().listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  record({ event: 'server-closed', pid: child.pid, port, exit: child.exitCode, signal: child.signalCode, portReclaimed: true });
}


const endpoint = '/api/workspace/backup';
const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function openBackup(page: Page) {
  const navigation = page.getByRole('button', { name: '项目导航', exact: true });
  if (await navigation.getAttribute('aria-expanded') !== 'true') await navigation.press('Enter');
  const trigger = page.getByRole('button', { name: '备份与恢复', exact: true });
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: '备份与恢复', exact: true });
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  return { dialog, trigger };
}

for (const width of [1360, 760]) test(`${width}px：正式工作台加密下载、独立校验、显式建立并重开副本`, async ({ browser, page }, testInfo) => {
  test.skip(!ageDirectory, '需要通过 FORKWISE_TEST_AGE_DIR 提供隔离测试所用的 age');
  await page.setViewportSize({ width, height: 900 });
  // Keep interception active across successive keyboard file selections.
  page.on('filechooser', () => {});
  const root = mkdtempSync(join(tmpdir(), 'forkwise-backup-browser-'));
  const evidence = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
  const record: RecordResource = event => {
    if (evidence) appendFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), fixturePID: process.pid, fixturePPID: process.ppid, directory: root, ...event }) + '\n');
  };
  const capture = async (target: Page, name: string) => {
    if (process.env.FORKWISE_BACKUP_CAPTURE === '1') await target.screenshot({ path: testInfo.outputPath(name + '.png') });
  };
  record({ event: 'allocate-directory', method: 'mkdtemp-direct' });
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    const keygen = join(ageDirectory!, 'age-keygen');
    const age = join(ageDirectory!, 'age');
    const identity = join(root, 'synthetic-age-key');
    const wrongIdentity = join(root, 'other-synthetic-age-key');
    for (const path of [identity, wrongIdentity]) execFileSync(keygen, ['-o', path], { env: {}, stdio: 'pipe' });
    const recipient = execFileSync(keygen, ['-y', identity], { env: {}, encoding: 'utf8' }).trim();
    const settings = { PATH: ageDirectory, FORKWISE_BACKUP_RECIPIENT: recipient, FORKWISE_BACKUP_IDENTITY: identity };
    const directory = join(root, 'source');
    const source = await start(directory, settings, record);
    children.push(source);
    await page.goto(source.url);
    const request = async (path: string, target = page) => {
      const response = await target.request.get(new URL('/api/mapping/' + path, target.url()).href);
      expect(response.ok()).toBe(true);
      return response;
    };
    const execute = async (projectId: string, command: Record<string, unknown>) => {
      const response = await page.request.post(source.origin + '/api/mapping/execute', {
        headers: { Origin: source.origin },
        data: { commandId: crypto.randomUUID(), projectId, expected: null, ...command },
      });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await place(page, '从已校验的副本读回', 375, 250);
    const originals = await (await request('projects')).json();
    const projectId = originals[0].id;
    const project = 'projects/' + projectId;
    const getProject = async (target = page) => (await request(project, target)).json();
    const card = (await getProject()).cards[0];
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\n%%EOF\n');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>');
    const assets = [
      { id: 'backup-pdf', name: '合成资料.pdf', mime: 'application/pdf', bytes: pdf, kind: 'file' },
      { id: 'backup-image', name: '合成图片.svg', mime: 'image/svg+xml', bytes: svg },
    ];
    for (const { bytes, ...asset } of assets) await execute(projectId, {
      type: 'asset.save', payload: { ...asset, base64: bytes.toString('base64') },
    });
    await execute(projectId, {
      type: 'card.attachment.add', expected: { attachments: null },
      payload: { id: card.id, assetId: 'backup-pdf', name: '合成资料.pdf' },
    });
    // The current canvas persists a measured layout after seeing the richer body.
    // Record the source only after that ordinary save has been acknowledged.
    const measured = page.waitForResponse(response => {
      const request = response.request();
      if (request.method() !== 'POST' || !response.url().endsWith('/api/mapping/execute')) return false;
      const command = request.postDataJSON();
      return response.ok() && command.type === 'card.layout' && command.payload.id === card.id &&
        command.expected.body !== card.body.versionId;
    });
    await execute(projectId, {
      type: 'body.edit', expected: card.body.versionId,
      payload: { id: card.id, requiredAssetIds: ['backup-image'], blocks: [
        { id: 'backup-paragraph', type: 'text', text: '隔离副本保留的完整正文' },
        { id: 'backup-image-block', type: 'image', assetId: 'backup-image', name: '合成图片.svg', mime: 'image/svg+xml', naturalWidth: 20, naturalHeight: 10 },
      ] },
    });
    await execute('backup-second-project', { type: 'project.create', payload: { name: '另一个独立研究' } });
    await measured;
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const recorded = await getProject();
    const recordedProjects = await (await request('projects')).json();
    const sourceDb = join(directory, 'workspace.sqlite');
    const sourceFiles = [sourceDb, sourceDb + '-wal', join(directory, 'local-access.json')];
    const sourceFingerprints = (paths: string[]) => paths.map(path => {
      const { dev, ino, mode } = statSync(path);
      return { dev, ino, mode, sha256: fingerprint(readFileSync(path)) };
    });
    const before = sourceFingerprints(sourceFiles);
    const dataDirectories = () => readdirSync(root).filter(name => name.startsWith('forkwise-restored-') || name.startsWith('.forkwise-'));

    await page.getByRole('button', { name: '导出', exact: true }).press('Enter');
    await expect(page.getByRole('menu', { name: '导出当前项目' })).toContainText('它不是加密备份');
    await page.keyboard.press('Escape');
    const { dialog, trigger } = await openBackup(page);
    await expect(dialog).toContainText('单项目导出位于项目顶部，只包含当前研究。');
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const download = dialog.getByRole('button', { name: '下载加密备份' });
    const chooser = dialog.getByLabel('加密备份文件');
    const validate = dialog.getByRole('button', { name: '校验备份', exact: true });
    const restore = dialog.getByRole('button', { name: '建立隔离恢复副本', exact: true });
    const status = dialog.getByRole('status');
    await expect(download).toBeEnabled();
    await expect(restore).toBeDisabled();
    await expect(dialog.getByText(/当前版本 \d+\.\d+\.\d+ \([a-f0-9]{12}\)/)).toBeVisible();
    await close.evaluate(button => (button as HTMLButtonElement).blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const exportMenu = page.getByRole('menu', { name: '导出当前项目' });
    if (width === 760) {
      await page.getByRole('button', { name: '导出', exact: true }).press('Enter');
      await expect(exportMenu).toBeVisible();
      for (let index = 0; index < 30; index++) {
        if (await trigger.evaluate(button => button === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(close).toBeFocused();
    } else {
      await trigger.press('Enter');
    }
    await expect(download).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(download).toBeFocused();

    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
    await page.route('**' + endpoint + '/download', async route => {
      await downloadGate;
      await route.continue();
    });
    const downloadEvent = page.waitForEvent('download', { timeout: 15000 });
    try {
      await page.keyboard.press('Enter');
      await expect(status).toHaveText('正在制作加密备份…');
      await capture(page, 'download-progress');
    } finally {
      releaseDownload();
    }
    const event = await downloadEvent;
    expect(event.suggestedFilename()).toMatch(/\.tar\.age$/);
    const downloaded = join(root, 'valid.tar.age');
    await event.saveAs(downloaded);
    const encrypted = readFileSync(downloaded);
    expect(encrypted.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    await expect(status).toHaveText('加密备份已生成，下载已开始。');
    await capture(page, 'download-complete');
    const tar = join(root, 'reference.tar');
    execFileSync(age, ['-d', '-i', identity, '-o', tar, downloaded], { env: {}, stdio: 'pipe' });
    expect(execFileSync('/usr/bin/tar', ['-tf', tar], { encoding: 'utf8' }).trim().split('\n')).toEqual(['manifest.json', 'workspace.sqlite']);
    const manifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOf', tar, 'manifest.json'], { encoding: 'utf8' }));
    const database = execFileSync('/usr/bin/tar', ['-xOf', tar, 'workspace.sqlite']);
    expect(manifest).toMatchObject({
      format: 'forkwise-workspace-backup', version: 1, database: { bytes: database.length, sha256: fingerprint(database) },
    });

    // Open the actual browser file chooser with the keyboard. Playwright supplies only the synthetic path.
    async function choose(file: string) {
      await expect(chooser).toBeEnabled();
      await chooser.focus();
      await expect(chooser).toBeFocused();
      const promise = page.waitForEvent('filechooser', { timeout: 9000 });
      await page.keyboard.press('Enter');
      await (await promise).setFiles(file);
      await expect(chooser).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(validate).toBeFocused();
    }
    const truncated = join(root, 'truncated.tar.age');
    writeFileSync(truncated, encrypted.subarray(0, -17), { mode: 0o600 });
    await choose(truncated);
    await page.keyboard.press('Enter');
    const alert = dialog.getByRole('alert');
    await expect(alert).toHaveText('备份密文不完整或损坏。');
    await expect(alert).toBeFocused();
    await expect(alert).toBeInViewport();
    await expect(restore).toBeDisabled();
    expect(dataDirectories()).toEqual([]);
    await capture(page, 'invalid-backup');
    if (width === 760) await expect(exportMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
    await expect(trigger).toBeFocused();
    if (width === 760) {
      await expect(exportMenu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(exportMenu).toHaveCount(0);
    }
    await trigger.press('Enter');
    await expect(chooser).toBeEnabled();

    await choose(downloaded);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('校验通过。可以建立隔离恢复副本。');
    await expect(restore).toBeFocused();
    expect(dataDirectories()).toEqual([]);
    await capture(page, 'validate-only');

    await choose(truncated);
    await expect(restore).toBeDisabled();
    await expect(status).toBeEmpty();
    await choose(downloaded);
    await page.keyboard.press('Enter');
    await expect(restore).toBeFocused();
    const response = page.waitForResponse(value => value.url() === source.origin + endpoint + '/restore' && value.status() === 201);
    await page.keyboard.press('Enter');
    expect((await response).status()).toBe(201);
    expect(dataDirectories()).toEqual(['forkwise-restored-' + manifest.backupId]);
    const restored = join(root, 'forkwise-restored-' + manifest.backupId);
    const result = dialog.locator('.workspace-backup-result');
    await expect(result).toBeFocused();
    await expect(result).toBeInViewport();
    await expect(status).toHaveText('已建立隔离恢复副本，可单独打开核对。');
    await expect(result.locator('code').filter({ hasText: 'start:workspace' })).toHaveText(`FORKWISE_DATA_DIR='${restored}' FORKWISE_PORT=8791 npm run start:workspace`);
    await capture(page, 'restored');
    expect(readdirSync(restored)).toEqual(['workspace.sqlite']);
    expect(fingerprint(readFileSync(join(restored, 'workspace.sqlite')))).toBe(manifest.database.sha256);
    expect(sourceFingerprints(sourceFiles)).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    const reopened = await start(restored, { PATH: root }, record);
    children.push(reopened);
    const wrong = await start(join(root, 'wrong-key'), { ...settings, FORKWISE_BACKUP_IDENTITY: wrongIdentity }, record);
    children.push(wrong);
    const isolated = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const copy = await isolated.newPage();
      await copy.goto(reopened.url);
      await expect(copy.getByRole('button', { name: '从已校验的副本读回', exact: true })).toBeVisible();
      expect(await (await request('projects', copy)).json()).toEqual(recordedProjects);
      expect(await getProject(copy)).toEqual(recorded);
      for (const asset of assets) {
        const path = project + '/assets/' + asset.id + '/content';
        expect(fingerprint(await (await request(path, copy)).body())).toBe(fingerprint(asset.bytes));
        expect(fingerprint(await (await request(path)).body())).toBe(fingerprint(asset.bytes));
      }
      const restoredDb = new Database(join(restored, 'workspace.sqlite'), { readonly: true, fileMustExist: true });
      try { expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok'); }
      finally { restoredDb.close(); }
      await capture(copy, 'isolated-open');
      await place(copy, '只写入隔离副本', 270, 400);
      expect((await getProject(copy)).cards.map((item: { title: string }) => item.title)).toContain('只写入隔离副本');
      expect(await getProject()).toEqual(recorded);
      expect(sourceFingerprints(sourceFiles)).toEqual(before);

      await copy.goto(wrong.url);
      const wrongBackup = await openBackup(copy);
      const wrongChooser = wrongBackup.dialog.getByLabel('加密备份文件');
      await expect(wrongChooser).toBeEnabled();
      await wrongChooser.setInputFiles(downloaded);
      await wrongBackup.dialog.getByRole('button', { name: '校验备份', exact: true }).press('Enter');
      const wrongAlert = wrongBackup.dialog.getByRole('alert');
      await expect(wrongAlert).toHaveText('所配置的 age 私钥与此备份不匹配。');
      await expect(wrongAlert).toBeFocused();
      await expect(wrongAlert).toBeInViewport();
      await expect(wrongBackup.dialog.getByRole('button', { name: '建立隔离恢复副本', exact: true })).toBeDisabled();
      await capture(copy, 'wrong-key');
      await wrongBackup.dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
      await expect(wrongBackup.trigger).toBeFocused();
    } finally {
      await isolated.close();
    }
    expect(dataDirectories()).toEqual(['forkwise-restored-' + manifest.backupId]);
    if (process.env.FORKWISE_BACKUP_CAPTURE === '1') writeFileSync(testInfo.outputPath('verified.json'), JSON.stringify({
      width, height: 900, age: '1.3.2', tarEntries: ['manifest.json', 'workspace.sqlite'],
      ciphertext: { sha256: fingerprint(encrypted), bytes: encrypted.length },
      manifest, resources: assets.map(({ mime, bytes }) => ({ mime, sha256: fingerprint(bytes), bytes: bytes.length })),
      sourceDB: { before, after: sourceFingerprints(sourceFiles) }, restoredProjects: recordedProjects.length,
      sourcePort: source.port, isolatedPort: reopened.port, wrongKeyPort: wrong.port, wrongKey: 'BACKUP_WRONG_KEY',
    }, null, 2));
  } finally {
    try {
      const stops = await Promise.allSettled(children.map(child => stop(child, record)));
      for (const stop of stops) if (stop.status === 'rejected') throw stop.reason;
    } finally {
      rmSync(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
      record({ event: 'directory-reclaimed', method: 'own-direct-allocation-finally' });
    }
  }
});
