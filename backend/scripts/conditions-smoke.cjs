// Synthetic research only; isolated database/browser and no model/SEC access.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { chromium } = require('/Users/d0m999/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-conditions-'));
  writeFileSync(join(directory, 'metrics.json'), JSON.stringify(['合成增长率']));
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const child = spawn(process.execPath, ['dist/src/server.js'], { cwd: process.cwd(),
    env: { ...process.env, FORKWISE_PORT: String(port), FORKWISE_DATA_DIR: directory,
      FORKWISE_OLLAMA_MODEL: '', FORKWISE_OLLAMA_VISION_MODEL: '', SEC_USER_AGENT: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let browser, page, token = '', logs = '';
  child.stderr.on('data', value => { logs += value; });
  const errors = [], delay = () => new Promise(r => setTimeout(r, 100));
  try {
    const access = join(directory, 'local-access.json');
    for (let i = 0; !existsSync(access) && i < 100; i++) await delay();
    assert.ok(existsSync(access), logs);
    const config = JSON.parse(readFileSync(access, 'utf8')); token = config.token;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(config.origin + '/conditions.js');
        assert.equal(res.status, 200); break;
      } catch (e) { if (e.cause?.code !== 'ECONNREFUSED' || i === 99) throw e; await delay(); }
    }
    const api = async (path, method = 'GET', body, credential = token) => {
      const response = await fetch(config.origin + '/api/v1' + path, { method,
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.code + ': ' + value.message);
      return value.data;
    };
    const project = await api('/projects', 'POST', { name: '条件隔离浏览器验收' });
    const path = '/projects/' + project.id, state = () => api(path + '/state');
    const write = async (commands) => {
      const current = await state();
      return api(path + '/operations', 'POST', { expected: Object.fromEntries(current.objects.map(e => [e.id, e.version])), commands });
    };
    const attribution = { origin: 'user', participation: 'personal', stance: { value: 'pending', reason: '' }, citations: [] };
    await write([
      ...['a', 'b'].map((id, i) => ({ op: 'statement.create', id, data: { ...attribution, text: ['需求改善', '利润增长'][i] } })),
      { op: 'inference.create', id: 'i', data: { ...attribution, premiseIds: ['a'], conclusionId: 'b', reason: '需求推动利润', combination: 'independent' } },
      { op: 'source.create', id: 's', data: { title: '合成材料', publisher: '测试', rights: 'authorized' } },
      { op: 'source.import', id: 'sv', sourceId: 's', text: '增长率12%。渠道仍待观察。', retrievedAt: '2025-05-01T00:00:00Z', publishedAt: null },
      { op: 'evidence.create', id: 'e1', data: { citation: { sourceVersionId: 'sv', start: 0, end: 6, quote: '增长率12%' },
        fact: { subject: '合成公司', metric: '合成增长率', value: 12, rawValue: '12%', unit: '%', currency: '', scope: '合并', periodKind: 'single', period: { start: '2025-01-01', end: '2025-03-31' } } } },
      { op: 'evidence.create', id: 'e2', data: { citation: { sourceVersionId: 'sv', start: 7, end: 13, quote: '渠道仍待观察' } } },
    ]);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(config.url);
    await page.locator('#object-list button').filter({ hasText: '需求改善' }).click();
    const root = page.locator('#conditions'), condition = id => root.locator('[data-condition-id="' + id + '"]');
    await root.getByRole('button', { name: '新建判断条件', exact: true }).click();
    let form = root.locator('.condition-editor');
    await form.getByLabel('判断标准', { exact: true }).fill('渠道需求持续改善');
    await form.locator('input[type=checkbox][value=i]').check();
    await form.getByRole('button', { name: '保存判断条件', exact: true }).click();
    await root.locator('.condition-editor').waitFor({ state: 'hidden' });
    let current = await state(), c = current.objects.find(e => e.kind === 'condition');
    assert.deepEqual(c.data.targetIds.sort(), ['a', 'i']);
    await condition(c.id).getByRole('button', { name: '独立记录本人判断' }).click();
    form = condition(c.id).locator('.condition-assessment');
    await form.getByLabel('本人评估理由').fill('资料不足，先保留未知');
    await form.getByRole('button', { name: '保存本人条件判断' }).click();
    await form.waitFor({ state: 'hidden' });
    assert.ok((await state()).objects.some(e => e.kind === 'evaluation' && e.data.evaluator === 'human' && !e.data.basedOn));
    await condition(c.id).getByRole('button', { name: '请求条件评估' }).click();
    form = condition(c.id).locator('.condition-assessment');
    await form.locator('input[value=e2]').check();
    await form.getByRole('button', { name: '使用所选材料发起评估' }).click();
    await form.waitFor({ state: 'hidden' });
    for (let i = 0; i < 100; i++) {
      const jobs = await api(path + '/jobs');
      if (jobs.some(j => j.state === 'failed')) {
        const job = await api(path + '/jobs/' + jobs[0].id);
        assert.deepEqual(job.input.evidence.map(e => e.id), ['e2']); break;
      }
      if (i === 99) throw new Error('模型未配置的失败状态未出现'); await delay();
    }
    await condition(c.id).locator('[data-condition-task]').filter({ hasText: '规则已保存；评估任务失败' }).waitFor();
    await condition(c.id).getByRole('button', { name: '重试此条件评估' }).click();
    await condition(c.id).locator('[data-condition-task]').filter({ hasText: '规则已保存；评估任务失败' }).waitFor();
    assert.equal((await state()).objects.find(e => e.id === c.id).data.description, '渠道需求持续改善');
    await condition(c.id).getByRole('button', { name: '编辑条件与引用' }).click();
    form = condition(c.id).locator('.condition-editor');
    await form.getByLabel('判断标准', { exact: true }).fill('渠道需求改善且库存下降');
    await form.getByLabel('本次修改范围').selectOption('selected');
    await form.locator('input[value=a]').uncheck();
    await form.getByRole('button', { name: '保存条件修改' }).click();
    await condition(c.id).locator('.condition-editor').waitFor({ state: 'hidden' });
    current = await state();
    const local = current.objects.find(e => e.kind === 'condition' && e.id !== c.id);
    assert.deepEqual(local.data.targetIds, ['i']); assert.equal(local.data.lineage.id, c.id);
    assert.deepEqual(current.objects.find(e => e.id === c.id).data.targetIds, ['a']);
    await page.locator('#object-list button').filter({ hasText: '需求推动利润' }).click();
    await condition(local.id).getByText('此条件由共享规则局部修改而来', { exact: true }).click();
    await condition(local.id).getByRole('button', { name: '查看派生前规则' }).click();
    await condition(local.id).locator('.condition-origin').getByText('渠道需求持续改善', { exact: true }).waitFor();
    await page.locator('#object-list button').filter({ hasText: '利润增长' }).click();
    await root.getByText('引用已有条件', { exact: true }).click();
    const reuse = root.locator('details > div').filter({ hasText: '渠道需求持续改善' });
    await reuse.getByRole('button', { name: '在当前对象引用此条件' }).click();
    await condition(c.id).waitFor();
    assert.equal((await state()).objects.find(e => e.id === c.id).contentVersionId, c.contentVersionId);
    await root.getByRole('button', { name: '新建判断条件', exact: true }).click();
    form = root.locator('.condition-editor');
    await form.getByLabel('判断标准', { exact: true }).fill('指定期间增长率达到本人阈值');
    await form.getByLabel('评估方式').selectOption('numeric');
    for (const [name, value] of Object.entries({ subject: '合成公司', metric: '合成增长率', unit: '%', scope: '合并', threshold: '10', start: '2025-01-01', end: '2025-03-31' }))
      await form.locator('input[name=' + name + ']').fill(value);
    await form.getByLabel('比较方式').selectOption('gte');
    await form.getByLabel('期间口径').selectOption('single');
    await form.getByRole('button', { name: '保存判断条件', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    let numeric = (await state()).objects.find(e => e.kind === 'condition' && e.data.mode === 'numeric');
    await condition(numeric.id).getByRole('button', { name: '请求条件评估' }).click();
    form = condition(numeric.id).locator('.condition-assessment');
    await form.locator('input[value=e1]').check();
    await form.getByRole('button', { name: '使用所选材料发起评估' }).click();
    await form.waitFor({ state: 'hidden' });
    await condition(numeric.id).getByText('规则计算：满足', { exact: true }).waitFor();
    await condition(numeric.id).getByRole('button', { name: '根据此建议记录判断' }).click();
    form = condition(numeric.id).locator('.condition-assessment');
    await form.getByLabel('本人评估结论').selectOption('not_satisfied');
    await form.getByRole('button', { name: '保存本人条件判断' }).click();
    await condition(numeric.id).locator('.condition-error').filter({ hasText: '本人理由' }).waitFor();
    await form.getByLabel('本人评估理由').fill('合成测试：本人仍有未排除的口径疑问');
    await form.getByRole('button', { name: '保存本人条件判断' }).click();
    await form.waitFor({ state: 'hidden' });
    await condition(numeric.id).getByText('本人确认：未满足', { exact: true }).waitFor();
    await condition(numeric.id).getByRole('button', { name: '编辑条件与引用' }).click();
    form = condition(numeric.id).locator('.condition-editor');
    await form.getByLabel('阈值', { exact: true }).fill('15');
    await form.getByRole('button', { name: '保存条件修改' }).click();
    await form.waitFor({ state: 'hidden' });
    await condition(numeric.id).getByText('规则计算：未满足', { exact: true }).waitFor();
    await condition(numeric.id).getByText('本人确认：当前规则暂无记录', { exact: true }).waitFor();
    await condition(numeric.id).getByRole('button', { name: '编辑条件与引用' }).click();
    form = condition(numeric.id).locator('.condition-editor');
    await form.getByLabel('阈值', { exact: true }).fill('20');
    await page.reload();
    await page.locator('#object-list button').filter({ hasText: '利润增长' }).click();
    assert.equal(await condition(numeric.id).getByLabel('阈值', { exact: true }).inputValue(), '20');
    numeric = (await state()).objects.find(e => e.id === numeric.id);
    await write([{ op: 'condition.edit', id: numeric.id, scope: 'all', data: { ...numeric.data, rule: { ...numeric.data.rule, threshold: 18 } } }]);
    await page.locator('#refresh').click();
    await condition(numeric.id).getByRole('button', { name: '保存条件修改' }).click();
    await condition(numeric.id).locator('.condition-error').filter({ hasText: '已变化' }).waitFor();
    await condition(numeric.id).getByRole('button', { name: '已复核，以当前版本继续' }).click();
    await condition(numeric.id).getByRole('button', { name: '保存条件修改' }).click();
    await condition(numeric.id).locator('.condition-editor').waitFor({ state: 'hidden' });
    assert.equal((await state()).objects.find(e => e.id === numeric.id).data.rule.threshold, 20);
    await condition(numeric.id).getByText('规则与评估历史', { exact: true }).click();
    await condition(numeric.id).getByRole('button', { name: '读取条件历史' }).click();
    await condition(numeric.id).locator('.condition-history').getByText('旧规则 v1 · 未满足', { exact: true }).waitFor();
    await condition(numeric.id).evaluate(el => el.scrollIntoView({ block: 'start' }));
    mkdirSync('artifacts', { recursive: true });
    await page.locator('aside.details').screenshot({ path: 'artifacts/conditions-browser.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: 条件创建/共享引用/局部派生/独立人工判断/明确材料范围/模型未配置失败/数值计算/改判理由/阈值自动重算/旧确认隔离/草稿刷新/并发复核/历史回查。仅合成材料与隔离数据库，无真实模型或来源验收。');
  } catch (e) {
    if (page) console.error('界面状态:', await page.locator('#notice').textContent(), await page.locator('#conditions').textContent());
    console.error('页面错误:', errors);
    throw new Error(String(e.message).replaceAll(token || 'NO_TOKEN', '[redacted]'));
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise(r => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
    rmSync(directory, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message); process.exit(1); });
