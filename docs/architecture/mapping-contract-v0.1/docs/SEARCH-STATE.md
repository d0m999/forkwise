# 搜索条件与历史的独立写域（#21 工程映射）

D180–D184、D226–D232、D242、D250 已确认的搜索条件与历史按项目保存在同一 SQLite；它们是搜索偏好，不推进研究 project revision、changefeed 或研究 undo/redo。`search.state` 及 HTTP `GET /api/mapping/projects/:id/search-state` 完整序列化 `projectId`、独立 `versionId`（未写入为 null）、`current: {text, tagIds}`、最近20组 `history: [{id, query, usedAt}]`、清理保护 `blockedIdentity`、最后一次清理的 `removed: {id, entries} | null`；同时返回同事务读取的 `projectRevision` 与 `tags`，由稳定 tagId 解析当前名称或墓碑末名，不另存历史标签名副本。此工程映射不扩大[CONTRACT第7节](../CONTRACT.md#7-可运行范围与明确缺口)原参考模型的验证结论，实际实施证据另在逐票记录中维护。

人类通过 `search.save` 只保存当前条件；`search.record` 在明确打开或退出时保存非空整组历史；`search.clear`、`search.delete`、`search.restore` 独立处理清理与绑定 `undoId` 的恢复。所有命令仍经原认证、项目授权、幂等回执和 CAS 顺序；`expected` 使用搜索 `versionId`，成功 receipt 返回明确 `searchState`，不借研究 revision 确认保存。条件只允许引用本项目现存或保留墓碑的标签。历史 id 与清理保护按 D250 的规范化身份生成，显示保留最近原写法。

正常离开的 `search.record(intent: exit)` 可携带至多200个 `pending` 搜索请求，用一个传输封套收拢在途 ACK。每项严格解析为上述五种同项目命令，禁止嵌套封套；已发送项保原 commandId、body、expected，未发送项按前一回执版本补 expected。外层 expected 是该精确链起点，各显式 expected 必须连续；原 receipt 幂等命中可推进链，最终写入仍以链末版本 CAS，不能覆盖链后另一页面的更新。任一子项或最终校验失败，整个事务不留部分新写；同 key 不同体仍拒绝。该封套不是通用批处理接口。

若退出封套明确因版本冲突失败，只有用户明确重试才将其展开回原搜索队列与最终记录；已发送子项先原样重放。仅原请求明确返回版本冲突，才可重读后为该未消耗 key 更新 expected；成功原回执后重新公开读取最新状态，再为后续项计算 CAS，既不把旧 receipt 当成当前锁，也不丢弃清理意图。未知 ACK 始终保原请求，不通过重建身份绕开幂等。

前端未确认队列、可见错误与最后输入仅在本次应用会话按项目隔离保留，干净会话离开后释放；SQLite 始终是唯一持久权威。正常页面离开采用浏览器 keepalive，受实际请求体预算和网络结果约束；页面尚存时失败保留原请求并可见重试，异常结束不虚构退出历史或未确认保存。回执保留遵循[CONTRACT第8节](../CONTRACT.md#8-版本保留与规模边界)，未定义窗口前不擅自 GC。
