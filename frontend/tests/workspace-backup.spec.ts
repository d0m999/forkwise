import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, place, test } from './writing-board-fixture';

const ageDirectory = process.env.FORKWISE_TEST_AGE_DIR;

async function start(directory: string, settings: NodeJS.ProcessEnv) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['dist/src/workspace-server.js'], {
    cwd: resolve('../backend'),
    env: { PATH: process.env.PATH, FORKWISE_DATA_DIR: directory, FORKWISE_PORT: String(port), ...settings },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      origin: `http://127.0.0.1:${port}`,
      url: (JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8')) as { url: string }).url,
    };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  expect(await exited).toEqual([0, null]);
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

for (const shortcut of ['Meta+k', 'Control+k']) {
  test(`备份对话框内 ${shortcut} 保持当前窗口，Esc 返回备份入口`, async ({ page, workspace }) => {
    const revision = (await workspace.state()).project.revision;
    const navigation = page.getByRole('button', { name: '项目导航', exact: true });
    if (await navigation.getAttribute('aria-expanded') !== 'true') await navigation.press('Enter');
    const trigger = page.getByRole('button', { name: '备份与恢复', exact: true });
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: '备份与恢复', exact: true });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press(shortcut);
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect((await workspace.state()).project.revision).toBe(revision);
  });
}

test('从项目导航用键盘打开备份，实下载密文，再恢复并打开新副本', async ({ browser, page }) => {
  test.skip(!ageDirectory, '需要通过 FORKWISE_TEST_AGE_DIR 提供隔离测试所用的 age');
  const root = mkdtempSync(join(tmpdir(), 'forkwise-backup-browser-'));
  const children: ChildProcess[] = [];
  try {
    const identity = join(root, 'synthetic-age-key');
    const keygen = join(ageDirectory!, 'age-keygen');
    execFileSync(keygen, ['-o', identity], { env: {}, stdio: 'pipe' });
    const recipient = execFileSync(keygen, ['-y', identity], { env: {}, encoding: 'utf8' }).trim();
    const source = await start(join(root, 'source'), {
      PATH: ageDirectory, FORKWISE_BACKUP_RECIPIENT: recipient, FORKWISE_BACKUP_IDENTITY: identity,
    });
    children.push(source.child);
    await page.goto(source.url);
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await place(page, '从已校验的副本读回', 375, 250);

    const navigation = page.getByRole('button', { name: '项目导航', exact: true });
    if (await navigation.getAttribute('aria-expanded') !== 'true') await navigation.press('Enter');
    const trigger = page.getByRole('button', { name: '备份与恢复', exact: true });
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: '备份与恢复', exact: true });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const download = dialog.getByRole('button', { name: '下载加密备份' });
    const restore = dialog.getByRole('button', { name: '校验并恢复副本' });
    await expect(close).toBeFocused();
    await expect(dialog.getByText(/当前版本 \d+\.\d+\.\d+ \([a-f0-9]{12}\)/)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(download).toBeFocused();
    await close.evaluate(button => (button as HTMLButtonElement).focus());
    await close.evaluate(button => (button as HTMLButtonElement).blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('button', { name: '从已校验的副本读回', exact: true })).toBeVisible();

    await trigger.press('Enter');
    await expect(download).toBeEnabled();
    const downloadEvent = page.waitForEvent('download', { timeout: 10000 });
    await download.press('Enter');
    const file = await downloadEvent;
    expect(file.suggestedFilename()).toMatch(/\.tar\.age$/);
    const downloaded = join(root, file.suggestedFilename());
    await file.saveAs(downloaded);
    expect(readFileSync(downloaded).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    await expect(dialog.getByRole('status')).toHaveText('加密备份已生成，下载已开始。');
    const chooser = dialog.getByLabel('加密备份文件');
    const truncated = join(root, 'truncated.tar.age');
    writeFileSync(truncated, readFileSync(downloaded).subarray(0, -17), { mode: 0o600 });
    await chooser.setInputFiles(truncated);
    await restore.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('备份密文不完整或损坏');

    await chooser.setInputFiles(downloaded);
    const response = page.waitForResponse(value => value.url() === source.origin + '/api/workspace/backup/restore' && value.status() === 201);
    await restore.press('Enter');
    expect((await response).status()).toBe(201);
    await expect(dialog.getByRole('status')).toHaveText('校验通过，已创建隔离副本。');
    const restored = readdirSync(root).filter(name => name.startsWith('forkwise-restored-'));
    expect(restored).toHaveLength(1);
    const directory = realpathSync(join(root, restored[0]!));
    await expect(dialog.locator('code').filter({ hasText: 'start:workspace' })).toContainText(directory);
    await close.press('Enter');
    await expect(trigger).toBeFocused();

    const reopened = await start(directory, { PATH: root });
    children.push(reopened.child);
    const isolated = await browser.newContext();
    try {
      const copy = await isolated.newPage();
      await copy.goto(reopened.url);
      await expect(copy.getByRole('button', { name: '从已校验的副本读回', exact: true })).toBeVisible();
    } finally {
      await isolated.close();
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});
