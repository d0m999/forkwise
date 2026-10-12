# 数据库 → 画布 → Agent 字段映射

唯一权威为当前domain_heads所指不可变domain_versions（参考Python等价records/versions/archive）；SQL的typed tables是同事务维护的索引，不能接受独立写入。独立参考包中的 SQL DDL 仅用于设计验证，未包含在本次文档发布中，也不是现有库迁移。

| 领域/写域 | 权威字段与主键 | Frontend派生 | Agent派生 | 旧库适配入口 |
|---|---|---|---|---|
| thought:{id} | id,bodyId,itemId；project+domain_key | 卡片寻址、打开正文 | 稳定节点ID | entities仅提供旧身份，不能沿用其论证类型约束 |
| body:{id} | thoughtId,blocks[id,type,data,parentId]；独立version | 富文本、标题章节、折叠 | block数、reference拓扑、detail片段 | versions中的内容需显式转换；layout文本不是第二权威 |
| item:{id} | kind、thoughtId或versionId | 渲染节点类型 | 可寻址对象类型 | layouts对象ID映射 |
| pose:{itemId} | 世界x/y,width,height,rotation；独立version | 屏幕坐标=世界坐标×视口变换 | 可选空间字段，不推断关系 | layouts坐标需拆域；视口只属于UI会话 |
| parent:{itemId} | parentId或null | 容器框和成员移动 | 显式单父层级 | layouts的容器成员关系，导入必须验证 |
| connector:{id} | start/end为bound(itemId,offset)或free(point)，label原文 | 路径/标签 | 无语义升级的普通边 | links不能默认视作推导边；普通连接需typed适配 |
| material:{id} | 可变source,latestVersionId | 资料入口当前信息 | 缩略元数据，source detail | source/research对象按明确ID映射 |
| materialVersion:{id} | materialId,sourceSnapshot,content；不可变 | 捕获时内容 | 固定快照detail | 旧来源版本独立保留 |
| asset:{id} | digest,mediaType；不可变 | 媒体解码/加载状态 | 媒体身份及读取状态 | asset/file Adapter，二进制不塞入pose |
| reference:{blockId}（派生） | 源body的reference Block保存targetKind/targetId | 引用块与broken标记 | 源块、目标、targetAvailability | links混合关系需拆分；不存在不可辨引用不可猜 |
| 历史/receipt/changefeed | project、commandId、actor、前后域补丁、revision | 保存状态、undo提示 | readonly历史、失效游标 | action_history/GraphWriteService统一transaction接入 |

## 完整提交顺序

1. 可信会话确定project/role/写权限；严格解析command，幂等查重
2. 在同一事务读取所有被修改域和相关关系；计算删除级联、容器后代移动等派生变化
3. expected必须覆盖实际修改域，新增依赖导致EXPECTED_DOMAINS或CONFLICT，调用者重读；不悄悄把未知影响补进用户动作
4. 检查ID所有权、块身份、单父无环、端点约束、被删引用保留身份
5. 创建不可变版本、更新heads及索引、写history/receipt/changefeed，再一次提交；失败不产生半写
6. UI/Agent凭receipt更新版本，observe使缓存失效；同snapshot read重建实际画布与结构图

## 生命周期映射

- 删除普通节点：thought/body/item/pose/parent墓碑；incident connector墓碑；incoming reference Block不改正文，其目标状态派生deleted
- remove_container：只删group/frame自身，保留成员；直接parent变null；容器绑定端点冻结为世界自由点；显式普通端点删除优先删线
- delete Group：组和成员删除；delete Frame：保留成员。空组在最后成员离开时移除
- Asset和MaterialVersion从不随卡片删除物理回收；旧版本继续持有引用。资料导入不进入研究撤销40步
- ID和VersionID不可回收，undo写新版本；tombstone索引使引用可区分deleted与从未存在

## 尚未实现的生产适配

现有GraphWriteService没有接入此参考Module；没有执行旧数据库迁移、真实浏览器接线、生产并发压测、跨进程锁、权限服务、媒体上传/解析。JSON Adapter只在单进程内串行写，原子replace+fsync提供本机文件提交演示，不声称停电零丢失。SQL DDL通过标准库SQLite创建验证；其typed索引与命令事务同步仍需生产实现。

## 语言与可选同步策略

生产推荐仍为 TypeScript/Node.js 与 SQLite 事务。CRDT不是本映射的前提；若未来获准做正文局部试验，SQL查询投影须作为同一权威状态的可恢复派生表示，不能出现双权威。详细约束见 [ADR 0004](adr/0004-language-and-crdt-strategy.md)。本轮仅文档记录，未变更本页字段或schema。
