# 本地门禁工具

`gate.py` 提供只读 `plan` / `verify`，以及显式执行的 `run`。不写总控、不变更完成门槛。当前面向本机 macOS，使用 Python 3.10+ 标准库及系统 `ps` / `lsof`；产品命令使用已安装、显式绑定的工具。

默认定义 [gate.frontend.json](gate.frontend.json) 包含 `workspace-build → frontend-playwright`。后端测试、公共数据、R2 独立检查和 native 尚未接入，继续沿原门禁；本工具不代表完整交付流水线。

## 生成计划

```sh
python3 -B scripts/gate.py plan --root . --summary
```

工具身份通过重复 `--tool NAME=PATH` 声明：`node` 为实际 Node 文件，`npm` 为完整 npm 安装目录，`chromium` 为实际使用的浏览器安装目录（含二进制和资源），以及 `sh`、`cp`、`mkdir` 的实际文件。路径必须与预期执行选择一致；未提供时输出 `MISSING_TOOL`，不会猜测旧运行使用了哪套工具。

省略 `--summary` 可将完整计划 stdout 保存到自有临时文件。摘要仅供阅读，不能作为 `verify --plan` 输入。命令、工具选择、当前目录及相关环境必须保持一致；临时计划使用后清理，必要证据按项目的私有 Git 留存规则处理。

默认清单覆盖源码直引、前端测试及支持代码、依赖安装内容、锁文件、构建配置、R2 搜索 vendor 和 `backend/dist`/`frontend/dist`。文件内容、目录成员、完整 POSIX mode、工具路径和工具自身实现均参与指纹。构建输入键与产物键分开；前端同时依赖构建输入、实际产物和直接导入的后端源码。

这是显式声明的范围，不是自动依赖分析。新的包、外部输入或构建路径需要审阅定义；不能从“指纹相同”推断声明已经穷尽所有依赖。`.npmrc`、`.env*`、Node 预加载等未声明的外部输入会阻止复用；`.env*` 只检查名称，不读取正文。npm 配置环境按大小写不敏感识别，敏感值不写入输出，也不被采纳为可复用条件。

当前尚未支持通过 `FORKWISE_NATIVE_CLIPBOARD_GUARD` 声明外部守卫程序；该变量非空时标记 `UNDECLARED_ENVIRONMENT_INPUT`，拒绝执行与复用。路径字符串不能证明程序内容和执行权限未变；不读取或执行该未声明程序。需要该守卫的测试应继续沿既有受控门禁运行。

执行环境只传递声明的语言/时区/CI 和 `NODE_*`、`FORKWISE_*`、`PLAYWRIGHT_*`、`VITE_*`、npm 配置；有 Node 绑定时 PATH 固定为该 Node 目录及系统目录。HOME、临时目录、npm cache、JSON reporter 和资源日志位于本次新目录；其生成规则参与指纹，实际路径在 argv/运行记录中保留。不会继承未声明的凭据环境。

## 显式执行并登记

`run` 一次执行一项检查；必须提供完整计划、检查名及**尚不存在**的输出目录，并沿用计划的 `--tool` 参数。默认实际执行；显式 `--reuse` 仅尝试复用，不合格即拒绝，绝不回退执行。不会自动重试、改写旧目录或登记旧 561/561。

```sh
# 以下调用都需追加与 plan 相同的 --tool NAME=PATH。
python3 -B scripts/gate.py run --root . --plan /absolute/build-plan.json \
  --check workspace-build --output backend/artifacts/new-build-run

# 构建改变了实际产物，先重新 plan，再执行前端。
python3 -B scripts/gate.py run --root . --plan /absolute/frontend-plan.json \
  --check frontend-playwright --receipt backend/artifacts/new-build-run/receipt.json \
  --output backend/artifacts/new-frontend-run --timeout 1800
```

前端执行前须设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 为 `chromium` 绑定目录内的实际可执行文件，再生成计划。当前项目的 `playwright.config.ts` 使用该变量；更换配置或增加其它浏览器启动路径时，须重新审查声明。

前端先运行完整选择参数下的 `--list`，再执行相同集合，强制 `--forbid-only`、全量 grep/project、无重试、单次重复和 JSON reporter。日志与两个原始报告分别保存，执行报告不能反过来充当发现报告。运行环境清除调用者的 `PLAYWRIGHT_JSON_OUTPUT_FILE` / `PLAYWRIGHT_JSON_OUTPUT_DIR`，分别将 `PLAYWRIGHT_JSON_OUTPUT_NAME` 绑定到本次目录的 `discovery.json` / `report.json`。实际 npm 通过绑定的 Node 和 npm-cli.js 启动，用户/全局 npm 配置分别隔离在两个空文件中。

输出包含 `started.json`、单份 `inputs.json`、原始 stdout/stderr、必要发现/执行报告和最终 `receipt.json`。回执记录真实退出码、argv、时间、上游 run ID、输入前后、产物、覆盖及收尾；`not_started` 的退出码为 null，非零退出、超时、取消、输入变化和核验失败均保持原状态。仅有 started、没有可解析的最终回执时保持 UNKNOWN，不能自动补为通过。

同工作区的本 runner 执行互斥；只对仍匹配出生身份的自有进程发送停止信号，并用本次进程组补全普通孤儿。成功后检查已观测子进程、输出写句柄和自有临时目录句柄，再清理本次创建的 home/tmp/cache。`test-results` 是运行证据，包含 JSON 报告按路径引用的附件、截图及原始观察，成功后也完整保留供审阅，随后按全局留存规则处理。链接、多 hard link、未知 owner 或失败证据保留待审，不读取 profile/数据库正文。输出路径拒绝 `..`、链接祖先及源码、产物、runner、工具安装目录。npm 子脚本的 node/npm/sh/cp/mkdir 解析须与声明一致，不符在启动前拒绝。

**runner 自身不能证明所有写者已停止或所有脱离会话的后代均关闭。** `run` 保留 `exclusive_inputs=false`、`resources_closed=false`、`evidence_status=INCOMPLETE`。命令真实成功且已观测资源完成收尾时可返回 `passed` / 退出 0；`verify` 默认拒绝复用。控制者可通过下述事前授权和事后证明补充缺失条件，原回执不改写。前后指纹、文件锁和进程采样不单独升级为完整证明。原始成功且已观测资源已关闭的构建可供继续执行前端，继承的证据缺口保持不变。

## 控制者证明与显式复用

可信控制者须先确认所有相关输入写者均已停止，再签发 `gate-input-grant` 私有 JSON，持有该文件覆盖全范围的 POSIX 写锁，并在 `run` 返回之前保持锁和输入所有权。使用 `fcntl.lockf`，不是 `flock`；macOS 上 runner 通过 `F_GETLK` 核对持锁 PID、进程出生身份与范围。POSIX 锁属于进程，控制者在这期间另开后关闭同一文件的描述符也会释放它。

```sh
# --tool 等参数与 plan 相同。grant 由持续持锁的控制者提供。
python3 -B scripts/gate.py run --plan /absolute/plan.json --check workspace-build \
  --output backend/artifacts/new-controlled-build --control-grant /absolute/grant.json

# 控制者收尾并提供 closeout 后，调用者显式信任 authority 的声明。
python3 -B scripts/gate.py verify --plan /absolute/current-plan.json \
  --receipt /absolute/original-run/receipt.json \
  --control-proof controller-session=/absolute/closeout.json --summary

# 不启动产品命令，仅写新的 coverage.json；不给复用伪造退出码或 run ID。
python3 -B scripts/gate.py run --reuse --plan /absolute/current-plan.json --check workspace-build \
  --receipt /absolute/original-run/receipt.json \
  --control-proof controller-session=/absolute/closeout.json \
  --output backend/artifacts/new-reuse-report
```

`--control-proof AUTHORITY=PATH` 仅用于 `plan`、`verify` 和 `run --reuse`，可逐检查提供。完整构建→前端核验须提供两份原回执及各自证明。`verify` 输出每项 `REUSED / GAP`、原 run ID、输入键、证据地址及原因；实际 `run` 输出本次 `EXECUTED`，检查成功与复用资格分开。

| 控制文件 | 必需字段 |
| --- | --- |
| 输入授权 | `schema_version: 1`、`kind: gate-input-grant`、`authority_id`、`grant_id`、`owner: {pid,birth}`、`root`、`check_id`、`input_key`、`output_directory`、带时区的 `issued_at/expires_at` |
| 输入协调声明 | `coordination: {input_scope: ALL_DECLARED_INPUTS, single_writer: true, outstanding_writers: []}`；包括源码、测试、依赖、工具和声明的上游产物 |
| 收尾证明 | `schema_version: 1`、`kind: gate-control-closeout`、`authority_id`、`check_id`、原 `run_id`、`grant/receipt: {path,sha256}`、`closed_at` |
| 所有权证明 | `ownership: {uninterrupted: true, outstanding_writers: []}`，由控制者确认执行期间所有权连续保持 |
| 资源证明 | `resources: {scope: ALL_DECLARED_RESOURCES, closed: true, unknown: [], remaining: [], terminal_waits: [...], basis: ...}`；`terminal_waits` 按 discovery、main 顺序列出各自原始 `exit_code/finished_at` 和 `phase`，`basis` 解释完整资源登记与收尾的依据 |

证明文件必须是本人所有的私有普通文件，不接受链接或多 hard link。启动前缺少锁、授权过期或输入不匹配直接拒绝；执行后失去锁则保留真实命令结果和证明缺口。收尾证明必须绑定 runner 原本记录的事前/事后授权，不能补造旧运行的入场记录。输入核验失败、原始 `incomplete`、非零/未知退出、终止信号和未关闭资源不能由补充证明改成成功。

**这是显式信任控制者的协调协议，不是数字签名认证或操作系统沙箱。** 工具核验关联、时间、摘要、实际父进程 wait 和已观测收尾；控制者负责确认写者协调及完整资源登记的真实性。`CONTROL_ATTESTED` 会保留在覆盖报告中。下述 v3 生产适配器提供统一签发入口，但不能把暂停快照或空的写者列表直接当授权；不切换规则或恢复业务票。临时测试中的 `test-controller` 仅用于工具演练。

## 由现有 v3 总控协调

当前有权总控可通过 `run` 的协调模式执行。每次上下文核验只调用一次本仓库固定位置的 `controller_v3.load(expected_revision)` 权威 API，从返回的同一完整逻辑状态取得总控字段和票状态，不读取磁盘投影或跨 revision 拼接。运行前、运行后及收尾仍各自重新读取并比较上下文与实现身份。`PAUSED` 在读取权威状态后立即拒绝，不因票仍为 `IN_PROGRESS` 而放行。

适配器核对 `workspace_root`、`workspace_policy.directory`、活动票、会话、严格串行和无额外 worktree 的规则；要求单独的本次输入冻结复核。它持有 grant 的 POSIX 锁、启动 gate 子进程并真正等待退出，在 `controller-result.json` 中保留 `actualParentWaitExit`、父/子 PID、argv、起止、原始日志及前后总控上下文。它不从子进程的 JSON 声明推算父 wait；源码检查失败时保留原失败码和状态。

```sh
# 示例占位 N/R 应换为权威入口的活动票与 revision；仍需追加相同 --tool 参数。
python3 -B scripts/gate.py run --plan /absolute/plan.json --check workspace-build \
  --controller-issue N --controller-revision R --input-ownership /absolute/ownership.json \
  --output backend/artifacts/new-controller-bundle

# 真实总控复核本次资源记录后签发追加证明；不改 run/receipt.json。
PYTHONPATH=scripts python3 -B -m gate_lib.controller --root . --issue N --revision R \
  --receipt backend/artifacts/new-controller-bundle/run/receipt.json \
  --resource-review /absolute/resources.json \
  --output backend/artifacts/new-controller-bundle/closeout.json
```

协调模式的输出是一个 bundle：`grant.json`、`run/` 中的原始执行证据、父进程的两个日志和 `controller-result.json`。控制证明使用总控的真实 `controller_session_id` 作为 `AUTHORITY`。任何 v3 revision/上下文变化、真实父 wait 不完整、原始失败或资源复核缺口都会阻止签发。实际成功但控制上下文变化时，原回执保留成功事实，协调结果单列不完整。

| 总控显式复核文件 | 必需字段 |
| --- | --- |
| 两类共同身份 | `schema_version: 1`、`issue`、`revision`、`controller_session_id`、非空 `basis` |
| 输入冻结 | `kind: gate-input-ownership`、`check_id`、`input_key`、`input_scope: ALL_DECLARED_INPUTS`、`frozen: true`、`outstanding_writers: []` |
| 资源复核 | `kind: gate-resource-review`、原 `run_id`、`inventory_complete: true`、`input_ownership_uninterrupted: true`、`unknown: []`、`remaining: []`、`raw_records` |

`raw_records` 按顺序绑定本次 `run/receipt.json`、`controller-result.json`，再绑定原回执 `resource_logs` 固定的日志清单与 SHA-256。runner 在运行结束时按 `runtime.RESOURCE_LOGS` 采集实际生成的日志；当前是 `run/resources.jsonl`，对应 `FORKWISE_ISSUE10_RESOURCE_LOG`。收尾不能按当前剩余文件缩小清单；删除、遗漏、改写或替换为链接均会阻止复用。没有生成日志时清单为 `[]`；缺少该清单的旧回执不能补造为可复用。`raw_records` 每项是绝对 `path` 和原始 SHA-256。新增采集器须先进入统一声明。全部是当前运行的原始文件，旧运行日志不能代入。现有 runtime/fixture 回调事件仍是回调事件，不改称独立 OS wait；未配对事件、未知退出及遗漏资源应写入 `unknown/remaining`，不能为了生成证明而置空。收尾复核者负责完整性判断，适配器不会只凭主进程退出 0 自动填好这份记录。

生产 closeout 只能新建在原 bundle 顶层，文件名须为 `.json`；不得覆盖原件、包含 `..` 或经链接目录写入。统一写入函数以不跟随链接的目录描述符创建文件。

本次已测试适配器的真实 CLI 行为及真实 #26 的暂停拒绝；恢复后的产品资源日志消费和业务试行尚未执行。生产资源采集需要沿受审的实际入口提供原始记录；不自动启用历史 `NODE_OPTIONS` collector，也不把旧 561/561 转成新运行。

## 核验已有证据

```sh
python3 -B scripts/gate.py verify --root . \
  --plan /absolute/path/plan.json \
  --receipt /absolute/path/workspace-build.receipt.json \
  --receipt /absolute/path/frontend-playwright.receipt.json \
  --summary
```

实际调用需带上生成计划时相同的 `--tool` 参数。`plan` 也可接受 `--receipt`，直接给出当前输入下的复用建议；`verify` 额外比较原始计划，报告新增、删除、变化的条目。

| 输出/退出码 | 含义 |
| --- | --- |
| `plan` 退出 0 | 已生成计划，包括可能的缺口；不表示产品或证据通过 |
| `verify` 退出 0、`EVIDENCE_MATCHES` | 所有声明检查的输入与原回执符合本工具合同，逐项为 `REUSE_CANDIDATE` |
| `verify` 退出 1、`NOT_REUSABLE` | 存在输入变化、身份/原始证据缺口、失败或不完整运行 |
| `run` 退出 0 | 选定检查真实成功，输入边界核验及已观测资源收尾完成；完整证据仍为 INCOMPLETE |
| `run` 退出 1 | 本次运行失败、未启动、超时、取消、输入变化、结果或核验不完整；读取原回执区分原因 |
| `run --reuse` 退出 0 / `reused` | 原证据合格，保留原 run ID，未启动检查；新文件仅为覆盖报告 |
| `run --reuse` 退出 1 / `reuse_refused` | 证据仍有缺口，不创建执行目录、不自动补跑 |
| 退出 2、`INVALID_INPUT` | 定义、完整计划、回执或路径格式不合法；命令行参数错误由 argparse 报错 |

所有结果均含 `acceptance: NOT_EVALUATED`。复用候选仍须由有权总控核实声明范围、原回执来源、现行规格及新 finding；本工具没有签发原运行证明，也不认证输入材料的来源。它不把新指纹回填为旧运行的输入事实。

## 原始回执合同 v2

`run` 为本次实际执行生成新的回执；`plan` / `verify` 只读，均不修补旧回执。每个检查一份 JSON。下表列出获得复用候选资格所需的条件；失败或不完整回执仍保留实测状态、退出码或 null，不能为了满足表格而改写：

| 字段 | 要求 |
| --- | --- |
| `schema_version`, `check_id`, `run_id` | 回执版本 2、定义中的检查名、非空原运行标识；计划/定义版本仍为 1 |
| `command`, `cwd`, `scope` | 与定义匹配的 argv/相对工作目录，完整检查 `scope: full` |
| `started_at`, `finished_at` | 带时区的 ISO 时间，结束不早于开始 |
| `status`, `exit_code` | 原始 `passed` 与整数 0；未知、部分完成和失败不能转换成通过 |
| `input_before`, `input_after`, `output_key` | 原运行前后取得的输入键和产物键，均须匹配当前要求 |
| `input_manifest` | 原运行输入清单的 `{path, sha256}`；路径相对该回执目录，须为现存普通 JSON 文件且与原 SHA-256 匹配。缺引用、删除、改写或链接替换均阻止复用，当前计划不能代替原始清单 |
| `integrity` | 原执行者记录三项真实成立；或原 `inputs_unchanged=true`，另外两项由调用者明确信任的控制者按上述合同补充证明，原字段保持原样 |
| `logs` | 非空数组，每项 `{path, sha256}`；路径相对该回执目录，必须是现存普通原始日志，摘要精确匹配 |
| `resource_logs` | 运行结束时固定的资源日志 `{path, sha256}` 清单，逐项按原摘要核验；未生成时为 `[]`，缺失字段阻止复用 |
| `coverage` | `collected` 与 `executed` 为相同、非空、无重复的标识集合；`failed`、`skipped`、`flaky` 均为空。构建用实际完成的步骤标识 |
| `upstream` | 构建为 `{}`；前端须关联已合格构建的 `{run_id, input_key, output_key}` |
| `report` | Playwright 检查另提供原始 JSON reporter 文件的 `{path, sha256}` |
| `attachments` | Playwright 报告引用的文件附件 `{path, sha256}` 清单，在原运行中固定；路径相对该回执目录、排序去重，无文件附件时为 `[]`。复用前核对报告引用的完整集合和每项原摘要；缺失清单、遗漏、删除、改写、越界或链接替换均阻止复用 |
| `discovery` | 独立 `--list` 报告的 `{path, sha256, command, exit_code}`；必须成功结束且无执行结果，集合与执行报告一致 |

`report.command` 和 `discovery.command` 必须匹配工具固定的完整选择合同；`run` 另记真实解析后的 `executed_command`，含隔离路径。原 v1 回执保持历史身份，不就地升级；本工具不给旧合同自动复用信用。

Playwright 覆盖标识为 `file::spec.id::projectId::repeatEachIndex`，缺少 `repeatEachIndex` 时为 `0`。核验 JSON reporter 的原始用例结果、错误、重试和统计，与回执覆盖集合对应。当前实现对 retry、flaky、skip 及无法唯一识别的重复运行保守拒绝复用，不改变项目对原始结果的历史处置。

附件从每个用例执行结果的 `attachments[].path` 采集，必须是本次回执目录内的普通文件；不跟随文件或祖先目录的符号链接。内嵌 `body` 由原始报告摘要覆盖。核验时不按当前剩余附件补写或缩小清单，也不为缺少清单的旧回执补造复用资格。

仅有 list 日志、`.last-run.json` 或旧格式回执时，工具保留证据缺口，不自动转换为新合同；可继续由总控人工核验原证据，不应仅为适配这个工具而重跑。#26 的 561/561 尚未由本工具接纳或写入台账；当前真实运行是独立的新结果。

普通链接只记录链接本身；链接及其目标必须被同一项检查的指纹覆盖，多级别名仅在已采集清单中展开，越界或循环链接阻止复用。原始证据链接和多级符号链接路径不作为普通日志读取。目录与文件读取通过不跟随链接的文件描述符，逐项检查读取前后的身份；这不代替原运行的独占输入和全过程稳定性证据。JSON 输入限 32 MiB。

## 工具自身验证

```sh
python3 -B -m unittest discover -s scripts/tests -p 'test_gate*.py'
```

测试跨真实 CLI seam，使用自动回收的临时文件、自有进程和明确标识的合成回执。另有真实 npm/Playwright 的极小临时测试，引用现有安装而不复制或改写依赖；它们不运行产品套件、产品服务器或 native，也不构成产品 TDD/验收。真实产品运行必须通过显式 `run` 另行记录。

浏览器默认由 `frontend/node_modules` 中同一 Playwright 安装的 registry 解析完整目录和可执行文件，不固定 revision、操作系统或 CPU 路径。标准安装是在 `frontend/` 执行 `npm ci` 和 `npx playwright install chromium`。使用另一个已安装浏览器做隔离测试时，须同时设置 `FORKWISE_GATE_TEST_BROWSER_ROOT` 为完整安装目录、`FORKWISE_GATE_TEST_BROWSER_EXECUTABLE` 为该目录内的可执行文件；只设置一项或越界路径会拒绝。缺少匹配浏览器明确失败，不静默跳过。
