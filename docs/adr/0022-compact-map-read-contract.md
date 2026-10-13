# 同 revision 的卡片紧凑读取与无损展开

状态：工程采纳；Issue #6 实施合同。这里只说明当前卡片切片，不声明未来对象或完整首版验收。

UI 与已授权 Agent 从 `Mapping.read` 读取同一 SQLite 权威状态。新增 `type: "map"`，`view: "index" | "body" | "detail"`；HTTP 使用 `GET /api/mapping/projects/{projectId}/map`，MCP 只读工具为 `forkwise_read_map`，复用本机 HTTP。写入、历史与媒体检查仍由既有 Mapping 执行，不建立另一份可写投影。

## 当前范围与身份

`index` 只覆盖已有普通卡片，保留稳定 Thought、Body、CanvasItem 身份、独立标题及 Thought/Body/Pose 版本、世界位置与尺寸。响应 `scope.types` 为 `["thought"]`，`scope.relations` 为 `not_implemented`。尚不存在的连线、容器、标签、独立媒体等由其拥有者票同步扩展投影与预算回归；不把空间邻近推断成关系，也不声称当前 scope 覆盖全部未来地图对象。

索引按 type/id 排序（当前只有 thought，ID 使用 JavaScript 字符串序）；每张卡的 `order` 是既有创建序位，`scope.order` 为 `creation_ordinal`，用于保持当前 UI 次序。它不是未来 StackOrder，也不把选择期间临时置前写进权威数据。

## 固定事实与权限

第一次 index 在同一 SQLite 读事务内固定 project revision、标题、Body 版本引用、Pose 与保留身份。snapshot 缓存仅保留索引；正文从既有、不可更新/删除的 `mapping_versions` 按固定版本无损读取，不在每份 snapshot 复制长正文。后续 body/detail 或分页必须携带原 snapshot；cursor 绑定 snapshot、view、cardId 和位置并签名，不能改换目标或续当前数据。

每次读先验证当前持久会话及项目权限，再读取 snapshot。snapshot 不是授权，可供同项目已授权的人与 Agent 对照；知道 token 不能越项目读取。会话撤销/过期返回 `UNAUTHORIZED`，无项目权限返回 `PROJECT_FORBIDDEN`；伪造/过时 Principal 拒绝。snapshot 不跨进程持久，重启或 TTL 到期返回 `SNAPSHOT_EXPIRED`；不自动改读当前正文。固定版本不可读取返回 `SNAPSHOT_UNAVAILABLE`，不会用新正文填补。

可读身份页的正文为 `not_fetched`，不含正文。局部/body 与 detail 请求按原快照分别返回 `availability: available | deleted | not_found`：已删除由保留身份识别，从未存在不当删除。旧 snapshot 中仍存在的对象继续表达该 revision 的事实；这不允许据其重新写入当前已删除对象。拒绝与过期为明确错误响应，不假装空内容。`summary` 始终为 null。

## 完整响应预算与保真

`budget` 的单位为 `utf8_bytes`，计入完整 Mapping JSON，包括 project、scope、snapshot、版本、覆盖范围、target、cursor、summary、items 与 `bytes` 字段本身；HTTP 成功响应体与此 JSON 相同。它不是模型 token 数。MCP 的文本/structuredContent 承载同一 Mapping JSON；JSON-RPC/MCP 外层协议封装不属于 Mapping JSON，工具说明明确这一预算范围。

每页返回 `budgetUnit`、实际 `bytes`、`totalItems`、`coverage: {start,end,complete}`、`nextCursor`、`fidelity`。start/end 为本查询目标内的半开序位；complete 表示已到集合末尾，调用方仍需从 0 连续组装全部页，不能只凭末页称全量。totalItems 在 index 是该 snapshot 的卡片数，在 body 是该卡正文块数，在 detail 是其 JSON 分片数。不返回无界 omittedIds。

- `index` 保留结构项和完整标题，`fidelity: index`。单个不可拆项放不下时明确 `ITEM_EXCEEDS_BUDGET`，提示 `requiredBytes`，不截断标题。
- `body` 保留块 ID/type 和每块最多 128 个 Unicode 码点，`fidelity: partial_body`；每块有 returnedCodePoints/totalCodePoints/complete，局部预览不当成全量。
- `detail` 把完整 Body JSON 按 128 个 Unicode 码点分片，`fidelity: lossless_json_chunks`。按 chunkIndex 连续拼接全部 jsonText 后 JSON 解码，保留 Body/Block 身份及原字符串。单片本身不必为独立 JSON；保留 emoji、组合码点、转义和 JSON 编码的孤立代理项，不承诺每片是完整字素。
- 元数据都放不下时为 `BUDGET_TOO_SMALL`；错误响应明确失败与所需字节，不冒称预算内成功。末页没有 cursor，可能比中间前缀更小，先验证完整末页是否能容纳。

UI 经该 index/detail 链完整重建现有卡片编辑状态；在整份投影组装成功前不暴露部分结果，并验证各页 snapshot/revision/序位、完整预算、chunkIndex 和 Body 版本。不把有限正文预览作为另一份可写正文。Agent 可只展开选定卡片；UI 当前保持完整卡片正文以兼容既有草稿、冲突、历史与媒体守卫。

## 可测试的工程常量

| 项目 | 当前值与语义 |
| --- | --- |
| 默认/最大每页预算 | 131072 / 1048576 UTF-8 字节；正整数，错误不假装成功 |
| 正文预览/JSON 分片 | 每块或片 128 Unicode 码点 |
| snapshot TTL | 首次捕获起 300000 ms；重复同 revision 复用 token，不延长原 TTL |
| snapshot 数量上限 | 每 Mapping 实例 1024，过期清理；达到上限明确 SNAPSHOT_CAPACITY |
| 固定索引逻辑容量 | 每实例 67108864 UTF-8 字节，计 project/卡片固定索引/保留身份；不是 V8 heap 上限，也不限制持久正文长度 |

clock/TTL/容量可由可信进程 host 在测试 fixture 注入，HTTP/MCP 调用者不能改变。容量拒绝不修改正文、历史或回执；不做旧数据迁移、破坏性清理、snapshot 跨进程恢复或 #7 changefeed 断档恢复。

本合同基于 Mapping ADR0003 与 D92；其字段属于工程表达。局部实现和完整固定 SHA 验收分别记录，不用旧参考模型或 dirty 工作区检查证明当前交付。
