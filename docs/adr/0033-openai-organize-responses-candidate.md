# 停用本地模型，按需卡片整理改用 OpenAI Responses API

2026-11-21，本人决定停止使用本地模型。开放工作台的卡片整理和旧研究服务的论证分析、定性评估、图片与 PDF 页转写均停用 Ollama，已有任务、候选、转写及用量记录继续保存在原库。

Issue #39 的按需卡片整理改用 OpenAI Responses API。供应商方向已确定，目标 API 项目的资格和真实调用仍待核验。旧研究与转写任务沿用原有输入和记录，不转交 OpenAI。

## 开发范围

OpenAI 适配器复用现有 `OrganizeModel` 和 Mapping 整理任务。采用 Vercel AI SDK 的 `@ai-sdk/openai` provider，通过 OpenAI 官方 Responses API 请求结构化候选。对外请求限本次勾选的标题与正文文字。研究项目、卡片、正文块和任务的内部标识留在本机。请求使用 `store: false` 和无工具的前台调用。任务记录各次实际用量及返回的供应商请求编号，费用缺失时留空。OpenAI 缓存和重试按具体 API 项目和固定日期快照区分，使用原请求号可重读旧回执。测试中的快照只用于合成夹具。

适配器和 Mapping 调用已通过受控传输验证。开放工作台当前支持模拟整理和历史记录审阅；真实整理在项目核验并完成工作台接入后启用。旧 Ollama 环境变量已退出两个服务的启动配置。

## 启用依据

| 依据 | 已查到的公开条件 | 此项目待核实 |
| --- | --- | --- |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) 第 4.2 节 | 客户未明确同意时，OpenAI 不使用客户内容开发或改进服务。协议的生效日以实际接受或签署为准。 | 适用协议、生效日及项目数据共享设置。 |
| [OpenAI API 数据控制](https://developers.openai.com/api/docs/guides/your-data) | 零数据留存（ZDR）需获批准。项目可以继承组织设置或显式配置。出站请求使用 `store: false`，项目资格仍需单独核验。 | 目标项目的有效 ZDR 状态，以及所选模型快照、Responses API 和结构化输出的适用性。 |

启用前，按 [D30 与 ADR 0014](0014-model-provider-and-extraction-strategy.md) 记录上表的项目核验结论和具体快照，再以该项目凭据接通工作台。发送前由工作台告知处理方、选中范围、用途及留存政策。真实验收从卡片的 AI 入口使用隔离样例，核对候选、用量及明确添加的结果。
