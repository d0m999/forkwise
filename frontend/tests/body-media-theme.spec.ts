import { test, expect, place } from './writing-board-fixture';
import { appendFileSync } from 'node:fs';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('正文媒体真实根节点、焦点、图注、进度和拖入提示随设计令牌渲染', async ({
  page,
  workspace,
}, info) => {
  await place(page, '媒体令牌');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const current = await workspace.state(),
    card = current.cards[0]!,
    assetId = crypto.randomUUID();
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: current.project.id,
    type: 'asset.save',
    expected: null,
    payload: { id: assetId, name: '令牌.png', mime: 'image/png', base64: png },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON().type === 'asset.save') await gate;
    await route.continue();
  });
  try {
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: current.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: {
        id: card.id,
        blocks: [
          {
            id: 'token-image',
            inlineId: 'token-image-inline',
            type: 'image',
            assetId,
            name: '令牌.png',
            mime: 'image/png',
            naturalWidth: 1,
            naturalHeight: 1,
            caption: '兼容图注',
          },
          {
            id: 'token-task',
            inlineId: 'token-task-inline',
            type: 'imageTask',
            ticket: crypto.randomUUID(),
            name: '进度.png',
            mime: 'image/png',
            base64: png,
            byteLength: 70,
            width: 320,
            height: 180,
            status: 'queued',
          },
          { id: 'token-tail', inlineId: 'token-tail-inline', type: 'text', text: '' },
        ],
      },
    });
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    const image = editor.locator('[data-block-id=token-image]'),
      task = editor.locator('[data-block-id=token-task]');
    await expect(image.locator('img')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: '图片保存进度' })).toBeVisible();
    await expect.soft(image).toHaveCSS('margin-top', '16px', { timeout: 100 });
    await expect.soft(image).toHaveCSS('margin-bottom', '16px', { timeout: 100 });
    const tokens = {
      '--editor-focus': 'rgb(201, 11, 31)',
      '--inline-gray': 'rgb(44, 55, 66)',
      '--body-block-spacing': '31px',
      '--body-content-padding': '23px',
      '--body-tool-font-size': '19px',
      '--body-caption-line-height': '27px',
      '--body-note-font-size': '17px',
      '--body-note-line-height': '26px',
      '--body-media-background': 'rgb(201, 210, 220)',
      '--body-media-border': 'rgb(12, 91, 137)',
      '--body-media-border-width': '3px',
      '--body-focus-outline-width': '5px',
      '--body-focus-outline-offset': '7px',
    };
    await page.evaluate((tokens) => {
      for (const [name, value] of Object.entries(tokens))
        document.documentElement.style.setProperty(name, value);
    }, tokens);
    await image.focus();
    for (const root of [image, task]) {
      await expect.soft(root).toHaveCSS('margin-top', '31px', { timeout: 100 });
      await expect.soft(root).toHaveCSS('margin-bottom', '31px', { timeout: 100 });
    }
    await expect.soft(image).toHaveCSS('outline-color', tokens['--editor-focus'], { timeout: 100 });
    await expect.soft(image).toHaveCSS('outline-width', '5px', { timeout: 100 });
    await expect.soft(image).toHaveCSS('outline-offset', '7px', { timeout: 100 });
    const caption = image.locator('.image-caption'),
      progress = task.locator('.image-progress'),
      limits = page.locator('.media-limits');
    await expect.soft(caption).toHaveCSS('color', tokens['--inline-gray'], { timeout: 100 });
    await expect.soft(caption).toHaveCSS('font-size', '19px', { timeout: 100 });
    await expect.soft(caption).toHaveCSS('line-height', '27px', { timeout: 100 });
    await expect.soft(progress).toHaveCSS('padding-top', '23px', { timeout: 100 });
    await expect.soft(progress).toHaveCSS('font-size', '19px', { timeout: 100 });
    await expect
      .soft(progress)
      .toHaveCSS('background-color', tokens['--body-media-background'], { timeout: 100 });
    await expect
      .soft(progress)
      .toHaveCSS('border-top-color', tokens['--body-media-border'], { timeout: 100 });
    await expect.soft(progress).toHaveCSS('border-top-width', '3px', { timeout: 100 });
    await expect.soft(progress).toHaveCSS('width', '320px', { timeout: 100 });
    await expect.soft(progress).toHaveCSS('height', '180px', { timeout: 100 });
    await expect.soft(limits).toHaveCSS('font-size', '17px', { timeout: 100 });
    await expect.soft(limits).toHaveCSS('line-height', '26px', { timeout: 100 });
    await expect.soft(limits).toHaveCSS('color', tokens['--inline-gray'], { timeout: 100 });
    await editor.evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0, 1, 2])], '拖入.png', { type: 'image/png' }));
      el.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    });
    await expect.soft(editor).toHaveCSS('outline-style', 'dashed', { timeout: 100 });
    await expect
      .soft(editor)
      .toHaveCSS('outline-color', tokens['--editor-focus'], { timeout: 100 });
    await expect.soft(editor).toHaveCSS('outline-width', '5px', { timeout: 100 });
    await expect
      .soft(editor)
      .toHaveCSS('background-color', tokens['--body-media-background'], { timeout: 100 });
    const computed = await page.evaluate(() =>
      Object.fromEntries(
        [
          '[data-block-id=token-image]',
          '.image-caption',
          '.image-progress',
          '.media-limits',
          '.paragraph-editor',
        ].map((selector) => {
          const s = getComputedStyle(document.querySelector(selector)!);
          return [
            selector,
            {
              color: s.color,
              fontSize: s.fontSize,
              lineHeight: s.lineHeight,
              marginTop: s.marginTop,
              marginBottom: s.marginBottom,
              paddingTop: s.paddingTop,
              background: s.backgroundColor,
              outline: s.outline,
              outlineOffset: s.outlineOffset,
              border: s.borderTop,
              width: s.width,
              height: s.height,
            },
          ];
        }),
      ),
    );
    await info.attach('rendered-media-token-styles', {
      body: JSON.stringify({ tokens, computed }),
      contentType: 'application/json',
    });
    if (process.env.FORKWISE_ISSUE16_RESOURCE_LOG)
      appendFileSync(
        process.env.FORKWISE_ISSUE16_RESOURCE_LOG,
        JSON.stringify({
          event: 'rendered-media-token-styles',
          phase: process.env.FORKWISE_ISSUE16_PHASE,
          tokens,
          computed,
        }) + '\n',
      );
  } finally {
    release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.unroute('**/api/mapping/execute');
  }
});
