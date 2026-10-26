import { test, expect, place } from './writing-board-fixture';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
test.use({ actionTimeout: 6000 });
// Capture real browser failures independently of protocol assertions.
const browserErrors = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
});
test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page) ?? [];
  if (errors.length) console.log(JSON.stringify({ title: info.title, pageErrors: errors }));
  expect(errors, 'media transitions keep the editor mounted without browser errors').toEqual([]);
});

test('文件真实字节插图经原卡保存、完整HTTP-MCP同revision、重启与一次undo/redo', async ({
  page,
  workspace,
}) => {
  await place(page, '媒体原卡');
  await page.getByRole('button', { name: '媒体原卡', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '真实原图.png', mimeType: 'image/png', buffer: png });
  await expect(editor.locator('img')).toBeVisible();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.some((b) => b.type === 'image'),
    )
    .toBe(true);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = await workspace.state(),
    card = saved.cards[0]!,
    image = card.body.blocks.find((b) => b.type === 'image')!;
  expect(image).toMatchObject({ name: '真实原图.png', naturalWidth: 1, naturalHeight: 1 });
  const asset = await page.request.get(
    `${workspace.origin}/api/mapping/projects/${saved.project.id}/assets/${image.assetId}`,
  );
  expect(asset.ok()).toBe(true);
  expect((await asset.json()).base64).toBe(png.toString('base64'));
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot'),
    revision = Number(await page.locator('.workspace').getAttribute('data-revision'));
  expect(snapshot).toBeTruthy();
  expect(revision).toBe(saved.project.revision);
  const http = await (
    await page.request.get(
      `${workspace.origin}/api/mapping/projects/${saved.project.id}/map?view=detail&cardId=${card.id}&snapshot=${snapshot}`,
    )
  ).json();
  expect(http.revision).toBe(revision);
  expect(JSON.parse(http.items.map((i: any) => i.jsonText).join('')).blocks).toEqual(
    card.body.blocks,
  );
  const mcp = await workspace.agentBody(saved.project.id, card.id, snapshot!);
  expect(mcp.revision).toBe(revision);
  expect(mcp.body.blocks).toEqual(card.body.blocks);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.some(
        (b) => b.type === 'image' || b.type === 'imageTask',
      ),
    )
    .toBe(false);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.find((b) => b.type === 'image'),
    )
    .toEqual(image);
  await workspace.restart();
  await workspace.open(page);
  expect((await workspace.state()).cards[0]!.body.blocks.find((b) => b.type === 'image')).toEqual(
    image,
  );
});

test('延迟真实上传后切卡完成原卡，取消替换后晚到保旧图', async ({ page, workspace }) => {
  await place(page, '原卡', 100, 120);
  await place(page, '另一卡', 430, 120);
  const before = await workspace.state(),
    original = before.cards.find((c) => c.title === '原卡')!;
  await page.getByRole('button', { name: '原卡', exact: true }).click();
  await page
    .locator('article')
    .filter({ has: page.getByRole('button', { name: '原卡', exact: true }) })
    .getByRole('button', { name: '编辑正文', exact: true })
    .click();
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (seen = r));
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON().type === 'asset.save') {
      seen();
      await gate;
    }
    await route.continue();
  });
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '延迟.png', mimeType: 'image/png', buffer: png });
  await started;
  await expect(page.getByRole('progressbar', { name: '图片保存进度' })).toBeVisible();
  await expect(page.locator('.save-state [role=status]')).not.toHaveText('已保存到本机');
  await page.getByRole('button', { name: '另一卡', exact: true }).click();
  await expect(page.getByRole('heading', { name: '正在编辑：另一卡' })).toBeVisible();
  release();
  await expect
    .poll(async () =>
      (await workspace.state()).cards
        .find((c) => c.id === original.id)!
        .body.blocks.some((b) => b.type === 'image'),
    )
    .toBe(true);
  expect(
    (await workspace.state()).cards
      .find((c) => c.title === '另一卡')!
      .body.blocks.some((b) => b.type === 'image'),
  ).toBe(false);
  await page.getByRole('button', { name: '原卡', exact: true }).click();
  await expect(editor.locator('img')).toBeVisible();
  await page.unroute('**/api/mapping/execute');
  let release2!: () => void, seen2!: () => void;
  const gate2 = new Promise<void>((r) => (release2 = r)),
    started2 = new Promise<void>((r) => (seen2 = r));
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON().type === 'asset.save') {
      seen2();
      await gate2;
    }
    await route.continue();
  });
  await editor.locator('img').click();
  const replacementChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换正文图片', exact: true }).click();
  await (await replacementChooser).setFiles({ name: '取消.png', mimeType: 'image/png', buffer: png });
  await started2;
  const cancel = page.getByRole('button', { name: '取消图片任务', exact: true });
  const hit = await cancel.evaluate(button => {
    const box = button.getBoundingClientRect();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const describe = (node: Element) => ({
      tag: node.tagName, className: node.className,
      zIndex: getComputedStyle(node).zIndex,
      rect: node.getBoundingClientRect().toJSON(),
    });
    const parents = [];
    for (let node: Element | null = button; node; node = node.parentElement) parents.push(describe(node));
    return { reachable: document.elementFromPoint(x, y)?.closest('button') === button,
      stack: document.elementsFromPoint(x, y).map(describe), parents };
  });
  console.log(JSON.stringify({ cancelHitTest: hit }));
  expect(hit.reachable, 'cancel remains reachable while media save status is visible').toBe(true);
  await cancel.click();
  await expect
    .poll(async () =>
      (await workspace.state()).cards
        .find((c) => c.id === original.id)!
        .body.blocks.some((b) => !!b.request),
    )
    .toBe(false);
  release2();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(
    (await workspace.state()).cards
      .find((c) => c.id === original.id)!
      .body.blocks.find((b) => b.type === 'image')!.name,
  ).toBe('延迟.png');
});

test('斜杠选图取消保原输入焦点，已保留pendingImage和拖入真实字节均转任务', async ({
  page,
  workspace,
}) => {
  await place(page, '保留字节');
  await page.getByRole('button', { name: '保留字节', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('/图片');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles([]);
  await expect(editor).toHaveText('/图片');
  await expect(editor).toBeFocused();
  const state = await workspace.state(),
    card = state.cards[0]!;
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const current = await workspace.state();
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: current.cards[0]!.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        {
          id: 'retained',
          type: 'pendingImage',
          name: '保留.png',
          mime: 'image/png',
          base64: png.toString('base64'),
          byteLength: png.length,
          status: 'unsupported',
        },
      ],
    },
  });
  await expect(editor.locator('[data-kind=pendingImage]')).toBeVisible();
  await editor.locator('[data-kind=pendingImage]').click();
  await page.getByRole('button', { name: '处理保留的图片字节', exact: true }).click();
  await expect(editor.locator('img')).toBeVisible();
  await editor.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], '拖入.png', { type: 'image/png' }));
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, Array.from(png));
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.body.blocks.filter((b) => b.type === 'image').length,
    )
    .toBe(2);
});

test('真实文件静态SVG可解码，恶意脚本外联SVG失败保文件名，脚本与外联均未执行', async ({
  page,
  workspace,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'svg-probe.invalid') external.push(request.url());
  });
  await page.evaluate(() => {
    (window as any).__svgExecuted = 0;
  });
  await place(page, 'SVG安全');
  await page.getByRole('button', { name: 'SVG安全', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: '静态.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    ),
  });
  await expect(editor.locator('img')).toBeVisible();
  await expect
    .poll(() =>
      editor.locator('img').evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth === 20),
    )
    .toBe(true);
  await editor.locator('img').click();
  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换正文图片', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: '危险.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>window.__svgExecuted=1</script><image href="https://svg-probe.invalid/image.png"/></svg>',
    ),
  });
  await expect(editor).toContainText('危险.svg');
  await expect(editor).toContainText('仅支持静态SVG');
  expect(await page.evaluate(() => (window as any).__svgExecuted)).toBe(0);
  expect(external).toEqual([]);
  const blocks = (await workspace.state()).cards[0]!.body.blocks;
  expect(blocks.find((b) => b.type === 'image')).toMatchObject({
    name: '静态.svg',
    request: { name: '危险.svg', status: 'failed' },
  });
  expect(await editor.locator('img').getAttribute('alt')).toBe('静态.svg');
});

for (const mode of ['undo', 'delete'] as const)
  test(`实际待上传占位${mode === 'undo' ? '撤销' : '删原卡'}后晚到结果不复活`, async ({
    page,
    workspace,
  }) => {
    await place(page, '晚到保护');
    await page.getByRole('button', { name: '晚到保护', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    let release!: () => void, seen!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (seen = r));
    await page.route('**/api/mapping/execute', async (route) => {
      if (route.request().postDataJSON().type === 'asset.save') {
        seen();
        await gate;
      }
      await route.continue();
    });
    try {
      const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
      await editor.click();
      await page.getByRole('button', { name: '插入块', exact: true }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: '图片', exact: true }).click();
      await (await chooser).setFiles({ name: '晚到.png', mimeType: 'image/png', buffer: png });
      await started;
      await expect(editor).toHaveAttribute('aria-readonly', 'false');
      if (mode === 'undo') await editor.press('Meta+z');
      else {
        const state = await workspace.state(),
          card = state.cards[0]!;
        await workspace.execute(page, {
          commandId: crypto.randomUUID(),
          projectId: state.project.id,
          type: 'thought.delete',
          expected: {
            thought: card.versionId,
            body: card.body.versionId,
            pose: card.item.versionId,
            appearance: card.appearance?.versionId ?? null,
          },
          payload: { id: card.id },
        });
        await expect(page.getByText('这张卡片已删除', { exact: true })).toBeVisible();
      }
      await expect
        .poll(
          async () =>
            (await workspace.state()).cards
              .flatMap((c) => c.body.blocks)
              .filter((b) => b.type === 'image' || b.type === 'imageTask').length,
        )
        .toBe(0);
      const completed = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/mapping/execute') &&
          r.request().postDataJSON()?.type === 'media.finish',
      );
      release();
      const response = await completed;
      expect(response.status()).toBe(409);
      expect((await response.json()).code).toBe('MEDIA_TASK_STALE');
      expect(
        (await workspace.state()).cards
          .flatMap((c) => c.body.blocks)
          .filter((b) => b.type === 'image' || b.type === 'imageTask'),
      ).toEqual([]);
    } finally {
      release();
    }
  });

test('丢失完成ACK后可重试原请求确认，后续正文不被旧回执覆盖且不重复插图', async ({
  page,
  workspace,
}) => {
  await place(page, '丢失媒体回执');
  await page.getByRole('button', { name: '丢失媒体回执', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  let lost = false;
  let originalCommand: string | undefined;
  const completions: string[] = [];
  await page.route('**/api/mapping/execute', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'media.finish') {
      completions.push(command.commandId);
      if (!lost) {
        lost = true;
        originalCommand = command.commandId;
        await route.fetch();
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '回执.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('alert')).toContainText('媒体结果尚未确认');
  await expect(editor.locator('img')).toBeVisible();
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-kind=text]').last().click();
  await page.keyboard.type('后续文字');
  await page.getByRole('button', { name: '重试媒体保存确认', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)?.text)
    .toBe('后续文字');
  expect(
    (await workspace.state()).cards[0]!.body.blocks.filter((b) => b.type === 'image'),
  ).toHaveLength(1);
  expect(completions).toEqual([originalCommand, originalCommand]);
});

test('asset ACK丢失及服务重开后恢复原媒体请求，保新输入且无重复插图', async ({
  page,
  workspace,
}) => {
  await place(page, '重开媒体任务');
  await page.getByRole('button', { name: '重开媒体任务', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const uploads: any[] = [],
    finishes: any[] = [];
  let lost = false;
  await page.route('**/api/mapping/execute', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'asset.save') {
      uploads.push(command);
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort('failed');
        return;
      }
    }
    if (command.type === 'media.finish' || command.type === 'media.fail') {
      if (command.type === 'media.finish') finishes.push(command);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '重开.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.save-state [role=status]')).toContainText('媒体结果尚未确认');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-kind=text]').last().click();
  await page.keyboard.type('重开前输入');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)?.text)
    .toBe('重开前输入');
  const before = await workspace.state(),
    task = before.cards[0]!.body.blocks.find((b) => b.type === 'imageTask')!;
  expect(task.status).toBe('queued');
  await page.unroute('**/api/mapping/execute');
  await workspace.restart();
  await page.route('**/api/mapping/execute', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'asset.save') uploads.push(command);
    if (command.type === 'media.finish') finishes.push(command);
    await route.continue();
  });
  await workspace.open(page);
  const saved = await workspace.state(),
    images = saved.cards[0]!.body.blocks.filter((b) => b.type === 'image');
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ id: task.id, assetId: task.ticket, name: '重开.png' });
  expect(saved.cards[0]!.body.blocks.at(-1)?.text).toBe('重开前输入');
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toEqual(uploads[0]);
  if (finishes.length > 1) expect(finishes[1]).toEqual(finishes[0]);
  const asset = await (
    await page.request.get(
      `${workspace.origin}/api/mapping/projects/${saved.project.id}/assets/${images[0]!.assetId}`,
    )
  ).json();
  expect(asset.base64).toBe(png.toString('base64'));
});

test('finish ACK丢失后刷新以完整持久化正文与资产确认，保单图和后续输入', async ({
  page,
  workspace,
}) => {
  await place(page, '完成后重开');
  await page.getByRole('button', { name: '完成后重开', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  let lost = false;
  let original: any;
  await page.route('**/api/mapping/execute', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'media.finish' && !lost) {
      lost = true;
      original = command;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '完成.png', mimeType: 'image/png', buffer: png });
  await expect(editor.locator('img')).toBeVisible();
  await expect(page.locator('.save-state [role=status]')).toContainText('媒体结果尚未确认');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-kind=text]').last().click();
  await page.keyboard.type('完成后新输入');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)?.text)
    .toBe('完成后新输入');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:recovery:v1:')))).toEqual([]);
  const before = await workspace.state();
  await page.unroute('**/api/mapping/execute');
  await workspace.restart();
  await workspace.open(page);
  const saved = await workspace.state();
  expect(saved.cards[0]!.body.blocks).toEqual(before.cards[0]!.body.blocks);
  expect(saved.cards[0]!.body.blocks.filter((b) => b.type === 'image')).toHaveLength(1);
  const image = saved.cards[0]!.body.blocks.find((b) => b.type === 'image')!;
  expect(image.assetId).toBe(original.payload.assetId);
  const asset = await (
    await page.request.get(
      `${workspace.origin}/api/mapping/projects/${saved.project.id}/assets/${image.assetId}`,
    )
  ).json();
  expect(asset.base64).toBe(png.toString('base64'));
  await expect(page.getByRole('button', { name: '重试媒体保存确认', exact: true })).toHaveCount(0);
});
