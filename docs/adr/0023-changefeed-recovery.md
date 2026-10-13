# 有界变更读取与断连后的一致地图恢复

状态：工程采纳；Issue #7 当前卡片切片。依据 D92、D123、Mapping ADR0003 与项目 ADR0022；不宣称未来对象或完整首版验收。

## 权威与恢复

`Mapping.observe`、`GET /api/mapping/projects/{id}/changes`、只读 MCP `forkwise_observe_map` 共用 SQLite 中与实体、不可变版本、历史和 receipt 同事务写入的 `mapping_changes`。返回 `status`、有序 `changes`、每项实际改变的 `domains`（project/thought/body/pose）与完整 `deletedIds`。既有 before/after、actor、commandId 保留兼容；正文不是客户端可独立写入的缓存。

首次 observe 以 `afterRevision` 请求，并可用 `baseSnapshot` 校验已有完整投影的 revision 与进程内 token。响应 `revision` 是整批固定终点；`nextRevision` 为本页末尾，`complete` 只说明已到终点。续页带返回 `snapshot` 和前页 `nextRevision`，不再带 baseSnapshot；之后发生的写入不加入这一批。调用方从自己的 afterRevision 连续验证至终点，重复或晚到页不能直接覆盖现有状态。

每批 token 与 ADR0022 的 index/detail 共用同一读事务及同一快照。UI 只用 delta 使派生投影失效，然后从该 token 完整组装 index 与无损 detail 后一次发布；不逐条写入本地权威对象。Agent 可按自己的范围重读。UI 发布前核对捕获的项目与投影是否仍当前，保留草稿、正文/Pose 分域、统一历史及原请求恢复路径。

超出窗口、游标领先或日志不连续返回成功协议中的 `status: RESET_REQUIRED`、明确 reason、空 changes 和 `recovery: {type: map, view: index, projectId, snapshot}`。丢弃派生地图，依该 token 完整重读，再从新 revision 开始；不把 reset 当作无变化。snapshot TTL 到期、实例重开或真正服务进程重启仍为 `SNAPSHOT_EXPIRED`，details 指明从不带 token 的 index 重新开始。固定正文不可取得为 `SNAPSHOT_UNAVAILABLE`，不能拿当前正文续旧页。

每次请求先验证持久会话和当前项目授权，包括空变化页、续页和重试。token 不是授权，可供同项目已授权人和 Agent 对照。撤销/过期为 UNAUTHORIZED，无范围为 PROJECT_FORBIDDEN，伪造或过时 Principal 为 UNTRUSTED_PRINCIPAL。UI 撤下已失去授权的地图、保留未确认草稿并提示从本机启动入口重新打开；恢复授权后完整读取，不沿旧缓存声称已同步。当前没有独立的授权变更推送或多人权限版本系统。

## 工程参数与背压

| 参数                | 合同                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| changefeed 有效窗口 | 最近 1000 个项目 revision；最小允许 afterRevision 为 max(0, 当前 revision − 1000)，等于边界可继续    |
| 页批次上限          | 默认/最大 100；limit 为 1–100 的整数，以已提交变化计数                                               |
| 响应预算            | 默认 131072、最大 1048576 UTF-8 字节，计完整 Mapping JSON 含 bytes；不是模型 token，MCP 协议外壳另计 |
| 不可拆变化放不下    | ITEM_EXCEEDS_BUDGET，413，requiredBytes 和固定 snapshot 完整重读路径；不截断正文或变化域             |
| 元数据放不下        | BUDGET_TOO_SMALL，413，同样提供完整重读路径；不返回假预算内成功                                      |
| snapshot TTL/容量   | 沿 ADR0022：300000 ms，不因重读延长；1024 个/67108864 逻辑 UTF-8 字节，容量拒绝不修改权威数据        |
| UI 轮询             | 单轮 settle 后 1000 ms；online/focus 触发同一串行读取，无无界请求队列；错误保留输入并重试            |

窗口为派生读取索引的逻辑保留边界。此次没有删除、改写、迁移历史 mapping_changes 行；SQL 按项目/revision 范围及 LIMIT 读取，不扫出无界响应。持久日志存储增长仍是限制，不宣称物理磁盘容量有界。未来压缩/物理清理须独立合同和证据。

幂等 receipt 继续跨重启保留，失败不占 ID；没有新建幂等 TTL。不可变版本、40步栈职责、资源引用、旧研究数据均不由 changefeed 窗口回收。没有定时 GC、旧数据迁移、多端离线同步、CRDT、新对象、自由放置或媒体票功能。授权 host 可注入测试 clock/TTL 与 retentionRevisions，调用者不能通过 HTTP/MCP 修改工程窗口。

## 验证与边界

主要行为 seam 为 Mapping.read/execute/observe 加真实临时 SQLite，外补真实 HTTP/MCP 与本机 Chrome、新 context、实际 workspace-server 的断连、删除、重复消息、过期/重启、授权及旧游标恢复。具体运行、失败与最终 SHA 验收在私有 Issue #7 记录中；文档状态不等于完成放行。真 OS IME、系统 clipboard、本人 UX、第二 OS、完整未来富文媒体和生产用户数据验收另行区分。
