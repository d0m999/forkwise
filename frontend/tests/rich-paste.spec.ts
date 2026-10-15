import { test, expect, place } from './writing-board-fixture';
import type { Page } from '@playwright/test';
test.use({ actionTimeout: 6000 });

async function select(page: Page, start: number, end: number) {
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.evaluate(
    (el, offsets) => {
      el.focus();
      const node = el.firstElementChild!.firstChild!;
      const r = document.createRange();
      r.setStart(node, offsets[0]!);
      r.setEnd(node, offsets[1]!);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    },
    [start, end],
  );
}
async function paste(page: Page, text: string, html = '') {
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).evaluate(
    (el, data) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', data.text);
      if (data.html) clipboardData.setData('text/html', data.html);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    { text, html },
  );
}

for (const sample of [
  { name: '纯文缺少地址且伴PNG', plain: 'before\nnested\nimage\nafter', embedded: true },
  {
    name: '纯文已有地址且重复img不补重',
    plain: 'before\nnested\nimage https://fallback14.invalid/remote.png\nafter',
    embedded: false,
    duplicate: true,
  },
  { name: '没有纯文仍保alt与地址', plain: '', embedded: false },
  {
    name: '仅补安全HTTP地址',
    plain: 'before\nnested\nimage\nafter',
    embedded: false,
    url: 'http://fallback14.invalid/remote.png',
    unsafe: true,
  },
])
  test(`C14-AC5 HTML降级${sample.name}仍保完整远程地址和原文，单次历史及SQLite重开保真`, async ({
    page,
    workspace,
  }) => {
    const url = sample.url ?? 'https://fallback14.invalid/remote.png';
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
    await place(page, '远程图降级');
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.fill('original');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
      .toBe('original');
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    const original = (await workspace.state()).cards[0]!.body.blocks;
    const requests: string[] = [];
    await page.route(/^https?:\/\/fallback14\.invalid\//, async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    await select(page, 0, 'original'.length);
    await paste(
      page,
      sample.plain,
      '<blockquote><p>before</p><ul><li>nested</li></ul><p><img src="' +
        url +
        '" alt="image"></p>' +
        (sample.duplicate ? '<img src="' + url + '" alt="image">' : '') +
        (sample.unsafe
          ? '<img src="javascript:window.__ac5Executed=1" onerror="window.__ac5Executed=1"><img src="mailto:drop@example.invalid"><script>window.__ac5Executed=1</script>'
          : '') +
        (sample.embedded ? '<img src="data:image/png;base64,' + png + '" alt="PNG">' : '') +
        '<p>after</p></blockquote>',
    );
    await expect(page.getByRole('alert')).toContainText('无法可靠保留');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const saved = await workspace.state(),
      blocks = saved.cards[0]!.body.blocks;
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Full original phrases stay in their original order; the extra link's
    // placement is intentionally not prescribed by the contract.
    let offset = 0;
    for (const phrase of ['before', 'nested', 'image', 'after']) {
      const found = text.indexOf(phrase, offset);
      expect(found).toBeGreaterThanOrEqual(offset);
      offset = found + phrase.length;
    }
    expect(text.split(url)).toHaveLength(2);
    await expect(editor).toContainText(url);
    await expect(editor.locator('a').filter({ hasText: url })).toHaveAttribute('href', url);
    await expect(editor.locator('img')).toHaveCount(0);
    expect(requests).toEqual([]);
    await expect(editor.locator('a[href^="javascript:"], a[href^="mailto:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__ac5Executed)).toBeUndefined();
    if (sample.embedded) expect(blocks.find((b) => b.type === 'pendingImage')?.base64).toBe(png);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+z');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
      .toEqual(original);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+Shift+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
    const oldSnapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    await workspace.restart();
    await workspace.open(page);
    await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', oldSnapshot!);
    await page.getByRole('button', { name: '远程图降级', exact: true }).click();
    const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
    expect(agent.body.blocks).toEqual(blocks);
    expect(agent.revision).toBe((await workspace.state()).project.revision);
  });

for (const sample of [
  {
    name: '引用中的列表',
    plain: '引用前\n不可丢失\n引用后',
    html: '<blockquote><p>引用前</p><ul><li>不可丢失</li></ul><p>引用后</p></blockquote>',
  },
  {
    name: '单元格中的列表',
    plain: '',
    html: '<table><tr><td><p>表前</p><ol><li>单元格列表</li></ol><p>表后</p></td></tr></table>',
    expected: ['表前', '单元格列表', '表后'],
  },
  {
    name: '引用多层包装列表',
    plain: '',
    html: '<blockquote><div><p>层前</p><section><ol><li>深层列表</li></ol></section><p>层后</p></div></blockquote>',
    expected: ['层前', '深层列表', '层后'],
  },
  {
    name: '列表项包装中的子列表',
    plain: '',
    html: '<ul><li><p>父前</p><div><section><ul><li>包装子项</li></ul></section></div><p>父后</p></li></ul>',
    expected: ['父前', '包装子项', '父后'],
  },
])
  test(`SPEC-1 ${sample.name}完整降级提示，单次撤销及SQLite重开保留全部原文字`, async ({
    page,
    workspace,
  }) => {
    await place(page, '结构保全');
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.fill('原文完整保留');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
      .toBe('原文完整保留');
    const before = (await workspace.state()).cards[0]!.body.blocks;
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await select(page, 0, '原文完整保留'.length);
    await paste(page, sample.plain, sample.html);
    const expected = sample.expected ?? ['引用前', '不可丢失', '引用后'];
    await expect
      .poll(async () =>
        (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]),
      )
      .toEqual(expected.map((text) => ['text', text]));
    await expect(page.getByRole('alert')).toContainText('无法可靠保留');
    const saved = await workspace.state(),
      blocks = saved.cards[0]!.body.blocks;
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(before);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+Shift+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
    const oldSnapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    await workspace.restart();
    await workspace.open(page);
    await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', oldSnapshot!);
    await page.getByRole('button', { name: '结构保全', exact: true }).click();
    const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
    expect(agent.body.blocks).toEqual(blocks);
    expect(agent.revision).toBe((await workspace.state()).project.revision);
  });

for (const sample of [
  {
    name: 'DIV多段继承',
    html: '<div style="color:#ad343e;font-weight:bold"><p>甲</p><p>乙</p></div>',
    texts: ['甲', '乙'],
    formats: [[['bold', 'textColor:red']], [['bold', 'textColor:red']]],
  },
  {
    name: 'UL和OL父容器及子项继承',
    html: '<div style="color:#ad343e;font-weight:bold"><ul style="font-style:italic"><li>甲<ol style="color:#2457ad"><li>乙</li></ol></li><li style="font-weight:normal">丙</li></ul><ol style="color:#6e409a"><li>丁</li></ol></div>',
    texts: ['甲', '乙', '丙', '丁'],
    formats: [
      [['bold', 'italic', 'textColor:red']],
      [['bold', 'italic', 'textColor:blue']],
      [['italic', 'textColor:red']],
      [['bold', 'textColor:purple']],
    ],
  },
  {
    name: '子节点预设覆盖与明确重置',
    html: '<div style="color:#ad343e;font-weight:bold;font-style:italic;text-decoration:underline;background-color:#fff0b5"><p>甲<span style="color:#2457ad;font-weight:normal;text-decoration:none;background-color:transparent">乙</span><span style="color:initial;font-weight:normal;font-style:normal;text-decoration:none;background-color:transparent">丙</span><span style="color:#123456;background-color:#654321">丁</span>戊</p><p><mark style="background-color:#deebff">己</mark></p></div>',
    texts: ['甲乙丙丁戊', '己'],
    formats: [
      [
        ['bold', 'highlight:yellow', 'italic', 'textColor:red', 'underline'],
        ['italic', 'textColor:blue'],
        [],
        ['bold', 'italic', 'underline'],
        ['bold', 'highlight:yellow', 'italic', 'textColor:red', 'underline'],
      ],
      [['bold', 'highlight:blue', 'italic', 'textColor:red', 'underline']],
    ],
  },
])
  test(`SPEC-2 ${sample.name}保留有效格式和子节点优先级，历史与SQLite重开一致`, async ({
    page,
    workspace,
  }) => {
    await place(page, '样式继承');
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.fill('原文完整保留');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
      .toBe('原文完整保留');
    const before = (await workspace.state()).cards[0]!.body.blocks;
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await select(page, 0, '原文完整保留'.length);
    await paste(page, '', sample.html);
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
      .toEqual(sample.texts);
    const saved = await workspace.state(),
      blocks = saved.cards[0]!.body.blocks;
    // Compare effective formats for every character, including explicit empty
    // reset ranges. Parent marks must not overlap and override child choices.
    const formats = blocks.map((b) =>
      Array.from(b.text!).map((_, i) =>
        (
          (b.marks ?? []) as {
            type: string;
            start: number;
            end: number;
            value?: string;
          }[]
        )
          .filter((m) => m.start <= i && i < m.end)
          .map((m) => m.type + (m.value ? ':' + m.value : ''))
          .sort(),
      ),
    );
    expect(formats).toEqual(sample.formats);
    if (sample.name.startsWith('UL')) {
      expect(blocks.map((b) => [b.type, b.listType, b.parentId ?? null])).toEqual([
        ['listItem', 'bullet', null],
        ['listItem', 'ordered', blocks[0]!.id],
        ['listItem', 'bullet', null],
        ['listItem', 'ordered', null],
      ]);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(before);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+Shift+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
    const oldSnapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    await workspace.restart();
    await workspace.open(page);
    await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', oldSnapshot!);
    await page.getByRole('button', { name: '样式继承', exact: true }).click();
    const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
    expect(agent.body.blocks).toEqual(blocks);
    expect(agent.revision).toBe((await workspace.state()).project.revision);
  });

test('C14-AC1 HTML预设文字色与高亮保留等价CSS和MARK语义，未知颜色降为文字', async ({
  page,
  workspace,
}) => {
  await place(page, '预设色');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await paste(
    page,
    'preset\nhex\nrgb\nmark\ncustom',
    '<p><span style="color:#ad343e;background-color:#fff0b5">preset</span></p>' +
      '<p><span style="color:#AD343E;background-color:#FFF0B5">hex</span></p>' +
      '<p><span style="color:rgb(173, 52, 62);background-color:rgb(255, 240, 181)">rgb</span></p>' +
      '<p><mark>mark</mark></p><p><span style="color:#123456;background-color:#654321">custom</span></p>' +
      '<p style="color:#AD343E;background-color:rgb(255,240,181)">wrapper</p>' +
      '<ul><li style="color:#ad343e">list</li></ul>' +
      '<table><tr><td style="background-color:#FFF0B5">cell</td></tr></table>',
  );
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.marks)
    .toEqual(
      expect.arrayContaining([
        { type: 'textColor', start: 0, end: 6, value: 'red' },
        { type: 'highlight', start: 0, end: 6, value: 'yellow' },
      ]),
    );
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  for (const text of ['hex', 'rgb']) {
    const marks = blocks.find((b) => b.text === text)!.marks;
    expect(marks).toHaveLength(2);
    expect(marks).toEqual(
      expect.arrayContaining([
        { type: 'textColor', start: 0, end: 3, value: 'red' },
        { type: 'highlight', start: 0, end: 3, value: 'yellow' },
      ]),
    );
  }
  expect(blocks.find((b) => b.text === 'mark')!.marks).toEqual([
    { type: 'highlight', start: 0, end: 4, value: 'yellow' },
  ]);
  expect(blocks.find((b) => b.text === 'custom')!.marks ?? []).toEqual([]);
  expect(blocks.find((b) => b.text === 'wrapper')!.marks).toEqual(
    expect.arrayContaining([
      { type: 'textColor', start: 0, end: 7, value: 'red' },
      { type: 'highlight', start: 0, end: 7, value: 'yellow' },
    ]),
  );
  expect(blocks.find((b) => b.text === 'list')!.marks).toEqual([
    { type: 'textColor', start: 0, end: 4, value: 'red' },
  ]);
  expect((blocks.find((b) => b.type === 'table')!.rows as any[][])[0]![0]!.marks).toEqual([
    { type: 'highlight', start: 0, end: 4, value: 'yellow' },
  ]);
  await expect(editor.locator('.textColor-red')).toHaveText([
    'preset',
    'hex',
    'rgb',
    'wrapper',
    'list',
  ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const beforeRestart = await page.locator('.workspace').getAttribute('data-snapshot');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', beforeRestart!);
  await page.getByRole('button', { name: '预设色', exact: true }).click();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  expect(agent.revision).toBe((await workspace.state()).project.revision);
});

test('C14-AC2 HTML列表和引用内段落保留段界及行内格式，历史与SQLite重开保真', async ({
  page,
  workspace,
}) => {
  await place(page, '嵌入段界');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await paste(
    page,
    '',
    '<ul><li><p><strong>first</strong></p><p>second</p></li></ul>' +
      '<blockquote><p>alpha</p><p><em>beta</em></p></blockquote>',
  );
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['listItem', 'first\nsecond'],
      ['quote', 'alpha\nbeta'],
    ]);
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  expect(blocks[0]!.marks).toEqual([{ type: 'bold', start: 0, end: 5 }]);
  expect(blocks[1]!.marks).toEqual([{ type: 'italic', start: 6, end: 10 }]);
  await expect(editor.locator('strong')).toHaveText('first');
  await expect(editor.locator('em')).toHaveText('beta');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const beforeRestart = await page.locator('.workspace').getAttribute('data-snapshot');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', beforeRestart!);
  await page.getByRole('button', { name: '嵌入段界', exact: true }).click();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  expect(agent.revision).toBe((await workspace.state()).project.revision);
});

test('图片暂存超限保留原剪贴板夹具、正文revision及可恢复草稿', async ({ page, workspace }) => {
  await place(page, '图片上限');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('已保存');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('已保存');
  const before = await workspace.state();
  await page.route('**/api/mapping/execute', (route) => {
    if (route.request().postDataJSON()?.type === 'body.edit')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '受控保存失败' }),
      });
    return route.continue();
  });
  await editor.fill('仍可恢复的原草稿');
  for (const input of [
    { size: 524289, text: '原剪贴板' },
    { size: 512000, text: '文'.repeat(60000) },
  ]) {
    await editor.evaluate((el, input) => {
      el.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', input.text);
      const bytes = new Uint8Array(input.size).fill(7);
      clipboardData.items.add(new File([bytes], '超限.png', { type: 'image/png' }));
      (window as any).oversizeClipboard = clipboardData;
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    }, input);
    await expect(page.getByRole('alert').filter({ hasText: /超过.*上限/ })).toBeVisible();
    await expect(editor).toHaveText('仍可恢复的原草稿');
    expect((await workspace.state()).cards[0]!.body).toEqual(before.cards[0]!.body);
    expect((await workspace.state()).project.revision).toBe(before.project.revision);
    expect(
      await page.evaluate(async () => {
        const data = (window as any).oversizeClipboard as DataTransfer;
        const bytes = new Uint8Array(await data.files[0]!.arrayBuffer());
        return {
          text: data.getData('text/plain'),
          size: bytes.length,
          intact: bytes.every((b) => b === 7),
        };
      }),
    ).toEqual({ text: input.text, size: input.size, intact: true });
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toBeVisible();
  await page.unroute('**/api/mapping/execute');
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('仍可恢复的原草稿');
});

test('导入表格保留后方正文输入位置，复制同时保留可读纯文本和完整结构', async ({
  page,
  workspace,
}) => {
  await place(page, '表格互通');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await paste(page, '甲\t乙', '<table><tr><td>甲</td><td>乙</td></tr></table>');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.type))
    .toEqual(['table', 'text']);
  await page.keyboard.type('表后文字');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)!.text)
    .toBe('表后文字');
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        (window as any).copiedBody = {
          plain: await (await items[0]!.getType('text/plain')).text(),
          html: await (await items[0]!.getType('text/html')).text(),
        };
      },
    }),
  );
  await page.getByRole('button', { name: '选择块：table', exact: true }).click();
  await page.getByRole('menuitem', { name: '复制所选块', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedBody?.plain)).toBe('甲\t乙');
  const copied = await page.evaluate(() => (window as any).copiedBody);
  const data = JSON.parse(
    decodeURIComponent(copied.html.match(/data-forkwise-blocks="([^"]+)"/)[1]),
  );
  expect(data.blocks).toEqual([(await workspace.state()).cards[0]!.body.blocks[0]]);
});

test('HTML内嵌图片字节保留在原文字之间且不挂载资源节点', async ({ page, workspace }) => {
  await place(page, '内嵌图片');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  const bytes =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
  await paste(
    page,
    '前内嵌后',
    `<p><strong>前<img src="data:image/png;base64,${bytes}" alt="内嵌">后</strong></p>`,
  );
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) =>
        b.type === 'pendingImage' ? b.base64 : b.text,
      ),
    )
    .toEqual(['前', bytes, '后']);
  await expect(editor.locator('img')).toHaveCount(0);
  await expect(editor).toContainText('尚未支持');
  await expect(editor.locator('strong')).toHaveText(['前', '后']);
});

test('HTML结构无法可靠保留且没有text/plain时保留列表与表格原文字并提示', async ({
  page,
  workspace,
}) => {
  await place(page, '降级');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await paste(
    page,
    '',
    '<ul><li>原列表甲</li><li>原列表乙</li></ul><table><tr><td colspan="2">合并内容</td></tr></table>',
  );
  await expect(editor).toContainText('原列表甲');
  await expect(editor).toContainText('原列表乙');
  await expect(editor).toContainText('合并内容');
  await expect(page.getByRole('alert')).toContainText('无法可靠');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['原列表甲', '原列表乙', '合并内容']);
});

test('图片文件字节保留为尚未支持状态，不上传或解码，撤销重做与SQLite重开保真', async ({
  page,
  workspace,
}) => {
  await place(page, '图片暂存');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  const bytes =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
  await editor.evaluate((el, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '一起保留');
    clipboardData.setData('text/html', '<p><strong>一起保留</strong></p>');
    clipboardData.items.add(
      new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], '像素.png', {
        type: 'image/png',
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, bytes);
  await expect(editor).toContainText('像素.png');
  await expect(editor.locator('strong')).toHaveText('一起保留');
  await expect(editor).toContainText('尚未支持');
  await expect(editor.locator('img')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.body.blocks.find((b) => b.type === 'pendingImage')
          ?.base64,
    )
    .toBe(bytes);
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  expect(blocks.find((b) => b.type === 'pendingImage')).toMatchObject({
    name: '像素.png',
    mime: 'image/png',
    byteLength: Buffer.from(bytes, 'base64').length,
    status: 'unsupported',
  });
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '图片暂存', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor).toContainText('尚未支持');
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  expect(
    (await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!)).body.blocks,
  ).toEqual(blocks);
});

test('HTML仅保允许结构和格式，表格可读并完整重开，脚本事件远程图片与CSS零请求', async ({
  page,
  workspace,
}) => {
  await place(page, '富文');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const requests: string[] = [];
  await page.route('https://paste.invalid/**', async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await editor.click();
  await paste(
    page,
    'fallback',
    '<h2 onclick="window.__pasteExecuted=1">中文 <strong>加粗</strong></h2><ul><li>父<ul><li><em>子</em></li></ul></li></ul><table><tr><th>名称</th><th>链接</th></tr><tr><td><u>甲</u></td><td><a href="https://example.com/">地址</a></td></tr></table><p style="background-image:url(https://paste.invalid/css)"><img src="https://paste.invalid/image.png" onerror="window.__pasteExecuted=2" alt="远图"></p><script>window.__pasteExecuted=3;fetch("https://paste.invalid/script")</script>',
  );
  await expect(editor.locator('h2')).toHaveText('中文 加粗');
  await expect(editor.locator('table')).toBeVisible();
  await expect(editor.locator('th')).toHaveText(['名称', '链接']);
  await expect(editor.locator('td')).toHaveText(['甲', '地址']);
  await expect(editor.locator('img,script,style')).toHaveCount(0);
  await expect(editor).toContainText('https://paste.invalid/image.png');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.some((b) => b.type === 'table'),
    )
    .toBe(true);
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  expect(blocks.find((b) => b.type === 'table')).toMatchObject({
    header: true,
    rows: [
      [{ text: '名称' }, { text: '链接' }],
      [
        { text: '甲', marks: [{ type: 'underline', start: 0, end: 1 }] },
        {
          text: '地址',
          marks: [{ type: 'link', start: 0, end: 2, value: 'https://example.com/' }],
        },
      ],
    ],
  });
  expect(blocks.filter((b) => b.type === 'listItem').map((b) => b.parentId ?? null)).toEqual([
    null,
    blocks.find((b) => b.type === 'listItem')!.id,
  ]);
  expect(await page.evaluate(() => (window as any).__pasteExecuted)).toBeUndefined();
  expect(requests).toEqual([]);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '富文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('table')).toBeVisible();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  expect(
    (await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!)).body.blocks,
  ).toEqual(blocks);
  expect(requests).toEqual([]);
});

test('明确粘贴为Markdown冻结原文字选区，异步读取后光标移动仍落原位，目标改动则拒绝', async ({
  page,
  workspace,
}) => {
  await place(page, '显式粘贴');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('ABCD');
  await select(page, 1, 3);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).finishPaste = resolve;
        }),
    }),
  );
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '粘贴为 Markdown', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishPaste)).toBe('function');
  await select(page, 4, 4);
  await page.evaluate(() =>
    (window as any).finishPaste('# 标题\n\n```js\nconst x = "**raw**";\n```'),
  );
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['text', 'A'],
      ['heading', '标题'],
      ['text', ''],
      ['code', 'const x = "**raw**";'],
      ['text', 'D'],
    ]);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['ABCD']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await select(page, 1, 3);
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '粘贴为纯文本', exact: true }).click();
  await editor.fill('changed');
  await page.evaluate(() => (window as any).finishPaste('late result'));
  await expect(page.getByRole('alert')).toContainText('原目标已失效');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['changed']);
});

test('粘贴结构化内容替换普通文字选区，纯文本换行与空行逐段保留且不猜Markdown', async ({
  page,
  workspace,
}) => {
  await place(page, '粘贴');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('ABCD');
  await select(page, 1, 3);
  const encoded = encodeURIComponent(
    JSON.stringify({
      format: 'forkwise-body-blocks-v1',
      blocks: [
        {
          id: 'copied',
          type: 'text',
          text: 'X',
          marks: [{ type: 'bold', start: 0, end: 1 }],
        },
      ],
      readonlyIds: [],
    }),
  );
  await paste(
    page,
    'wrong fallback',
    `<div data-forkwise-blocks="${encoded}">wrong fallback</div>`,
  );
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['AXD']);
  await expect(editor.locator('strong')).toHaveText('X');
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['ABCD']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await select(page, 1, 3);
  await paste(page, '# literal\n\n**raw**');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['text', 'A# literal'],
      ['text', ''],
      ['text', '**raw**D'],
    ]);
  await expect(editor.locator('strong,h1')).toHaveCount(0);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['ABCD']);
});
