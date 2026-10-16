import { test, expect, place } from './writing-board-fixture';
import { preserveClipboard } from './clipboard-fixture';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
test.use({ actionTimeout: 6000 });
for (const kind of ['queued', 'failed', 'replacement', 'saved'] as const)
  test(`媒体创建副本保持独立身份：${kind}`, async ({ page, workspace }) => {
    await place(page, '复制媒体');
    const state = await workspace.state(),
      card = state.cards[0]!;
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: 'asset.save',
      expected: null,
      payload: { id: 'original-asset', name: 'old.png', mime: 'image/png', base64: png },
    });
    const task = {
      id: 'task',
      type: 'imageTask',
      ticket: 'original-ticket',
      name: 'next.png',
      mime: 'image/png',
      base64: png,
      byteLength: 70,
      width: 320,
      height: 180,
      status: kind === 'failed' ? 'failed' : 'queued',
      ...(kind === 'failed' ? { reason: '明确失败原因' } : {}),
    };
    const image = {
      id: 'image',
      type: 'image',
      assetId: 'original-asset',
      name: 'old.png',
      mime: 'image/png',
      naturalWidth: 1,
      naturalHeight: 1,
      width: 123,
      caption: '图注保留',
      alt: '替代文字保留',
    };
    const block =
      kind === 'saved' ? image : kind === 'replacement' ? { ...image, request: task } : task;
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: { id: card.id, blocks: [block] },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/mapping/execute', async (route) => {
      if (route.request().postDataJSON().type === 'asset.save') await gate;
      await route.continue();
    });
    try {
      await workspace.open(
        page,
        kind === 'saved'
          ? '已保存到本机'
          : kind === 'failed'
            ? '媒体保存失败 · 重试或移除'
            : '媒体处理中 · 尚未保存',
      );
      await page.getByRole('button', { name: '编辑正文', exact: true }).click();
      await page.getByRole('button', { name: `选择块：${block.type}`, exact: true }).click();
      await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
      await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(2);
      const blocks = (await workspace.state()).cards[0]!.body.blocks;
      expect(blocks[0]!.id).toBe(block.id);
      expect(blocks[1]!.id).not.toBe(block.id);
      if (kind === 'saved') expect(blocks[1]).toMatchObject({ ...image, id: blocks[1]!.id });
      else if (kind === 'replacement') {
        expect((blocks[1]!.request as any).ticket).not.toBe(task.ticket);
        expect((blocks[1]!.request as any).id).not.toBe(task.id);
        expect(blocks[1]).toMatchObject({
          assetId: 'original-asset',
          width: 123,
          caption: '图注保留',
          alt: '替代文字保留',
        });
      } else {
        expect(blocks[1]!.ticket).not.toBe(task.ticket);
        expect(blocks[1]).toMatchObject({ name: task.name, base64: png, status: task.status });
      }
      release();
    } finally {
      release();
    }
  });

test('已保存正文图的真实浏览器复制保完整JSON，纯文仅取图注', async ({ page, workspace }, info) => {
  const caption = '复制图注-' + crypto.randomUUID();
  await place(page, '图注复制');
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'asset.save',
    expected: null,
    payload: { id: 'asset', name: '不进纯文.png', mime: 'image/png', base64: png },
  });
  const image = {
    id: 'image',
    type: 'image',
    assetId: 'asset',
    name: '不进纯文.png',
    mime: 'image/png',
    naturalWidth: 1,
    naturalHeight: 1,
    width: 123,
    caption,
    alt: '不进纯文的alt',
  };
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: [image] },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const guard = await preserveClipboard(page, info, caption);
  try {
    await page.getByRole('button', { name: '选择块：image', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制所选块', exact: true }).click();
    await guard.wrote(caption);
    const copied = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0]!;
      const html = await (await item.getType('text/html')).text();
      return JSON.parse(decodeURIComponent(html.match(/data-forkwise-blocks="([^"]+)"/)![1]!));
    });
    expect(copied.blocks).toEqual([image]);
  } finally {
    await guard.restore();
  }
});
