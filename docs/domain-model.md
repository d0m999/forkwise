> **施工契约更新（D118/D119，2026-10-08）**：正式后端以 `backend/src/contracts/` 与 ADR 0017 的版本化对象、关系和业务操作为当前施工契约。本文旧字段表保留领域设计演变，不再据其中旧 Node 子类型、branch override 或端点唯一索引直接建库。实现状态见后端进度文档。

# 见岔（Forkwise）领域模型 v0.2

本文把 `docs/prd/投资推理图谱_PRD_v0.2.md` 第 09 节的概念对象落为可施工的实体定义：字段、类型、必填性、关系基数、唯一性约束、ID 与版本策略。数据库产品、框架与模型供应商不在此决定，见 `docs/adr/0010` 至 `0016`（技术决策）。

**术语纪律**：全部术语复用根目录 `CONTEXT.md`，本文不新增领域术语。工程化名称（表名、枚举值）在每个实体的「术语对照」中标注其所对应的 CONTEXT 术语。

**范围纪律**：首版单用户、本机 Web（访谈 D29 已确认）、仅本机访问不做远程、默认私有；监控首版手动、结构按定时可接入（ADR 0008）。PRD 中标注为建议值的额度与指标不是本文的约束。

**施工以本文命名为准**，PRD 第 09 节的产品层称谓见下方 §0 映射表。第一性原理访谈正在修订旧实体方案：D107 的角色／类型字段和 D110 的局部改写身份规则已确认，相关字段与迁移尚待重新设计。下文明确标为旧方案的定义不作为当前施工约束。

---

## 0. 命名对照：PRD 概念对象 ↔ 领域实体

PRD 第 09 节按产品语言列出概念对象，本文按施工需要定义实体，二者不是一一对应。下表逐行给出对应关系；凡合并、拆分或新增的，在「说明」中写明原因。实现时一律使用本文的实体名与表名。

| PRD 概念对象（第 09 节） | 对应领域实体 | 说明 |
| --- | --- | --- |
| Project 项目 | Project | 一一对应 |
| Node 节点 | Node | 一一对应 |
| Claim／Premise 主张与前提 | Node + JointInferencePremise | 不建独立的 Claim 实体：主张与前提是同一段陈述的两种**角色**，不是两种对象。内容落在 Node，前提角色落在 JointInferencePremise |
| Inference 推导关系 | JointInference + Edge | 合并。PRD 的「推导关系」描述一步推导，「联合推导」描述其共同依赖形态，「前提组合」描述其组合类型——三者是同一步推导的不同侧面。拆成三个实体会使 D27 要求的「整步立场」无处可挂 |
| JointInference 联合推导 | JointInference（`combination='joint_required'`） | 收为本实体的一个取值 |
| Combination 前提组合 | JointInference.combination + JointInferencePremise | 收为字段与成员表，不建独立实体：组合类型是一步推导的属性，离开该步推导没有独立生命周期 |
| Branch 条件路径 | Branch + BranchCondition；旧 BranchNodeOverride 方案由 D110 替代 | 路径成员不落表（由遍历导出）；局部改写采用新陈述身份及选定推导改接，具体字段待重设 |
| Condition 条件 | Condition | 一一对应 |
| AIAssessment AI 评估建议 | ConditionEvaluation（`evaluator='ai'`） | 不建两张表。二者字段集合几乎相同，差别只在提出者；合并后由 `evaluator` 区分，并把「未经确认不覆盖人工结论」落成写入规则而非表结构 |
| HumanAssessment 人工评估结论 | ConditionEvaluation（`evaluator='human'`）+ Condition.confirmed_status | 同上；条件的当前确认状态冗余在 Condition 上以便查询 |
| Source 来源 | Source + SourceVersion | 拆分。材料的「身份」与「每次获取到的内容」必须分开，否则 E04 的重述（新版本不覆盖旧快照）无法表达，内容指纹去重也无处落地 |
| Evidence 证据 | Evidence + EvidenceLink | 拆分。PRD 第 09 节备注已要求「关系与解释保留在关联记录」，本文把它落成独立实体 |
| Revision 版本 | Revision | 一一对应 |
| Candidate 候选 | Candidate | 一一对应 |
| Impact 影响建议 | Candidate（由新材料触发的子集）+ Candidate.impact_scope_json | 不建独立实体。影响建议是一种候选意见，同样要走「待审阅／已接受／已拒绝／已过期」流程；与 Candidate 合并可复用同一套审阅、去重与过期逻辑（M03） |
| ReviewOutcome 复核结果 | Review | 一一对应（字段 `disposition`） |
| Monitor 监控 | Monitor | 一一对应；`schedule_expr` 等定时字段按 ADR 0008 保留结构，首版不实现定时执行 |
| Job 与 Event | Job + Event | 一一对应 |

### 本文新增、PRD 第 09 节未单列的实体

| 实体 | 为什么必须新增 |
| --- | --- |
| NodeVersion 节点版本 | 对象自身的编辑历史、版本回看和论证溯源需要具体内容版本；D110 的局部改写另建 Node 身份。Revision 是审计记录（只追加），不能充当可查询的内容版本 |
| BranchNodeOverride 分支局部版本覆盖（旧方案） | 原为 D25 表达同一身份在不同分支使用不同内容；该身份方案已由 D110 替代，定义仅保留用于旧方案追溯，迁移另行设计 |
| JointInferencePremise 推导步前提 | 一步推导的前提是**多值**成员关系，不能塞进推导步的单列 |
| SourceVersion 来源版本 | 见上表 Source 行 |
| EvidenceLink 证据关联 | 见上表 Evidence 行 |
| Edge 连接 | PRD v0.2 第 09 节用 Inference 取代了 v0.1 的 Edge。画布仍需要一条可渲染、可防环的有向连接；本文把 Edge 定义为推导步与路径条件的**派生投影**，不承载独立语义，因此不会与 JointInference 形成两套真相 |

### 本文未建的 PRD 对象

无。PRD 第 09 节的每个概念对象在上表中都有落点；不存在被遗漏或未建模的对象。

---

## 验证节点的当前施工契约（D129）

术语对应 `CONTEXT.md` 的“验证节点”；生产代码实体为 `verification_node`，复用 ADR 0017 的对象/不可变版本存储。它定义未来观察安排，与陈述内容、推导理由、条件规则/评估、证据及个人立场分别负责。

| 边界 | 规则 |
| --- | --- |
| 内容 | 事件、核对目标、可未知的业务期间与披露日期、资料缺口 |
| 对象绑定 | 固定主张/推导的内容版本；推导另外固定直接前提、结论的内容版本 |
| 候选 | `verification.propose` 创建独立 AI 候选，可记录受控来源任务；不会覆盖本人安排 |
| 本人操作 | `verification.confirm` 创建或修改本目标唯一的本人节点；事件/目标必填，保存所参考候选版本 |
| 并发与无变化 | 校验节点、目标与直接上下文的写入版本；相同字段及相同内容上下文不新增历史 |
| 变化与复制 | 内容/上下文变化需复核，立场变化不使节点过期；复制/局部派生不继承本人节点 |
| 历史与删除 | 本人修改留下节点版本；关联对象删除时节点从当前视图连带移除，历史保留 |
| 不负责 | 判断预测是否成立、选择立场、确认条件结论、自动取材/交易/提醒 |

状态 `confirmed` 表示发生过本人节点确认；是否仍适用于当前内容，须另外比较固定版本与上下文，不能只读该状态字段。其余旧命名表的迁移按 ADR 0017 和实现进度处理，不将本文历史表结构误作当前 SQLite 已建表清单。

## 条件与评估的当前施工契约（D130）

正式 `condition` 的 `description/mode/rule` 定义判定要求；`targetIds` 是同项目主张/推导的去重引用集合。修改引用不改变规则内容版本。局部派生的选定范围必须与新条件引用一致，`lineage` 由服务绑定原对象版本；原条件和原评估不迁移到新身份。

`evaluation` 始终固定条件内容版本。本人可独立提交，或通过 `basedOn` 指向候选；改判须补充本人理由。当前人工确认和当前 AI/规则候选分别从相同规则版本的记录选择，其他记录作为历史。混合评估可含 `components.numeric/qualitative`，各自记录结论、理由、证据、缺口及倾向，整体为共同满足的候选；它不替代独立的人工评估。

后端工作台的规则草稿、评估材料选择、人工判断、失败重试与历史回查已接通；完整旧外壳、统一撤销和真实材料验收见进度文档，下文旧字段表不覆盖此契约。

## 1. 全局约定

| 约定 | 取值 |
| --- | --- |
| 主键 ID | 带类型前缀的 ULID，TEXT，26 字符 + 前缀。前缀：`prj_` `nod_` `nvr_` `bno_` `jif_` `jip_` `jic_` `edg_` `brh_` `brc_` `cnd_` `cev_` `src_` `svr_` `evd_` `evl_` `rev_` `cdt_` `rvw_` `mtr_` `job_` `evt_` |
| 引用 | 一律以「ID + 版本」建立；不允许以展示文本做外键 |
| 时间 | UTC 存储，ISO 8601 字符串（秒精度）；纯日期用 `YYYY-MM-DD` |
| 有效区间 | 半开区间 `[valid_from, valid_to)`，`valid_to` 为空表示仍有效 |
| 缺失 | 一律 NULL。禁止填 0、空串或占位值替代缺失（AGENTS.md：缺失数据不填零） |
| 软删除 | `deleted_at` 可空。审计类表（`revisions` / `events`）禁止删除 |
| 归属 | `attribution ∈ {author, ai_inference, user}` 对应 CONTEXT 的作者论证 / AI 推断 / 个人论证 |
| 操作者 | `actor ∈ {user, system, job}`；`actor_job_id` 仅在 `actor='job'` 时非空 |
| JSON 字段 | 以 TEXT 存 JSON（ADR 0010 选定 SQLite 后的落法），读取时按 schema 校验 |

---

## 2. 论证主体

### 2.1 Project 项目

> 一项研究的权限、额度与导出边界；是全部对象的归属根。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `prj_` | 是 | 主键 |
| name | TEXT | 是 | 项目名；无题目时用草稿名保存（G01 异常） |
| research_question | TEXT | 否 | 研究问题 |
| subject | TEXT | 否 | 主体或主题（如 `INTC`） |
| target_period_start / target_period_end | TEXT(日期) | 否 | CONTEXT「目标时间范围」：研究者自选、希望重建覆盖的历史区间（D13） |
| observation_window_start / observation_window_end | TEXT(日期) | 否 | 观察期，用于条件计算与等待观察判定 |
| visibility | TEXT | 是 | 默认 `private`；首版仅有此值 |
| quota_materials / quota_pages / quota_nodes / quota_edges | INTEGER | 否 | PRD 建议额度，可调，不写为承诺 |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

**约束**：`visibility` 首版 CHECK 只允许 `private`；删除项目级联软删除其下全部对象。
**关系**：1 Project → N Node / JointInference / Branch / Condition / Source / Monitor / Job / Event / Revision。

---

### 2.2 Node 节点

> 图谱中的展示与编辑单元，承载一项「主张」；前提与结论是它在推导步中扮演的角色，不是独立内容类型（D107）。

**术语对照**：承载内容为 CONTEXT「主张」；作为推导步输入时称「前提」，作为该步输出时称「结论」。同一主张可以在不同推导中担任这两种角色，作为路径终点也可称“结果”；角色由引用位置确定，不改变对象身份。

**D107 修订边界**：本轮第一性原理访谈已确认角色与内容对象身份分开。旧 `node_type` 中的 `outcome` 不再作为新模型的独立内容类型约束；字段是否保留、待讨论问题的分类与旧值兼容继续设计，尚未修改 schema 或执行迁移。

**对象身份（D108）**：分别新建的陈述拥有独立身份，即使文字或含义相同也不自动归并；明确复用时引用已有对象。相似性判断仅用于提示，共享身份须由明确复用或合并操作建立。明确合并的来源、版本、立场与历史处理规则继续设计，不能以正文指纹或语义相似度直接替代对象 ID。

**局部改写身份（D110）**：只修改共享陈述的部分引用时，创建独立 Node 身份的派生陈述，选定推导改接它，未选引用保留原 Node 与内容。改写来历须定位原 Node 及当时 NodeVersion；新旧对象随后分别演化，来源变化不自动同步。来历不属于 JointInference 或推导 Edge。原有证据按 D111 作为参考，确认后另建关联，见 4.4 节；原有上游推导按 D112 保留，新对象按需另建推导，见 2.5 节。具体来历字段、改接协议及旧数据迁移继续设计，不据本段直接生成 schema。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `nod_` | 是 | 稳定 ID，跨版本不变 |
| project_id | TEXT | 是 | FK → projects |
| node_type | 待定 | 待定 | 旧稿为 `claim` / `outcome` / `question`；按 D107 重新设计，前提与结论由推导引用关系表达。字段保留方式及问题对象分类待定 |
| attribution | TEXT | 是 | `author` / `ai_inference` / `user` |
| stance | TEXT | 是 | 当前内容版本的个人立场展示值，取自该 NodeVersion；四态见 D24。派生陈述拥有独立身份，历史回看使用当时版本的立场，不能用原对象当前值替代（D32、D110） |
| reconstruction_check_status | TEXT | 是 | CONTEXT「重建核对」：`pending_check` 待核对 / `checked` 已核对。仅对 `attribution ∈ {author, ai_inference}` 有意义；与 stance 彼此独立（ADR 0004） |
| period_start / period_end | TEXT(日期) | 否 | 该主张所指的业务期间；定性主张可空 |
| time_layer | INTEGER | 否 | 期次序号，用于时间分层表达反馈环（第 8.3 节） |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

**约束**：`UNIQUE(id)`；删除前必须展示受影响路径并提供「仅解除本路径连接」与「删除节点」两种操作（G03 异常）；删除后不得残留悬空边（由 Edge 级联校验保证）。

---

### 2.3 NodeVersion 节点版本

> 一个节点在某个有效区间内的一份具体内容，是对象自身编辑历史、版本回看与论证溯源的载体。D110 的局部改写创建另一个节点身份。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `nvr_` | 是 | 主键 |
| node_id | TEXT | 是 | FK → nodes |
| version_no | INTEGER | 是 | 该节点内单调递增，从 1 起 |
| scope | 待重设 | 待定 | 旧稿为 `shared` / `branch_local`；同身份局部覆盖已由 D110 替代，字段保留方式待定 |
| branch_id | 待重设 | 待定 | 旧稿用于标明 `branch_local` 所属路径；不能作为 D109 选定推导范围与 D110 新身份的替代 |
| title / body | TEXT | 是/否 | 短句与正文；展示文本可变化，引用以 ID+版本建立 |
| stance | TEXT | 是 | 本内容版本的当前个人立场，取 D24 四态；实质改写分支前提后的新版本默认 `pending`（D32），与 `inherited_stance` 分别保存 |
| stance_reason | TEXT | 条件必填 | 本人对该内容版本的立场理由；`stance ∈ {questioned, not_endorsed}` 时必须有非空白的具体疑问或理由，`endorsed` / `pending` 可空（D38） |
| attribution | TEXT | 是 | 该版本的表达归属。AI 补充内容恒为 `ai_inference`，不因用户接受而改为 `author`（ADR 0003） |
| valid_from / valid_to | TEXT | 是/否 | 版本有效区间（PRD 第 10 节） |
| supersedes_version_id | TEXT | 否 | 上一版本，形成版本链 |
| lineage_origin_type | TEXT | 否 | `author_node_version` / `ai_candidate` / `user_original`（CONTEXT「论证溯源」） |
| lineage_origin_id | TEXT | 否 | 所依据的作者节点版本 ID 或候选 ID（ADR 0002） |
| baseline_version_id | TEXT | 否 | CONTEXT「对照基线」：收录时的作者版本；作者后续更新不自动替换（D22） |
| inherited_from_version_id | TEXT | 否 | 本版本由哪个版本派生而来（局部版本、复制改写、收录均填写） |
| inherited_stance | TEXT | 否 | 继承时的个人立场取值快照，用于回答「当初继承的是什么状态」；此后本版本的立场独立演化，不回写本字段 |
| inherited_reconstruction_check_status | TEXT | 否 | 继承时的重建核对状态快照，语义同上 |
| adopted_at | TEXT | 否 | 用户采用时间（用户把该版本纳入个人论证的时刻） |
| actor / actor_job_id / reason | TEXT | 是/否/否 | 变更来源与理由 |
| created_at | TEXT | 是 | |

**约束**：`UNIQUE(node_id, version_no)` 保持。旧 `branch_local` 的路径必填、继承字段 CHECK 与 BranchNodeOverride 生效覆盖约束属于已被 D110 替代的身份方案，不作为新局部改写的施工规则。新旧对象来历及改接历史的字段约束待重设；源版本及当时状态仍须可追溯。

**共享前提与修改范围（D66、D109、D110 / ADR 0006）**：共享前提由同一陈述被多项推导或条件路径明确引用形成，不另建“共享前提”类型。修改时先展示引用它的推导，由编辑者明确选择全部引用或选定推导；不默认当前分支，不以当前视口或选区推定范围。选择部分时按 2.2 节派生新 Node 并改接选定推导，未选引用保留原 Node 及内容。各对象仍有自己的内容版本；这与 B 方案用同一 Node 的不同版本表达局部假设不同。全部更新时的版本细节不由 D110 确定。

**立场与理由（D38）**：应用质疑或不认可立场时一并校验和记录理由，空白不得作为有效理由；不满足要求则保持原已保存立场，保留编辑输入供补充。理由与所针对的内容版本一起演化，Revision 保存修改者、时间和前后值，历史判断引用当次立场与理由。继承记录仍指向源版本及其当时理由，不能据此自动为实质改写后的新假设表达立场。

**AI 起草与本人采用（D39）**：主张和整步推导的立场理由均可引用本人主动请求生成的 AI 候选；保存原候选 ID、对应目标版本、材料及识别产物版本与引用、本人修改及确认者和时间。候选生成不写入已生效的 `stance_reason`，采用后仍保留 AI 起草来源；本人选择的立场与采用理由一并按 D38 校验。候选的目标版本已变化时沿用过期规则，重新核对后处理。

**改写来历与实质改写（D32、D110）**：派生陈述记录源对象与当时版本，保留原立场的历史与继承记录。实质改写后的新陈述当前立场默认 `pending`（D32），源版本立场保持；不能把来源中的旧立场当作新内容的当前立场。新旧对象分别记录与演化，派生对象的修改不得回写源对象。旧 `inherited_*` 字段如何承载跨对象来历待进一步规格确认；重建核对继续按既有定义与表达归属处理，本题不新增其继承规则。

---

### 2.4 BranchNodeOverride 分支局部版本覆盖（旧方案，D110 已替代）

以下字段、解析和写入步骤保留用于理解旧稿，不作为新局部改写的实现要求。D110 采用独立新身份与推导改接；旧数据是否已有及如何迁移须在实现前核对。

> 一条条件路径对某个节点内容版本的覆盖声明，是「局部版本只作用于本分支」的可施工表达。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `bno_` | 是 | 主键 |
| branch_id | TEXT | 是 | FK → branches |
| node_id | TEXT | 是 | FK → nodes |
| node_version_id | TEXT | 是 | FK → node_versions，且该版本 `scope='branch_local'` 且 `branch_id` 与本行一致 |
| created_at / deleted_at | TEXT | 是/否 | 覆盖的生效与关闭时间；解除或替换覆盖时关闭旧行并保留，保证可审计 |

**约束**：`UNIQUE(branch_id, node_id) WHERE deleted_at IS NULL`。

**解析规则** `resolveNodeVersion(nodeId, branchId, asOf)`：
1. 在同一项目与所选分支中，命中 `created_at <= asOf AND (deleted_at IS NULL OR deleted_at > asOf)` 的 override，且所引局部版本在该时点有效 → 返回该局部版本；
2. 否则取 `scope='shared'` 且 `valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)` 中 `version_no` 最大者；
3. 无命中 → 返回空，界面显示「该研究时点无内容」，不得回退到任意一版。

每次替换局部版本，关闭旧 override 并追加指向新版本的行，不原地覆盖旧行的 `node_version_id`；同一分支与节点的覆盖有效区间不得重叠。完整历史判断按 D36 保存的版本引用清单回放，不能用当前 override 替代当次记录。

**创建 override 时的必做动作**：创建局部版本并写入 override 之前，先按 2.3 保留继承来源与继承时的状态快照；实质改写前提时将新版本当前立场初始化为 `pending`，源版本不变（D32），并写一条 `op='update'` 的 Revision 记录改写与状态变化。override 本身不存立场——立场属于版本，不属于作用域声明。

---

### 2.5 JointInference 推导步（联合推导）

> 一步推导：一个或一组前提与恰好一项结论之间的论证联系。个人立场标在整步上（D27、D113）。

**术语对照**：CONTEXT「联合推导」= 本实体 `combination='joint_required'` 且前提数 ≥ 2 的实例；CONTEXT「独立支持」= 每个理由各自一条 `combination='independent'` 的推导步。

**输出边界（D113）**：一项 JointInference 恰好引用一个结论 Node，相同前提导出不同结论时分别建立不同身份的 JointInference。各步可以引用相同的前提 Node，分别保存理由、引用与个人立场；前提复用不生成内容副本，修改一项推导不改写另一项。单项对象不能以多个结论共用一个说明与立场；自动拆分、批量创建协议及旧数据兼容另行设计。

**派生陈述与上游推导（D112）**：派生新 Node 不自动复制以原 Node 为结论的 JointInference，也不迁移原推导的 `conclusion_node_id`；原前提集合、说明与立场保持。为新 Node 论证时，由明确操作另建独立 JointInference，可以引用已有前提 Node 并复用理由，不能仅因前提或理由相同而共用原推导身份。新旧推导分别维护，改写来历不生成推导 Edge。D110 的选定下游改接继续适用；具体复用入口、来源记录和命令契约待设计。

设立这一实体的理由：D27 要求研究者能表达「认可两个前提，但质疑它们共同支持该结论的推导」。立场因此不能挂在 Edge 上——一条边只连接一个前提与结论，无法承载「这一组前提合起来」的判断。Edge 退化为推导步在画布上的投影（1.7）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `jif_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| conclusion_node_id | TEXT | 是 | 该步唯一的结论节点；每项推导恰好一个，不使用结论数组（D113） |
| combination | TEXT | 是 | `joint_required`（共同依赖）/ `independent`（独立支持）/ `unspecified`（原文未说明，保留不确定性，D26） |
| polarity | TEXT | 是 | `support`（支撑）/ `rebut`（反驳） |
| stance | TEXT | 是 | 整步推导的个人立场：`pending` / `endorsed` / `questioned` / `not_endorsed`。不因各前提被认可而自动获得认可（D27） |
| stance_reason | TEXT | 条件必填 | 针对整步推导的具体疑问或理由；`questioned` / `not_endorsed` 必填非空白文本，`endorsed` / `pending` 可空；不以成员前提的理由代替（D38） |
| reconstruction_check_status | TEXT | 是 | `pending_check` / `checked`，与 stance 独立 |
| attribution | TEXT | 是 | `author` / `ai_inference` / `user`；AI 补足的推导桥梁恒为 `ai_inference`（ADR 0003、D07） |
| premise_set_fingerprint | TEXT | 是 | 前提 ID 排序后拼接的 SHA-256，用于同一结论下同一前提集合的推导步去重 |
| period_start / period_end | TEXT(日期) | 否 | 该推导关系所指的业务期间 |
| valid_from / valid_to | TEXT | 是/否 | 版本有效区间 |
| lineage_origin_id | TEXT | 否 | 所依据的作者推导步版本（论证溯源） |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

**约束**：`UNIQUE(conclusion_node_id, combination, polarity, premise_set_fingerprint) WHERE deleted_at IS NULL`；`combination='joint_required'` 时前提数必须 ≥ 2（由 service 校验）。

**共同依赖与独立支持的区分**：共同依赖落成**一条**推导步、多个前提成员；假设必需前提不成立时，该步失去这组前提的联合支持，不表示结论已被证伪。前提是否成立尚未明确时保留不确定性。独立支持落成**多条**单前提推导步、指向同一结论；缺少某个理由，其他推导步仍然存在（CONTEXT「独立支持」的定义）。原文未说明组合关系时 `combination='unspecified'`，界面必须显示该不确定性，不得替用户选定（D26、D46）。

**临时假设预览（D46）**：以本人选择的范围与内容版本为基础，用独立预览状态表达“假设该前提不成立”，依据已有推导成员与组合关系计算结构影响。`joint_required` 的必需前提不成立时，该步在假设下失去对应联合支持；其他独立推导分别保留；`unspecified` 的影响保持不确定，下游只标为可能受影响，不写成结论已证伪。反驳关系保留原有语义，不能把支持减少或反驳减少直接换算为结论真伪。预览不更新 NodeVersion、JointInference、EvidenceLink 或 ConditionEvaluation，也不生成已保存分支或内容修订；本人明确保存后才按分支、局部版本及溯源规则写入。预览须保留其依据的版本，实际版本已变时标明，不能套用旧结果。

---

### 2.6 JointInferencePremise 推导步前提

> 推导步与其前提之间的成员关系，一个前提一行。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `jip_` | 是 | 主键 |
| joint_inference_id | TEXT | 是 | FK → joint_inferences |
| node_id | TEXT | 是 | 作为前提的节点（CONTEXT「前提」） |
| ordinal | INTEGER | 是 | 展示顺序 |
| note | TEXT | 否 | 该前提在这一步中的作用说明 |

**约束**：`UNIQUE(joint_inference_id, node_id)`；删除推导步级联删除其全部前提行。

---

### 2.7 Edge 连接

> 画布上的一条有向连接。它是推导步或路径条件的派生投影，不承载独立语义。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `edg_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| from_node_id / to_node_id | TEXT | 是 | 起点 / 终点 |
| edge_kind | TEXT | 是 | `derivation`（推导）/ `condition_dependency`（条件依赖） |
| joint_inference_id | TEXT | 否 | 仅 `derivation` 非空；一条推导步（n 个前提）投影为 n 条边，共享同一 ID |
| branch_id / condition_id | TEXT | 否 | 仅 `condition_dependency` 非空 |
| label | TEXT | 否 | 展示标签，不参与语义判断 |
| created_at / deleted_at | TEXT | 是/否 | |

**约束**：`CHECK(from_node_id <> to_node_id)`；`UNIQUE(project_id, from_node_id, to_node_id, joint_inference_id, branch_id) WHERE deleted_at IS NULL`；`CHECK(edge_kind='derivation' → joint_inference_id IS NOT NULL AND branch_id IS NULL AND condition_id IS NULL)`；`CHECK(edge_kind='condition_dependency' → branch_id IS NOT NULL AND condition_id IS NOT NULL AND joint_inference_id IS NULL)`。两种边互斥，一条边只能属于其中一种。

**两种边与推导步、分支条件的关系**（施工易错点，务必按此判读）：
- `derivation` 边是**推导步**的投影，`joint_inference_id` 非空。它不表达条件——条件约束某步推导时落在 `joint_inference_conditions`，不落在边上。
- `condition_dependency` 边是**BranchCondition**的投影，`branch_id` + `condition_id` 非空。它表达「在该路径的该条件下走到这个节点」，**不是一步推导**：它没有前提集合、没有 `combination`、没有整步个人立场，`joint_inference_id` 必须为空。
- 判断一条连线是不是推导步，只看 `joint_inference_id` 是否为空，不看它在画布上长什么样、也不看它是否带条件标签。
- 分支条件的连线由 branch service 随 `branch_conditions` 同步生成与撤销；**禁止**把一条分支条件连线建成 `derivation` 边再补一个空的推导步，那会污染推导步集合（去重、防环、整步立场统计都会算错）。
- 一个条件可以同时约束整条路径（`branch_conditions`）与路径内某一步推导（`joint_inference_conditions`）；此时画布上会同时出现一条 `condition_dependency` 边和该步的 `derivation` 边，两者是两个对象，不要合并成一条边。

**派生规则**：Edge 不由用户直接创建或删除。创建推导步时由 service 生成 n 条 derivation 边；创建或修改路径条件时由 branch service 生成/同步 condition_dependency 边。这一约束消除了「图与语义两套真相」的漂移风险。画布上点击一条 derivation 边时，按 `joint_inference_id` 高亮同组全部边，让「这一组共同依赖」可见（D27 的呈现要求）。

折叠只影响展示，不写 Edge（G03）。

---

### 2.8 Branch 条件路径

> 研究者命名的一条可能情景路径：从起点经一组条件走到某个结果节点。可共享、可汇合，不是独立树。

**术语对照**：CONTEXT「条件路径」。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `brh_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| name | TEXT | 是 | 用户命名 |
| start_node_id / outcome_node_id | TEXT | 是 | 起点 / 结果节点 |
| note | TEXT | 否 | 情景说明 |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

**路径成员不落表**：从 `start_node_id` 沿 derivation 与 condition_dependency 边遍历至 `outcome_node_id` 导出。100 节点 / 150 边规模下按需计算即可，无需物化缓存。「共享前提」判定 = 某节点被 ≥ 2 条路径的成员集合包含。汇合 = 两条路径的 `outcome_node_id` 相同。

---

### 2.9 BranchCondition 路径条件

> 一条条件路径与其进入条件之间的关联，含组合逻辑。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `brc_` | 是 | 主键 |
| branch_id | TEXT | 是 | FK → branches |
| condition_id | TEXT | 是 | FK → conditions |
| ordinal | INTEGER | 是 | 展示顺序 |
| logic | TEXT | 是 | 多条条件间的组合：`all` / `any` / `custom_note` |

**约束**：`UNIQUE(branch_id, condition_id)`。

条件也可直接约束某一步推导（`joint_inferences` 通过 `joint_inference_conditions` 关联，结构与本表同构）。约束整条路径用 `branch_conditions`，约束单步推导用 `joint_inference_conditions`；两者分别记录作用范围，按 2.7 节可同时存在。

D114 确认独立 Condition 也可被多项陈述或推导引用。陈述与条件的关联、规则版本绑定及共享修改范围仍待设计；本节已有路径／推导关联不作为该能力已经完整实现的证据。

---

## 3. 条件与评估

### 3.1 Condition 条件

> 独立的定性或结构化条件规则，定义适用范围内如何判断要求是否满足（D114）。条件状态的人工确认与 AI 评估建议继续分开处理。

**独立规则身份（D114）**：Condition 承载判定要求、适用主体、期间与口径，可以被多个 Node 或 JointInference 引用，独立编辑并保留规则历史；引用不复制规则，也不改变陈述、推导或个人立场。定性规则不要求填写无意义的数值字段。具体规则版本字段、陈述关联表与共享修改协议待设计，下表仍是待同步的旧字段方案。D115 确认每次评估拥有独立身份，`confirmed_status` 仅可用于当前状态展示，不能替代具体评估及其依据。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `cnd_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| kind | TEXT | 是 | `qualitative`（定性，始终人工判断）/ `structured`（结构化） |
| statement | TEXT | 是 | 条件原文表述；自然语言无法可靠解析时保留原文并要求补全（G02 异常） |
| metric / subject / comparator / threshold | TEXT/REAL | 结构化时必填 | 指标、主体、比较式、阈值。阈值由用户指定并附用途 |
| period_definition | JSON | 结构化时必填 | 期间定义：单季或累计、连续期数、何时重置、最新期是否完整（PRD 第 10 节） |
| unit / currency / consolidation_scope | TEXT | 结构化时必填 | 单位、币种、合并范围，用于可比性校验 |
| source_entry_id | TEXT | 否 | 允许使用的数据入口 |
| observation_start / observation_end | TEXT(日期) | 否 | 观察窗口；期间未结束 → 等待观察 |
| whitelisted | BOOLEAN | 是 | 是否属于评审通过的白名单；仅白名单结构化条件支持自动计算（G02） |
| confirmed_status | TEXT | 否 | 最新**人工评估结论**：`unconfigured` / `evaluable` / `satisfied` / `not_satisfied` / `awaiting_observation` / `unknown` / `not_comparable`。为空表示尚未确认 |
| confirmed_at / confirmed_basis_ids | TEXT / JSON | 否 | 确认时间与所用评估依据 ID 列表（可复用 AI 理由，D19） |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

---

### 3.2 ConditionEvaluation 条件评估

> 一次关于特定条件规则版本是否满足的独立评估对象，绑定当时材料、时点、评估者与结果（D115）。规则计算、AI 建议与人工结论分别记录，不互相覆盖。

**术语对照**：`evaluator='ai'` 对应 CONTEXT「AI 评估建议」（含「倾向性意见」）；`evaluator='human'` 对应 CONTEXT「人工评估结论」。

**独立身份与追溯（D115）**：不同次评估具有独立身份，可被历史判断等记录引用；新材料下的新评估不覆盖旧结果与依据。必须能够定位所用条件规则版本、材料版本及引用、实际评估者、评估时点与业务期间。现有 `condition_id` 仅标识规则对象，不足以绑定规则版本；规则版本引用、实际评估者／时点字段及当前结果选取仍需补充规格，下表不能直接视为已完整实现 D115。重试幂等与更正规则另行设计，不仅凭结果相同合并不同依据下的评估。

**自动重算的触发边界（D116）**：已支持确定性计算的结构化条件修改阈值保存后，在本地必需输入齐全且可比时，自动形成新的 `evaluator='rule'` 评估，绑定修改后的规则版本、实际使用的材料版本与评估时点。新结果仍待本人确认，不覆盖旧评估或人工确认历史，不写入 `confirmed_status`。本次触发不获取新数据、不调用模型；资料缺失、不可比或规则不支持时不得虚构结果或判作未满足。保存与计算失败的处理按 D117；同步或异步执行、材料选取及重试幂等另行设计，不据此确定整链批量操作的整体成败边界。

**保存与计算失败分别处理（D117）**：规则保存成功后，计算运行失败不撤回已保存的阈值修改，分别暴露规则保存状态、计算失败及重试入口。运行失败不等于评估得出 `not_satisfied`，不伪造成功的评估记录；旧评估仍绑定原规则版本，不能作为新版结果。规则保存本身失败仍遵守既有保存与版本冲突规则。重试成功的新计算记录仍待本人确认，运行状态的持久化字段与重试幂等继续设计。

定性标准仍可由条件对象承载；D116／D117 不限定所有评估都执行公式，也不授权修改定性标准后自动调用 Agent。确定性工具与 Agent 的执行分工及显式触发策略按 D118；任务与结果分别按 D119 和 ADR 0017 实现。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `cev_` | 是 | 主键 |
| condition_id | TEXT | 是 | FK → conditions |
| evaluator | TEXT | 是 | `ai` / `human` / `rule`（确定性计算，无模型参与） |
| verdict | TEXT | 是 | `satisfied` / `not_satisfied` / `awaiting_observation` / `unknown` / `not_comparable` |
| confidence_level | TEXT | 否 | 仅 AI：`high` / `medium` / `low`，必须附 `confidence_reason`（PRD 第 10 节：解释置信度而非制造概率） |
| is_tentative | BOOLEAN | 否 | 仅 AI：是否为「倾向性意见」（D20），为真时必须写明资料缺口 |
| basis_ids | JSON | 否 | 评估依据：引用的 Evidence ID 列表（CONTEXT「评估依据」） |
| missing_fields | JSON | 否 | 资料或字段缺口；确定性计算缺必需输入时 verdict 为 `unknown`。AI 可在已有部分依据时给出明确标为 `is_tentative=true` 的倾向性意见，保留缺口及依据（D20） |
| incomparable_reason | TEXT | 否 | 不可比原因；非空时 verdict 必须 `not_comparable` |
| computed_value / formula / input_version_ids | REAL / TEXT / JSON | 否 | 计算值与公式；由累计值推算的单季值必须标为计算值并保留两份输入版本（PRD 第 10 节） |
| period_start / period_end | TEXT(日期) | 否 | 本次评估针对的业务期间 |
| valid_from / valid_to | TEXT | 是/否 | 评估结论的有效区间 |
| created_at | TEXT | 是 | |

**约束**：确定性计算缺必需输入时保存 `unknown` 与缺失清单，不填零或自动判为 `not_satisfied`。AI 在资料有限时给出的满足或未满足倾向只是候选意见，必须标为「依据有限」、保留已有依据、推断与缺口，不冒充完整计算或人工结论（D20）。未知原因可为缺失资料或其他未解问题，不限于缺少结构化字段。**`unknown` 与 `not_satisfied` 是两个枚举值，任何路径不得仅凭数据缺失自动确认条件未满足。** 只有 `evaluator='human'` 的记录能写入 `conditions.confirmed_status`。

**可比性校验顺序**（PRD 第 10 节，实现必须按序）：主体与合并范围 → 期间与累计口径 → 币种与单位 → 计算。任一步不一致即 `not_comparable` 并中止；单位转换须可追踪；无用户认可的汇率来源与时点不做币种换算。

---

## 4. 材料与证据

### 4.1 Source 来源

> 一份材料的身份（谁写的、哪一篇），与它的每次获取内容分开。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `src_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| author / publisher | TEXT | 否 | 作者或机构；同名作者不自动合并（I03 异常） |
| title | TEXT | 是 | |
| canonical_url | TEXT | 否 | 原始地址 |
| original_file_name | TEXT | 否 | 原文件名保留（I01） |
| published_at / published_at_precision | TEXT / TEXT | 否 | 发布时间与精度：`day` / `month` / `quarter` / `year` / `unknown`。缺失需用户补充或标未知 |
| rights_status | TEXT | 是 | `authorized` / `public` / `restricted`；导出受授权范围限制（S01） |
| reprint_of_source_id | TEXT | 否 | 转载关系，指向原出处。转载不计独立佐证（E02、AGENTS.md） |
| availability | TEXT | 是 | `available` / `unavailable` / `superseded`。来源消失不等同撤稿（E04 异常） |
| created_at / deleted_at | TEXT | 是/否 | |

---

### 4.2 SourceVersion 来源版本

> 一次具体获取到的材料内容，是去重、重述与按研究时点回看的最小单位。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `svr_` | 是 | 主键 |
| source_id | TEXT | 是 | FK → sources |
| version_no | INTEGER | 是 | 来源内单调递增 |
| content_fingerprint | TEXT | 是 | 原始文件或实际获取内容字节的 SHA-256，用于同项目、同来源身份内精确去重（E02）；规范化文本只用于相似关系候选 |
| similarity_sketch | TEXT | 是 | SimHash 签名，用于识别转载与近似文本（ADR 0013） |
| storage_path | TEXT | 是 | 本地存储路径（原文与快照） |
| retrieved_at | TEXT | 是 | 获取时间，系统生成。回看可见性的硬边界 |
| is_restatement_of_version_id | TEXT | 否 | 重述关系；重述是新版本，不覆盖历史快照（E04） |
| parse_status | TEXT | 是 | `pending` / `succeeded` / `partial` / `failed` / `skipped` |
| parse_failure_reason | TEXT | 否 | 受限访问、损坏、OCR 失败、无法读清的图像、未知编码分别记录；扫描件本身不作为不支持原因（I01、D34） |
| page_count | INTEGER | 否 | 解析页数，用于成本统计 |
| created_at | TEXT | 是 | |

**约束**：`UNIQUE(source_id, content_fingerprint)` 与 `UNIQUE(source_id, version_no)`。重复导入仅在同项目、同来源身份与原始内容一致时返回既有版本，不倍增来源与提醒（E02）。不同项目或不同出处即使内容字节相同，仍各自保留来源身份、权利信息、获取时间与来源版本；转载另记关系，不当作独立佐证。底层文件可按指纹复用，但检索与下载须校验项目边界；规范化文本相同或相似不能直接合并来源。

**截图与扫描件（D34）**：首版采用多模态模型识别文字，保留原始图像与识别文本的对应关系、实际成功识别的页或区域，以及失败和不确定的部分。识别文本是对原始图像的转写结果，不替换原图，也不自动成为已核对原文；模型坐标是待验证定位，引用在转写文本中匹配成功不等于已核验图像内容。具体模型、供应商、解析产物存储结构与图像定位校验仍待选型验证。

**转写校正与识别产物版本（D35）**：同一 SourceVersion 的模型初始转写和人工校正分别形成可引用的识别产物版本；原图及 `retrieved_at` 不变，校正不创建作者重述关系。记录版本标识、修改者、时间及修改前后内容，证据、候选、评估和历史判断同时引用所用 SourceVersion 与识别产物版本，不能只凭来源版本回放最新转写。校正后仅重新分析受影响内容，产生候选或影响建议，不改写已确认的个人判断。具体产物表结构仍在 OD-24 中待定。

---

### 4.3 Evidence 证据

> 材料中可核对的特定段落、表格或字段，附精确锚点。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `evd_` | 是 | 主键 |
| source_version_id | TEXT | 是 | FK → source_versions；证据永远锚定到具体版本 |
| anchor | JSON | 是 | 精确锚点，见 ADR 0013：文本型 PDF 用 `{page, char_start, char_end, bbox, table_ref}`；截图与扫描页引用保留原图、页码（适用时）、`bbox` 与对应识别文本定位（D34）；网页用 `{text_fragment, prefix, suffix, dom_path}` |
| anchor_status | TEXT | 是 | `valid` / `relocated` / `broken`。失效时保留合法快照与旧定位并告警，不捏造原文（E01 异常） |
| quote_text | TEXT | 是 | 原文片段；来自 OCR 时明确其识别文本属性并关联原图区域，不因识别完成而视为已核对（D34） |
| extracted_fields | JSON | 否 | 抽取到的财务字段，逐项带十项必备属性：主体、指标、原始值、期间、币种、单位、合并范围、累计或单季、披露版本、来源锚点（E03）。**白名单清单首版不锁定**，待首个案例材料到位后按其真实论证涉及的指标反推（本人裁定）；十项属性与下列两条规则对任何白名单字段一律适用，不因清单未定而放宽 |
| period_start / period_end | TEXT(日期) | 否 | 业务期间 |
| block_fingerprint | TEXT | 是 | 段落级指纹，用于段落去重与锚点重定位 |
| retrieved_at | TEXT | 是 | 获取时间，继承来源版本 |
| adopted_at | TEXT | 否 | 用户采用时间 |
| created_at / deleted_at | TEXT | 是/否 | |

**约束**：`UNIQUE(source_version_id, block_fingerprint)`，同一来源版本的同一段落只产生一条证据；同一来源含多个有效段落时保留多个锚点（E02 异常）。

**两条对任何白名单字段一律适用的规则**（本人裁定，清单未定不影响其生效）：其一，未知字段一律为缺失，不填零、不填占位值；其二，主体、合并范围、期间与累计口径、币种与单位任一不一致即中止跨期计算并标为 `not_comparable`，明确指出缺少哪项信息，不做自动换算。由累计值推算单季值必须显式标为计算值并保留两份输入版本。

---

### 4.4 EvidenceLink 证据关联

> 一条证据如何作用于某个主张、推导步或条件：关系类型与解释留在这里，不写在证据上。

**派生时的责任边界（D111）**：原 Evidence 及其 SourceVersion／锚点继续可引用，新陈述可以展示它作为来自原陈述的参考；原 EvidenceLink 的关系与解释仍针对原目标，不自动复制成新目标的生效关联。参考展示不计作已关联的支持／反驳，不继承旧查证结果或个人立场。明确确认后才建立针对新陈述内容版本的独立关联；原 Evidence、原对象与原 EvidenceLink 保持，新旧关联分别维护。参考状态的存储结构、目标内容版本的绑定字段及确认操作契约待设计；下表不是已完成 D111 的施工规格。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `evl_` | 是 | 主键 |
| evidence_id | TEXT | 是 | FK → evidences |
| subject_type | TEXT | 是 | `node` / `joint_inference` / `condition` |
| subject_id | TEXT | 是 | |
| relation | TEXT | 是 | `support` 支持 / `rebut` 反驳 / `qualify` 限定条件 / `background` 背景 / `undetermined` 尚待判断（E02） |
| explanation | TEXT | 否 | 为什么这条证据作用于该对象 |
| set_by | TEXT | 是 | `user` / `ai_suggestion` |
| changed_reason | TEXT | 否 | 用户改关系时留下的理由（E02 验收） |
| valid_from / valid_to | TEXT | 是/否 | 有效区间 |
| created_at / deleted_at | TEXT | 是/否 | |

**约束**：`UNIQUE(evidence_id, subject_type, subject_id) WHERE deleted_at IS NULL`。一条证据可关联多个对象（G03）；共享证据更新只新增版本，不连带改写各分支判断（E02 验收）。转载内容通过 `sources.reprint_of_source_id` 归一，不计入独立佐证数量。

---

## 5. 变更与审阅

### 5.1 Revision 版本记录（审计）

> 每一次内容变更的追加式记录，含变更前后、操作者、时间与理由。是日常编辑历史与版本恢复的依据；D36 的完整历史判断记录独立保存，引用当次内容与依据版本。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `rev_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| subject_type | TEXT | 是 | `node` / `joint_inference` / `branch` / `condition` / `evidence_link` / `stance` / `graph` |
| subject_id | TEXT | 是 | |
| op | TEXT | 是 | `create` / `update` / `delete` / `restore` / `adopt` / `stance_change` / `check_status_change` / `discarded` |
| before_json / after_json | JSON | 否 | 变更前后快照（不记录完整敏感原文，S02） |
| reason | TEXT | 条件必填 | 变更理由；本人设为质疑或不认可时按 D38 必须保存立场理由，其余操作按各自规则填写，不能用通用操作描述替代本人具体疑问 |
| candidate_id | TEXT | 否 | 若是采纳候选产生，记录候选来源（G04） |
| actor / actor_job_id | TEXT | 是/否 | |
| idempotency_key | TEXT | 否 | 幂等键，见第 10.2 节 |
| created_at | TEXT | 是 | |

**约束**：只追加，无 UPDATE 与 DELETE。`UNIQUE(idempotency_key)`（非空时）。

**编辑历史与历史判断记录（D36）**：草稿自动保存，日常内容修改、立场变化和条件确认仍各自留下修订记录，不自动创建完整历史判断。本人主动记录时另建可独立引用的历史判断记录，保留记录者、记录时间、当次图谱与各内容版本、个人立场、作者对照基线、所用 SourceVersion、识别产物版本、证据和 ConditionEvaluation 及评估依据的对应关系。后续编辑、校正转写或新评估只改变当前研究状态，不替换该记录引用的版本；完整记录的表结构在规格阶段细化。

**转写修改记录（D35）**：识别产物须有独立修订主体；模型初始转写及人工校正内容保存为本机研究资产，修订记录关联前后产物版本、修改者与时间。应用日志不写入完整敏感原文，不能以日志作为校正历史的唯一存储。

**恢复语义**：恢复不是回滚。恢复动作新增一条 `op='restore'` 记录，并把目标主体的内容设为被恢复版本的内容（写入新的 NodeVersion / JointInference 版本，`version_no` 递增），中间版本全部保留。恢复**不触碰** `sources`、`source_versions`、`evidences`、`revisions`、`jobs`、`events`——恢复旧图谱不会删除后来取得的原始来源（G04 异常）。恢复前展示差异与影响范围并经本人确认。

---

### 5.2 Candidate 候选

> AI 或系统提出的、尚未进入个人论证的建议。采用前不属于用户判断。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `cdt_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| kind | TEXT | 是 | `argument_chain` / `claim` / `inference` / `evidence` / `condition_change` / `merge_suggestion` / `stance_reason`（D39，AI 起草的候选疑点和依据） |
| attribution | TEXT | 是 | `author` / `ai_inference`；AI 补充恒为 `ai_inference`，不因接受而改为作者表达（ADR 0003） |
| target_type / target_id / target_version | TEXT / TEXT / INTEGER | 是 | 目标对象与其版本；版本变化则候选过期 |
| suggested_op | TEXT | 是 | `add` / `modify` / `remove` / `link_evidence` / `merge` |
| payload_json | JSON | 是 | 建议内容 |
| impact_scope_json | JSON | 否 | CONTEXT「影响建议」：受影响的主张、推导步与分支 |
| basis_ids | JSON | 否 | 生成依据的材料与证据版本；立场理由候选按 D39 引用相关材料，条件评估中的「评估依据」按 CONTEXT 定义 |
| confidence_level / confidence_reason | TEXT / TEXT | 是/是 | 高/中/低，且必须解释依据（原文是否直接表述、锚点是否精确、字段是否缺失、段落是否冲突） |
| review_status | TEXT | 是 | `pending` / `accepted` / `accepted_edited` / `rejected` / `later` / `expired` |
| reviewed_at / review_reason | TEXT / TEXT | 否 | 审阅时间与理由 |
| generated_by_job_id | TEXT | 否 | FK → jobs |
| dedupe_key | TEXT | 是 | 幂等键 |
| created_at / updated_at | TEXT | 是/是 | |

**约束**：`UNIQUE(dedupe_key)`；一个候选至多被接受一次（由 `revisions.candidate_id` 部分唯一索引保证）。拒绝建议不删除原始来源（PRD 第 10 节）。

**立场理由候选（D39）**：`kind='stance_reason'` 时目标为具体主张内容版本或整步推导版本，归属为 AI 起草；payload 保留候选理由、已有依据、AI 推断和资料缺口，basis 引用相关材料与识别产物版本。候选被本人采用或修改后确认，才写入所选目标的立场理由并保留确认与修改记录；不从候选推断本人应选择哪种立场。

---

### 5.3 Review 复核记录

> 研究者审阅一条影响建议后的处理记录，与「需复核」提示和个人立场分别存在。

**术语对照**：CONTEXT「复核结果」；触发它的提示是 CONTEXT「需复核」；被审阅的对象是 CONTEXT「影响建议」。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `rvw_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| candidate_id | TEXT | 否 | 所审阅的影响建议 |
| subject_type / subject_id | TEXT / TEXT | 是 | 被复核的主张或推导步 |
| disposition | TEXT | 是 | `revised` 修订判断 / `maintained` 维持原判断 / `later` 稍后处理（D23） |
| reason | TEXT | 条件必填 | `revised` / `maintained` 必须保存非空白处理理由；`later` 可空（D23） |
| reviewed_at | TEXT | 是 | |
| created_at | TEXT | 是 | |

**约束**：一条复核记录对应一条影响建议。`disposition='later'` 时保留「需复核」标记；`revised` 与 `maintained` 必须保存处理理由后才完成本次复核，理由保存在对应 Review 中，不依赖是否产生立场修订。复核结果不表示其他未处理建议已完成复核（D23）。复核完成不自动改变个人立场——修订立场是另一次独立操作并另写 Revision。

**当前后端映射（D146）**：复核以 `kind=review` 保存于既有通用对象／不可变版本表；不另建 Review 表。`candidate_id` 在当前实现中由 `jobId + proposalIndex` 定位已完成影响任务中的一条建议，`proposalHash` 校验内容身份；`proposalTarget` 固定原目标内容版本，`target` 固定本人当次核对的目标写入版本，`context` 固定推导直接端点的内容版本。`disposition`、`reason`、`reviewedAt` 承载处理结果，当前适用性另按目标内容、个人立场和前提比较，不持久化一个可失真的“永远已完成”状态。命令／契约见 `backend/src/contracts/entities.ts`、`commands.ts`；读取及行为取舍以 D146 为准。

---

## 6. 监控与任务

### 6.1 Monitor 监控

> 一个来源范围与匹配目标的声明。首版不调度，但字段按定时可接入保留（ADR 0008）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `mtr_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| name | TEXT | 是 | |
| subject | TEXT | 是 | 公司或主题 |
| source_entry_id | TEXT | 是 | 已允许的报告入口；入口不稳定时不得显示为监控中（M01 异常） |
| report_type | TEXT | 是 | |
| target_node_ids | JSON | 是 | 匹配范围；首版不做全库智能关联（M02） |
| status | TEXT | 是 | `active` / `paused` / `canceled`。暂停不删除既有证据（PRD 第 09 节） |
| schedule_expr | TEXT | 否 | 定时表达式。**首版恒为空**，空的即无定时（ADR 0008）。本字段只为后续接入调度时不必改动领域模型而存在，首版不实现定时执行 |
| schedule_timezone | TEXT | 否 | 同上，首版不使用 |
| next_run_at | TEXT | 否 | 同上，首版不使用 |
| quota_limit | INTEGER | 否 | 额度上限。**首版不设计定时频率与额度**，本字段不启用、不参与首版计算 |
| last_success_at / last_failure_reason | TEXT / TEXT | 否 | 授权过期、限流、连续失败需在状态页显示（M01 异常） |
| created_at / updated_at / deleted_at | TEXT | 是/是/否 | |

**首版边界（ADR 0008）**：监控实体与任务结构按定时可接入设计，仅此而已。首版不交付定时获取、不交付频率配置、不交付监控额度，也不在界面上承诺「下次检查时间」。手动导入与后续可能的定时入口共用同一套去重与审阅逻辑。

---

### 6.2 Job 任务

> 一次后台处理的可追踪单元：状态、阶段、重试与成本。

首版不额外采集行为事件或提供使用频率统计（D40）。既有 Job 状态、进度、用量、实际费用、有限重试与故障记录继续保存，Revision 编辑历史及主动记录的历史判断也继续保留；这些记录不自动外传，不引入第三方分析 SDK。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `job_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| monitor_id | TEXT | 否 | 由监控触发时非空 |
| kind | TEXT | 是 | `import` / `parse` / `extract` / `reconstruct` / `match` / `assess` / `draft_stance_reason`（D39，本人主动请求起草理由）/ `inspect_inference`（D44，本人主动检查推导）/ `export` |
| status | TEXT | 是 | `queued` / `running` / `partial` / `succeeded` / `failed` / `canceled`（N01） |
| stage | TEXT | 否 | 当前阶段；支持按阶段继续与重试复用成功阶段 |
| progress_json | JSON | 否 | 进度与已完成阶段 |
| retry_count / max_retries | INTEGER | 是 | 有上限的退避重试；解析或权限错误不盲目重试（N01 异常） |
| cost_json | JSON | 否 | 解析页数、模型调用、输入输出量、缓存命中、实际供应商成本；费用未取得时保留未知或待结算，不填零；首版仅记录用量与费用、不设费用硬上限（PRD 第 11 节、D33） |
| error_code / error_message | TEXT | 否 | |
| idempotency_key | TEXT | 是 | 幂等键 |
| started_at / finished_at / created_at | TEXT | 否/否/是 | |

**约束**：`UNIQUE(idempotency_key)`。取消后晚到的结果一律丢弃并写一条 `op='discarded'` 的 Revision（N02 异常）。手动与定时入口共用同一套去重与审阅逻辑（M01 验收）。

**识别文本任务依据（D35）**：涉及识别文本的任务记录所用识别产物版本，幂等与缓存键包含该版本；校正后对受影响内容重新分析，不命中旧转写版本的抽取、重建或评估结果。

**引导检查任务（D44）**：`inspect_inference` 只由本人主动点“检查这一步”发起，围绕所选推导及相关前提、结论与材料工作。输出保留目标版本、所用材料与识别产物版本、检查问题及其依据、AI 假设与资料缺口；问题与立场理由候选分别记录，生成完成不写入个人立场或确认结论。目标改写后旧输出仍指向旧版本，不能当作新版本已检查。输出记录与问题处理状态的具体结构在 OD-25 及规格阶段细化，不把生成问题等同于接受论证变更。

**待查问题（D45）**：未解检查问题可保存为待查并继续引导，保留问题与目标版本、依据及缺口的对应关系，之后仍可从该对象访问。问题是否已解决与 Job 执行状态分别记录：`succeeded` 只表示生成任务成功，展示或跳过不表示问题已解决，也不自动改变核对状态、个人立场或人工条件结论。保存与后续处理的具体结构在规格阶段细化，不能仅用易失的界面状态保留待查问题。

---

### 6.3 Event 事件

> 一次披露或变更的提醒单元，按项目与变更类型去重。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | TEXT `evt_` | 是 | 主键 |
| project_id | TEXT | 是 | FK → projects |
| event_type | TEXT | 是 | `new_source` / `content_changed` / `restatement` / `condition_triggered` / `monitor_blocked` / `quota_exhausted` |
| dedupe_key | TEXT | 是 | 幂等键 |
| payload_json | JSON | 否 | 事件内容摘要 |
| impacted_node_ids | JSON | 否 | 受影响节点，可展开（M04） |
| occurred_at / notified_at | TEXT | 是/否 | |
| created_at | TEXT | 是 | |

**约束**：`UNIQUE(dedupe_key)` —— 同一报告在重试、多个节点引用、或手动与定时重合时只形成一个事件（M04 验收）。被拒绝的内容不会无变化反复提醒；新的重述版本可以重新提醒并写明差异。

**当前后端映射（D147）**：手动更新使用 `research.impact` 任务中的 `input.update` 保存 `schemaVersion`、`eventKey`、来源／材料 ID、原文指纹、范围说明和固定目标／直接上下文绑定；事件列表由这些任务按项目与来源内容身份归集，不另存 Event 表。任务执行、建议、本人复核分别保存，事件不承载真假或个人立场。上述完整概念模型仍包含未实现的跨文件披露归并及条件变化事件；当前精确内容归集不能替代这些要求。

---

## 7. 关系总览

```
Project 1──N Node 1──N NodeVersion
派生 Node ──改写来历── 原 Node 的指定 NodeVersion（D110，字段待设计）
Node N──N JointInference（前提成员经 JointInferencePremise；结论经 conclusion_node_id）
JointInference 1──N Edge（投影）
Branch 1──N BranchCondition N──1 Condition 1──N ConditionEvaluation
Source 1──N SourceVersion 1──N Evidence 1──N EvidenceLink
                                        └── 指向 Node / JointInference / Condition
Candidate ──(可选)── Job ；被采纳时写 Revision
Review N──1 Candidate
Monitor ──(可选)── Job ──(产生)── Candidate / Event
全部主体 ──N Revision（只追加）
```

---

## 8. 时间语义：四种时间字段与按研究时点回看

### 8.1 四种时间字段并存

| 时间字段 | 回答什么问题 | 承载实体 | 必填性 |
| --- | --- | --- | --- |
| 业务期间 `period_start` / `period_end` | 这条信息描述哪个期间 | Evidence、ConditionEvaluation、Node、JointInference | 结构化材料必填；定性主张可空 |
| 发布时间 `published_at` + `published_at_precision` | 材料何时对外发布 | Source / SourceVersion | 尽量填写；未知标 `unknown`，需用户补充（I03 异常） |
| 获取时间 `retrieved_at` | 本系统何时取得 | SourceVersion、Evidence | 必填，系统生成。**回看的硬边界** |
| 用户采用时间 `adopted_at` | 研究者何时采用 | Evidence、NodeVersion、Candidate（审阅时） | 采用后必填 |
| 版本有效区间 `valid_from` / `valid_to` | 该版本在图谱中何时生效 | NodeVersion、JointInference、EvidenceLink、ConditionEvaluation | `valid_from` 必填 |

### 8.2 按研究时点取版本

所有读图接口统一携带 `asOf`（缺省为当前时刻，即「按今天已知」）。三条可见性谓词：

1. **内容版本**：`valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`
2. **材料与证据**：`retrieved_at <= asOf`。后续披露的 `retrieved_at` 必然大于早先的研究时点，因此**在结构上不可能倒灌为当时已知**（I03、E04）。
3. **引用关系与派生身份**：使用在 `asOf` 生效的推导引用及对应对象版本；后来创建的派生陈述与改接不得进入更早的时点视图。具体改接历史结构随 D110 继续设计。

旧 2.4 节的 `resolveNodeVersion` 仅属于已替代的同身份覆盖方案，新的解析流程待 D110 字段与引用历史明确后制定。界面进入回看模式时必须在顶部明示当前研究时点，并允许一键切回「今天已知」（PRD 第 10 节：用户可主动切换）。回看结果不得写回任何 `*_at` 字段。

**已确立的部分**（PRD 第 10 节、AGENTS.md，与 D28 无关）：任何时点视图都只取当时已获得的材料，后来导入或重述的内容不得倒灌为当时已知；用户可主动切换到「今天已知」，切换是显式操作，不改写历史记录。

**D28 已确认的默认回放**：用户在 Q28 中选择 A，回看某次已保存的个人判断时默认展示该次判断、当时的材料版本与评估记录，后来新增或修订的材料另行对照。材料按当次记录引用的版本与获取时间边界取，评估按当次记录引用的版本及有效区间取，个人立场按当次 NodeVersion.stance 与修订记录回放；不得用最新共享立场替代历史或局部版本立场（D32）。用户主动切换到今天已知的信息重新审视旧判断时，不改写原历史记录。

**D36 的创建与读取边界**：完整历史判断只由本人主动记录，区别于 Revision 编辑历史。回放该记录时按其保存的版本引用清单取图谱、立场、作者基线、材料、识别文本与评估，不仅凭 `asOf` 查询当前对象。记录中未核对或未知的内容保留当时状态，不因记录完成而变为已核实。

### 8.3 反馈与防环的时间分层表达

现实中的「投入增加 → 收入变化 → 再投入」不是图里的环，而是不同期间的三个节点。建模时按 `time_layer` 与 `period_start/period_end` 拆开（本期投入 / 下一期收入 / 再下一期投入），保存可读的有向无环结构（PRD 第 10 节、G03）。缺少方向、时间或机制说明的联系先标为关联，不称因果（AGENTS.md）。

---

## 9. 状态机汇总

下表 9.1 至 9.3 是三套主状态机（条件、候选、复核），9.4 与 9.5 是挂在内容上的两套独立标记（个人立场、重建核对），9.6 与 9.7 是运行时状态。六者彼此不互相推导：确认条件满足不表示认可该论证，接受候选不自动把立场切成认可，完成复核也不表示立场已改变。

### 9.1 条件计算、建议状态与人工评估结论

下图描述当前计算或待评估状态。自动计算与新材料可更新计算结果或候选建议，只有本人确认才能新增人工评估结论并更新 `confirmed_status`；已有人工结论、依据与确认时间保持不变，新的差异提示待本人确认（D18、D19）。

```
unconfigured 未配置
     │ 补全结构化规则且白名单字段齐备
     ▼
evaluable 可评估 ──┬── 期间已结束 + 输入可比 + 字段完整 ──► satisfied 满足
                   │                                    └─► not_satisfied 未满足
                   ├── 期间未结束 ─────────────────────► awaiting_observation 等待观察
                   ├── 必需字段缺失 ──────────────────► unknown 未知
                   └── 主体/期间口径/币种单位不一致 ──► not_comparable 不可比
```

| 迁移 | 触发 | 守卫 |
| --- | --- | --- |
| unconfigured → evaluable | 用户补全规则 | 结构化 schema 校验通过 |
| evaluable → satisfied / not_satisfied | 生成确定性计算结果 | 期间已结束且可比且字段完整；结果本身不更新人工结论 |
| evaluable → awaiting_observation | 期间未结束 | `observation_end >= 今天` |
| evaluable → unknown | 必需字段缺失 | 缺失清单非空；**禁止**降级为 not_satisfied |
| evaluable → not_comparable | 口径不一致 | 按主体→期间→币种单位的顺序校验，任一失败即中止 |
| 任意 → unconfigured | 用户清空规则 | — |
| awaiting_observation / unknown / not_comparable → evaluable | 缺口补齐后重新评估 | 重走完整校验顺序 |
| 候选意见 → 新的人工评估结论 | 本人明确确认（可复用 AI 评估依据，D19） | 保留本人选择、理由及引用、确认时间；AI 倾向与资料缺口仍按原归属记录 |

**硬约束**：`unknown` 与 `not_satisfied` 是两个枚举值，永不共用；缺失数据不填零，不映射为 false（AGENTS.md、G02 异常）。定性条件始终显示人工评估结论及理由，不走自动计算。结构化条件可自动计算，但计算结果与用户确认的状态分开显示（M03 验收）。

### 9.2 候选审阅状态

`pending` 待审阅 → `accepted` 已接受 / `accepted_edited` 编辑后接受 / `rejected` 已拒绝 / `later` 稍后；`pending` 或 `later` 在目标版本变化时 → `expired` 已过期。

- `accepted` / `accepted_edited` 为终态，写入 Revision（记录候选、来源、采用者与时间，G04）。
- `rejected` 不删除原始来源。
- `later` 仍留在收件箱提醒列表内。
- `expired` 需重新计算差异再提交，不在未知版本上套用旧修改（M03 异常）。

### 9.3 复核结果（D23）

`revised` 修订判断 / `maintained` 维持原判断 / `later` 稍后处理。前两项完成本次复核并保留理由；`later` 保留「需复核」标记。复核结果独立于条件状态与个人立场。

### 9.4 个人立场（D24）

`pending` 待研究 / `endorsed` 认可 / `questioned` 质疑 / `not_endorsed` 不认可。挂在 Node（主张）与 JointInference（整步推导，D27）上。收录作者论证默认 `pending`；局部版本与推导步的立场互不自动继承同化。

D38 补充：`questioned` / `not_endorsed` 生效前必须有一句具体疑问或理由；主张理由属于实际选用的 NodeVersion，推导理由属于整步 JointInference，`endorsed` / `pending` 可空。编辑历史和主动记录的历史判断分别保留所引用版本的立场及理由，后来修改理由不改写旧记录。

D39 补充：本人可请求 AI 根据已有材料起草理由候选，AI 起草、本人采用与修改分别留存；生成完成不自动改变个人立场或既有理由，采用时仍需通过 D38 校验。

### 9.5 重建核对状态（ADR 0004）

`pending_check` 待核对 / `checked` 已核对。挂在 Node 与 JointInference 上，与 stance 独立——核对回答「重建是否忠实于原文」，立场回答「我是否接受」。

### 9.6 任务状态（N01）

`queued` → `running` → `succeeded` / `partial` / `failed` / `canceled`。

### 9.7 监控状态

`active` / `paused` / `canceled`。首版 `schedule_expr` 恒空，状态仅由用户手动切换。

---

## 10. 防环、幂等与恢复

### 10.1 防环

| 层级 | 措施 |
| --- | --- |
| 单点校验 | `CHECK(from_node_id <> to_node_id)` |
| 结构校验 | 写入 `from_node_id → to_node_id` 前，从 `to_node_id` 沿同一图谱范围内的现有边正向遍历（递归 CTE）；若可达 `from_node_id` 则拒绝，并返回 G03 要求的解释文案（提示把「当期现金流」与「下一期投入」拆开） |
| 唯一性 | `UNIQUE(project_id, from, to, joint_inference_id, branch_id)` 防重复边 |
| 入口统一 | 所有写图操作经唯一的 `GraphWriteService`，防环校验只有一处实现 |
| 建模纪律 | 反馈环用时间分层拆成不同期间的不同节点（7.3） |

先按建议规模 100 节点 / 150 边使用按需遍历，不引入闭包表；实际性能须验证，建议规模不作为已确认容量限制。

### 10.2 幂等（N02）

| 环节 | 幂等键 | 落点 | 重复时行为 |
| --- | --- | --- | --- |
| 任务提交 | `hash(project_id + kind + 目标集合 + 配置版本 + 内容指纹)` | `jobs.idempotency_key` UNIQUE | 仅在同项目与同任务范围返回既有 job，不新建 |
| 来源入库 | `source_id + SHA-256(原始材料字节)`，先校验来源所属项目 | `UNIQUE(source_id, content_fingerprint)` | 同项目、同来源的重复内容返回既有版本；其他出处或项目分别保留，不跨边界返回既有 ID（E02、S01） |
| 候选生成 | `hash(job_id + target_type + target_id + target_version + kind)` | `candidates.dedupe_key` UNIQUE | 不重复生成；仅目标版本变化才产生新候选 |
| 用户接受 | 请求体携带 `expected_target_version` | 服务端比对当前版本 | 不符返回 409，不应用变更（M03） |
| 事件提醒 | `hash(event_type + project_id + 变更标识)` | `events.dedupe_key` UNIQUE | 重试、多节点引用、手动与定时重合只形成一个事件 |
| 审计 | `op + subject + 目标版本 + 操作内容` | `revisions.idempotency_key` UNIQUE | 超时重试最多产生一次可见变更 |
| 已取消任务的晚到结果 | `jobs.status = 'canceled'` | 应用前校验 | 丢弃结果并写 `op='discarded'` 的 Revision |

结果未知时先查询任务状态，不得靠反复新建任务恢复（N02 异常）。

### 10.3 版本恢复不篡改审计

恢复 = 新增一条 `op='restore'` 的 Revision + 写入内容的新版本。已存在的 Revision 永不修改、永不删除；被恢复版本之后的中间版本全部保留，仍可按研究时点查到。恢复不触碰来源与证据（4.1）。

---

## 11. 索引清单

| 表 | 索引 | 用途 |
| --- | --- | --- |
| nodes | `(project_id, deleted_at)`；`(project_id, node_type)` | 项目内列举、按类型筛选 |
| node_versions | `UNIQUE(node_id, version_no)`；`(node_id, valid_from, valid_to)`；`(inherited_from_version_id)` | 版本链、按研究时点回看、局部版本的继承来源反查 |
| branch_node_overrides（旧方案） | `UNIQUE(branch_id, node_id) WHERE deleted_at IS NULL` | 仅对应 2.4 旧方案；D110 不按此索引设计新局部改写 |
| joint_inferences | `(project_id, deleted_at)`；`(conclusion_node_id)`；不建立端点集合唯一索引（D105/D119：相同端点的不同理由可独立存在） | 结论反查、去重 |
| joint_inference_premises | `UNIQUE(joint_inference_id, node_id)`；`(node_id)` | 前提反查某节点参与哪些推导步 |
| edges | `(project_id, from_node_id)`；`(project_id, to_node_id)`；`(joint_inference_id)` | 遍历、防环、同组高亮 |
| branches | `(project_id, deleted_at)`；`(outcome_node_id)` | 汇合判定 |
| conditions | `(project_id, kind)`；`(confirmed_status)` | 待评估清单 |
| condition_evaluations | `(condition_id, created_at)`；`(condition_id, evaluator)` | 最新结论与 AI/人工分离 |
| source_versions | `UNIQUE(source_id, content_fingerprint)`；`UNIQUE(source_id, version_no)`；`(retrieved_at)` | 来源内去重、回看；项目范围随 Source 校验 |
| evidences | `UNIQUE(source_version_id, block_fingerprint)`；`(period_start, period_end)` | 段落去重、期间检索 |
| evidence_links | `UNIQUE(evidence_id, subject_type, subject_id)`；`(subject_type, subject_id)` | 证据面板反查 |
| revisions | `(project_id, created_at)`；`(subject_type, subject_id, created_at)`；`UNIQUE(idempotency_key)` | 审计回看、幂等 |
| candidates | `UNIQUE(dedupe_key)`；`(project_id, review_status)` | 收件箱 |
| jobs | `UNIQUE(idempotency_key)`；`(project_id, status)` | 任务状态查询 |
| events | `UNIQUE(dedupe_key)`；`(project_id, occurred_at)` | 提醒聚合 |
| 全文检索 | SQLite FTS5（`trigram` 分词）覆盖 `node_versions.title/body` 与 `evidences.quote_text` | 中文子串检索（ADR 0010） |

---

## 12. 导出格式（S01）

导出为单个 JSON 文件，顶层键：

```
schema_version, exported_at, project,
nodes, node_versions, branch_node_overrides,
joint_inferences, joint_inference_premises, edges,
branches, branch_conditions, conditions, condition_evaluations,
sources, source_versions, evidences, evidence_links,
revisions, candidates, reviews, monitors, jobs
```

规则：ID、时间、单位与币种原样保留，导入导出不丢失（S01 验收）；原文受授权限制无法合法导出的部分只导出来源索引与说明；导出不含密钥、日志与供应商凭据；另行生成一份便于阅读与继续编辑的 Markdown 研究摘要（D37）。

D36 补充：完整导出须包含编辑历史、本人主动创建的历史判断记录及其引用的版本对应关系，识别文本使用 D35 的独立产物版本；不能以只导出最新对象代替历史回放能力。新增记录与产物的具体 JSON 字段仍由 OD-18 的格式说明确定。

D37 补充：可读摘要采用 Markdown，包含个人判断、前提及其立场、条件路径、引用出处与对应记录的时间和版本，保留作者／AI／个人归属及待核对、未知等状态。摘要导出依据已有记录，不另建历史判断，也不改变各内容版本；具体引用链接与授权范围内原文的打包方式仍待 OD-18 细化。

D38 补充：JSON 与 Markdown 保留各内容版本的个人立场和立场理由；对整步推导的疑问与前提疑问分别呈现。导出历史判断使用当次版本的理由，不以最新理由替代。

D39 补充：导出已采用的 AI 起草理由时保留原候选、引用的材料与识别产物版本、AI 来源和本人确认或修改记录，历史判断仍引用当次理由版本。

---

## 13. 本轮已裁定事项与遗留未决项

### 13.1 已裁定（本人 2026-10-01 拍板，本文据此编写）

1. **部署形态**：本机 Web，访谈 D29 已确认并翻正为已确认决策。ADR 0011 与 ADR 0015 按已确认编写。
2. **访问范围**：仅本机，不做远程、不做多端同步、**不预留远程**。ADR 0015 不含任何云端鉴权或远程访问设计。
3. **备份保留期**：默认 30 天恢复窗口，可在设置中调整；该数值是可调默认值而非服务承诺。上线前必须实测一次完整恢复，未实测不得视为可用（ADR 0015）。
4. **材料外传范围**：允许送商业模型 API，但供应商必须明确提供零数据留存（ZDR）与企业／API 条款、承诺不将输入用于训练，且能给出可核验的条款依据。写为硬性筛选条件（ADR 0014）。
5. **财务白名单字段**：首版不锁定清单，待首个案例材料到位后按真实论证涉及的指标反推。十项必备属性与「未知不填零、不可比中止跨期计算」作为通用规则保留（见 4.3 节）。
6. **定时监控**：首版只交付手动更新（ADR 0008）。不设计定时频率与额度；监控与任务结构按定时可接入保留，不扩展为首版功能（见 6.1 节）。
7. **局部改写的来历与当前立场**（D32、D109、D110）：明确选择部分引用时派生新身份，保留来源与当时版本；实质改写后当前立场默认待研究，原立场历史与未选引用保留。2.4 的旧同身份覆盖方案已被替代，相关字段与迁移待重设，重建核对按既有归属与核对规则处理。
8. **ADR 编号冲突**：已解决。手动更新保持 0008，历史判断重编号为 `docs/adr/0009-preserve-historical-judgment-context.md`，技术决策保持 0010–0016。

### 13.2 遗留未决项（交产品裁决，本文不作结论）

1. 独立支持的多条推导步在画布上是否折叠显示为一条箭头，以及展开的触发方式。
2. 历史判断的默认回放已由 Q28 的 A 确认，规则见 D28 与 8.2 节；后续需验证回放是否使用当次记录的材料、评估与立场版本，不再重复询问该默认选择。
3. 模型供应商的最终入选者：ADR 0014 只给出候选池与硬性筛选条件，未锁定单一厂商，入选后需另记 ADR。
4. 备份保留期在具体使用场景下的实际取值（30 天为默认值，是否调整由本人按需决定）。
