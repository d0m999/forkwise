import type { Page, Locator } from '@playwright/test';
import { test, expect, place } from './writing-board-fixture';
import { appendFileSync } from 'node:fs';

test('父列表后插入分隔线及后续段落不拆散子树', async ({ page, workspace }) => {
  await place(page, '分隔线边界', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
        { id: 'c', type: 'listItem', listType: 'bullet', text: '子项', parentId: 'p' },
        { id: 'g', type: 'listItem', listType: 'bullet', text: '孙项', parentId: 'c' },
      ],
    },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '分隔线边界', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '分隔线', exact: true }).click();
  await page.keyboard.insertText('后续段落');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [
        b.type,
        b.text ?? '',
        b.parentId ?? null,
      ]),
    )
    .toEqual([
      ['listItem', '父项', null],
      ['listItem', '子项', 'p'],
      ['listItem', '孙项', 'c'],
      ['divider', '', null],
      ['text', '后续段落', null],
    ]);
});

test('空父项Enter保留后代，待办父项勾选独立且IME阻止折叠与缩进', async ({ page, workspace }) => {
  await place(page, '边界正文', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'todo', checked: false, text: '' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'todo',
      checked: false,
      text: '子项',
      parentId: 'p',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '边界正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '标为完成', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.checked))
    .toEqual([true, false]);
  await editor.locator('[data-block-id="p"]').click();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(3);
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved[0]!.id).toBe('p');
  expect(saved[1]!.parentId).toBe('p');
  expect(saved[2]!.type).toBe('listItem');
  expect(saved[2]!.checked).toBe(false);
  await editor.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: '收起：空条目', exact: true }).click();
  await editor.dispatchEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    isComposing: true,
  });
  await expect(editor.locator('[data-block-id="c"]')).toBeVisible();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved);
  await editor.dispatchEvent('compositionend');
});

test('嵌套列表加号插入同级项保父项，非列表子块入口禁用', async ({ page, workspace }) => {
  await place(page, '嵌套插入', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    {
      id: 's',
      type: 'listItem',
      listType: 'bullet',
      text: '同级子项',
      parentId: 'p',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '嵌套插入', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="c"]').click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '段落', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '有序列表', exact: true }).click();
  await page.keyboard.insertText('新同级');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.text, b.parentId ?? null]),
    )
    .toEqual([
      ['父项', null],
      ['子项', 'p'],
      ['新同级', 'p'],
      ['同级子项', 'p'],
    ]);
});

test('含旧未知原件的章节仍可折叠阅读，隐藏不丢完整JSON或改变版本', async ({ page, workspace }) => {
  await place(page, '原件章节', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'h', type: 'heading', level: 1, text: '旧章节' },
    {
      id: 'opaque',
      type: 'vendor-block',
      data: { nested: ['完整原件'] },
      parentId: 'vendor-owner',
    },
    { id: 'next', type: 'heading', level: 1, text: '下一章' },
  ];
  await workspace.installOriginalBody(card.id, blocks);
  await workspace.open(page);
  await page.getByRole('button', { name: '原件章节', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const before = await workspace.state();
  await expect(page.getByRole('button', { name: '收起：旧章节', exact: true })).toBeVisible({
    timeout: 1500,
  });
  await page.getByRole('button', { name: '收起：旧章节', exact: true }).click();
  await expect(page.locator('.original-body [data-block-id="opaque"]')).toBeHidden();
  await expect(page.locator('.original-body [data-block-id="next"]')).toBeVisible();
  expect(await workspace.state()).toEqual(before);
  await page.getByRole('button', { name: '展开：旧章节', exact: true }).click();
  await expect(page.locator('.original-body [data-block-id="opaque"]')).toContainText('完整原件');
});

test('单独移动标题不搬正文并重新计算H3范围，列表移入折叠章节临时显示', async ({
  page,
  workspace,
}) => {
  await place(page, '范围边界', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '移入项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    { id: 'h', type: 'heading', level: 3, text: '三级标题' },
    { id: 't', type: 'text', text: '原正文' },
    { id: 'end', type: 'heading', level: 2, text: '边界' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '范围边界', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await page.getByRole('button', { name: '收起：三级标题', exact: true }).click();
  await expect(editor.locator('[data-block-id="t"]')).toBeHidden();
  await expect(editor.locator('[data-block-id="end"]')).toBeVisible();
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['h', 'p', 'c', 't', 'end']);
  await expect(editor.locator('[data-block-id="p"]')).toBeVisible();
  await expect(editor.locator('[data-block-id="c"]')).toBeVisible();
  await editor.locator('[data-block-id="h"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['p', 'c', 'h', 't', 'end']);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('[data-block-id="p"]')).toBeVisible();
  await expect(editor.locator('[data-block-id="t"]')).toBeHidden();
  expect(await page.locator('.board-scroll').evaluate((el) => el.scrollTop)).toBe(0);
});

test('旧列表parent原件只读保护，旁段HTTP保存及同版本MCP和重启完整保全', async ({
  page,
  workspace,
}, info) => {
  await place(page, '旧列表兼容', 80, 120);
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  const originals = [
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'bullet',
      text: '旧列表原文',
      parentId: 'vendor-owner',
    },
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'vendor',
      text: '旧列表原文',
      parentId: 'vendor-owner',
    },
    {
      id: 'legacy',
      type: 'listItem',
      listType: 'bullet',
      text: '旧列表原文',
      parentId: 'vendor-owner',
      vendorJSON: { all: [null, '保留中文🚀', { keep: true }] },
    },
  ];
  for (const original of originals) {
    const blocks = [
      { id: 'editable', type: 'text', text: '旁段原文', inlineId: 'inline' },
      original,
    ];
    await workspace.installOriginalBody(card.id, blocks);
    await workspace.open(page);
    await page.getByRole('button', { name: '旧列表兼容', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const view = page.getByLabel('只读正文原件');
    await expect(view).toContainText('vendor-owner');
    await expect(view).toContainText('旧列表原文');
    await expect(page.getByRole('textbox', { name: '卡片正文', exact: true })).toHaveCount(0);
    await view.click();
    await page.keyboard.press('Backspace');
    const before = await workspace.state();
    expect(before.cards[0]!.body.blocks).toEqual(blocks);
    const next = [{ ...blocks[0]!, text: '旁段正式保存' }, original];
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'body.edit',
      expected: before.cards[0]!.body.versionId,
      payload: { id: card.id, blocks: next },
    });
    await expect(view).toContainText('旁段正式保存');
    const saved = await workspace.state();
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-revision',
      String(saved.project.revision),
    );
    const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    const agent = await workspace.agentBody(initial.project.id, card.id, snapshot!);
    expect(agent.revision).toBe(saved.project.revision);
    expect(agent.body).toEqual(saved.cards[0]!.body);
    expect(agent.body.blocks).toEqual(next);
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'history.undo',
      expected: saved.project.revision,
      payload: {},
    });
    await expect(view).toContainText('旁段原文');
    expect((await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
    const undone = await workspace.state();
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'history.redo',
      expected: undone.project.revision,
      payload: {},
    });
    await expect(view).toContainText('旁段正式保存');
    const persisted = await workspace.state();
    await workspace.restart();
    await workspace.open(page);
    expect((await workspace.state()).cards[0]!.body).toEqual(persisted.cards[0]!.body);
    await page.getByRole('button', { name: '旧列表兼容', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const displayed = await view.locator('[data-block-id="legacy"] pre').textContent();
    expect(JSON.parse(displayed!)).toEqual(original);
  }
  await page.screenshot({ path: info.outputPath('legacy-list-originals.png') });
});

for (const activation of ['Enter', 'Space']) {
  test(`真实Tab聚焦父组删除后${activation}仅删除整组，完整JSON及一次历史经重启保留`, async ({
    page,
    workspace,
  }, info) => {
    await place(page, '键盘父组删除', 80, 120);
    const initial = await workspace.state(),
      card = initial.cards[0]!;
    const blocks = [
      {
        id: 'parent',
        inlineId: 'parent-inline',
        type: 'listItem',
        listType: 'bullet',
        text: '父组原文',
      },
      {
        id: 'child',
        inlineId: 'child-inline',
        type: 'listItem',
        listType: 'ordered',
        text: '子项原文',
        parentId: 'parent',
      },
      {
        id: 'grandchild',
        inlineId: 'grandchild-inline',
        type: 'listItem',
        listType: 'todo',
        checked: false,
        text: '孙项原文',
        parentId: 'child',
      },
      {
        id: 'following',
        inlineId: 'following-inline',
        type: 'listItem',
        listType: 'bullet',
        text: '保留同级',
      },
      { id: 'tail', inlineId: 'tail-inline', type: 'text', text: '保留正文' },
    ];
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: { id: card.id, blocks },
    });
    await workspace.open(page);
    await page.getByRole('button', { name: '键盘父组删除', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.locator('[data-block-id="parent"]').click();
    await page.getByRole('button', { name: '块菜单', exact: true }).click();
    const action = page.getByRole('menuitem', { name: '删除此项及 2 个子项', exact: true });
    const focusTrail = [];
    for (let i = 0; i < 16; i++) {
      focusTrail.push(
        await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          text: document.activeElement?.textContent,
          label: document.activeElement?.getAttribute('aria-label'),
        })),
      );
      if (await action.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(action).toBeFocused();
    await page.evaluate(() => {
      const events: unknown[] = [];
      Reflect.set(window, '__menuKeyboardWitness', events);
      for (const type of ['keydown', 'click'])
        document.addEventListener(
          type,
          (event) => {
            const target = event.target as HTMLElement;
            events.push({
              type,
              trusted: event.isTrusted,
              key: event instanceof KeyboardEvent ? event.key : null,
              phase: event.eventPhase,
              target: target.textContent,
              active: target === document.activeElement,
              defaultPrevented: event.defaultPrevented,
            });
          },
          true,
        );
      document
        .querySelector('[role="menu"]')!
        .addEventListener('keydown', (event) =>
          events.push({
            type: 'menu-native-bubble',
            key: (event as KeyboardEvent).key,
            target: (event.target as HTMLElement).textContent,
            defaultPrevented: event.defaultPrevented,
          }),
        );
    });
    const before = await workspace.state();
    const historyBefore = await (
      await page.request.get(
        workspace.origin + '/api/mapping/projects/' + initial.project.id + '/history',
      )
    ).json();
    await info.attach('real-tab-focused-before', {
      body: JSON.stringify({ focusTrail, before, historyBefore }),
      contentType: 'application/json',
    });
    await page.keyboard.press(activation);
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.versionId)
      .not.toBe(before.cards[0]!.body.versionId);
    const saved = await workspace.state();
    const events = await page.evaluate(() => Reflect.get(window, '__menuKeyboardWitness'));
    const historyAfter = await (
      await page.request.get(
        workspace.origin + '/api/mapping/projects/' + initial.project.id + '/history',
      )
    ).json();
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-revision',
      String(saved.project.revision),
    );
    const index = await (
      await page.request.get(
        workspace.origin + '/api/mapping/projects/' + initial.project.id + '/map?view=index',
      )
    ).json();
    const agent = await workspace.agentBody(initial.project.id, card.id, index.snapshot);
    const delta = await (
      await page.request.get(
        workspace.origin +
          '/api/mapping/projects/' +
          initial.project.id +
          '/changes?after=' +
          before.project.revision,
      )
    ).json();
    await info.attach('real-enter-saved-full-json', {
      body: JSON.stringify({ saved, agent, delta, historyAfter, events }),
      contentType: 'application/json',
    });
    expect(saved.cards[0]!.body.blocks).toEqual(blocks.slice(3));
    expect(agent.body).toEqual(saved.cards[0]!.body);
    expect(agent.revision).toBe(saved.project.revision);
    expect(delta.changes.at(-1).revision).toBe(saved.project.revision);
    expect(saved.project.revision).toBe(before.project.revision + 1);
    expect(historyAfter.undo.length).toBe(historyBefore.undo.length + 1);
    let releaseUndo!: () => void, undoPersisted!: () => void;
    const undoGate = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    const persisted = new Promise<void>((resolve) => {
      undoPersisted = resolve;
    });
    const historyRequests: { type: string; commandId: string }[] = [];
    const network = (event: string, details: object = {}) => {
      if (process.env.FORKWISE_ISSUE16_RESOURCE_LOG)
        appendFileSync(
          process.env.FORKWISE_ISSUE16_RESOURCE_LOG,
          JSON.stringify({
            event: 'history-network-diagnostic',
            stage: event,
            phase: process.env.FORKWISE_ISSUE16_PHASE,
            activation,
            at: Date.now(),
            ...details,
          }) + '\n',
        );
    };
    for (const event of ['request', 'requestfinished', 'requestfailed'] as const)
      page.on(event, (request) => {
        if (!request.url().includes('/api/mapping/')) return;
        network(event, {
          url: new URL(request.url()).pathname,
          method: request.method(),
          command: request.postData()?.startsWith('{') ? request.postDataJSON().type : undefined,
          failure: request.failure()?.errorText,
        });
      });
    page.on('response', (response) => {
      if (response.url().includes('/api/mapping/'))
        network('response-headers', {
          url: new URL(response.url()).pathname,
          status: response.status(),
          contentLength: response.headers()['content-length'],
          connection: response.headers()['connection'],
        });
    });
    await page.route('**/api/mapping/execute', async (route) => {
      const command = route.request().postDataJSON();
      if (command.type.startsWith('history.'))
        historyRequests.push({ type: command.type, commandId: command.commandId });
      if (command.type === 'history.undo') {
        network('route-fetch-start', { command: command.type });
        const response = await route.fetch();
        network('route-fetch-return', { command: command.type, status: response.status() });
        undoPersisted();
        await undoGate;
        network('route-fulfill-start', { command: command.type });
        await route.fulfill({ response });
        network('route-fulfill-return', { command: command.type });
      } else {
        network('route-continue-start', { command: command.type });
        await route.continue();
        network('route-continue-return', { command: command.type });
      }
    });
    await page.evaluate(() => {
      Reflect.set(window, '__historyBusyKeys', []);
      document.addEventListener(
        'keydown',
        (event) => {
          if (!event.metaKey || event.key.toLowerCase() !== 'z') return;
          Reflect.get(window, '__historyBusyKeys').push({
            key: event.key,
            shift: event.shiftKey,
            trusted: event.isTrusted,
            targetId: (event.target as HTMLElement).id,
            activeId: (document.activeElement as HTMLElement)?.id,
            readonly: document.querySelector('#card-body')?.getAttribute('aria-readonly'),
          });
        },
        true,
      );
    });
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    try {
      await editor.press('Meta+z');
      await persisted;
      await expect
        .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
        .toEqual(blocks);
      await expect(editor).toHaveAttribute('aria-readonly', 'true');
      await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
      const busyFocusBefore = await page.evaluate(() => ({
        activeId: (document.activeElement as HTMLElement)?.id,
        focused: document.hasFocus(),
      }));
      // A persisted read is not the UI's ACK. Busy shortcuts must not enqueue
      // another history action; the next user action waits for edit readiness.
      await editor.press('Meta+Shift+z');
      expect(historyRequests.filter((r) => r.type === 'history.redo')).toEqual([]);
      const witness = {
        historyRequests,
        busyFocusBefore,
        busyFocusAfter: await page.evaluate(() => ({
          activeId: (document.activeElement as HTMLElement)?.id,
          focused: document.hasFocus(),
        })),
        keys: await page.evaluate(() => Reflect.get(window, '__historyBusyKeys')),
        state: await workspace.state(),
        history: await (
          await page.request.get(
            workspace.origin + '/api/mapping/projects/' + initial.project.id + '/history',
          )
        ).json(),
      };
      if (process.env.FORKWISE_ISSUE16_RESOURCE_LOG)
        appendFileSync(
          process.env.FORKWISE_ISSUE16_RESOURCE_LOG,
          JSON.stringify({
            event: 'undo-persisted-before-ack',
            phase: process.env.FORKWISE_ISSUE16_PHASE,
            activation,
            ...witness,
          }) + '\n',
        );
      await info.attach('undo-persisted-before-ack', {
        body: JSON.stringify(witness),
        contentType: 'application/json',
      });
    } finally {
      releaseUndo();
    }
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
    const undone = await workspace.state();
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-revision',
      String(undone.project.revision),
    );
    await editor.press('Meta+Shift+z');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
      .toEqual(blocks.slice(3));
    expect(historyRequests.filter((r) => r.type === 'history.redo')).toHaveLength(1);
    if (process.env.FORKWISE_ISSUE16_RESOURCE_LOG)
      appendFileSync(
        process.env.FORKWISE_ISSUE16_RESOURCE_LOG,
        JSON.stringify({
          event: 'history-ready-redo',
          phase: process.env.FORKWISE_ISSUE16_PHASE,
          activation,
          historyRequests,
          keys: await page.evaluate(() => Reflect.get(window, '__historyBusyKeys')),
          state: await workspace.state(),
        }) + '\n',
      );
    const redone = await workspace.state();
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-revision',
      String(redone.project.revision),
    );
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    network('unroute-start');
    await page.unroute('**/api/mapping/execute');
    network('unroute-return');
    await workspace.restart();
    await workspace.open(page);
    expect((await workspace.state()).cards[0]!.body).toEqual(redone.cards[0]!.body);
    await info.attach('real-enter-redo-restart', {
      body: JSON.stringify(await workspace.state()),
      contentType: 'application/json',
    });
  });
}

async function tabToMenuAction(page: Page, target: Locator) {
  const trail = [];
  for (let i = 0; i < 20; i++) {
    trail.push(
      await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent,
        label: document.activeElement?.getAttribute('aria-label'),
        disabled: document.activeElement?.matches(':disabled'),
      })),
    );
    if (await target.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  expect(trail.some((entry) => entry.disabled)).toBe(false);
  return trail;
}

for (const activation of ['Enter', 'Space']) {
  test(`真实Tab聚焦选择本节后${activation}仅选择范围，不写版本历史`, async ({
    page,
    workspace,
  }, info) => {
    await place(page, '键盘章节选择', 80, 120);
    const initial = await workspace.state(),
      card = initial.cards[0]!;
    const blocks = [
      { id: 'h', inlineId: 'h-inline', type: 'heading', level: 1, text: '第一章' },
      { id: 'p', inlineId: 'p-inline', type: 'listItem', listType: 'bullet', text: '章节父项' },
      {
        id: 'c',
        inlineId: 'c-inline',
        type: 'listItem',
        listType: 'ordered',
        text: '章节子项',
        parentId: 'p',
      },
      { id: 'text', inlineId: 'text-inline', type: 'text', text: '章节正文' },
      { id: 'end', inlineId: 'end-inline', type: 'heading', level: 1, text: '下一章' },
    ];
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: { id: card.id, blocks },
    });
    await workspace.open(page);
    await page.getByRole('button', { name: '键盘章节选择', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await page.getByRole('button', { name: '收起：第一章', exact: true }).click();
    await editor.locator('[data-block-id="h"]').click();
    await page.getByRole('button', { name: '块菜单', exact: true }).click();
    const before = await workspace.state();
    const historyURL =
      workspace.origin + '/api/mapping/projects/' + initial.project.id + '/history';
    const historyBefore = await (await page.request.get(historyURL)).json();
    const trail = await tabToMenuAction(
      page,
      page.getByRole('menuitem', { name: '选择本节', exact: true }),
    );
    await page.keyboard.press(activation);
    await expect(editor.locator('[data-block-selected="true"]')).toHaveCount(4);
    await expect(page.getByText('已选择 4 个块', { exact: true })).toBeVisible();
    await expect(page.getByText('包含 3 个隐藏块，已临时展开', { exact: true })).toBeVisible();
    const after = await workspace.state();
    const historyAfter = await (await page.request.get(historyURL)).json();
    expect(after).toEqual(before);
    expect(historyAfter).toEqual(historyBefore);
    const index = await (
      await page.request.get(
        workspace.origin + '/api/mapping/projects/' + initial.project.id + '/map?view=index',
      )
    ).json();
    const agent = await workspace.agentBody(initial.project.id, card.id, index.snapshot);
    expect(agent.revision).toBe(before.project.revision);
    expect(agent.body).toEqual(before.cards[0]!.body);
    await info.attach('section-native-selection', {
      body: JSON.stringify({
        activation,
        trail,
        before,
        after,
        historyBefore,
        historyAfter,
        agent,
        selected: await editor
          .locator('[data-block-selected="true"]')
          .evaluateAll((nodes) => nodes.map((el) => el.getAttribute('data-block-id'))),
      }),
      contentType: 'application/json',
    });
    await workspace.restart();
    await workspace.open(page);
    expect((await workspace.state()).cards[0]!.body).toEqual(before.cards[0]!.body);
  });
}

for (const action of ['上移', '下移', '增加缩进', '减少缩进']) {
  test(`真实Tab聚焦整理${action}后Enter保持整组层级且一次撤销`, async ({
    page,
    workspace,
  }, info) => {
    await place(page, '键盘整理' + action, 80, 120);
    const initial = await workspace.state(),
      card = initial.cards[0]!;
    const blocks = [
      { id: 'a', inlineId: 'a-inline', type: 'listItem', listType: 'bullet', text: '前一同级' },
      {
        id: 'p',
        inlineId: 'p-inline',
        type: 'listItem',
        listType: 'bullet',
        text: '父组',
        ...(action === '减少缩进' ? { parentId: 'a' } : {}),
      },
      {
        id: 'c',
        inlineId: 'c-inline',
        type: 'listItem',
        listType: 'ordered',
        text: '子项',
        parentId: 'p',
      },
      {
        id: 'g',
        inlineId: 'g-inline',
        type: 'listItem',
        listType: 'todo',
        checked: false,
        text: '孙项',
        parentId: 'c',
      },
      { id: 'b', inlineId: 'b-inline', type: 'listItem', listType: 'bullet', text: '后一同级' },
    ];
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: initial.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: { id: card.id, blocks },
    });
    await workspace.open(page);
    await page.getByRole('button', { name: '键盘整理' + action, exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.locator('[data-block-id="p"]').click();
    await page.getByRole('button', { name: '块菜单', exact: true }).click();
    const trail = await tabToMenuAction(
      page,
      page.getByRole('menuitem', { name: action, exact: true }),
    );
    const before = await workspace.state();
    const expected =
      action === '上移'
        ? [blocks[1], blocks[2], blocks[3], blocks[0], blocks[4]]
        : action === '下移'
          ? [blocks[0], blocks[4], blocks[1], blocks[2], blocks[3]]
          : action === '增加缩进'
            ? [blocks[0], { ...blocks[1], parentId: 'a' }, ...blocks.slice(2)]
            : [
                blocks[0],
                {
                  id: 'p',
                  inlineId: 'p-inline',
                  type: 'listItem',
                  listType: 'bullet',
                  text: '父组',
                },
                ...blocks.slice(2),
              ];
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
      .toEqual(expected);
    const saved = await workspace.state();
    expect(saved.project.revision).toBe(before.project.revision + 1);
    await info.attach('organize-native-enter', {
      body: JSON.stringify({ action, trail, before, saved }),
      contentType: 'application/json',
    });
    await editor.press('Meta+z');
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  });
}

test('菜单原有筛选与类型选项方向键Enter、Space、Esc、disabled及IME路径保持可用', async ({
  page,
  workspace,
}, info) => {
  await place(page, '菜单路由对照', 80, 120);
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  const blocks = [
    { id: 'h', inlineId: 'h-inline', type: 'heading', level: 1, text: '类型标题' },
    { id: 'p', inlineId: 'p-inline', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      inlineId: 'c-inline',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: initial.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '菜单路由对照', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  async function open(id: string) {
    await editor.locator('[data-block-id="' + id + '"]').click();
    await page.getByRole('button', { name: '块菜单', exact: true }).click();
  }
  await open('h');
  const filter = page.getByLabel('筛选块类型');
  await expect(filter).toBeFocused();
  await filter.fill('标题');
  await page.keyboard.press('ArrowDown');
  const second = page.getByRole('menuitem', { name: '转为二级标题', exact: true });
  await expect(second).toHaveAttribute('aria-current', 'true');
  await expect(second).toHaveAttribute('tabindex', '0');
  const trail = await tabToMenuAction(page, second);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '转为三级标题', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(second).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.level).toBe(3);
  await open('h');
  await filter.fill('引用');
  await tabToMenuAction(page, page.getByRole('menuitem', { name: '转为引用', exact: true }));
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.type)
    .toBe('quote');
  await open('h');
  await filter.fill('二级');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.level).toBe(2);
  await open('h');
  const beforeEscape = await workspace.state();
  await tabToMenuAction(page, page.getByRole('menuitem', { name: '选择本节', exact: true }));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await workspace.state()).toEqual(beforeEscape);
  await open('c');
  const beforeDisabled = await workspace.state();
  await expect(page.getByRole('menuitem', { name: '转为段落', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await workspace.state()).toEqual(beforeDisabled);
  await editor.dispatchEvent('compositionstart');
  for (const key of ['ArrowDown', 'Enter', 'Escape'])
    await filter.dispatchEvent('keydown', { key, keyCode: 229, isComposing: true });
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await workspace.state()).toEqual(beforeDisabled);
  await editor.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await info.attach('menu-routing-controls', {
    body: JSON.stringify({
      trail,
      beforeEscape,
      beforeDisabled,
      after: await workspace.state(),
      compositionScope: 'Synthetic composition priority control only; real OS IME NOT_RUN',
    }),
    contentType: 'application/json',
  });
});
