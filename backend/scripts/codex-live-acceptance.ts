import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { createApplication } from '../src/app.js';

// Isolated disposable research, with no Forkwise internal model and no persistent Codex config edit.
const resumeSession = process.env.FORKWISE_ACCEPTANCE_RESUME;
const previous = resumeSession
  ? JSON.parse(readFileSync('artifacts/codex-live-acceptance.json', 'utf8'))
  : undefined;
const directory = resolve(
  previous?.directory ?? process.env.FORKWISE_ACCEPTANCE_DIR ?? '.data/codex-live-' + Date.now(),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
mkdirSync('artifacts', { recursive: true });
const origin = 'http://127.0.0.1:8897',
  owner = { id: 'local-owner', type: 'human' as const };
const setup = createApplication({ database: join(directory, 'research.sqlite'), origin });
const project = previous
  ? setup.repo.project(previous.projectId)
  : setup.write.createProject(owner, randomUUID(), {
      name: '真实 Codex 本机链路验收（演示材料）',
      question: '只验证材料读取、候选研究和受委托记录，不作投资判断',
    });
const token = setup.access.issue('agent', [project.id], 30 * 24 * 60 * 60 * 1000, undefined, [
  project.id,
]);
setup.db.close();
const imports = join(directory, 'imports');
mkdirSync(imports, { recursive: true, mode: 0o700 });
const textPath = join(imports, 'research.txt'),
  imagePath = join(imports, 'scan.png');
writeFileSync(
  textPath,
  '这是验收演示材料，不是企业真实财务数据。\n作者的论证：订单数量增加。如果平均售价保持稳定，营业收入可能增加。价格下降、订单取消和收入确认时间是需要核对的缺口。\n研究者应区分条件性推导与已披露事实，不把这个演示判断用于投资。',
);
const canvas = createCanvas(680, 220),
  ctx = canvas.getContext('2d');
ctx.fillStyle = 'white';
ctx.fillRect(0, 0, 680, 220);
ctx.fillStyle = '#102820';
ctx.font = '24px sans-serif';
ctx.fillText('SYNTHETIC ACCEPTANCE MATERIAL', 25, 50);
ctx.fillText('Orders: 12', 25, 95);
ctx.fillText('Average price: unknown', 25, 140);
ctx.fillText('Not investment evidence', 25, 185);
writeFileSync(imagePath, canvas.toBuffer('image/png'));
writeFileSync(join(directory, 'import-roots.json'), JSON.stringify({ [project.id]: [imports] }), {
  mode: 0o600,
});
const server = spawn(process.execPath, ['dist/src/server.js'], {
  env: {
    ...process.env,
    FORKWISE_PORT: '8897',
    FORKWISE_DATA_DIR: directory,
    FORKWISE_OLLAMA_MODEL: '',
    FORKWISE_OLLAMA_VISION_MODEL: '',
    SEC_USER_AGENT: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLogs = '';
server.stderr.on('data', (b) => {
  serverLogs += String(b);
});
server.stdout.on('data', () => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = {
  tier: '真实 Codex 会话／stdio MCP／真实回环 HTTP，材料为明确演示夹具；委托由隔离验收 owner 签发',
  directory,
  projectId: project.id,
  startedAt: new Date().toISOString(),
  internalModelConfigured: false,
  ...(resumeSession ? { resumedSession: resumeSession, priorStartedAt: previous.startedAt } : {}),
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/health')).ok) break;
    } catch {}
    await sleep(100);
  }
  if (server.exitCode !== null) throw new Error('服务启动失败：' + serverLogs);
  const fullPrompt = `始终用中文回复。你负责执行真实 Forkwise stdio MCP 本机验收，禁止修改源码或读取凭据。所有数据操作只能用 forkwise MCP 工具；可用 shell 仅作等待。当前授权项目 ${project.id}，本次隔离 owner 已签发 personal_record（验收示例代录，不能声称本人核验）。Forkwise 内部模型完全未配置。\n1. 使用 forkwise_import_local_file 分别导入 ${textPath} (text/plain) 和 ${imagePath} (image/png)，source rights=authorized、publisher=验收夹具、publishedAt=null，操作键自选唯一。读任务直至解析完成，用 forkwise_read_project 找 source_version。\n2. 为文字版本建立 reconstruct 外部研究，使用 forkwise_read_material_segment 携带 jobId 阅读，理解作者文字，提交完整 Reconstruction（作者陈述必须精确引用，材料没表达的推导标 ai），至少 3 项陈述和 1 项条件性推导，明确缺口。所有引用采用 UTF-16 绝对位置，不伪造。\n3. 使用 forkwise_read_material_image 阅读原图，按真实可见文字向 forkwise_submit_external_transcription 提交绑定 fileHash/page/region 的未核验转写；不要提交 human_verified。\n4. 回读候选，明确编辑一个陈述，保留归属，再通过 stance.set 代录 pending、理由“验收代录：示例仅用于测试，尚无投资立场”，并通过 note.create 保存演示笔记。创建一个 qualitative 条件并用 evaluation.confirm 代录 unknown，理由“验收代录：信息不足”，保存与执行分别说明。采用一个 AI 或作者候选使用 object.adopt，不能改 origin。\n5. 读取布局，使用 forkwise_edit_drawings 创建稳定 ID live_rectangle、live_text、live_arrow、live_image（引用本项目图片 fileId），调整研究对象位置。将图形安排在 x=50..1000,y=50..700，至少一张主张置于 x=80,y=80，演示文字在 y=480，原图 x=600,y=480,width=500,height=160；普通箭头不能形成推导。修改 rectangle，删除一个临时 ellipse，最后回读布局验证。\n6. 建立 verify 外部任务后编辑目标，再提交对应旧内容版本的 insufficient 结果，确认 stale=true 且未应用当前。另建一个 stance_draft 任务提交 failed 并说明缺口，用 forkwise_retry_external_research 新建记录，取消新记录后尝试晚到提交并确认 TASK_CLOSED。\n7. 回读项目、jobs 和布局。最终报告包含 projectId、完成任务 ID、绘图 ID、过时/失败/取消证据；明确本次是真实 Codex 执行、研究材料是演示数据，SEC 与真实投资研究质量未在本次验证。不要配置 Forkwise 模型，不进行外发、授权或管理操作。
契约示例（须填入本次真实 ID 和内容，不照抄占位值）：外部 reconstruct 提交 request={state:"succeeded",gaps:[],result:{statements:[{key:"orders",text:"作者的原句",origin:"author",citations:[{sourceVersionId:"材料版本ID",start:0,end:5,quote:"精确原句"}],gaps:[]}],inferences:[{key:"growth",premiseKeys:["orders"],conclusionKey:"revenue",reason:"条件推导理由",combination:"joint_required",origin:"author",citations:[],gaps:[]}],gaps:[]}}。必须实际创建至少三个 statement key，包括 revenue，origin=author 的推导也须有效引文。可以用 JavaScript 计算 indexOf 和 length；UTF-16 offsets 由工具页面的 start 加上片段 indexOf 得到。提交完成后再回读 generated candidate_ 对象，不能用直接 statement.create 绕过外部研究提交验收。若工具报参数错误请按返回的实际字段纠正；不要猜字段。
evaluation.confirm 正确命令={op:"evaluation.confirm",id:"稳定新ID",condition:{id:"条件ID",versionId:"条件contentVersionId"},verdict:"unknown",reason:"验收代录：信息不足",evidenceIds:[],citations:[]}。stance.set 正确命令={op:"stance.set",id:"陈述ID",stance:{value:"pending",reason:"验收代录：示例仅用于测试，尚无投资立场"}}；note.create={op:"note.create",id:"笔记ID",targetId:"陈述ID",text:"代录笔记"}；condition.create={op:"condition.create",id:"条件ID",data:{description:"演示判断标准",mode:"qualitative",targetIds:["陈述ID"]}}；statement.edit={op:"statement.edit",id:"陈述ID",text:"改写正文",scope:"all"}，expected 必须包含主张及其直接依赖推导的最新写入 version。
外部 verify 提交 request={state:"succeeded",gaps:[],result:{checks:[{target:{id:"固定目标ID",versionId:"任务输入中的旧contentVersionId"},relation:"insufficient",explanation:"示例资料不足",citations:[],gaps:["示例资料不足"]}],gaps:["示例资料不足"]}}。外部 failed 只需 request={state:"failed",error:"明确失败原因",gaps:["缺口"]}。drawing.put 命令={op:"drawing.put",drawing:{id:"live_rectangle",type:"rectangle",x:50,y:350,width:200,height:100}}；object.position={op:"object.position",id:"研究对象ID",x:80,y:80}；drawing.delete={op:"drawing.delete",id:"临时图形ID"}。`;
  const prompt = resumeSession
    ? `继续本次真实验收，原项目 ${project.id} 和前一轮所有结果保持。MCP 已重启并修复绘图工具的 schema，请先确认 ALL_TOOLS 内有 forkwise_edit_drawings；若无，直接尝试调用 tools.mcp__forkwise__forkwise_edit_drawings，不能再改旧 drawings 冒充画布成功。所有操作只用 MCP。新的凭据仍由隔离 owner 授权同项目个人记录，但此前任务保持原创建 Agent，不要改其结果。
先读取项目和布局，用 forkwise_edit_drawings 的 request={expectedVersion:当前布局version,commands:[{op:"drawing.put",drawing:{id:"live_rectangle",type:"rectangle",x:50,y:350,width:200,height:100}},...]} 在规范 canvas.annotations 创建 live_rectangle、live_text、live_arrow、live_image；原图引用本项目 scan.png 的 fileId（从 source_version 读取），x=600,y=480,width=500,height=160。live_text 文案“验收演示材料：尚无投资立场，未经本人核验”，x=50,y=480,width=500,height=80。至少一个陈述用 {op:"object.position",id:实际陈述ID,x:80,y:80}。再用新布局 version 修改 live_rectangle；创建临时 ellipse 后用 drawing.delete 删除。前一轮误用了旧 drawings，将这次误写的 live_ 前缀旧记录从旧 drawings 删除（保留其他旧数据），通过 forkwise_save_layout 清理时保留整个 canvas 及其新 annotations。最后回读项目、所有 jobs 和布局，报告规范绘图 IDs、原图 fileId、重建成功／stale／失败／取消均来自此前真实会话，材料为演示数据，不能声称真实投资研究或本人逐句确认。`
    : fullPrompt;
  writeFileSync(join(directory, resumeSession ? 'resume-prompt.txt' : 'prompt.txt'), prompt, {
    mode: 0o600,
  });
  const args = [
    'exec',
    '--ignore-user-config',
    '--json',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'mcp_servers.forkwise.default_tools_approval_mode="approve"',
    '-c',
    'mcp_servers.forkwise.command="node"',
    '-c',
    `mcp_servers.forkwise.args=${JSON.stringify([resolve('dist/src/mcp.js')])}`,
    '-c',
    'mcp_servers.forkwise.env_vars=["FORKWISE_URL","FORKWISE_AGENT_TOKEN"]',
    '-c',
    'mcp_servers.forkwise.tool_timeout_sec=60',
    ...(resumeSession ? ['resume', resumeSession, '-'] : ['-']),
  ];
  const child = spawn('codex', args, {
    env: { ...process.env, FORKWISE_URL: origin, FORKWISE_AGENT_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    diagnostics = '';
  child.stdout.on('data', (b) => {
    output += String(b);
  });
  child.stderr.on('data', (b) => {
    diagnostics += String(b);
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise<number | null>((r, j) => {
    child.on('error', j);
    child.on('exit', r);
  });
  const redact = (s: string) => s.replaceAll(token, '[REDACTED]');
  writeFileSync('artifacts/codex-live-events.jsonl', redact(output), { mode: 0o600 });
  writeFileSync('artifacts/codex-live-stderr.log', redact(diagnostics), { mode: 0o600 });
  const started = output
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((event) => event?.type === 'thread.started');
  evidence.sessionId = started?.thread_id ?? resumeSession ?? null;
  evidence.exitCode = exitCode;
  const api = async (path: string) => {
    const response = await fetch(origin + '/api/v1/projects/' + project.id + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`回读失败 ${response.status}`);
    return (await response.json()).data;
  };
  const state = await api('/state'),
    layout = await api('/layout'),
    jobs = await api('/jobs');
  const external = await Promise.all(
    jobs
      .filter((j: { executor: string }) => j.executor === 'external')
      .map((j: { id: string }) => api('/jobs/' + j.id)),
  );
  Object.assign(evidence, {
    objects: state.objects.map((e: { id: string; kind: string; data: unknown }) => ({
      id: e.id,
      kind: e.kind,
      data: e.data,
    })),
    drawingIds: layout.data.canvas?.annotations.elements
      .filter((e: { isDeleted: boolean }) => !e.isDeleted)
      .map((e: { id: string }) => e.id),
    layoutVersion: layout.version,
    jobs,
    externalResults: external.map((j) => ({
      id: j.id,
      state: j.state,
      input: j.input,
      output: j.output,
    })),
  });
  const kinds = state.objects.map((e: { kind: string }) => e.kind);
  evidence.passed =
    exitCode === 0 &&
    kinds.includes('inference') &&
    kinds.includes('note') &&
    kinds.includes('evaluation') &&
    evidence.drawingIds instanceof Array &&
    ['live_rectangle', 'live_text', 'live_arrow', 'live_image'].every((id) =>
      (evidence.drawingIds as string[]).includes(id),
    ) &&
    external.some((j) => j.output?.stale === true) &&
    external.some(
      (j) =>
        j.kind === 'research.reconstruct' &&
        j.state === 'succeeded' &&
        j.output?.coverage?.serverReads?.length > 0,
    ) &&
    external.some((j) => j.state === 'failed') &&
    external.some((j) => j.state === 'cancelled');
  if (!evidence.passed) process.exitCode = 1;
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : '未知失败';
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise<void>((r) => (server.exitCode !== null ? r() : server.once('exit', () => r())));
  writeFileSync('artifacts/codex-live-acceptance.json', JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      projectId: project.id,
      passed: evidence.passed,
      failure: evidence.failure,
      directory,
    }),
  );
}
