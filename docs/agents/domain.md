# Domain docs

## 布局与权威来源

采用 single-context，沿用现有文件，不复制术语定义，也不新建 `GLOSSARY-MAP.md`。

- 全项目术语：根目录 `CONTEXT.md`。在要求读取或更新根 `GLOSSARY.md` 的技能中，使用此文件作为本仓库的等价入口。
- 项目决策：`docs/adr/`，结合 `docs/design-interview.md` 中的已确认决定读取。
- 映射契约提案：`docs/architecture/mapping-contract-v0.1/GLOSSARY.md`、`CONTRACT.md` 及其 `docs/adr/`。这些文件只约束该提案上下文；先看文档状态和 CONTRACT 的决策状态章节。

## 消费与维护规则

1. 建模、规格、审查或实现前，读取相关术语和 ADR，核实状态、适用范围以及后续修订。
2. 处理映射契约时同时读取其局部词汇与契约；Thought、普通 Connector 与旧主张、推导关系分别解释。局部提案不能自动替代项目已确认决定。
3. 术语定义在其现有权威文件维护；业务词汇不混入实现规格。新增或修改定义及 ADR 均以当前任务授权为准。
4. 通用已确认决策沿用 `docs/adr/`；仅属于映射契约的提案记录沿用其局部 ADR 目录。新编号先检查目标目录现有最大编号；保留既有状态和相互引用。
5. 私有 PRD 引用、计划与研究文档归属继续遵守 `AGENTS.md` 和 `.gitignore`。缺失资料或冲突无法判断时，明确指出缺口并保留待决。
