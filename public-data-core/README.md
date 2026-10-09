# 公开金融数据核心

独立的来源目录、确定性适配器、财务口径校验与 Agent Skill。当前先在 Forkwise 工作区内维护，可整体移入独立 GitHub 仓库；尚未发布，也未安装为全局 Skill。没有中心数据服务。只用 Node 内置模块，运行环境见 `package.json`。

```sh
node src/cli.js catalog
node src/cli.js --help
npm test
```

实际取数需自行配置 `SEC_USER_AGENT` 为可联系身份、`FORKWISE_DATA_CACHE` 为本机私有目录。SDK 返回原始字节文本、SHA-256、获取时间和快照文件；重复字节不覆盖旧快照，每次联网获取另存回执。缓存复用须明确给出快照 hash。

目前实现 SEC `companyfacts`、`submissions`、目录内历史索引分片及按固定索引取得 HTML 主文件。`companyFacts()` 提取明确指定的 taxonomy/tag/单位，保留全部披露版本；持续期间默认未分类，不自动推导季度、同比或增长率。合成样例验证语义与失败行为，真实 SEC 请求及首个研究案例仍待配置联系人后实测。

单进程共用串行请求队列、至少间隔 250 ms；429/临时故障最多 3 次尝试，403 不重试。其他程序和机器也占用 SEC 同一使用者额度，部署者须统筹。SDK 只允许维护目录中的固定 SEC 地址，重定向停止。

来源事实与访问限制依据：[SEC API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)、[公平访问](https://www.sec.gov/about/developer-resources)。Skill 入口为 `skills/public-financial-sources/SKILL.md`。发布前须确定独立仓库名称及代码许可；本包未授予第三方原文的再分发许可。


`selectCompanyFactPassages(raw, { queries, maxCharacters, expectedCik })` 为有界模型输入提供结构化原文片段。按原文关键词匹配科目与记录，连同主体/科目/单位的父级原文一起选取，返回绝对 UTF-16 位置、JSON pointer、角色、记录缺口和实际覆盖数；最大 200 条、20 万字符，未选中的记录保持未核查。原始数字不重序列化，重复键和错误结构拒绝。`validateCompanyFactPassages(raw, passages, expectedCik)` 在恢复/使用固定片段前核对完整上下文与原文位置，无需重新选择数据。解析上限为 500 万字符、深度 64、50 万节点；超限明确失败，不截断。

该接口不提供指标同义词映射、财年/单季识别、自动选取最新披露或跨期计算；基础完整性提示不代替财务口径核对。公司事实及申报索引的合成测试范围见 `tests/`；真实来源验收仍待完成。


`selectSubmissionPassages(raw, { queries, maxCharacters, expectedCik })` 按关键词选择 `submissions.filings.recent` 中完整的同一行：各字段分别保留原始位置，`recordPointer` 指向该行的 accession 原文，连同主体及历史文件目录提供给模型。列式数组长度不一致、重复键或主体错误时拒绝。选取上限与 companyfacts 相同，整行及共享上下文一起计算预算；原版、修订版与不同申报分别保留，不按顺序自动合并。`records` 返回行号、accession、可安全构造的 SEC 文件入口与逐条缺口；`historyFileCount` 只表示索引列出的文件数量。

`validateSubmissionPassages(raw, passages, expectedCik)` 不重跑查询，核对每段的位置、角色、行归属和所有同一行字段，返回从原文重建的记录元数据及历史文件数量，供消费端核对保存的覆盖记录。两个解析器共用有界 JSON 原文位置索引，均不重序列化证据词元。

申报索引支持核对申报元数据；取到索引不等于读取申报正文、附件或历史分片，也不能证明营收等正文事实。`reportDate` 保留为报告期间日期，`acceptanceDateTime` 保留原始字段；不据此补造完整财务期间或历史已知时刻。取材函数的文件入口仅由当前索引字段构造，不触发下载，非法相对路径返回缺口和空入口。需要取得正文时调用下面的独立获取接口。官方结构说明见 [SEC Submissions API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)。本包的 SDK 与 CLI 范围不同：上述取材/校验函数由 SDK 提供，CLI `sec` 仍用于保存完整来源快照。

`selectSubmissionDocuments(raw, {expectedCik, forms, filedFrom, filedThrough, maxDocuments: 10})` 在固定索引中按确切类型、含首尾的披露日期选择主文件，返回 `documents`、无法取得的 `unavailable` 行、匹配数、未读历史文件数和缺口。它不联网，也不推断业务期间；`10-Q` 不自动包含 `10-Q/A`，日期缺失不会改用 `reportDate`。超过文件预算（最多 10）直接返回 `TOO_MANY_FILINGS`，不截取前几条。调用方再将实际索引中的 accession 交给 `fetchFiling`，并分别保存选择范围、获取回执及观点核对结果。


`resolveSubmissionDocument(raw, expectedCik, accessionNumber)` 要求固定原文中恰好有一条匹配申报，检查列对齐与安全相对路径，返回其 HTML 主文件地址、原索引 JSON pointer、申报类型和原始日期。`SecClient.fetchFiling(indexSnapshot, accessionNumber, { signal, cachedHash })` 先校验原索引的来源 URL、CIK 和字节指纹，再访问维护目录中的 `www.sec.gov/Archives/edgar/data/` 路径；不能传入任意 URL。accession 前缀可为提交代理，路径主体使用索引 CIK。快照保存原始 UTF-8 字节文本、独立指纹、获取时间及索引 hash/URL/行定位；不将只有日期的 filingDate 改成精确发布时间。

正文入口仅支持 UTF-8/ASCII HTML 主文件，流式上限 25 MB；错误格式、编码、403、重定向分别停止，图片/附件/历史分片不跟随获取。正文与原索引独立保存。缓存文件以 URL 身份及内容 hash 共同命名，相同字节的不同来源不会覆盖；显式 `cachedHash` 也可读取原先仅按 hash 命名且身份一致的旧快照。CLI `sec` 仍只支持两类 JSON 数据集，正文获取由 SDK 提供。以上经过合成测试，实际 SEC 联系身份和真实申报验收仍待配置。

`selectSubmissionHistory(raw, {expectedCik, filedFrom, filedThrough, maxFiles: 10})` 只在固定根索引目录中选择与披露日期范围相交的历史文件，返回 `files`、`listedFiles`、`excludedFiles` 和 `gaps`。未知日期、重复文件名和不安全路径保留缺口；超过预算明确拒绝，不截取前几个文件。`resolveSubmissionHistory(raw, expectedCik, fileName)` 校验唯一目录项及主体，不能接受任意网址。

`SecClient.fetchHistory(rootSnapshot, fileName, {signal, cachedHash})` 获取该目录项，返回 `dataset: submissions-history` 快照及 `history` 父目录 URL/hash/原文位置。原始 JSON 按顶层列式数组读取，保留 `/accessionNumber/0` 等原文定位，不通过重序列化伪造主体字段。数量或有效披露日期与父目录不符时拒绝；缺失日期在选报时保留缺口。既有 JSON 大小、队列、403/429 和缓存规则同样适用。

对历史原文调用 `selectSubmissionPassages` / `selectSubmissionDocuments` 时传 `history: true`；`validateSubmissionPassages` / `resolveSubmissionDocument` 的第四个参数为 `{history: true}`。调用方须先通过 `assertIndexSnapshot(historySnapshot, rootSnapshot)` 核对固定父目录。取得旧申报正文使用 `fetchFiling(historySnapshot, accessionNumber, {historyRoot: rootSnapshot, signal, cachedHash})`，强制检查来历后再取主文件。历史分片由上述独立 SDK 接口获取，CLI 仍不递归获取目录。官方目录机制已核对，实时历史 JSON 兼容性与真实来源验收仍待完成。
