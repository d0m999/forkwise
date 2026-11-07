import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMapping } from '../../backend/src/mapping/storage';
import { expect, test } from './writing-board-fixture';

const YELLOW = '#f8dfc4';
const BLUE = '#d9e7f1';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#43a89a"/></svg>';
const base64 = Buffer.from(svg).toString('base64');

test('真实键盘经系统剪贴板跨项目粘贴，保存重开后目标撤销只撤回本次粘贴，无授权写入被拒绝', async ({ page, workspace }) => {
  test.setTimeout(180000);
  const sourceId = (await workspace.state()).project.id;
  const execute = (projectId: string, type: string, payload: unknown, expected: unknown = null) =>
    workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  const read = async (projectId: string) => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}`)).json();
  await execute(sourceId, 'tag.create', { id: 'src-ai', name: 'AI' });
  let source = await read(sourceId);
  await execute(sourceId, 'tag.update', { id: 'src-ai', color: YELLOW }, source.tags.find((tag: { id: string }) => tag.id === 'src-ai').versionId);
  await execute(sourceId, 'tag.create', { id: 'src-defi', name: 'DeFi' });
  source = await read(sourceId);
  await execute(sourceId, 'tag.update', { id: 'src-defi', color: YELLOW }, source.tags.find((tag: { id: string }) => tag.id === 'src-defi').versionId);
  await execute(sourceId, 'thought.create', { id: 'source-card', title: '市场观察', text: '需求增长', x: 80, y: 120 });
  await execute(sourceId, 'card.tags', { id: 'source-card', tagIds: ['src-defi', 'src-ai'] });
  await execute(sourceId, 'asset.save', { id: 'src-asset', name: '图.svg', mime: 'image/svg+xml', base64 });
  source = await read(sourceId);
  await execute(sourceId, 'body.edit', {
    id: 'source-card',
    blocks: [
      { id: 'words', type: 'text', text: '需求增长' },
      { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.svg', mime: 'image/svg+xml', naturalWidth: 160, naturalHeight: 120 },
    ],
  }, source.cards.find((card: { id: string }) => card.id === 'source-card').body.versionId);

  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(sourceId);
  const targetId = new URL(page.url()).searchParams.get('project')!;
  await execute(targetId, 'tag.create', { id: 'dst-ai', name: 'ai' });
  let target = await read(targetId);
  await execute(targetId, 'tag.update', { id: 'dst-ai', color: BLUE }, target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId);
  target = await read(targetId);
  const reusedVersion = target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId;

  await page.locator(`[role="tab"][title="${sourceId}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(sourceId);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const artifacts = join(repo, 'backend/artifacts/issue34-20261107');
  const evidence = join(repo, 'docs/plans/evidence/issue-34-cross-project-copy-2026-11-07.json');
  mkdirSync(artifacts, { recursive: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '市场观察', exact: true }).click();
  const readPageClipboard = () => page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
    return {
      raw: item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '',
      text: await navigator.clipboard.readText(),
    };
  });
  await page.keyboard.press('Meta+c');
  await expect.poll(async () => (await readPageClipboard()).raw).toContain('"library"');
  const clipboard = await readPageClipboard();
  writeFileSync(join(artifacts, 'browser-clipboard.json'), clipboard.raw);
  expect(clipboard.text).toContain('市场观察');
  // headless Chromium 的页面剪贴板与系统剪贴板分离，系统侧读取只在 headed 运行里成立。
  if (test.info().project.use.headless === false) {
    const swift = join(artifacts, 'read-pasteboard.swift');
    const reader = join(artifacts, 'read-pasteboard');
    writeFileSync(swift, `import Cocoa
let pasteboard = NSPasteboard.general
print("changeCount \\(pasteboard.changeCount)")
for item in pasteboard.pasteboardItems ?? [] {
  for type in item.types where type.rawValue == "public.utf8-plain-text" || type.rawValue.hasPrefix("org.w3.web-custom-format.") {
    let data = item.data(forType: type)
    print("TYPE \\(type.rawValue) BYTES \\(data?.count ?? 0)")
    if let data, let text = String(data: data, encoding: .utf8) {
      print(text)
    }
  }
}
`);
    execFileSync('swiftc', ['-o', reader, swift]);
    const readSystemPasteboard = () => ({
      pasteboard: execFileSync(reader, { encoding: 'utf8' }),
      plain: execFileSync('pbpaste', { encoding: 'utf8' }),
    });
    await expect.poll(async () => {
      const system = readSystemPasteboard();
      if (system.plain.includes('市场观察') && system.pasteboard.includes(clipboard.raw) && system.pasteboard.includes('application/x-forkwise-canvas')) return true;
      await page.keyboard.press('Meta+c');
      return false;
    }, { timeout: 30000, intervals: [1000] }).toBe(true);
    const system = readSystemPasteboard();
    writeFileSync(join(artifacts, 'nspasteboard.txt'), system.pasteboard);
    writeFileSync(join(artifacts, 'pbpaste.txt'), system.plain);
    expect(system.plain).toContain('市场观察');
    expect(system.pasteboard).toContain(clipboard.raw);
    expect(system.pasteboard).toContain('application/x-forkwise-canvas');
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, JSON.stringify({
      issue: 34, ac: 'AC5', run: 'headed', at: new Date().toISOString(),
      systemTypes: [...new Set([...system.pasteboard.matchAll(/TYPE (\S+)/g)].map(match => match[1]))],
      pbpaste: system.plain,
      pageClipboard: clipboard.raw,
    }, null, 2));
  } else {
    test.info().annotations.push({
      type: 'system-clipboard',
      description: 'headless 运行不读系统剪贴板；FORKWISE_SYSTEM_CLIPBOARD=1 跑 headed 项目补齐 AC5',
    });
  }

  const host = openMapping(workspace.directory);
  const agent = host.access.issue('agent', [sourceId], undefined, undefined, [sourceId]);
  host.close();
  const beforeDenial = await read(targetId);
  const denied = await page.request.post(`${workspace.origin}/api/mapping/execute`, {
    data: {
      commandId: 'denied-paste', projectId: targetId, type: 'canvas.paste', expected: null,
      payload: { translation: { x: 12, y: 12 }, library: JSON.parse(clipboard.raw).library, objects: [{
        kind: 'card', copyId: 'denied-card', stack: 1, title: '市场观察',
        blocks: [{ id: 'words', type: 'text', text: '需求增长' }], tagIds: ['src-defi', 'src-ai'], appearance: null,
        pose: { x: 80, y: 120, width: 280, height: 160 },
      }], connectors: [] },
    },
    headers: { Origin: workspace.origin, Authorization: `Bearer ${agent}` },
  });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
  expect(await read(targetId)).toEqual(beforeDenial);

  const frozen = await read(sourceId);
  await page.locator(`[role="tab"][title="${targetId}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(targetId);
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + 420, pane.y + 260);
  await page.locator('.canvas').press('Meta+v');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(targetId)).cards.length).toBe(1);
  target = await read(targetId);
  const pasted = target.cards[0];
  const created = target.tags.find((tag: { name: string }) => tag.name === 'DeFi');
  const reused = target.tags.find((tag: { id: string }) => tag.id === 'dst-ai');
  expect(pasted.id).not.toBe('source-card');
  expect(pasted.cardTags.tagIds).toEqual([created.id, 'dst-ai']);
  expect(created.id).not.toBe('src-defi');
  expect(created).toMatchObject({ color: YELLOW, deleted: false });
  expect(reused).toMatchObject({ name: 'ai', color: BLUE, deleted: false, versionId: reusedVersion });
  const assetId = pasted.body.blocks.find((block: { type: string }) => block.type === 'image').assetId;
  expect(assetId).not.toBe('src-asset');
  const asset = await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/${assetId}`);
  expect(asset.status()).toBe(200);
  expect(await asset.json()).toMatchObject({ name: '图.svg', mime: 'image/svg+xml', base64 });
  expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/src-asset`)).status()).toBe(409);
  expect(await read(sourceId)).toEqual(frozen);

  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await read(targetId)).cards.map((card: { id: string }) => card.id)).toEqual([pasted.id]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(targetId)).cards.length).toBe(0);
  target = await read(targetId);
  expect(target.tags.find((tag: { id: string }) => tag.id === created.id)).toMatchObject({ deleted: true, name: 'DeFi', color: YELLOW });
  expect(target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId).toBe(reusedVersion);
  expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/${assetId}`)).status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await read(targetId)).toEqual(target);
  expect(await read(sourceId)).toEqual(frozen);
});
