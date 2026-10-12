# Forkwise 映射契约 v0.1（参考契约；产品提案待确认）

本目录发布已整理的领域契约文档；对应的隔离参考模型在本次发布前完成本地验证，但 Python 代码、测试及 SQL DDL 不包含在本次文档提交中。这不是生产迁移，不改动旧后端或 R2。标注「建议」的结论不冒充用户已确认决定。公开源码基线与验证边界见 [验证说明](VALIDATION.md)。下文“本包”“参考实现”均指该隔离模型，而不是仓库现有生产实现。

## 1. 身份、所有权和生命周期

- Project 是隔离与历史的单位。所有对象归属一个 Project，不能用另一个项目的 ID 绑定；跨项目复制另建身份。
- Thought 是一个可编辑的思维节点身份，恰好拥有一个 Body、一个 CanvasItem。Body 不可被两个节点共享；当前版本不提供同一正文多处摆放。移位、改文、撤销均保留节点身份。
- Body 是有序 Block 列表。Block 有稳定 ID；重排保留 ID，复制生成新 ID，删除再撤销恢复原 ID。普通文本、标题、列表、图片、附件、引用等是呈现结构，不强制观点或假设分类。参考实现实现 text/heading/listItem/asset/reference/opaque 联合类型；只有 listItem 可形成块内父子，未知内容用 opaque 原样保留。
- CanvasItem 只表达布局与视觉身份：Thought、MaterialCard、Group、Frame。Pose 独立版本化。正文写入不得覆盖 Pose，拖动不得覆盖正文。
- Material 是项目中可复用的资料身份，拥有可变 source 元数据与不可变 MaterialVersion。MaterialCard 是本包仅用于解释资料摆放的产品建议，不是已确认的新 UX 类型。每个建议中的 MaterialCard 捕获一个具体 MaterialVersion；更新 source 不悄悄改变已有卡片，更新快照必须显式执行。重复使用同一资料产生新卡片，重复复制 Thought 产生新 Thought/Body/Block，已有 Asset 可复用。
- Asset 是不可变内容身份及媒体元数据。替换文件创建新 Asset。删除节点不立即删除 Asset；只有所有当前与保留历史引用都释放后才具备回收资格，本包不执行物理回收。
- Reference 是正文内指向 Thought 或特定 MaterialVersion 的引用，不等于屏幕连线。引用身份在本参考模型中就是其来源 Block ID；目标删除变为 broken，保留可解释的目标身份，不级联删除正文。
- Connector 是用户画出的普通连线，可有用户标签。不自动解释因果、支持、反对、出处或推理。允许环；禁止两端绑定同一个对象。端点可绑定 CanvasItem 或是世界坐标 free point。
- Group 是一层集合，只含普通 CanvasItem，不含 Group/Frame；Frame 是单父、无环空间容器，可含 Frame。两者不等于 Reference/Connector。每个 item 至多一个直接父容器，类型为 group 或 frame。
- 删除 Thought：墓碑 Thought/Body/CanvasItem；其 Reference 标 broken；与该普通 CanvasItem 相连的 Connector 一并删除。仅保留内容的容器移除才将容器绑定端点按删除前世界坐标冻结为 free point。删除 Frame 或取消 Group：保留内容与世界坐标；直接成员提升到画布顶层，子 Frame 保留自身成员。删除整个 Group 则删除组及成员。删除 Material source：保留已有快照卡片与引用，阻止新增复用。历史保留可恢复对象，不复用被删 ID。

## 2. 权威写入与版本

唯一写入 seam 是 Mapping.execute(command, actor)。UI 和 Agent 均调用它；存储 Adapter 承担原子提交。actor 是可信会话上下文，绝不采信 command 内自称 human 的字段。read(query) 和 observe(cursor) 是其余两个 Interface；后两者只读。客户端草稿不是另一个权威库。

command = {commandId, type, expected, payload}。commandId 在项目内唯一；expected 按写域给出不可变版本 ID（新对象使用 null）。body、pose、material、connector、containment 分域，互不借用全局 revision 做乐观锁。跨域操作一次原子校验所有触及域，失败完全不写。

处理顺序：认证及项目权限 → 严格解析 → 查 commandId → 已成功且规范化请求相同则返回原 receipt → 同 ID 不同请求报 IDEMPOTENCY_MISMATCH → 校验域版本及约束 → 原子持久化实体/版本/历史/receipt/changefeed。丢失 ACK 后原请求可跨重启重试，不能因旧 expected 拒绝已完成命令。失败命令不消耗 commandId。幂等保留窗口不得短于客户端可重试窗口；本参考模型不清理 receipt。

每次成功写入生成新的不可变 VersionId；project revision 和域 generation 单调增长。撤销是新写入与新版本，不把时钟或版本 ID 倒退。Project revision 用于读一致性与变更游标，不是所有命令的写锁。并发编辑同一正文冲突返回当前版本，由调用方重读/人工合并；不虚构自动合并。

## 3. 历史与编辑批次

人类可按项目时间顺序撤销/重做；Agent 可读历史，不可执行 undo/redo。项目历史包含 UI 和 Agent 成功写入，因此人类可以撤销 Agent 的最新变更。参考模型保留 40 个可撤销 action；保留的不可变版本不等同于可撤销 action。新的研究编辑清空 redo 栈；非研究步骤的资料/资源导入保留 redo 栈。undo/redo 自身产生新 change revision，但不插入可无限递归撤销的普通 action。

D283 的 1 秒连续编辑间隔、400ms debounce、2s 最大等待及 IME 单元须由 UI 草稿协调器贯彻：编辑组以节点/会话/焦点/1s间隔分界；组内多次落盘合并成一个 undo 单元，仍保留独立写入版本；拖动或其它命令会截断正文编辑组，禁止跨并发事件重排历史。composition 未结束不拆分提交；2s 上限在 IME 完成后生效。ACK 仅确认其覆盖的 draft generation，旧 ACK 不能清除新草稿。参考模型分别实现服务器历史组和最小草稿状态机，实际编辑器/网络接线仍待生产集成。

## 4. 两个投影，同一真相

Frontend read：按世界坐标、结构化 Block、连线端点、frame/group 布局重建画布；正文、姿态各自版本可见。Agent read：优先 identity index → 局部正文/邻接/资料快照 → 必要时分块展开，避免把画布截图当唯一结构。不得把空间邻近自动变成语义关系。

read 固定 project revision，返回 snapshot token。后续页面只能读取该 token 的相同快照；过期必须 SNAPSHOT_EXPIRED，不能用当前数据续旧页。稳定排序按 type/id，页边界不改变 ID。token 是不透明快照引用，不是授权；每次读仍检查权限。带预算读明确返回 coverage、totalItems、nextCursor、fidelity；不枚举无限长 omittedIds；正文截断必须说明，不得把未读内容写进摘要。参考模型用 UTF-8 字节预算替代模型 tokenizer，明确 budgetUnit，不能称 token 数。

observe(afterRevision) 返回顺序 delta：变化对象/写域和被删除 ID；游标太旧返回 RESET_REQUIRED。UI 与 Agent 根据相同 delta 作缓存失效，再用相同 revision/token 重读；不能拼接不同 revision 页后声称完整图。摘要只基于本次返回事实，包含 coverage；本包不调用 LLM，不生成推断性摘要。

## 5. 适配旧系统与未决产品项

目标 Adapter 对照旧 entities/versions/links/layouts/action_history 和 GraphWriteService，不照搬它们的模糊术语。R2 的 localStorage 文本+pose混合记录只能做草稿/缓存，不能直升权威库。上线前须确定 ID 映射、旧引用缺失策略、事务持久化、真实权限和迁移回滚。

建议已固定为本包测试前提：一节点一正文一摆放；资料快照引用；项目全体行动按时间撤销；frame 使用世界坐标规范化。真正需产品确认：资料原始文件永久删除/保留策略；跨项目资料共享是否要成为产品能力；超过40行动后的历史展示保留期。它们不阻塞本包，但不得以本包存在为由擅自上线。

## 6. 决策状态（不得合并）

- existingaccepted：D136/D65 最近40步；D283 1秒编辑间隔、400ms debounce、2秒批次上限、IME与旧ACK规则；D279–282 块复制/标题/未知块/异步图片保护；D416 单父与分区保留内容；D418/D420 普通删除与容器移除差异。
- engineeringchoice：read/execute/observe、小写域版本、不可变VersionId、幂等先于版本冲突、世界坐标规范化、快照分页、字节预算、JSON参考存储。
- productproposal：一节点一正文一摆放的当前保守范围（不默许共享正文）；MaterialCard命名及资料复用交互；source与attachment快照的产品表现。仅本包实验可执行，须在正式集成前确认。

资料导入和文件创建不进入研究编辑40步历史，撤销卡片附着不删除资料、原文件或资源。生产历史 Adapter 必须保留这一差别。

## 7. 可运行范围与明确缺口

运行时入口签名为 read(query, actor)、execute(command, actor)、observe(afterRevision, actor)。持久字段设计见 [字段映射](docs/STORAGE-MAPPING.md)；独立参考包的 SQL DDL 未随本次文档发布。

- 隔离参考模型已实现（非生产实现）：身份/正文/姿态、普通连线、组/框单父归属与平移、普通删除和保留内容容器移除、引用失效、资料快照复用、独立正文复制、40步undo/redo、输入草稿/旧ACK保护、固定快照分页、完整响应字节预算、JSON文件重启幂等恢复
- duplicate_current 是“执行时复制当前正文”，不是剪贴板；D337 固定剪贴板快照、完整容器复制/粘贴、卡片更新资料快照、连线路径/样式编辑、框缩放后的收纳命中算法不在此参考切片
- D281 异步图片请求ticket、取消、晚到结果防复活尚未接线；不能据旧ACK测试称媒体完成。参考Asset只保存digest/mediaType，未上传或验证真实二进制。Group创建暂允许空组用于构造fixture，不作为产品新能力；已存在非空组最后成员离开会清理
- available 仅表示已存记录可读取，不表示source URL可访问、文件字节已下载或媒体已解析。not_fetched表示内容需detail；redacted表示当前调用者不可见；deleted由保留身份判定；从未存在返回NOT_FOUND。外部inaccessible状态须在资料Adapter实现，不能用空内容代替
- detail按128个Unicode码点的JSON文本片段无损展开，必须按chunkIndex重组后JSON解码；原Block ID保留。单个不可拆拓扑项（例如超长连线label）超过预算时ITEM_EXCEEDS_BUDGET，调用方提高预算；不静默截断
- snapshot不跨进程持久；重启后续页返回SNAPSHOT_EXPIRED。cursor绑定当前授权范围摘要，权限变化返回AUTHORIZATION_CHANGED，重新开始授权后的读取
- 参考进程串行化来自多个调用者的命令，不含多线程/多进程互斥。真实并发数据库、权限服务、真实浏览器渲染、迁移与性能均未验收

## 8. 版本保留与规模边界

不可变版本是逻辑不变量，不等于无限保留承诺。此参考Adapter不清理archive、receipts、changefeed；读snapshot在内存复制整份状态，写入也序列化完整JSON。随着项目增长会增加内存与存储占用，不能据此宣称可扩展架构。生产需单独决定历史版本/快照/幂等窗口、压缩与回收，不能先删仍被引用的Asset或MaterialVersion。Agent投影是派生查询/缓存，永远不形成第二份可写权威。

编辑组由可信客户端输入协调器按D283产生；服务器只合并同actor、同body、同editGroup的相邻正文提交，不用两次网络提交间隔替代输入间隔。因此2秒自动保存批次不会把持续输入的同一动作切碎；其它命令会截断合并。跨会话editGroup须使用session唯一前缀，避免重启复用。

## 9. 生产语言与 CRDT 策略（2026-10-12 补充）

生产推荐沿用 TypeScript 前端/领域/后端、现有 Node.js 与 SQLite 事务；本包 Python 只是参考验证实现，本次未迁移。当前不采用 CRDT：Agent 投影和 Body/Pose 分域不以它为前提。若以后证实频繁的人与 Agent 同正文并发、离线多设备或多人实时协作需求，再经独立批准对 Body/Block 做局部试验。

CRDT 收敛不保证改写语义正确；Agent 应提交细粒度补丁，不能以可合并为理由用旧基线整段覆盖。权限、领域不变量、业务幂等和同revision投影仍要保留；CRDT 更新与 SQL 派生投影须有一致、可恢复的持久化协议。元数据、日志、GC与离线恢复均有存储和工程成本。

继续采用人类执行的项目时间顺序undo/redo，包含Agent修改；不改为按actor选择性撤销。Rust/WASM只在实测热点或必要集成证明有价值时考虑，不是CRDT必选项。Yjs（JavaScript）、Yrs（Rust）与Automerge（Rust核心及JavaScript绑定）的候选事实和条件试验验收见 [ADR 0004](docs/adr/0004-language-and-crdt-strategy.md)。本次仅记录建议，未安装、采用或性能测试任何CRDT库。
