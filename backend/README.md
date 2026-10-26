# 见岔（Forkwise）本机后端

此目录包含 SQLite 持久化、业务 API、持久化研究任务、本机 MCP 与接入原 Excalidraw 组件的研究工作台。它能运行和接受协议测试，但尚不等于完整首版验收。旧 `prototype/forkwise-step-prototype.html` 的浏览器存档保持独立；当前没有自动迁移用户存档。

开放工作台的 UI 与 Agent 可按[紧凑读取合同](../docs/adr/0022-compact-map-read-contract.md)核对同一 snapshot：`GET /api/mapping/projects/{projectId}/map?view=index&budget=131072`，再携带原 snapshot、cardId 读取 body/detail。MCP 只读工具 `forkwise_read_map` 连接开放工作台的实际回环端口；沿用明确签发的项目 Agent 凭据，不因工具存在而新增授权。预算为完整 Mapping JSON 的 UTF-8 字节，分页和正文分片必须固定 snapshot；当前仅覆盖已有普通卡片，未来类型由拥有者票扩展。

## 安装和启动

要求 Node.js >= 22.22.2、npm，首轮实现实际使用 Node.js 24.4.1。完整构建包含正式开放工作台与旧研究画布，两者依赖分别安装。

```sh
cd /Users/d0m999/Desktop/forkwise
npm --prefix frontend ci
npm --prefix backend/canvas ci
cd backend
npm ci
npm run build
npm start
```

`build:canvas` 从 `canvas/` 构建到 `web/canvas/`，完整 `build` 再将旧工作台资源复制到 `dist/web/`。正式工作台的构建与入口仍为 `build:workspace` / `start:workspace`，使用独立数据目录，见[开放工作台说明](../docs/open-workspace.md)。

默认绑定 `http://127.0.0.1:8787`。本机会话入口写入 `.data/local-access.json`，权限为 `0600`；使用其中 `url` 打开工作台，不要将该文件分享或加入版本库。URL 中的会话令牌在加载后从地址栏移除。数据库、原文件、备份及任务历史在 `.data/`。服务使用数据目录进程锁，不能同时启动两个实例操作同一目录。

可配置环境变量：

| 配置                           | 用途                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `FORKWISE_PORT`                | 本机端口，默认 8787                                                          |
| `FORKWISE_DATA_DIR`            | 数据目录，默认当前目录的 `.data`                                             |
| `FORKWISE_OLLAMA_MODEL`        | 用于研究和定性评估的本机模型，必须明确版本标签；不接受省略标签或 `:latest`   |
| `FORKWISE_OLLAMA_VISION_MODEL` | 用于截图和 PDF 页转写的本机多模态模型，同样要求明确标签                      |
| `SEC_USER_AGENT`               | SEC 请求所需的真实应用名称与联系邮箱，格式见 `../public-data-core/README.md` |

Ollama 只连接 `127.0.0.1:11434`，代码不安装或拉取模型。未配置时任务明确失败并保留输入，不调用外部替代模型。模型真实能力、供应商资质和识别质量仍需分别验证；本次真实 SEC 取数范围见交付证据。`metrics.json` 是数据目录中的已启用确定性指标名称数组；默认空，示例指标不自动进入白名单。

## 操作与同步契约

浏览器与 MCP 共用 `/api/v1`。完整契约见生成的 `openapi.yaml`；运行中也可携带会话访问 `/api/v1/openapi.json`。除健康检查外，API 要求 `Authorization: Bearer ...`，写操作通常还要求 `Idempotency-Key`。跨网站 Origin、非配置 Host、跨项目 Agent 请求都被拒绝。

图谱提交使用 `POST /projects/{projectId}/operations`：

```json
{
  "expected": { "existing_object_id": 3 },
  "commands": [
    { "op": "statement.edit", "id": "existing_object_id", "text": "新的研究表述", "scope": "all" }
  ]
}
```

`expected` 包含操作实际依赖的对象写入版本。共享修改还要包含受影响推导；新增对象可在同一批次引用。批次原子校验和写入，返回完整 `upserted`、`deletedIds`、前后项目修订号。`GET /projects/{projectId}/sync?afterRevision=...&layoutVersion=...` 返回至多 100 批连续变化；断档返回 `needsSnapshot`。首次打开和断档时读取 `/workspace`，同一事务内取得图谱与布局。客户端整批应用变化，读取期间本地编辑则保留草稿。任务列表只传摘要，详情按需读取。网络结果未知时先查询原操作键，找不到再以原请求和原键重试；不换键重复创建。

`layout` 可随业务批次提交自己的 `expectedVersion` 与布局数据，实现文字转卡、连线转换、关联删除等操作的原子保存。独立移动、绘图、样式不增加研究内容版本。自由绘图不能注入研究对象；研究图谱始终从领域对象生成。引用和评估绑定不可变内容版本，个人立场及 AI 候选分别记录。

## 操作历史

原画布的撤销／重做按钮和快捷键已接入后端。一次业务批次及其连带对象、布局作为一步，拖动/绘图在动作完成时入栈；视口、选择、未提交草稿和无变化保存不产生步骤。每项目最近 40 步持久保存，撤销恢复内容与原内容版本身份，写入版本仍递增。来源、原文和原文件保留；未提交草稿不被撤销覆盖。

`GET /projects/{projectId}/action-history` 返回 `{version, undo, redo}`，动作摘要为 `{id,label}` 或 null；工作区与同步也包含该状态。本人会话可向 `POST /projects/{projectId}/action-history/travel` 发送 `{direction: "undo" | "redo", expectedRevision, expectedHistoryVersion, expectedLayoutVersion}` 与唯一操作键。任何并发变化均拒绝；响应丢失查询原 `/operations/{key}`，不能换键再撤销。MCP 共用上述契约，但 Agent 凭据不能执行历史旅行或恢复本人判断。

新发起的首次研究从排队时记为“梳理并查证”一步，重建、节点候选和逐项证据追加到该步骤。期间本人编辑或布局继续独立；异步追加会清除重做分支。撤销在同一事务中停止父子任务，重做只恢复已完成结果；原执行不能重新领取或重试，晚到响应被丢弃。任务返回可选 `historyState: applied | undone | stopped`，与 `state` 执行记录分别呈现；`stopped` 表示重做已恢复完成结果而原执行保持停止。继续研究须创建新任务。

SQLite 及 JSON 保存最近栈、游标和独立的 `workflowGroups` 归属/停止状态。超出 40 步的研究不重新占栈，停止状态不会随栈淘汰或重做分支清除而丢失。导入校验父子任务、唯一归属、运行状态和历史回放；旧资产缺少分组或操作栈时仍可导入，保留原有阶段历史与审计，不自动合并。独立后台评估完成仍为独立一步。旧原型栈重放、大图片历史容量与真实研究案例仍待验收。参见 ADR 0019、D136–D137。

## MCP

先在工作台为项目签发 Agent 授权，再在 Agent 软件中配置 stdio MCP：

```json
{
  "mcpServers": {
    "forkwise": {
      "command": "node",
      "args": ["/Users/d0m999/Desktop/forkwise/backend/dist/src/mcp.js"],
      "env": {
        "FORKWISE_URL": "http://127.0.0.1:8787",
        "FORKWISE_AGENT_TOKEN": "由工作台签发的项目令牌"
      }
    }
  }
}
```

先运行后端服务。MCP 只代理 HTTP 业务接口，不直写数据库。默认没有个人记录能力；只有本人显式签发的项目委托才可代录规定操作，执行者始终保留为 Agent。可读取图谱、历史和材料，提交候选与业务操作，调整布局，检索、获取目录内公开资料、发起评估/研究/转写任务、查询及取消任务。授权默认 30 天，可在工作台列出并撤销；本机会话默认 8 小时。备份不携带访问令牌，恢复后重新授权。

## 材料与模型任务

工作台“判断条件”支持定性、数值、混合规则及多个观察期间，能引用同一条件、修改全部引用或仅对选定引用派生新条件。数值字段无默认阈值；未知值不能填零。编辑草稿保存在浏览器，保存时检查条件及相关对象版本，冲突保留草稿并要求明确复核。引用调整保持规则内容版本与原评估，局部派生的新条件不继承原人工确认。

条件评估先明确选择证据，支持独立记录本人判断及根据候选填写判断。改判须补充本人理由，沿用理由保留候选来历。条件下显示当前规则任务的状态、失败和重试；条件保存与计算状态分别报告。旧规则下的确认仅出现在历史。混合任务由代码计算数值要求、模型评估定性要求，保存两部分结果；仅规则明确 `mixedCombination: joint_required` 时按共同满足组合为候选，其他标准保留分项及总体意见；不支持从任意自然语言自动执行布尔逻辑，也不以模型意见覆盖数值缺口。公开接口的任务摘要 `condition` 引用仅含条件 ID 和内容版本。

原文件以 BLOB 存在 SQLite，与文本及定位产物分别保存。PDF 文本提取和页图渲染在受时间/内存边界约束的 worker 中运行；HTML 不执行脚本、不加载外部资源。单原文件上限 25 MB，正文上限 500 万字符；研究任务一次最多选择 30 份材料；首次研究的初始观点输入仍最多 20 份。内部模型全文模式总计上限 100 万字符，包含对象等上下文的序列化输入上限 120 万字符；超限明确拒绝，不静默截断。外部任务固定范围而不随创建传全文，Agent 使用分段接口按需读取。

研究接口及 MCP 支持可选 `retrieval: { queries: ["原文关键词"], maxCharacters: 80000 }`，只在明确选择的材料版本内检索，不扩展到其他材料或项目。关键词最多 8 个，字符预算为 2–20 万，默认 8 万；当前按原文关键词做全文检索，不伪称语义召回。各来源均分字符预算，记录实际片段、原文绝对位置、覆盖字符数、候选及预算上限。模型只能引用实际提供的连续片段；引用超出范围即使原文确有其句也会拒绝。没有命中时不调用模型，返回资料不足而非否定主张。工作台可查看片段、未覆盖说明和完整原文；原始材料保留，重试使用固定片段，任务与资产导出带相同范围。

带固定 SEC `companyfacts` 来源元数据的材料使用完整财务记录检索：匹配科目名称/标签/说明、单位或记录原文，并一并提供主体、taxonomy、科目和单位的原文位置。最多 200 条完整记录，字符预算同时包含父级口径；超限整条跳过并标记缺口。记录带 JSON pointer、结构角色和 UTF-16 位置，保留所有选中的披露版本及原始数字词元。缺失期间/披露身份/数值和未确认的单季或累计口径逐条显示，来源 CIK 不一致、重复键或结构损坏拒绝。任务运行和恢复后显式重试均校验固定片段及结构，不重跑检索替换输入。目前没有主张到财务科目的可靠自动映射或完整可比性判定。

SEC `submissions` 按同一行绑定所有列式申报字段，连同主体和历史文件目录取材。每段的 `recordPointer` 绑定 accession 字段原文；列长错位、重复键和错误主体拒绝。任务详情按申报编号/类型/日期分组，原版与修订版分别保留，可定位每个字段的原文并由本人打开安全 SEC 文件入口。索引不等于申报正文、附件或历史分片，详情和模型输入明确未读范围；文件链接仅构造入口，未联网验证。保存的任务再次运行须通过原文、行归属、完整列及派生目录元数据校验；无结构标记的旧索引片段任务明确失败，保留历史并提示从原材料新建，不能静默重选输入。两类 JSON 解析共享有界原文位置索引，不扩充 MCP 写入职责。

截图或 PDF 页可显式发起多模态转写。输出逐块保存文字、归一化区域、页码、缺口和未核对标记。页面识别完整只表示处理覆盖，并非文字正确。工作台支持原图对照、区域修改和人工校正；校正另存来源版本，固定来历，保留旧引用。保存人工校正后按引用定位受影响对象，自动排队影响分析；不足以排队时保留校正和明确缺口。建议须本人选择作用范围后采用，记录固定旧版本与 AI 来历，不覆盖人工条件确认。PDF 单页转写明确标注其余页不在本次范围内。

研究任务提供材料重建、依据选定材料查证、影响建议和立场理由草稿。模型无交易、外发和任意文件写入工具。独立 `research-tasks` 的查证仍只使用选定材料；首次研究由独立编排服务负责取材，不能把某个模型子任务描述为执行了全网搜索。AI 新证据关联仍是候选，个人采用和立场另行保存。

当前原生画布的空白区域及工具栏提供“输入观点 / 材料”。可粘贴原文并开始研究，也可先导入 PDF/HTML/PNG/JPEG，再明确选择解析出的文字版本。原始网址仅作出处记录，不自动抓取 X 或网页；图片没有转写时提示先处理原图。作者、权限、正文范围和发布时间独立保存，输入草稿按项目保存在浏览器。

入口与原文件/研究面板共用可恢复请求：发送前保存到本机 IndexedDB，刷新后先查原回执，再用原键恢复尚未完成的步骤。结果未知时保留原请求，不生成新键重做。明确拒绝可回到输入，已保存文字可直接选用；不能将恢复存储失败冒充后端没有保存。浏览器草稿和未完成上传请求不包含在服务端项目备份中；本机存储不可用时该入口停止新请求，图谱其余功能继续可用。

`POST /projects/{projectId}/files/import`（MCP：`forkwise_import_file`）接受 `{source: {title, publisher, rights, url?}, file: {name, mime, base64, publishedAt}}`。来源、原文件及解析任务原子保存，返回 `{fileId, hash, job, deduplicated, changes}`；同键恢复不会重复创建。格式/大小或任务容量校验失败全部回滚；后续解析失败保留合法原文件。既有 `/files` 保留向已存在来源上传版本的能力。文件上限和类型沿用 25 MB、PDF/HTML/PNG/JPEG，Agent 仍受项目授权，受限路径入口见下文；普通字节接口不读取路径。

`POST /projects/{projectId}/initial-research`（MCP：`forkwise_initial_research`）接受 `{ "sourceVersionIds": ["已保存的观点材料版本"] }`。工作台“对选定材料进行研究”默认提供该入口。流程依次执行论证重建、目录内来源规划、SEC 数据集获取与逐项目标查证；固定目标和推导端点的内容版本。来源规划由已配置模型产生，当前只允许 SEC `companyfacts` / `submissions`，每次最多 10 个不同数据集；不确定 CIK 或目录不覆盖时应返回缺口。模型对主体和期间的识别质量仍待真实案例验证，索引文件不等于实际财报内容。

来源计划的 `submissions` 请求可带 `filings: {forms: ["10-Q"], filedFrom: "2025-04-01", filedThrough: "2025-04-30", includeHistory: true}`。数据核心按确切类型与含首尾的披露日期范围选择固定索引记录，编排取得主文件正文后继续逐项查证；不猜 accession/URL、不用业务期间代替披露日期、`/A` 修订版须显式包含。每次研究最多 10 个不同正文，超限保留错误，不静默截取。父任务 `filings.selections` 记录各目标的范围、匹配数（失败时可为 null）和缺口，`filings.acquisitions` 记录共用的子任务及正文版本。取得正文不等于取得附件、图片或完成财务口径核对。

计划明确 `includeHistory: true` 时，先从固定根索引选择与披露日期范围相交的历史分片，再沿用原条件选择正文；旧计划省略该字段时不扩大范围。每次至多 10 个历史分片，未知目录日期留缺口、不相交项记录为排除。父任务 `history.selections/acquisitions` 保存选择范围、排除数、子任务和材料版本；根索引与历史分片重复列出的申报只在地址/类型/日期相同时共用正文，并在 `filings.acquisitions.indexBindings` 保留各索引绑定，冲突停止自动选择。工作台可查看获取状态和阅读历史原文。

父任务保存阶段、目录版本、子任务身份、材料覆盖和缺口。各阶段仍复用已有业务服务；来源失败不撤回重建，显式重试复用成功阶段，新取得材料会产生新的查证任务并保留先前结果。正文任务同样纳入持久研究历史分组，恢复时核对固定输入、原结果及文件/文本指纹。取消父任务同时取消其未完成子任务，晚到结果不能入库。预测查证强制使用 `current_basis`，推导使用 `inference_basis`，已披露事实使用 `reported_fact`；这些字段限定分析范围，不保证模型判断正确。未来验证事件保存为独立 AI 节点候选，须通过本人确认操作才形成本人安排。

可选 `asOf` 使用完整 ISO 时间，界面按本机时区输入后转换。历史模式要求原始材料当时已记录且已取得，公开依据也仅复用符合该时点的本机快照；已知发布时间不能晚于该时点。缺少历史快照时保留 `not_known`，不会获取当前报告并冒充过去已知。首次研究的来源计划会提供检索词，计划有检索词时使用上述局部检索；材料总量超过 8 万字符却没有检索词时保留资料并说明补充方式。初始观点材料也可显式指定 `retrieval` 缩小重建范围。超过 500 万字符的原始 SEC 数据仍未接入正文库；结构化记录的期间缺失、口径未确认等仍须保留为缺口。财务字段白名单及口径规则不因文字检索扩张，内部模型真实研究质量与完整 SEC 申报链路仍未验收；本次 submissions 实时取数见交付证据，不能据此宣称 D48 完整可用性已验收。

`verification.propose` / `verification.confirm` 通过已有 `POST /projects/{projectId}/operations` 与 MCP `forkwise_apply_operations` 使用同一契约。请求带 `target: {id, versionId}`、按 ID 排序的直接上下文 `context: [{id, versionId}]` 和 `details: {event, goal, period, date}`；其中 versionId 是内容版本，主张的 context 为空，推导列出全部直接前提与结论。外层 `expected` 仍是目标、上下文与已有节点的写入版本。候选还带 `gaps`；内部 `sourceTask` 仅受控系统能填写。

`GET /projects/{projectId}/research-results` 返回 `{projectId, revision, targets}`，逐对象给出固定目标/上下文、当前候选与已采用依据数、旧/缺少范围的依据数、核对记录分类及最近当前记录的短预览。摘要不加载到响应中的材料全文、引用全文或图谱变化；依据数量不能当作独立来源数或真假评分。`GET /projects/{projectId}/objects/{id}/research-results?limit=20&cursor=…` 读取指定对象的依据关联身份和逐次核对，包含适用性、原引用、缺口、已记录的模型/取材范围；上限 50 条，返回 `nextCursor`，游标不可跨项目或对象使用。完整任务仍按既有任务接口读取。

MCP `forkwise_read_research_results` 不带 `id` 时读摘要，带 `id` 时读对象记录，可选 `limit/cursor`；分页必须提供对象。API/MCP 复用同一只读服务和项目授权。`current` 只表示对应当前固定内容；`stale`、`withdrawn`、`unbound` 分别表示旧范围、研究已撤销和范围无法核对。推导前提改写也会使结果过期，修改立场不会；执行期间整体过期而未应用的任务结果不能被当成已应用。无命中时即使没有新证据对象，也保留证据不足记录。

工作台从主张查证区或推导“查证与立场”直接查看这些记录；当前候选可逐条采用、固定引文可回源，验证节点在独立区域确认。摘要按项目修订发布，面板读取按项目/对象/修订丢弃迟到结果。

D142 的第七次迁移增加 `research_result_jobs` / `research_checks` 派生索引。原始 `jobs`、证据对象及版本历史继续作为事实来源；SQL 触发器在任务写入事务中更新索引，读取轮询不再解析任务长材料。适用性仍动态核对当前内容/推导端点及撤销状态。索引失败时本次任务结果与候选写入一起回滚；显式重试沿用现有任务机制。

打开数据库会用 migration 0006 定义的视图重建索引，旧库升级与损坏缓存恢复在服务启动前完成。JSON 资产不导出派生行；SQLite 备份权限省略后和隔离恢复时也重建，研究指纹继续只覆盖原始资产。项目清理通过任务删除触发同步清除派生记录，包括受管理副本。索引多占存储并增加一次启动/恢复开销；`scripts/research-results-capacity.ts` 可在临时数据库重现 10/100/500 个合成任务的读取、写入、体积及重建测量，结果见 `artifacts/research-results-capacity-before.json` 与 `-after.json`，不代表真实投资材料或端到端延迟验收。

本人确认时 event/goal 必填，period/date 可为 null，日期采用 YYYY-MM-DD。候选与本人节点身份独立；确认可带 `basedOn` 候选版本。一个目标仅有一个本人节点，修改须传该节点 ID 与当前写入版本；同字段/同上下文不新增版本。AI 后续建议不覆盖确认；内容或前提变化后旧节点保留为需复核。`status=confirmed` 只表示本人曾确认安排，消费端必须比较绑定版本判断当前适用性。节点不改变个人立场、预测结果或条件评估，不创建定时任务。工作台支持节点草稿、明确复核、版本历史和卡面摘要；当前节点批次已纳入操作历史，新首次研究的节点候选随该研究整组撤销。

任务有排队、运行、成功、部分完成、失败、取消、中断状态。进程重启后运行中的任务标为中断，须显式重试；取消后的晚到结果不得应用。用量未知保存 `null`，不填零。规则保存与任务结果分别处理。

`GET /projects/{projectId}/summary` 导出 Markdown 研究摘要；可用 `judgmentId` 指定固定历史判断。摘要包含条件、人工确认与 AI/规则意见、引用版本和来源时间；导出本身不会记录新判断。

## 影响建议复核（D146）

项目中的“影响建议与复核”、对象编辑区和影响任务结果均能打开列表，对照建议形成时与当前的内容／前提，回查引文并逐条处理。选择“维持原判断”或“修订判断”须填写理由；“稍后处理”仍需复核。保存复核不改个人立场，也不采用 AI 修改。旧建议和旧草稿须明确按当前状态重新核对，改写或保存立场继续使用各自入口；复核草稿保存在浏览器，服务端备份不含草稿。

`GET /api/v1/projects/{projectId}/impact-reviews` 接受可选 `targetId`、`jobId`、`limit`（默认 20，上限 50）、`cursor`，返回逐条 `proposalState`、`reviewState`、原／当前内容、直接上下文、引用和复核对象。`reviewState=completed` 只对应本条当次内容／立场／前提；变化后为 `stale`，尚未处理为 `pending`，稍后处理为 `later`。MCP `forkwise_read_impact_reviews` 共用同一接口，按需读取，不做新的后台轮询。

本人通过既有 `/operations` 保存 `{op: "impact.review", id, jobId, proposalIndex, target, context, disposition, reason}`。`target.versionId` 是本人此次看到的目标写入版本；`context` 按 ID 排序，固定直接端点内容版本；外层 `expected` 包含目标、端点和已有复核对象的写入版本。读取结果的 `current.expected` 提供对应范围；旧版本写入失败保留草稿。复核身份／指纹与时间由服务校验，Agent 不可代为确认。一条建议只有一份当前记录，更新沿用 ID；无变化保存不新增历史。记录纳入完整变化集合、原键恢复、撤销重做、JSON/SQLite 和 Markdown，导入检查原任务及全部固定版本。

`impact.adopt` 同时校验原目标和推导前提／结论内容版本，旧前提下的建议不能直接采用。复核完成不产生新模型任务。D147 已补新原文和已有材料的更新预览及来源内容事件归集；完整异步取材预览、跨文件披露归并、条件新旧值对照与真实模型质量继续开放。

## 手动更新与范围预览（D147）

在“手动更新与复核”中选择已有来源并粘贴新原文，或选用已保存的可读材料；填写公司／主题并勾选具体主张、推导，先预览再确认。预览列出直接上下文、仅供查看的下游范围、原文字符数、新任务数及可复用任务；金额和 Token 估计未知。新原文字符串原样保存，材料与排队同事务完成。已成功保存的材料不会因模型失败消失；复核与个人判断仍分开。

- `POST /api/v1/projects/{projectId}/manual-updates/preview`：`{scopeLabel, material, targetIds}`；`material` 为 `{kind:"text", sourceId, text, retrievedAt, publishedAt, coverage}` 或 `{kind:"existing", sourceVersionId}`。只读、不调用模型，返回 `previewHash`、固定范围、重复覆盖及用量说明。
- `POST /api/v1/projects/{projectId}/manual-updates`：同输入加 `previewHash`，带 `Idempotency-Key`。相关版本变化返回 `UPDATE_PREVIEW_CONFLICT`；返回材料版本、事件身份、新／旧任务 ID 与完整 `changes`。结果未知时先查询原操作回执，保留原键。
- `GET /api/v1/projects/{projectId}/manual-updates` 与 `GET /api/v1/projects/{projectId}/manual-updates/{eventKey}/tasks`：事件及本事件任务分别分页，`limit` 默认 20、最多 50，`cursor` 绑定项目与范围，不返回材料原文。

MCP 对应 `forkwise_preview_update`、`forkwise_submit_update`、`forkwise_read_updates`、`forkwise_read_update_tasks`。相同来源内容、目标内容和直接端点版本复用已有任务；失败／中断显式重试，取消后主动重新预览提交可以新建任务；重述的新内容另成事件。只有本人可以记录 D146 复核结果，Agent 提交更新仍不能改变个人立场。

输入草稿留在本机浏览器。请求发送前写入共享 IndexedDB 恢复记录，刷新后可在本窗口恢复；明确拒绝后“保留草稿，重新预览”。无变化的重复提交不会新增模型任务。文件、SEC 等异步取得仍通过原入口完成后选用；此实现没有启用定时取材、跨文件披露自动归并或数值条件新旧值对照，也未完成真实金融观点质量验收。

## 备份、恢复、删除

文字来源可在材料浮窗按固定版本阅读、高亮引用、前后分段、放大/还原并返回原画布。引用位置或保存指纹不匹配时明确拒绝定位，不改读最新版本。任务片段、查证引用和条件评估依据共用此入口。粘贴文本默认按摘录保存，可选全文或范围不确定，并可记录原始 URL（不会自动抓取）。`source.import` 的可选 `coverage` 与来源版本共用 `full/excerpt/unknown`，旧记录按未知显示；API/MCP、JSON 恢复和 Markdown 保留该标注。浏览器使用约 12000 字符的分段接口，返回固定版本、全文和段指纹；既有全文接口保留兼容。

旧原型工作区可在左侧“迁移旧原型副本”选择 JSON、选择项目、预览转换结果，再确认创建新项目。预览不会保存数据；旧数据库和已有项目不被覆盖。迁入当前主张/推导、个人立场、材料及有效引用、画布位置/样式/批注/图片；“查看旧版迁移记录”可回看作者原版、初始对照、旧历史，复制旧草稿，下载单项目原型恢复副本。旧模拟查证和旧撤销栈保留为只读记录，不冒充新后端结果；新版本从导入时建立 v1。工作区文件上限 80 MiB，浏览器先按项目隔离上传，单项目上限 25 MB；原有正文 500 万字符及画布 12 MB 限制仍适用。

对应本机会话接口为 `POST /prototype-migrations/preview`（`{workspace}`）、`POST /prototype-migrations`（`{workspace, previewHash}`，带原 `Idempotency-Key`）及 `GET /projects/{projectId}/prototype-migration`。同一副本不会重复创建，网络结果未知时在同一预览窗口原键重试。恢复文件随项目 JSON/备份保留且随项目清理；明确受限来源会使完整旧档不进入 JSON 导出。当前未对用户实际 IndexedDB 存档执行迁移；D133 已迁入静态原图区域和对象材料/隐藏记录；旧动图引用因缺少帧号仍需重新定位。旧版本来历及旧撤销重放保留旧档待适配。转换器 v2 保持 v1 迁移说明可读，已迁入 v1 的项目不会自动升级或覆盖。

工作台可在线备份 SQLite 和项目 JSON，并恢复到新的隔离目录。校验后仍需停服，再用恢复命令预览并明确切换：

```sh
npm run restore -- /绝对路径/已校验的恢复目录
npm run restore -- /绝对路径/已校验的恢复目录 --confirm-replace
npm start
```

切换前另存当前状态备份；恢复日志用于处理中断，运行中的服务会拒绝替换。备份指纹 v4 包含图谱历史、材料、文件、定位、布局、判断、研究任务、操作历史及研究分组归属/停止状态。旧版指纹按其记录版本校验。

删除项目须确认项目名和当前修订号。默认保留 30 天，可调整后续删除的保留期；既有截止时间保持。服务启动和运行期间会清理已到期项目及受管理 SQLite/JSON 备份、恢复副本，失败保留清理记录并可重试。应用无法替用户清除已手动拷贝到其他位置的文件。受权利限制的原文/原文件在备份和导出中只保留索引及缺失说明。

## 验证与剩余范围

```sh
npm run check
npm test
npm run openapi
npm run build
node scripts/browser-smoke.cjs
```

浏览器脚本使用独立 Chromium 和临时数据库，当前默认使用这台开发机上的 Playwright 与 Chrome 路径；其他机器需调整脚本或提供对应运行时。普通测试使用临时或内存数据库，不操作实际研究存档。

最新覆盖、未完成项与真实服务证据见 `../docs/plans/backend-implementation-2026-10-08.md`。当前主要缺口仍包括旧 IndexedDB 资产的完整迁移、完整研究流程编排、若干画布任务和撤销语义、真实模型/来源及本人案例验收。目录和 MCP 尚未独立发布到 GitHub，不把可运行实现当作已开源发布。


### 对象材料和原图区域（D132）

选中画布图片，点击“加入卡内材料”并选择卡片。服务读取已保存原图，以一个事务保存文件与对象材料归属。响应丢失后打开材料列表的“恢复图片加入材料操作”，沿用原键重试。项目材料列表可以加入当前对象或从其列表移除；移除保留原文件和证据。材料不会自动表达支持或改变个人立场。

“原图框选证据”支持拖动框选、数字坐标、暂不判断/支持/反对/限定/背景、修改关系及解除关联。保存固定原图和内容版本，重复保存同一区域复用；推导前提改变后必须重新核对。动图按第一帧，PDF 手工区域引用尚未接通。原图材料未识别文字时不进入全文索引；文本评估器明确拒绝未读取的图像依据。

接口为 `POST /api/v1/projects/{projectId}/canvas-materials`（本人），请求包含 `targetId`、`expectedTargetVersion`、`imageId`、`expectedLayoutVersion` 和 `Idempotency-Key`。常规业务命令新增 `material.attach`、`material.hide`、`evidence.relate`，共享 API/MCP 契约及本人权限边界。`evidence.link` 新关联记录直接上下文，调用方须提供推导端点写入版本。图片引用使用 `kind: image`、`sourceVersionId`、`fileId`、`page: 1`、`imageWidth/imageHeight`、`region`，文字引用继续使用原契约。本次已补 MCP 原图读取及外部转写；真实客户端验收范围见文末 D149 交付证据。


### SEC 申报正文与历史索引（D143 / D144 / D145）

在申报索引的研究任务结果中展开具体申报，点击“获取正文并保存为材料”。界面、`POST /api/v1/projects/{projectId}/public-data/filing` 和 MCP `forkwise_fetch_sec_filing` 共用固定索引版本与申报编号契约：`{indexSourceVersionId, accessionNumber}`，写入须有 `Idempotency-Key`。缺失、重复或不安全记录在联网前拒绝；任务类型为 `source.sec-filing`，使用既有取消、显式重试及原请求恢复。

原始 HTML 文件先独立落盘，后续解析失败不丢文件。正文和 DOM 定位通过同一受控材料解析操作保存，解析结果、文件指纹、索引版本/行和获取回执均保留；恢复后重试优先处理已保存字节，无须再次联网。下载和解析分别产生完整变化集合，不能跨过交错编辑拼成一次原子写入。查看任务结果可阅读保存正文，再明确选择该材料发起查证；取材不产生证据关联或个人立场。仅索引披露日期不会填成正文精确发布时间。

目前支持原索引中的 UTF-8/ASCII HTML 主文件，原文件上限 25 MB、当前 HTML 解析上限 500 万字符，超过解析边界时保留原件及失败。附件、图片识别及完整表格财务口径核验仍待接通。真实网络仍要求本人 `SEC_USER_AGENT`；合成 API/MCP/浏览器验证不代表真实来源或模型质量。

`POST /api/v1/projects/{projectId}/public-data/history-index` 与 MCP `forkwise_fetch_sec_history` 接受 `{indexSourceVersionId, fileName}`，沿用项目权限和 `Idempotency-Key`。`source.sec-history` 任务只取得固定根索引目录中的同主体分片，不接受任意 URL。材料来源版本保存 `provenance.indexParent`（父版本 ID 与快照 hash）；原始 JSON 保持顶层列式结构和原文定位。获取、全文/片段查证及恢复都核对父目录、材料和固定范围。数量或有效披露日期偏离固定目录时拒绝，需重新取得目录后新建任务；403 不自动重试。任务纳入取消、研究撤销、JSON 恢复及显式续跑，`asOf` 仅用当时已记录且已取得的本机分片。SDK 细节见 `../public-data-core/README.md`，真实历史 JSON 兼容性仍待验收。


## D149：外部 Agent 本机交付

本阶段不要求配置 Forkwise 内部模型。数值条件仍走确定性工具，Agent 梳理论证、阅读材料及提交定性候选。已有内部模型接口作为兼容能力保留，未配置时不会替代外部执行。

Codex 使用 stdio MCP，令牌通过进程环境转交。将以下非秘密配置加入 Codex 的 `config.toml`，启动 Codex 的进程提供 `FORKWISE_AGENT_TOKEN` 和可选 `FORKWISE_URL`：

```toml
[mcp_servers.forkwise]
command = "node"
args = ["/Users/d0m999/Desktop/forkwise/backend/dist/src/mcp.js"]
env_vars = ["FORKWISE_AGENT_TOKEN", "FORKWISE_URL"]
```

格式及环境变量转交方式已核对 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。不要将令牌写入源码或可分享配置。工作台“授权本项目给 Agent”的复选框默认关闭个人记录委托；开启后仅允许当前项目的立场、理由、对象采用、笔记和条件确认。撤销立即失效，旧凭据无新能力。管理、恢复、项目删除、人工转写核验仍须本人会话。记录中的 `actor.type` 仍为 `agent`，`actor.delegation` 保留授权范围；AI 内容的 `origin` 不变。授权不是逐句本人审核证明。

| MCP 工具 | 共用 HTTP 操作 | 作用 |
| --- | --- | --- |
| `forkwise_begin_external_research` | `POST /projects/{id}/external-research` | `{kind, sourceVersionIds, targetIds, retrieval?}` 固定输入；不把全文随创建结果传输 |
| `forkwise_begin_external_evaluation` | `POST /projects/{id}/external-evaluations` | `{conditionId,ruleVersionId,evidenceIds}` 固定条件与证据；不调用模型 |
| `forkwise_submit_external_research` | `POST /projects/{id}/external-research/{job}/submit` | `{state,result?,error?,gaps,agentCoverage?,agentUsage?}`；研究结果结构沿用 reconstruct／verify／impact／stance_draft，评估结果沿用 AssessmentResult |
| `forkwise_cancel_external_research`／`forkwise_retry_external_research` | `POST …/{job}/cancel`／`retry` | 取消拒绝晚到，重试另建记录并保留 `input.external.retryOf` |
| `forkwise_import_local_file` | `POST /projects/{id}/files/import-path` | 指定目录内单文件路径导入；文字支持 UTF-8 `text/plain` |
| `forkwise_read_material_segment` | `GET /projects/{id}/materials/{version}/segments` | start／limit；最多 20,000 UTF-16 单位，字符边界、固定及分段指纹、解析锚点 |
| `forkwise_read_material_image` | `GET …/materials/{version}/image-data` | 指定页，MCP 返回实际图像及原文件指纹 |
| `forkwise_submit_external_transcription` | `POST /projects/{id}/external-transcriptions` | `{sourceVersionId,page,fileHash,result:{blocks,gaps}}`；区域归一化，独立未核验文字版本 |
| `forkwise_edit_drawings` | `POST /projects/{id}/drawing-operations` | `{expectedVersion,commands}`；drawing.put／drawing.delete／object.position |

接口完整前缀为 `/api/v1`。写操作须幂等键；先用原 `/operations/{key}` 回查，再以原键原内容恢复。外部任务 `input.external` 记录 `executor: external`、`createdBy`、`retryOf` 和 `serverReads`。文本／图像读取带 `jobId` 时记录服务端实际提供的范围，这不证明 Agent 理解了内容；`agentCoverage`／`agentUsage` 仅为自报。过时目标或直接上下文的结果继续保存在任务里，`output.stale=true`，不改当前图谱。失败和部分完成保留缺口；重启保持外部待执行状态，不交给模型。外部结果提交限创建执行者或本人，项目内另一 Agent 不能冒名提交。

路径导入默认关闭。本人在服务数据目录创建 `import-roots.json`，示例：

```json
{"项目ID": ["/Users/d0m999/Documents/我的授权材料"]}
```

重启服务生效。目录授权与项目授权同时约束读取；拒绝越界、符号链接、非普通文件与读取期间变化。一次只读单文件，不扫描目录。原件仍存 SQLite BLOB 并进入备份；保留字节导入兼容接口。JSON／SQLite 备份保留任务输入、结果、材料、图形与记录者审计，恢复不会恢复会话令牌或重新授予委托。

全文检索不返回 `rights: restricted` 的材料正文及对应证据引文，项目隔离与历史时点过滤同时生效。

基础图形规范数据在 `canvas.annotations` 中只保存一份，工作台原 Excalidraw 显示和回写同一数据；旧 `drawings` 和原场景原样保留。`drawing.put` 的 drawing 包含 `{id,type,x,y,width,height,text?,color?,points?,fileId?}`，image 必须引用本项目原图；普通 arrow 不建立推导，研究位置写入 positions，均按布局版本原子保存。正式引擎仍遵循 ADR 0011。

混合条件需明确 `mixedCombination: joint_required` 才共同满足；未指定或 unspecified 时仅保留分项和 Agent 总体意见。工具执行了数值规则不证明财务输入已核验。

验收脚本：`npm test`、`node scripts/text-reader-smoke.cjs`、`node scripts/browser-smoke.cjs`、`npx tsx scripts/codex-live-acceptance.ts`、`SEC_USER_AGENT=… npx tsx scripts/sec-live-acceptance.ts`；真实 Codex 通过后运行 `npx tsx scripts/verify-codex-recovery.ts` 和 `node scripts/local-delivery-ui.cjs`。Codex 脚本使用隔离演示数据和临时配置，真实会话不等于真实投资研究质量验收；SEC脚本则实际取数和恢复，不使用网络夹具。最终证据及版本见 `../docs/plans/local-delivery-2026-10-09.md`。
