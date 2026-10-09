const {
  chromium,
} = require('/Users/d0m999/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-browser-'));
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORKWISE_PORT: String(port),
      FORKWISE_DATA_DIR: directory,
      FORKWISE_OLLAMA_MODEL: '',
      FORKWISE_OLLAMA_VISION_MODEL: '',
      SEC_USER_AGENT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (b) => {
    logs += b;
  });
  let browser,
    page,
    token = '';
  const errors = [],
    requests = [];
  try {
    const access = join(directory, 'local-access.json');
    for (let i = 0; !existsSync(access) && i < 100; i++)
      await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(access)) throw new Error('服务未启动：' + logs);
    const credentials = JSON.parse(readFileSync(access, 'utf8'));
    token = credentials.token;
    // The access file is written before listen(). Wait only for connection
    // readiness; a real HTTP error or wrong module response must still fail.
    let nodeModule;
    for (let i = 0; i < 100; i++) {
      try {
        nodeModule = await fetch(credentials.origin + '/verification.js', {
          signal: AbortSignal.timeout(2000),
        });
        break;
      } catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED' || child.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!nodeModule) throw new Error('HTTP 服务未就绪：' + logs);
    if (
      nodeModule.status !== 200 ||
      !nodeModule.headers.get('content-type')?.includes('javascript')
    )
      throw new Error(`验证节点模块未正确提供：HTTP ${nodeModule.status}`);
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('response', async (response) => {
      if (response.url().endsWith('/operations')) {
        try {
          requests.push({
            request: JSON.parse(response.request().postData()),
            response: await response.json(),
          });
        } catch {}
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(credentials.url);
    await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
    await page.locator('#new-project input').fill('浏览器隔离研究');
    await page.locator('#new-project button').click();
    await page.locator('#revision').filter({ hasText: '修订 0' }).waitFor();
    const canvas = page.frameLocator('#native-canvas');
    await canvas.getByRole('button', { name: '＋ 新建卡', exact: true }).waitFor();
    async function add(text) {
      await canvas.getByRole('button', { name: '＋ 新建卡', exact: true }).click();
      await canvas.getByRole('dialog', { name: '写下主张' }).locator('textarea').fill(text);
      await canvas.getByRole('button', { name: '放到画布', exact: true }).click();
      await page.locator('#object-list button').filter({ hasText: text }).waitFor();
      await canvas.getByRole('dialog', { name: '写下主张' }).waitFor({ state: 'hidden' });
    }
    await add('需求增加');
    await add('收入增加');
    const ids = await page
      .locator('#connect select[name=from] option')
      .evaluateAll((nodes) => nodes.map((n) => n.value));
    await page.locator('#connect select[name=from]').selectOption(ids[0]);
    await page.locator('#connect select[name=to]').selectOption(ids[1]);
    await page.locator('#connect input').fill('订单量推动收入');
    await page.locator('#connect button').click();
    await page.locator('#object-list button').filter({ hasText: '订单量推动收入' }).waitFor();
    await page.locator('#connect input').fill('另一项独立理由');
    await page.locator('#connect button').click();
    await page.locator('#object-list button').filter({ hasText: '另一项独立理由' }).waitFor();
    await page.locator('#object-list button').filter({ hasText: '需求增加' }).click();
    await page.locator('#edit textarea[name=text]').fill('需求持平');
    await page.locator('#edit select[name=scope]').selectOption('selected');
    await page.locator('#inference-choices input').first().check();
    await page.locator('#edit button').filter({ hasText: '保存改写' }).click();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).waitFor();
    await page.locator('#edit select[name=stance]').selectOption('questioned');
    await page.locator('#edit textarea[name=reason]').fill('需要核对订单数据');
    const stanceSaved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/operations') &&
        r.request().postData()?.includes('stance.set') &&
        r.status() === 200,
    );
    await page.locator('#save-stance').click();
    await stanceSaved;
    await page.locator('#save-stance').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#save-stance').disabled);
    await page.reload();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).waitFor();
    if ((await page.locator('#object-list button').count()) !== 5)
      throw new Error('刷新后图谱对象不一致');
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    await page.locator('#edit textarea[name=reason]').fill('尚未提交的研究草稿');
    await page.locator('#object-list button').filter({ hasText: '收入增加' }).click();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    if ((await page.locator('#edit textarea[name=reason]').inputValue()) !== '尚未提交的研究草稿')
      throw new Error('切换对象丢失草稿');
    await page.reload();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    if ((await page.locator('#edit textarea[name=reason]').inputValue()) !== '尚未提交的研究草稿')
      throw new Error('刷新丢失草稿');
    await page.locator('#record').click();
    await page.locator('#history-content').filter({ hasText: '已记录' }).waitFor();
    const { createCanvas } = require('../node_modules/@napi-rs/canvas');
    const image = createCanvas(600, 180),
      ctx = image.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 180);
    ctx.fillStyle = 'black';
    ctx.font = '36px sans-serif';
    ctx.fillText('Revenue 12', 40, 90);
    await page
      .locator('#upload-material')
      .evaluate((form) => (form.closest('details').open = true));
    await page.locator('#upload-material input').setInputFiles({
      name: 'known-fixture.png',
      mimeType: 'image/png',
      buffer: image.toBuffer('image/png'),
    });
    await page.locator('#upload-material button').click();
    await page.locator('#jobs .job').filter({ hasText: 'material.parse：partial' }).waitFor();
    await page.locator('#refresh').click();
    await page.locator('#list-materials').click();
    await page.locator('#material-list button').filter({ hasText: '原图与转写校正' }).click();
    await page.locator('#transcription-dialog').waitFor({ state: 'visible' });
    await page.locator('#transcription-blocks textarea').fill('Revenue 12');
    await page.locator('#transcription-form input[name=reason]').fill('核对测试图像文字');
    await page.locator('#transcription-form input[name=confirmed]').check();
    await page
      .locator('#transcription-form button')
      .filter({ hasText: '另存人工校正版本' })
      .click();
    await page.locator('#transcription-dialog').waitFor({ state: 'hidden' });
    await page.locator('#notice').filter({ hasText: '人工校正已另存' }).waitFor();
    // Seed only a completed model fixture in this temporary test database.
    // This validates browser adoption, never real model inference quality.
    const Database = require('better-sqlite3');
    const fixtureDb = new Database(join(directory, 'research.sqlite'));
    let projectId, target;
    try {
      projectId = fixtureDb.prepare('SELECT id FROM projects WHERE deleted_at IS NULL').get().id;
      const row = fixtureDb
        .prepare(
          "SELECT id,project_id AS projectId,kind,version,version_id AS versionId,content_version_id AS contentVersionId,data,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt FROM entities WHERE project_id=? AND kind='statement'",
        )
        .all(projectId)
        .find((r) => JSON.parse(r.data).text === '收入增加');
      target = { ...row, data: JSON.parse(row.data) };
      const output = {
        result: {
          proposals: [
            {
              target: { id: target.id, versionId: target.contentVersionId },
              proposedText: '收入预期需要复核',
              reason: '浏览器测试的合成建议',
              citations: [],
              gaps: ['合成样本没有真实财务材料'],
            },
          ],
          gaps: [],
        },
        stale: false,
        coverage: { sourceVersionIds: [], networkQueries: [], mode: 'fixture' },
      };
      const now = new Date().toISOString();
      fixtureDb
        .prepare(
          "INSERT INTO jobs(id,project_id,kind,state,input,output,attempt,created_at,updated_at,dedupe_key) VALUES(?,?,'research.impact','succeeded',?,?,1,?,?,?)",
        )
        .run(
          'browser-impact-fixture',
          projectId,
          JSON.stringify({ fixture: true, targets: [target], context: [] }),
          JSON.stringify(output),
          now,
          now,
          'browser-impact-fixture',
        );
    } finally {
      fixtureDb.close();
    }
    await page
      .locator('#jobs .job')
      .filter({ hasText: 'research.impact：succeeded' })
      .getByRole('button', { name: '查看任务结果' })
      .click();
    await page.getByRole('button', { name: '放入正文草稿并选择作用范围' }).click();
    await page.locator('#edit select[name=scope]').selectOption('all');
    const impactSaved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/operations') &&
        r.request().postData()?.includes('impact.adopt') &&
        r.status() === 200,
    );
    await page.locator('#edit button').filter({ hasText: '保存改写' }).click();
    await impactSaved;
    await page.locator('#object-list button').filter({ hasText: '收入预期需要复核' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#save-stance').disabled);
    await page.locator('#edit textarea[name=text]').fill('本人仍在编辑的草稿');
    const api = async (path, method = 'GET', data, bearer = token) => {
      const response = await page.request.fetch(credentials.origin + '/api/v1' + path, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(method !== 'GET' ? { 'Idempotency-Key': require('node:crypto').randomUUID() } : {}),
        },
        ...(data ? { data } : {}),
      });
      const result = await response.json();
      if (!response.ok()) throw new Error(result.message);
      return result.data;
    };
    const grant = await api('/agent-grants', 'POST', { projectIds: [projectId] });
    const snapshot = await api(`/projects/${projectId}/state`);
    const existing = snapshot.objects.find((e) => e.id === target.id);
    const related = snapshot.objects.filter(
      (e) =>
        e.id === target.id ||
        (e.kind === 'inference' &&
          (e.data.conclusionId === target.id || e.data.premiseIds.includes(target.id))),
    );
    await api(
      `/projects/${projectId}/operations`,
      'POST',
      {
        expected: Object.fromEntries(related.map((e) => [e.id, e.version])),
        commands: [
          { op: 'statement.edit', id: existing.id, text: '外部 Agent 更新后的内容', scope: 'all' },
        ],
      },
      grant.token,
    );
    await page.locator('#notice').filter({ hasText: '后台有新结果或 Agent 修改' }).waitFor();
    if ((await page.locator('#edit textarea[name=text]').inputValue()) !== '本人仍在编辑的草稿')
      throw new Error('外部 Agent 更新覆盖了本地草稿');
    await page.locator('#refresh').click();
    await page.locator('#rebase-draft').waitFor({ state: 'visible' });
    if ((await page.locator('#edit textarea[name=text]').inputValue()) !== '本人仍在编辑的草稿')
      throw new Error('冲突恢复丢失了本地草稿');
    const exported = await api(`/projects/${projectId}/summary`);
    if (!exported.markdown.includes('外部 Agent 更新后的内容'))
      throw new Error('摘要未反映当前已保存内容');
    // Selection controls and the wrapped bottom dock must both remain usable.
    // Resize the embedded canvas viewport without changing research data.
    for (const width of ['', '620px', '390px']) {
      await page.locator('#native-canvas').evaluate((el, value) => {
        el.style.width = value;
      }, width);
      const more = canvas.locator('[data-object-action="more"]');
      await more.click();
      await canvas.getByRole('button', { name: '＋ 新建卡', exact: true }).click({ trial: true });
      const clear = await canvas.locator('.object-toolbar').evaluate((el) => {
        const dock = el.closest('.canvas-shell').querySelector('.canvas-extras');
        return el.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top;
      });
      if (!clear) throw new Error(`研究工具条遮挡底部按钮：${width || '默认宽度'}`);
      await more.click();
    }
    await page.locator('#native-canvas').evaluate((el) => {
      el.style.width = '';
    });
    let rejected = false;
    await page.route('**/api/v1/projects/*/operations', async (route) => {
      const data = route.request().postDataJSON();
      if (
        !rejected &&
        data.commands?.some(
          (c) => c.op === 'statement.create' && c.data.text === '测试未保存的画布卡片',
        )
      ) {
        rejected = true;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'LAYOUT_CONFLICT', message: '合成布局冲突', data: null }),
        });
      } else await route.continue();
    });
    await canvas.getByRole('button', { name: '＋ 新建卡', exact: true }).click();
    await canvas
      .getByRole('dialog', { name: '写下主张' })
      .locator('textarea')
      .fill('测试未保存的画布卡片');
    await canvas.getByRole('button', { name: '放到画布', exact: true }).click();
    await page.locator('#canvas-recovery-list').filter({ hasText: '合成布局冲突' }).waitFor();
    await page.reload();
    await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
    await page
      .locator('#canvas-recovery-list')
      .evaluate((el) => (el.closest('details').open = true));
    await page.locator('#show-canvas-recovery').click();
    await page.locator('#canvas-recovery-list').filter({ hasText: '合成布局冲突' }).waitFor();
    const failedCreation = page
      .locator('#canvas-recovery-list > div')
      .filter({ hasText: '合成布局冲突' });
    await failedCreation.locator('summary').click();
    await page
      .locator('#canvas-recovery-list pre')
      .filter({ hasText: '测试未保存的画布卡片' })
      .waitFor();
    await page.locator('#task-kind').evaluate((el) => {
      el.closest('details').open = true;
    });
    await page.locator('#task-kind').selectOption('initial');
    await page.locator('#choose-task-materials').click();
    await page.locator('#task-materials input').first().check();
    await page.locator('#run-research-task').click();
    const initialJob = page.locator('#jobs .job').filter({ hasText: '首次研究：failed' });
    await initialJob.waitFor();
    await initialJob.getByRole('button', { name: '查看任务结果' }).click();
    await page.locator('#task-result').filter({ hasText: 'PROVIDER_NOT_CONFIGURED' }).waitFor();
    await page.reload();
    await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
    await page.locator('#jobs .job').filter({ hasText: '首次研究：failed' }).waitFor();
    await page.locator('#object-list button').filter({ hasText: '需求增加' }).first().click();
    await page.locator('#task-kind').evaluate((el) => {
      el.closest('details').open = true;
    });
    await page.locator('#task-kind').selectOption('verify');
    await page.locator('#choose-task-materials').click();
    await page.locator('#task-materials input').first().check();
    await page.locator('#task-queries').fill('syntheticNeverMatches_4361');
    await page.locator('#run-research-task').click();
    const scopedJob = page.locator('#jobs .job').filter({ hasText: 'research.verify：succeeded' });
    await scopedJob.waitFor();
    await scopedJob.getByRole('button', { name: '查看任务结果' }).click();
    await page.locator('#task-result').filter({ hasText: '未取得可用片段，未调用模型' }).waitFor();
    await page.locator('#task-result').filter({ hasText: '证据不足' }).waitFor();
    await page.locator('#task-result details summary').first().click();
    await page
      .locator('#task-result')
      .getByRole('button', { name: '查看完整保存原文' })
      .first()
      .click();
    await page.locator('#material-content').filter({ hasText: 'Revenue 12' }).waitFor();
    await page
      .getByRole('dialog', { name: '材料原文阅读' })
      .getByRole('button', { name: '返回画布', exact: true })
      .click();
    // Real structured selection, synthetic completed model output, isolated DB only.
    const financialText = JSON.stringify({
      cik: 1,
      entityName: '浏览器合成公司',
      facts: {
        'us-gaap': {
          SyntheticRevenue: {
            label: 'Synthetic revenue',
            units: {
              USD: [
                {
                  start: '2025-01-01',
                  end: '2025-03-31',
                  val: 12,
                  filed: '2025-04-01',
                  accn: '0000000001-25-000001',
                },
                {
                  start: '2025-01-01',
                  end: '2025-03-31',
                  val: 14,
                  filed: '2025-05-01',
                  accn: '0000000001-25-000002',
                },
              ],
            },
          },
        },
      },
    });
    await api(`/projects/${projectId}/operations`, 'POST', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 'financial-browser-source',
          data: { title: '浏览器合成财务披露', publisher: '合成夹具', rights: 'public' },
        },
        {
          op: 'source.import',
          id: 'financial-browser-sv',
          sourceId: 'financial-browser-source',
          text: financialText,
          retrievedAt: new Date().toISOString(),
          publishedAt: null,
          provenance: {
            provider: 'sec-edgar',
            adapterVersion: 'synthetic-browser@1',
            snapshotHash: require('node:crypto')
              .createHash('sha256')
              .update(financialText)
              .digest('hex'),
            requestUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json',
          },
        },
      ],
    });
    const financialDb = new Database(join(directory, 'research.sqlite'));
    try {
      const { ResearchRepository } = await import('../dist/src/repositories/research.js');
      const { SearchRepository } = await import('../dist/src/repositories/search.js');
      const { selectMaterialContext } = await import('../dist/src/services/material-context.js');
      const repo = new ResearchRepository(financialDb),
        version = repo.snapshot(projectId).objects.find((e) => e.id === 'financial-browser-sv');
      const selection = selectMaterialContext(
        projectId,
        [{ id: version.id, version, text: financialText }],
        new SearchRepository(repo),
        { queries: ['Synthetic revenue'], maxCharacters: 20_000 },
      );
      const now = new Date().toISOString();
      financialDb
        .prepare(
          "INSERT INTO jobs(id,project_id,kind,state,input,output,attempt,created_at,updated_at,dedupe_key) VALUES(?,?,'research.verify','succeeded',?,?,1,?,?,?)",
        )
        .run(
          'browser-financial-fixture',
          projectId,
          JSON.stringify({ materials: selection.materials }),
          JSON.stringify({
            result: { checks: [], gaps: ['浏览器合成结果，未执行模型'] },
            stale: false,
            coverage: {
              sourceVersionIds: [version.id],
              networkQueries: [],
              mode: 'retrieved_passages',
              retrieval: selection.coverage,
            },
          }),
          now,
          now,
          'browser-financial-fixture',
        );
    } finally {
      financialDb.close();
    }
    await page.locator('#refresh').click();
    await page
      .locator('#jobs .job')
      .filter({ hasText: 'research.verify：succeeded' })
      .first()
      .getByRole('button', { name: '查看任务结果' })
      .click();
    await page.locator('#task-result details summary').click();
    await page
      .locator('#task-result')
      .filter({ hasText: '按财务记录选取 2 / 匹配 2 条' })
      .waitFor();
    await page
      .locator('#task-result')
      .filter({ hasText: '科目 · /facts/us-gaap/SyntheticRevenue' })
      .waitFor();
    await page
      .locator('#task-result')
      .filter({ hasText: '单位 · /facts/us-gaap/SyntheticRevenue/units/USD' })
      .waitFor();
    await page.locator('#task-result pre').filter({ hasText: '0000000001-25-000002' }).waitFor();
    await page.locator('#task-result').getByRole('button', { name: '查看完整保存原文' }).click();
    await page.locator('#material-content').filter({ hasText: '浏览器合成公司' }).waitFor();
    await page
      .getByRole('dialog', { name: '材料原文阅读' })
      .getByRole('button', { name: '返回画布', exact: true })
      .click();
    if (errors.length) throw new Error(errors.join('\n'));
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/backend-browser-smoke.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 2000 });
    await page.locator('#task-result').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page
      .locator('aside.details')
      .screenshot({ path: 'artifacts/financial-context-browser.png' });
    const { expectedVersions } = await import('../web/operation-versions.js');
    const nodeState = await api(`/projects/${projectId}/state`);
    const nodeTarget = nodeState.objects.find(
      (e) => e.kind === 'statement' && e.data.text === '需求持平',
    );
    const nodeProposal = {
      op: 'verification.propose',
      id: 'browser-node-candidate',
      target: { id: nodeTarget.id, versionId: nodeTarget.contentVersionId },
      context: [],
      details: {
        event: '2027 年年度报告披露',
        goal: '核对全年需求变化',
        period: '2027 年',
        date: null,
      },
      gaps: ['实际披露日期未知'],
    };
    await api(
      `/projects/${projectId}/operations`,
      'POST',
      {
        expected: expectedVersions(nodeState.objects, [nodeProposal]),
        commands: [nodeProposal],
      },
      grant.token,
    );
    await page.locator('#refresh').click();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    await page.locator('#verification-node').filter({ hasText: 'AI 建议 · 待你确认' }).waitFor();
    await page.locator('#verification-confirm').click();
    await page.locator('#verification-node').filter({ hasText: '已确认节点' }).waitFor();
    let confirmedState = await api(`/projects/${projectId}/state`);
    if (
      JSON.stringify(confirmedState.objects.find((e) => e.id === nodeTarget.id).data.stance) !==
      JSON.stringify(nodeTarget.data.stance)
    )
      throw new Error('节点确认改变了个人立场');
    await page.locator('#verification-edit').click();
    await page.locator('#verification-form input[name=goal]').fill('核对需求与本人原假设的差异');
    await page.locator('#object-list button').filter({ hasText: '需求增加' }).click();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    if (
      (await page.locator('#verification-form input[name=goal]').inputValue()) !==
      '核对需求与本人原假设的差异'
    )
      throw new Error('切换对象丢失节点草稿');
    await page.reload();
    await page.locator('#object-list button').filter({ hasText: '需求持平' }).click();
    if (
      (await page.locator('#verification-form input[name=goal]').inputValue()) !==
      '核对需求与本人原假设的差异'
    )
      throw new Error('刷新丢失节点草稿');
    await page.locator('#verification-form button').click();
    await page.locator('#verification-node').filter({ hasText: '已确认节点' }).waitFor();
    await page.locator('#verification-node').getByRole('button', { name: '查看节点历史' }).click();
    await page.locator('#verification-history').filter({ hasText: 'v2' }).waitFor();
    await page.locator('#verification-edit').click();
    await page.locator('#verification-form input[name=goal]').fill('复核新需求假设');
    confirmedState = await api(`/projects/${projectId}/state`);
    const nodeEdit = {
      op: 'statement.edit',
      id: nodeTarget.id,
      text: '需求假设已更新',
      scope: 'all',
    };
    await api(
      `/projects/${projectId}/operations`,
      'POST',
      {
        expected: expectedVersions(confirmedState.objects, [nodeEdit]),
        commands: [nodeEdit],
      },
      grant.token,
    );
    await page.locator('#notice').filter({ hasText: '后台有新结果或 Agent 修改' }).waitFor();
    await page.locator('#refresh').click();
    await page.locator('#verification-rebase').waitFor();
    if (
      (await page.locator('#verification-form input[name=goal]').inputValue()) !== '复核新需求假设'
    )
      throw new Error('并发修改覆盖节点草稿');
    await page.locator('#verification-form button').click();
    await page.locator('#notice').filter({ hasText: '请先复核当前版本' }).waitFor();
    await page.locator('#verification-error').filter({ hasText: '节点草稿保留' }).waitFor();
    await page.locator('#verification-rebase').click();
    await page.locator('#verification-form button').click();
    await page.locator('#verification-node').filter({ hasText: '已确认节点' }).waitFor();
    const nodeFinal = await api(`/projects/${projectId}/state`);
    const humanNode = nodeFinal.objects.find(
      (e) => e.kind === 'verification_node' && e.data.status === 'confirmed',
    );
    if (
      humanNode.version !== 3 ||
      humanNode.data.target.versionId !==
        nodeFinal.objects.find((e) => e.id === nodeTarget.id).contentVersionId
    )
      throw new Error('复核未绑定新内容版本或节点历史不完整');
    await page
      .locator('#verification-node')
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page
      .locator('aside.details')
      .screenshot({ path: 'artifacts/verification-node-browser.png' });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(
      'PASS: 本机 HTTP 服务 + Chromium 原 Excalidraw 画布创建/草稿切换与刷新/编辑/同端点多推导/局部派生/立场/刷新持久化/历史判断/原图上传/人工转写校正/合成 AI 建议采用/外部 Agent 并发草稿保护/Markdown/合成冲突后画布恢复/首次研究入口与失败记录跨刷新保留/材料关键词检索未命中/结构化财务记录及口径显示与原文回查/验证节点候选确认和修改历史/节点草稿切换及刷新保留/并发内容变化后明确复核；无页面异常。仅临时测试数据库，未验证真实模型。',
    );
  } catch (error) {
    console.error('Page errors:', errors);
    if (page) {
      const frame = page.frames().find((f) => /\/canvas\//.test(f.url()));
      if (frame)
        console.error(
          'Canvas hit areas:',
          await frame.evaluate(() =>
            ['.canvas-extras', '.object-toolbar'].map((selector) => {
              const el = document.querySelector(selector),
                box = el?.getBoundingClientRect();
              return { selector, box: box?.toJSON(), zIndex: el && getComputedStyle(el).zIndex };
            }),
          ),
        );
    }
    console.error(
      'Recent writes:',
      JSON.stringify(
        requests.slice(-5).map((r) => ({
          commands: r.request.commands,
          code: r.response.code,
          revision: r.response.data?.revisionAfter,
          layout: r.response.data?.layout?.version,
        })),
        null,
        2,
      ),
    );
    if (page)
      console.error(
        JSON.stringify(
          await page.evaluate(() => ({
            notice: document.querySelector('#notice')?.textContent,
            objects: document.querySelector('#object-list')?.textContent,
            nodes: [...document.querySelectorAll('.node')].map((e) => ({
              selected: e.classList.contains('selected'),
              text: e.textContent,
            })),
            stance: document.querySelector('#edit select[name=stance]')?.value,
            recovery: [...document.querySelectorAll('#canvas-recovery-list > div > p')].map(
              (e) => e.textContent,
            ),
          })),
          null,
          2,
        ),
      );
    throw new Error(String(error.message).replaceAll(token || 'TOKEN_NOT_SET', '[redacted]'));
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else {
        child.once('exit', resolve);
        setTimeout(resolve, 3000);
      }
    });
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
