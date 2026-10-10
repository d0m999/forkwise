# 见岔（Forkwise）

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-green.svg)](README.zh-CN.md)

见岔（Forkwise）是以**投资研究**为首个场景的**个人推理工作台**。它帮助你梳理一条观点背后的推理链，在本次研究任务内通过公开资料查证，然后让你在同一张画布上直接研究、编辑前提、推导与结论。

- **理解作者论证**：把外部材料的观点、前提与推导关系还原成可追溯的结构，每条主张都能回到具体材料与原文锚点。
- **整理个人推理**：在参考候选基础上形成属于你自己的研究项，分别记录作者论证、AI 推断与个人论证，各自保留版本与理由。
- **不做的事**：不提供自动交易、不生成“真理分数”或情景概率、不承诺投资收益。证据与条件计算只说明材料和条件状态，不证明整条论证成立。

> ⚠️ 本项目当前处于**早期研究阶段**。它是给作者本人跑通真实研究流程的工作台，尚未作为面向外部用户的稳定产品发布。相关范围与验收边界以仓库内文档为准。

## 快速开始

项目由本机后端（Node + Hono + SQLite）与浏览器工作台组成，运行在你自己的机器上。详细安装、配置与启动步骤见 [backend/README.md](backend/README.md)。

简要流程：

```sh
cd prototype/canvas-lab && npm ci        # 先装画布前端依赖
cd ../../backend && npm ci              # 再装后端依赖
npm run build                           # 构建画布 + 后端
npm start                               # 启动，默认 http://127.0.0.1:8787
```

要求 Node.js >= 22.22.2（首轮实现实际使用 24.4.1）。真实模型调用需本机 [Ollama](https://ollama.com)，且须显式指定带版本标签的模型。更多运行与配置说明见 [backend/README.md](backend/README.md)。

## 仓库结构

| 目录 | 说明 |
| --- | --- |
| `backend/` | 本机 HTTP API、SQLite 持久化、持久化研究任务、本机 MCP 与接入 Excalidraw 组件的研究工作台 |
| `public-data-core/` | 公开数据源（如 SEC EDGAR）的取数适配器与校验规则 |
| `prototype/` | 研究与交互原型，含 Excalidraw 画布试验与分步存档 |
| `docs/` | 需求（PRD）、领域模型、设计访谈、ADR 与开源调研 |
| `docs/adr/` | 架构决策记录（ADR） |
| `docs/research/` | 开源库与参考产品的调研结论 |

术语与领域概念以 [CONTEXT.md](CONTEXT.md) 为唯一来源；工程与产品取舍记录在 [docs/design-interview.md](docs/design-interview.md) 与 [docs/adr/](docs/adr/)。

## 技术栈

- **后端**：Node.js + [Hono](https://hono.dev)，以 OpenAPI 作为前后端唯一契约
- **存储**：单文件 SQLite（关系表 + 内置 FTS5）
- **前端 / 画布**：生产采用 [React Flow](https://reactflow.dev)；原型阶段接入 [Excalidraw](https://excalidraw.com)
- **模型**：本机 Ollama（文本研究 + 多模态转写），可配置供应商适配器
- **测试**：TypeScript + Vitest，浏览器与协议层另有独立检查脚本

## 文档

- 领域术语：[CONTEXT.md](CONTEXT.md)
- 领域模型：[docs/domain-model.md](docs/domain-model.md)
- 设计访谈与已确认决策：[docs/design-interview.md](docs/design-interview.md)
- 架构决策：[docs/adr/](docs/adr/)

> 需求（PRD）与开源／参考产品调研属于内部文档，不随本公开仓库分发。

## 品牌资产

已确认的 [T1 基础设计包 v1.0](assets/brand/forkwise-basic-kit/README.txt) 采用 Forkwise32 精修 A / Current，含 26 件文件。使用或再分发前，请阅读包内的[使用说明与字体许可](assets/brand/forkwise-basic-kit/LICENSE-usage.txt)。

## 许可

本项目以 [Apache License 2.0](LICENSE) 授权，版权归 mempAw（Copyright 2026 mempAw）所有。

Apache-2.0 允许自由使用、修改、商用与再分发，并要求保留版权与许可声明、标注修改、随附 NOTICE（若有）。有关贡献默认适用本许可的条款见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目还包含若干第三方组件，各自按其许可使用，主要许可清单见 [NOTICE](NOTICE)。

## 行为准则

参与本项目请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 安全

如果你发现安全问题，请**不要**直接提交公开 Issue，参考 [SECURITY.md](SECURITY.md) 中的私下报告方式。
