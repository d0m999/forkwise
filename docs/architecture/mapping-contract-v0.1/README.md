# 见岔映射契约 v0.1

2026-10-12。开放画布领域映射的架构文档：正文与画布身份、统一写入、历史、双投影、持久化映射，以及生产语言和 CRDT 策略。

## 阅读顺序

1. [契约正文](CONTRACT.md)：身份、版本、历史、投影、边界与待确认项
2. [本提案词汇](GLOSSARY.md)：仅适用于本映射上下文
3. [设计自问自答](docs/SELF-GRILL.md)：场景与反例
4. [数据库 → 画布 → Agent 字段映射](docs/STORAGE-MAPPING.md)
5. 本提案的四份 ADR：
   - [0001 正文独占与三类关系分离](docs/adr/0001-owned-body-and-typed-relations.md)
   - [0002 统一命令、细域版本与持久幂等](docs/adr/0002-versioned-command-seam.md)
   - [0003 同 revision 投影与有预算的逐层读取](docs/adr/0003-revision-pinned-projections.md)
   - [0004 生产语言与 CRDT 引入策略](docs/adr/0004-language-and-crdt-strategy.md)
6. [验证范围与公开来源](VALIDATION.md)

## 状态与职责

这是文档发布，不是生产集成或迁移。推荐生产沿用 TypeScript/Node.js + SQLite；Python 是隔离参考模型，当前不采用 CRDT，后续试验另行确认。未测生产性能或模型 token 消耗。

本目录的 ADR 编号只在本契约内有效，不覆盖[仓库现有 ADR](../../adr/)。工程参考选择、已有产品决定与待确认产品提案分别保留；一正文一摆放、资料卡与复用交互仍按契约中的提案状态处理。

仓库术语来源仍为 [CONTEXT.md](../../../CONTEXT.md)，已确认产品取舍仍查[设计访谈](../../design-interview.md)。本契约不更新这些文档，也不把技术验证视为新产品授权。

参考代码、测试、SQL DDL、原始日志、旧仓库证据副本及私有研究材料均不在本次文档提交中。涉及“已实现”的描述仅针对隔离参考模型；完整范围与生产缺口见契约第7–8节。
