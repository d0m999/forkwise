# 自问自答：领域映射决策树

状态：已完成本轮工程契约收敛；未声称产品建议已获确认。来源基线：147e9da588b5fb54991b00c8d8c8127d0c05eebf。

## 决策树与每轮 frontier

1. 地图究竟保存什么？
   - 1.1 思维身份 → 1.2 正文归属 → 1.3 摆放数量 → 1.4 复制/删除
   - 1.5 关系类型 → 1.6 普通连线环 → 1.7 引用失效 → 1.8 容器移除
2. 谁有权改变它？（依赖 1）
   - 2.1 UI/Agent统一写入 → 2.2 写域 → 2.3 幂等 → 2.4 原子派生依赖
   - 2.5 撤销主体与粒度 → 2.6 编辑批次 → 2.7 重启与迟到结果
3. 怎样看见它？（依赖 1、2）
   - 3.1 画布投影 → 3.2 Agent投影 → 3.3 分页快照 → 3.4 预算和保真度
4. 资料怎样加入？（依赖 1、2、3）
   - 4.1 可变来源/不可变快照 → 4.2 复用/复制 → 4.3 删除/保留 → 4.4 产品确认

## 第一轮：身份与关系

Q1 同一文字是否同一思维节点？否。身份从稳定ID来；标题、位置、内容、顺序都不是身份。反例：两个同名节点同时存在，改名不能意外合并。状态 engineeringchoice。

Q2 多个画布项能共用正文吗？本包建议不提供：一 Thought 一 Body 一 CanvasItem。否则修改一张卡会改变远处的卡，必须额外设计共享提示与权限。MaterialVersion/Asset 可以复用，但不能偷换为 Body 共享。状态 productproposal，保守实现，不引入新交互承诺。

Q3 正文标题块是树父节点吗？不是。正文 heading 后的章节范围可派生；持久块父子只允许列表项。未知块原始 payload 不丢失。反例：移动正文标题块若递归带走后续正文，会把章节显示推导误写成所有权。这里的 heading 与独立卡片 title 不同。状态 existingaccepted D279/D282。

Q4 Reference、Connector、Containment 是同一种边吗？不是。Reference是正文内容指向；Connector含用户原标签、端点位置和绑定，不解释推理；Containment只管理直接父容器。反例：“because?” 标签不能变成 causal=true；两节点靠近不能产生边。状态 existingaccepted D403/D416/D418 与 engineeringchoice 表达形式。

Q5 环一律拒绝吗？否。普通Connector允许环；绑定同一对象两端拒绝；Containment必须单父无环。反例 A→B、B→A 是用户地图，不因旧推导模型DAG约束拒绝。状态 existingaccepted 当前普通连线范围。

Q6 删除容器等于删除内容吗？分命令：delete Frame 仅移框；remove_container Group 解组；delete Group 删组和成员；delete普通对象删相连Connector。保留内容移除容器才冻结其绑定端点，且普通删除优先。反例 同时移框并删另一端，线必须删除而非复活。状态 existingaccepted D416/D418/D420。

## 第二轮：写入、历史和失效

Q7 前端localStorage和数据库都能是权威吗？不能。UI/Agent都发统一command；本地只存草稿、outbox、缓存。反例UI保存一整份含旧pose的Body记录覆盖刚完成的Agent拖动。状态 engineeringchoice，契约核心。

Q8 全局revision可当写锁吗？不。正文和姿态等细域独立；project revision只排序读与delta。反例并发正文编辑+拖动应均成功。删除/容器移动必须派生依赖写集合并原子检查；不能只锁入口对象。状态 existingaccepted D92，具体域粒度 engineeringchoice。

Q9 ACK丢失后旧expected是否冲突？已提交同commandId同请求，返回原receipt；同ID不同payload失败；先验证可信会话权限。反例保存成功→undo→重启→原请求重试不能再覆盖undo。状态 engineeringchoice。

Q10 undo能回退版本时钟吗？不能。恢复的是内容，写入的是新版本。历史40步，人类顺序undo/redo，Agent只读；资料/资源导入不随卡片撤销删除。反例恢复v1内容后仍叫v1会使旧客户端误以为没有发生过变更。状态 existingaccepted D65/D136 + engineeringchoice单调版本。

Q11 400ms保存批次等于撤销步吗？不。D283 1秒连续输入间隔、语义边界和IME决定动作，400ms/2s决定落盘批次；并发画布操作截断时间连续合并。反例正文a→拖动→正文b不能合并成一次正文undo越过拖动。状态 existingaccepted。

Q12 丢失回执/晚到图片怎么办？原card+block身份、草稿generation、请求ticket与body版本必须一起校验；旧ACK不得清新草稿。迟到资源可落为未附着Asset，不能复活已删节点。运行时只覆盖旧ACK；异步上传ticket与取消需在生产集成前实现，已列为阻断验收。状态 existingaccepted D281/D283。

## 第三轮：Agent投影

Q13 Agent用Markdown总览即可吗？不足。先给稳定ID/版本/关系拓扑，正文及资料以相同snapshot分块展开；Markdown只是派生显示。反例有相同标题的两节点，纯标题摘要无从准确编辑。状态 engineeringchoice。

Q14 能在固定小包内承诺无限全图吗？不能。拓扑可分页，完整性只在同snapshot全部页获取后成立；单个超长标签超过预算需明确ITEM_EXCEEDS_BUDGET，不静默截断。正文/资料任意JSON按Unicode安全片段重组。预算计完整JSON的UTF-8字节，不伪称模型token。状态 engineeringchoice。

Q15 observe后又写入，会混读吗？observe原子附带固定revision的snapshot；read以该token续读。重启后内存snapshot明确过期，不伪续页。权限每页重新检查，撤销权限不能从旧snapshot泄漏内容。状态 engineeringchoice。

Q16 摘要遗漏能算完整吗？不能。参考模型summary=null，exact结构与内容detail分离，redacted、not_fetched和deleted明确；没有运行的推理不伪装摘要。外部不可访问/尚未抓取的source是下一Adapter需要细化的状态。状态 engineeringchoice。

## 第四轮：资料

Q17 source更新会改变旧引用吗？不会。material当前source可改，materialVersion内存sourceSnapshot和content，不改旧version。反例网页更新后去年引用自动指向今年内容。状态 engineeringchoice；具体资料UX为productproposal。

Q18 卡片复制等于资料复制吗？否。duplicate_current明确读执行时当前正文并产生新Body/Block；可复用不可变Asset。它不是剪贴板粘贴；D337剪贴板固定快照命令尚未实现，不能拿它替代。状态 existingaccepted复制独立身份，工程切片限制。

Q19 必须现在问用户什么？本包不需要额外回答即可作为可执行提案。正式集成前需确认一正文一摆放范围与资料复用展示；原文件永久删除和跨项目资料共享另议。不阻塞技术验证，不把建议升级为已确认需求。

## 规则核对记录

最终数字经固定仓库D136/D283原文核实：40步、1秒连续编辑间隔、400ms debounce、2秒批次上限。普通删除与保留内容容器移除按D418/D420分别验证。公开来源与本地验证范围见 [验证说明](../VALIDATION.md)。

## 第五轮：语言与 CRDT（2026-10-12 文档补充）

Q20 Python测试通过是否意味着生产应改Python？否。推荐生产沿用TypeScript前端/领域/后端、Node.js与SQLite事务；Python只保留参考实现。状态 engineeringchoice recommendation。

Q21 Agent结构化视图或正文/姿态并发是否迫使采用CRDT？否。当前使用细域版本与固定snapshot投影；只有频繁同正文并发、离线多设备或多人实时协作需求成立才考虑Body/Block局部试验。状态 engineeringchoice recommendation，不是采用授权。

Q22 CRDT能否直接替代领域规则和项目undo？不能。收敛并不证明文本语义正确，也不执行权限与业务命令幂等；按actor的选择性撤销不能取代人类按项目时间顺序撤销（包含Agent修改）。

Q23 Rust是否是CRDT必选语言？否。候选有Yjs JavaScript、Yrs Rust、Automerge Rust核心与JavaScript绑定；先用相同场景核验语义、恢复、存储成本和性能，再选择，不能由语言推断速度。完整取舍与来源见 [ADR 0004](adr/0004-language-and-crdt-strategy.md)。

## 第六轮：文档评审补齐（2026-10-12，待实现/待验证）

Q24 只有标题、带标签但正文为空的卡片能往返保存吗？目标契约必须能。Thought.title 独立于 Body；Tag 保存项目共享名称/颜色，CardTags 保存单卡有序关联。不能从正文首行或可见标签猜完整数据。依据 D151、D167、D187、D195；字段与分域属于本次工程表达，未追加运行通过结论。

Q25 删除共享标签只删当前卡片的标记可以吗？不可以。确认后原子移除项目标签与全部卡片关联，保留原关联顺序和墓碑身份；一次撤销完整恢复。已有搜索条件不删 tagId，改为失效，改名则解析为新名称；跨项目粘贴优先使用目标标签及颜色。依据 D188–D195、D347/D348。

Q26 独立图片、文字或形状可以统一包装成 Thought 吗？不可以据此获得完整写字板。独立内容按 kind 保存：图片引用不可变 Asset 并单独记录裁剪与 Pose；文字 runs 保留局部强调，字号作用于整个对象；形状保留外形和短文字。连线绑定各自 itemId，删除/撤销不丢对象身份。笔迹也单独保存，但不成为端点。依据 D355–D406、D418、D422。

Q27 保存 x/y/width/height/rotation 能恢复遮挡吗？不能。四类内容还需要独立 StackOrder，保存从后到前的 itemId 顺序；type/id 只是索引分页。置底、多选保序、复制置顶和删除恢复都维护此域；临时选中置前不修改它。依据 D310–D323，不能把 DOM 当前显示顺序写回权威数据。

Q28 补齐字段就能沿用18项通过结论吗？不能。原验证只针对先前隔离切片；标题/标签生命周期、独立对象往返和持久排序都是新增待验场景。CRDT 候选资料只归并到统一研究入口，未安装、采用或验证新库。场景清单见 [验证说明](../VALIDATION.md)。

Q29 随动批注可用普通连线或容器归属代替吗？不能。附着关系保留既定目标身份与偏移，移动跟随，复制自由副本，删目标保留批注并解绑、撤销恢复（D78/D84/D421）。它与删普通端点连带删线不同，也须避免容器双重移动。新增字段/旧目标Adapter未实现；删卡后写字板仍按 D261 保留删除状态与本次撤销入口，不自动收起。范围与验收只索引[产品基线](../../../prd/current-product-baseline.md)，不将旧PRD或原18项测试当新增通过记录。

Q30 附着图片裁剪/恢复只写 image.crop 与 Pose 可以吗？只有无需改偏移时才可以，仍须校验附着和目标依赖。单侧裁剪或展开完整图若改变批注锚点所需世界位置，要按新世界框回算 attachment.offset，与crop/尺寸原子提交；Pose.x/y是派生读数。恢复沿当前移动/拉伸/旋转后的变换，不回滚旧布局；取消不写，undo/redo同一步恢复三域，依赖变化无半写。中心锚点fixture裁去左侧25%后，B从(100,100,200,120)变成(150,100,150,120)，offset须从(0,0)变成(25,0)，保持旧偏移会误读左边为125。字段闭包与量化[待验场景](../VALIDATION.md#附着图片裁剪与恢复待验场景)已补，非运行通过记录。
