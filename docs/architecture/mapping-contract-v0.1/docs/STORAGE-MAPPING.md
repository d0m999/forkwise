# 数据库 → 画布 → Agent 字段映射

唯一权威为当前domain_heads所指不可变domain_versions（参考Python等价records/versions/archive）；SQL的typed tables是同事务维护的索引，不能接受独立写入。独立参考包中的 SQL DDL 仅用于设计验证，未包含在本次文档发布中，也不是现有库迁移。

2026-10-12 评审补充：本页现在描述目标映射，新增的标题、标签、独立对象内容、排序与随动批注附着域尚未在隔离参考模型或生产实现。字段名与分域是工程表达；产品行为以[设计访谈](../../../design-interview.md)为依据，范围/验收查[产品基线](../../../prd/current-product-baseline.md)，不能把下表当作已经存在的 SQL schema。

| 领域/写域 | 权威字段与主键 | Frontend派生 | Agent派生 | 旧库适配入口 |
|---|---|---|---|---|
| thought:{id} | id,bodyId,itemId,title；独立version，project+domain_key | 独立卡片标题、卡片寻址；空标题占位派生 | 稳定卡片ID、原始标题 | 显式区分旧身份/标题/正文，不能沿用论证类型约束或猜正文首行是标题 |
| body:{id} | thoughtId,blocks[id,type,data,parentId]；独立version | 富文本、正文标题章节、折叠 | block数、reference拓扑、detail片段 | versions中的内容需显式转换；layout文本不是第二权威 |
| tag:{id} | name,color，独立version及墓碑；nameKey为名称派生索引 | 项目标签名/颜色、删除状态与末次名称 | 稳定tagId、名称和有效性；不解释为立场 | 项目标签显式建身份，不从正文词语或旧立场字段生成 |
| cardTags:{thoughtId} | 去重有序orderedTagIds；独立version | 一行预览/写字板完整列表，按该卡顺序 | 完整标签关联，名称颜色从同快照tag读取 | 保留完整集合与每卡顺序，不从屏幕可见标签反推 |
| item:{id} | kind；Thought关联thoughtId，提案MaterialCard关联versionId，Shape/Text/Image/Stroke/Frame关联同itemId内容域；Group成员由parent域决定 | 按类型选择渲染/编辑能力 | 明确对象类型，不把所有对象当卡片 | layouts对象需保留身份及类型，不能用“有文字”判断Thought |
| shape:{itemId} | shapeType,shortText,fill,stroke等已支持外观；独立version | 五种形状及短文字 | 形状与文字原文，无推理角色 | 原形状映射为Shape，不造Body |
| text:{itemId} | runs[{text,marks}],fontSize,lineHeight,align,widthMode；独立version | 多行文字、局部强调、整块字号与对齐 | 原文由runs串接，保留格式；不加入卡片搜索 | 保留局部颜色/加粗，不引入局部字号 |
| image:{itemId} | 固定assetId,crop{x,y,width,height}；独立version | 独立图片及非破坏裁剪 | 资源身份、裁剪范围、可选显示尺寸；无自动OCR | 原独立图片不包装成正文块或MaterialCard |
| stroke:{itemId} | penKind（普通/荧光笔）,path,color,width,opacity；独立version | 笔迹覆盖显示，不改底层内容 | 笔迹几何与样式；不当作文字或连线 | 保留原笔迹数据，具体引擎编码须做适配验证 |
| frame:{itemId} | name,background；独立version | 分区名和外观 | 容器名称，不是卡片正文 | 显式映射分区属性，成员由parent域决定 |
| pose:{itemId} | 自由对象世界x/y及width,height,rotation；独立version；附着对象世界位置见下节 | 屏幕坐标=世界坐标×视口变换 | 可选空间字段，不推断关系 | layouts坐标需拆域；视口只属于UI会话 |
| attachment:{annotationItemId} | targetKind/targetId,offset{dx,dy}；可选独立version及墓碑，目标明确区分卡片item和旧推导身份 | 同快照目标锚点＋偏移派生世界位置；解除后自由Pose | 明确附着及当前空间位置，不推断证据/推导 | 保留已有批注目标/偏移；旧推导Adapter不可映成普通Connector，新类型兼容待验证 |
| stack:{projectId} | orderedItemIds，从后到前；独立version | Thought/Shape/Text/Image共同持久叠放，临时选择显示另算 | 原始序位与排序版本，不推断语义 | 显式读取已有持久顺序；缺失时列迁移缺口，不从类型/UUID/当前临时置前猜测 |
| parent:{itemId} | parentId或null | 容器框和成员移动 | 显式单父层级 | layouts的容器成员关系，导入必须验证 |
| connector:{id} | start/end为bound(itemId,offset)或free(point)，label原文 | 路径/标签 | 无语义升级的普通边 | links不能默认视作推导边；普通连接需typed适配 |
| material:{id} | 可变source,latestVersionId | 资料入口当前信息 | 缩略元数据，source detail | source/research对象按明确ID映射 |
| materialVersion:{id} | materialId,sourceSnapshot,content；不可变 | 捕获时内容 | 固定快照detail | 旧来源版本独立保留 |
| asset:{id} | digest,mediaType；图片另需已确认的naturalWidth/naturalHeight，内容及其元数据不可变 | 媒体解码/加载状态、原始比例 | 媒体身份及读取状态，元数据缺失须明示 | 参考实现只有digest/mediaType；真实二进制与尺寸验证由asset/file Adapter实现，不塞入pose |
| reference:{blockId}（派生） | 源body的reference Block保存targetKind/targetId | 引用块与broken标记 | 源块、目标、targetAvailability | links混合关系需拆分；不存在不可辨引用不可猜 |
| 历史/receipt/changefeed | project、commandId、actor、前后域补丁、revision | 保存状态、undo提示 | readonly历史、失效游标 | action_history/GraphWriteService统一transaction接入 |

### 卡片与标签的约束

1. `title` 是独立纯文字，允许手动换行和空值。Body 的 heading 只组织正文，不代替 title；“未命名卡片”只用于显示。只有标题的卡片也可保存、复制、重读和搜索（D151、D252、D254）。
2. 有效 Tag 的 `(projectId, nameKey)` 唯一。nameKey 由固定的大小写折叠规则产生，不可由调用者独立写入；保留 name 原文，不套用全文搜索的简繁/同义规则。创建撞名复用原 tagId，重命名撞名拒绝。标签颜色只在 Tag 保存，不在各卡片复制一份（D185–D194）。
3. orderedTagIds 只引用同项目的有效标签、每个最多一次。增加默认追加，重排只改当前 cardTags；删除卡片只删关联，不删项目标签。复制卡片生成独立关联列表，沿用原标签；跨项目按目标同名标签及颜色优先，缺失标签新建后绑定目标 ID（D195、D327、D347、D348）。
4. 删除 Tag 的事务写集包括 tag 和受影响的全部 cardTags；历史保留每卡原来的关联位置。确认时显示数量和受影响范围，执行时重新检查标签版本、关联版本及范围是否变化，变化则重读后重新确认。undo 同一次恢复原标签身份、名称、颜色、全部原关联及顺序（D188、D189）。
5. 搜索条件和历史持久保存 tagId 引用；显示名称由标签记录解析。标签删除不静默删条件：用墓碑/历史保留的末次名称显示失效状态，暂停结果；撤销删除后引用恢复有效。改名不修改独立关键词（D184、D190–D192）。查询偏好与搜索历史不是卡片正文或标签名称的第二权威。
6. 搜索索引由 title、Body 的完整可检索文字和 cardTags 派生，保留字段与块边界及原文命中位置。内容最近编辑时间从标题/正文的实际写入记录派生，不由姿态、叠放或标签重排推进。按同一 snapshot 联结 Tag，不能出现新名称配旧关联；匹配与排序沿用 D238、D245、D246，搜索范围不扩大到独立对象。

### 独立内容与几何的边界

- item.kind 与内容记录一一对应：Shape/Text/Image/Stroke 不创建 thought/body/cardTags；卡片也不能靠添加 image 内容域变成独立图片。不提供转卡命令（D422）。MaterialCard 仍是提案，不因进入字段表就开通产品入口。
- Shape 的 shapeType 仅为 rectangle、roundedRectangle、ellipse、diamond、triangle；shortText 与外观没有研究角色，不承载完整写字板（D402、D404）。
- Text 的 runs 顺序与文字是权威，纯文字投影由串接派生；marks 只包含允许的局部强调样式，不含 fontSize。fontSize、lineHeight、align 对整块生效。widthMode 表达未手调的自动宽度或手调后的固定宽度；实际世界宽度只在 Pose 保存。左右调宽保持字号，四角缩放原子更新 text.fontSize 与 Pose，保留局部强调；自动排版导致的尺寸变化同样按所依据的文字版本校验（D385–D401）。
- Image 的 crop 使用**未旋转原图**的归一化坐标，完整范围为 `(0,0,1,1)`，要求正宽高且不越界；assetId 在对象存续期间不可替换。Pose 的矩形是当前可见裁剪区域的世界包围框，图片 rotation 仅允许 `0/90/180/270`；90°旋转保持可见中心并交换宽高。依照原图自然宽高、crop、Pose 和旋转可还原拉伸/裁剪映射，不能把裁剪后的像素覆盖 Asset（D364–D378、D382）。
- 应用/恢复裁剪需原子修改 image.crop 与相应 Pose；附着图片还须同事务保存必要的 attachment.offset 变化，不能写派生的 Pose.x/y 代替。裁剪应用保持预览位置和大小，恢复完整图按当前比例向外展开、保持原可见内容的大小/位置。预览、取消和大图查看状态不写入权威数据；原图保持不变。单纯调整显示尺寸且附着锚点无需改变世界位置时只改 Pose，附着几何的写入原则见[原子闭包](#附着图片裁剪与恢复的原子闭包待实现)（D363、D367–D381）。
- Connector 的 bound(itemId,offset) 只接受同项目有效的 Thought/Shape/Text/Image/Group/Frame；卡片 offset 保留所选固定边。独立对象移动或改尺寸由该身份与 Pose 更新路径；Asset、Body 内的图片 Block、Stroke 不是画布连线端点（D79、D418、D419）。

### 持久顺序的写入与读取

`stack:{projectId}` 是 D310 四类内容对象共同顺序的唯一权威；SQL 中每对象的序位是从它派生的索引，不接受另一套独立排序写入。每个有效 Thought/Shape/Text/Image itemId 出现一次，禁止重复、缺漏、墓碑和跨项目 ID。集合是项目级，版本冲突只约束排序相关命令，不充当所有正文写入的项目锁。

置顶/置底保留选区内部原顺序；前移/后移基于同一操作前的顺序和几何，跳过不重叠对象，多选以最近未选重叠对象为目标，必要时联动以保序（D313–D319）。例如从后到前 `甲、乙、X`，选中甲乙、只有甲与 X 重叠，前移后为 `X、甲、乙`。执行中校验 stack 版本及计算重叠/选区外框依赖的 pose/parent 版本；这些只读依赖不因被检查就生成新版本。重叠检测的引擎几何实现仍待验证。

新建/副本创建、删除、恢复与 stack 增删同事务；整批副本按原内部顺序插到前方，取消选择不回滚。只有排序变化时不改坐标、正文和字号；没有变化不创建操作历史。普通移动、进出容器和解组保持成员排序。Group/Frame 外框、笔迹与连线的绘制层适配范围见契约1.3，不据此扩大菜单。

Frontend 在同一 revision 读取 item/content/Pose/StackOrder 后构图，再应用会话内的选中临时置前；Agent 如请求空间数据只获得持久顺序。纯卡片多选临时整体置前、混合多选保持遮挡、显式置底或逐层操作暂停临时置前均不产生另一份持久排序（D303–D315）。身份索引的 type/id 分页与这里的从后到前顺序无关；大集合分块返回时需保留原序位和 snapshot，不能跨快照拼接。

### 随动批注的空间与生命周期（待实现）

Attachment 只在明确附着后有效，每个 Text/Shape/Image/Stroke 批注至多一个同项目目标。卡片使用 itemId，旧整步推导使用显式旧身份/锚点 Adapter；具体 targetKind 枚举、旧记录格式和新笔迹编码在实现时验证，不扩展当前附着目标范围（D78/D84/D421）。

附着期间 offset 与目标锚点为位置权威，Pose 的世界 x/y 为读取时派生投影，不接受独立覆盖；width/height/rotation 仍由 Pose 保存。目标移动/增高按同快照重建批注位置；批注拖动只改 offset。裁剪、恢复或其他已支持的几何动作若改变批注锚点所需的世界位置，必须同事务更新 offset，不能只检查其版本；无需改变 offset 时仍校验 attachment 与目标锚点依赖、不生成 attachment 新版本。解除时用同一操作前状态算出世界位置，写入自由 Pose 并墓碑 attachment，不让视口坐标成为权威。

删除目标写集包含受影响 attachment 及未纳入本次删除范围的批注自由 Pose，读依赖包括目标锚点/几何、批注尺寸和附着范围；范围或版本变化整体冲突。保留批注的内容、身份和排序，undo 同一次恢复原目标、原附着和偏移。批注自身明确删除或按既定整组删除纳入范围时，连同自身 attachment 墓碑；相连 Connector 与批注附着不共用级联删除规则。附着和容器运动避免双重随动，既有框架/混合类型适配仍须核验。

复制只取复制时的投影世界位置及内容，副本无有效 attachment；同时复制目标也不继承随动关系，跨项目亦不保留源目标 ID。Frontend 与 Agent 同 snapshot 读取目标/关系/Pose，旧目标无法解析时保留原记录并标缺口，不能猜测或静默丢关系。

### 附着图片裁剪与恢复的原子闭包（待实现）

本节补齐 D369/D370 与既有随动的工程衔接，不改变裁剪/恢复的用户行为或附着目标范围。

1. **计算目标几何。**在同一操作前快照读取 image.crop、图片 Pose、有效 Attachment、目标身份及计算目标锚点所需的实际域、已确认的资源尺寸。应用裁剪以完成时的裁剪框世界范围为新可见框；恢复完整图片从当前已应用的 crop、显示尺寸/旋转和位置推导原图到世界的变换，再展开完整范围。裁剪后的移动、拉伸或90°旋转必须保留，不能复用裁剪前的旧位置/尺寸。
2. **回算偏移。**设 T 为该快照的目标世界锚点，A(B_new, rotation_new) 为按同一批注锚点定义从新可见框计算的世界锚点，则 `offset_new = A(B_new, rotation_new) - T`。锚点定义沿类型 Adapter，不因裁剪切换；归一化 crop、世界 offset 与屏幕坐标分别处理。公式是工程表达，不指定新的产品锚点交互。
3. **确定实际写集。**自由图片写 image.crop 与自由 Pose 中实际改变的字段；附着图片写 image.crop、Pose 的尺寸/允许旋转等实际字段，并在 offset 改变时写 attachment.offset。targetKind/targetId、Asset、目标本身及布局顺序不因裁剪改写。附着图片的 Pose.x/y 只读派生，不另写绝对位置；offset 未变时不新建附着版本，没有有效附着时不创建关系。
4. **校验并一次提交。**expected 覆盖实际写域及读依赖，包括图片/姿态、附着有效性或无附着状态、目标身份/锚点域及所用资源事实。目标移动/增高/删除、批注被解除或重附着、图片已被另一操作修改，任一使依赖失效则整体冲突，不写部分 crop/Pose/offset，也不靠旧位置静默重放。只读依赖不生成写入版本；幂等、receipt、delta 与历史同事务提交。
5. **预览与历史。**预览/取消不写领域版本或历史。应用或恢复为一次可撤销动作，记录同次 crop、Pose 与必要 offset 的前后变化；undo/redo 原子恢复它们及原附着身份，沿现有新版本规则。Frontend/Agent 重读同 revision 后应重建相同世界范围，不显示新 crop 配旧 offset。若内容/几何/偏移均无变化，不写版本或新增历史。

offset 的更新由目标几何决定，不以“尺寸发生变化”推定偏移必变，也不以“已附着”漏掉必要写入。中心锚点下的对称裁剪可只改变 crop/尺寸；单侧裁剪通常需要新偏移。具体量化场景及旋转/拉伸适配见[验证说明](../VALIDATION.md#附着图片裁剪与恢复待验场景)。

### 操作闭包与历史粒度（待实现）

| 操作 | 必须原子提交/检查的范围 | 历史边界 |
| --- | --- | --- |
| 创建卡片并完成首次标题 | thought、空body、item、pose、cardTags、parent及stack项；按落点更新归属 | 创建与连续首次标题输入为一步，正文/标签等后续操作另计；已有标题一轮编辑另成一步（D262、D263） |
| 标签改名/改色 | tag版本与项目内名称唯一约束；关联保持tagId，相关投影按依赖失效 | 一个标签操作；不伪造每张卡片正文修改 |
| 增删/重排某卡标签 | 当前cardTags及所引用标签有效性；不覆盖标签的名称/颜色 | 只作用于该卡关联；不连带改其他卡顺序 |
| 删除/撤销删除标签 | tag及当次全部受影响cardTags、范围校验、receipt和delta | 删除为一步；撤销原子恢复原名/色/关联位置（D189） |
| 新建或复制独立对象 | item、对应内容域、pose、parent，四类内容另含stack；复制重建新身份 | 沿用复制规则；独立文字连续首次输入并入创建（D394）；图片Asset持久保留 |
| 文字角点缩放 | text与pose；若改变附着锚点所需世界位置，同写必要attachment.offset，并校验实际依赖 | 一次完成手势为一步，预览中间帧不拆步 |
| 应用/恢复图片裁剪 | image.crop、实际变化的pose；附着图片同写必要attachment.offset，校验附着状态及目标锚点依赖；详见上节 | crop/几何/必要偏移同一动作原子撤销/重做；offset未变只校验，不新建附着版本 |
| 批注附着/重附着/解除及偏移调整 | attachment、适用的自由pose/容器归属变更及目标/批注几何依赖 | 一次完成动作为一步；复制为自由副本，撤销恢复原附着与位置 |
| 置顶/置底/逐层批量调整 | stack与决定目标所依赖的几何/归属版本 | 一次命令为一步，内部顺序保持；无变化不记步 |
| 删除普通对象 | 身份/内容/pose/parent，适用的cardTags/stack，相连Connector及受影响attachment/批注自由Pose | 一次删除含连带变化，撤销恢复原身份/顺序/附着；批注目标删除保留批注，资源不物理删除 |

所有新增域的变更进入同一 receipt/changefeed 和40步项目历史；客户端不能在正文、标签、排序之间分开持久提交一个本应原子的动作。命令/参数的最终 DTO、存储索引及规模策略需在实现时验证，本次不提供或迁移 DDL。

## 完整提交顺序

1. 可信会话确定project/role/写权限；严格解析command，幂等查重
2. 在同一事务读取所有被修改域和相关关系；计算删除级联、容器后代移动等派生变化
3. expected必须覆盖实际修改域及影响计算所依赖的只读域；新增依赖或范围变化导致EXPECTED_DOMAINS或CONFLICT，调用者重读；不悄悄把未知影响补进用户动作。项目标签名称唯一性和关联集合的并发变化也在事务内检查
4. 检查ID所有权、块身份、标签唯一性及有序关联、kind与内容域对应、图片资源/裁剪约束、StackOrder完整性、单父无环、端点约束和被删引用保留身份
5. 创建不可变版本、更新heads及索引、写history/receipt/changefeed，再一次提交；失败不产生半写
6. UI/Agent凭receipt更新版本，observe使缓存失效；同snapshot read重建实际画布与结构图

## 生命周期映射

- 删除卡片：thought/body/item/pose/parent/cardTags墓碑，移除stack项；incident connector墓碑；incoming reference Block不改正文，其目标状态派生deleted；项目Tag不删除，随动批注保留并按删除前世界位置解除附着
- 删除独立对象：item、对应shape/text/image/stroke内容域及pose/parent墓碑，适用的stack项、相连线及自身attachment同批移除；Frame仍走保留内容的容器路径
- 删除Tag：保留身份和末次名称/颜色，移除有效卡片关联；搜索条件保留失效tagId，不删除卡片或Body；撤销一次恢复原有序关联
- remove_container：墓碑容器自身的item/pose/parent及适用的frame内容域，保留成员；直接成员parent变null；容器绑定端点冻结为世界自由点；显式普通端点删除优先删线
- delete Group：组和成员删除并维护成员stack项；delete Frame：保留成员及其顺序。空组在最后成员离开时移除；容器端点按契约的普通删除/保留内容两类规则处理
- Asset和MaterialVersion从不随卡片删除物理回收；旧版本继续持有引用。资料导入不进入研究撤销40步
- ID和VersionID不可回收，undo写新版本；tombstone索引使引用可区分deleted与从未存在

## 尚未实现的生产适配

现有GraphWriteService没有接入此参考Module；没有执行旧数据库迁移、真实浏览器接线、生产并发压测、跨进程锁、权限服务、媒体上传/解析。JSON Adapter只在单进程内串行写，原子replace+fsync提供本机文件提交演示，不声称停电零丢失。SQL DDL通过标准库SQLite创建验证；其typed索引与命令事务同步仍需生产实现。

上述 JSON/DDL 描述只对应原隔离切片。新补的标题/标签、各独立对象内容域、Frame外观字段、图片自然尺寸和StackOrder均没有新增运行证据；相关端到端场景列在[验证说明](../VALIDATION.md)，标为待实现/待验证。

本次批注 attachment 与派生 Pose 的目标字段同样未改代码/schema、未做旧数据迁移或真实交互验证。

## 语言与可选同步策略

生产推荐仍为 TypeScript/Node.js 与 SQLite 事务。CRDT不是本映射的前提；若未来获准做正文局部试验，SQL查询投影须作为同一权威状态的可恢复派生表示，不能出现双权威。详细约束见 [ADR 0004](adr/0004-language-and-crdt-strategy.md)。本次评审修改的是文档字段契约，未修改运行代码、参考模型或数据库schema。
