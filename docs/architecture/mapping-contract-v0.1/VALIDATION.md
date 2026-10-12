# 验证范围与公开来源

日期：2026-10-12。发布类型：架构文档。

## 本地参考验证

发布前，在独立云端参考模型目录重新运行 Python 标准库命令 `python -m unittest discover -s test -v`，18 项通过。该目录的 Python 代码、测试与 SQL DDL 未随本次文档发布；仓库读者不能仅凭本目录复跑这些测试。此记录是本地参考验证摘要，不是 GitHub CI 结果或生产验收。

覆盖：40步历史和单调版本、人类撤销与 Agent 只读历史、编辑与拖动分域、丢失回执重启重试、失败事务无半写、命令幂等与权限、IME与旧ACK草稿保护、连续编辑分组、单父无环与成员移动、普通连线环与同对象端点限制、普通删除优先及容器端点冻结、正文独立复制与引用失效、资料快照复用、固定快照分页、完整响应字节预算、Unicode及未知块无损展开、权限变化游标失效、SQLite参考DDL创建。

未验证：真实编辑器和浏览器接线、媒体上传请求ticket与取消、生产权限服务、多线程或跨进程并发、旧数据迁移、生产性能、CRDT候选库、真实模型token消耗。没有运行仓库后端 TypeScript 检查、Vitest 或构建；文档发布没有改动运行时代码、配置或依赖，不能将18项参考测试等同于这些检查。

## 公开基线

文档对照的仓库提交为 [`147e9da588b5fb54991b00c8d8c8127d0c05eebf`](https://github.com/d0m999/forkwise/commit/147e9da588b5fb54991b00c8d8c8127d0c05eebf)。不复制旧源码或内部资料，按以下公开文件核对：

- [设计访谈](https://github.com/d0m999/forkwise/blob/147e9da588b5fb54991b00c8d8c8127d0c05eebf/docs/design-interview.md)：D65/D136 的40步历史、D279–283正文与保存规则、D416分区、D418普通连线、D420容器移除；D422/D423保留首版范围边界
- [领域术语](https://github.com/d0m999/forkwise/blob/147e9da588b5fb54991b00c8d8c8127d0c05eebf/CONTEXT.md)
- [现有写入服务](https://github.com/d0m999/forkwise/blob/147e9da588b5fb54991b00c8d8c8127d0c05eebf/backend/src/services/graph-write.ts)
- [现有数据库结构](https://github.com/d0m999/forkwise/blob/147e9da588b5fb54991b00c8d8c8127d0c05eebf/backend/src/repositories/schema.ts)

D编号指上述访谈记录，不表示本契约的每个工程细节均为用户决定。具体状态以契约第6节及各ADR开头为准。
