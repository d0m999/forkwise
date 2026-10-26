# 参与贡献见岔（Forkwise）

感谢你有兴趣参与见岔（Forkwise）。本指南说明如何参与贡献、本地开发与提交约定。参与前请先阅读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

> 当前项目处于早期研究阶段，主要服务作者本人的真实研究流程。欢迎反馈与改进建议；在提交较大改动前，建议先通过 Issue 讨论方向。

## 提交 Issue

- 反馈 Bug：说明复现步骤、期望结果、实际结果，以及运行环境（Node 版本、操作系统）。
- 提出想法：说明使用场景与要解决的问题。请注意，产品范围与优先级由已确认决策决定（见 [docs/design-interview.md](docs/design-interview.md) 与 [docs/adr/](docs/adr/)），未决内容保持开放，不在 Issue 里替项目补成决定。

## 提交 Pull Request

1. Fork 本仓库并创建特性分支：`git switch -c feat/your-change`。
2. 保持改动聚焦、粒度适中，并在 PR 描述中说明动机与影响范围。
3. 遵循现有代码风格与命名约定（代码标识符、命令、文件名保持原样；面向用户的文案使用简体中文）。
4. 确保本地检查通过后再提交（见下）。
5. 需要新增产品取舍或工程选型时，在 PR 中说明，并在相应 ADR / 文档中记录，不静默改动已确认决策。

## 本地开发与检查

后端（`backend/`）、正式开放工作台（`frontend/`）与旧研究画布（`backend/canvas/`）需分别安装锁定依赖。完整安装、构建与启动步骤见 [backend/README.md](backend/README.md)。

常用命令（在 `backend/` 目录）：

```sh
npm ci          # 安装依赖
npm run check   # TypeScript 类型检查
npm test        # 运行 Vitest 测试
npm run build   # 构建画布与后端
```

提交前请至少保证 `npm run check` 与 `npm test` 通过。浏览器与协议层的检查脚本另见 `backend/scripts/`。

## 提交信息

- 使用清晰的祈使句标题，可带类型前缀，如 `feat:`、`fix:`、`chore:`、`docs:`。
- 说明“做了什么”与“为什么”，必要时关联 Issue 编号。

## 许可授权

按 Apache License 2.0 第 5 条：你为本项目提交的任何贡献，除非你明确声明采用其他条款，否则将**自动以 Apache-2.0 的条款授权**纳入本项目。若你与项目维护者就某贡献另行签署了独立协议，以该协议为准。
