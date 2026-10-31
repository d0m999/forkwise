# 见岔画布原型

当前产品范围与验收要求查私有的[产品基线](../docs/prd/current-product-baseline.md)，详细交互按[设计访谈](../docs/design-interview.md)的后续明确决定读取。本页记录原型入口、实际检查及历史证据；旧 PRD 已归档，需求已定不表示本页原型能力全部实现或通过本人验收。

## 当前原型清单（2026-10-24）

按可打开的交互原型入口计，工作区现有 **1 份**：开放画布 R2。配套脚本、样式、测试、依赖及历史验证材料不另算原型；Git 中已删除但尚未提交的旧入口也不计入现存数量。

| 入口 | 用途与状态 | 后续处理 |
| --- | --- | --- |
| [开放画布 R2](open-canvas-r2-20261011/index.html) | 已确认的项目主原型；包含完整工作台、卡片、写字板、画布工具及本轮视频交互 | 后续界面调整在此原型内进行；顶部「视频演示」可进入独立演示会话 |

2026-10-24，本人明确要求删除主原型之外的原型，并在 R2 中制作视频交互。已删除两份未跟踪的独立草图 `video-watch-layout.html` 和 `video-chrome-outside.html`，没有另留副本。

[直接体验视频交互](open-canvas-r2-20261011/index.html?isolated=1&video-demo=1)。封面、原地播放、全屏及两级 Esc 返回在同一个 R2 入口内体验，演示会话不读取或改写原浏览器项目。视频模块为 `video.js`／`video.css`，属于 R2 的配套代码，不是另一份独立原型。本轮操作按钮仍是待本人体验的界面方案，来源功能继续暂缓；能力与验证边界见 [R2 说明](open-canvas-r2-20261011/README.md)。

## 现行首版：开放画布 R2（`open-canvas-r2-20261011/`）

> 口径说明（2026-10-13）：本人已确认**以 `open-canvas-r2-20261011` 这套为项目主原型**。它是自包含的独立静态原型（自研 canvas，非 Excalidraw SDK），入口 `open-canvas-r2-20261011/index.html`，浏览器直接打开即可交互，**无需安装依赖、无需构建**。本页「现行首版语义」与后续收尾验证都针对它。

启动（任选其一）：

```sh
# 方式一：Python 静态服务（r2 文档口径，端口 48933）
python3 -m http.server 48933 --bind 127.0.0.1 --directory prototype/open-canvas-r2-20261011
# 打开 http://127.0.0.1:48933/

# 方式二：直接双击 open-canvas-r2-20261011/index.html（file:// 亦可运行）
```

内容保存在当前浏览器与访问地址对应的 localStorage；换地址、端口、浏览器不会自动迁移。项目菜单可导出 Markdown 和完整项目 JSON。私有浏览、清理站点数据或浏览器存储故障会影响保存，请导出保留重要试用内容。

R2 的能力范围、恢复重建来源、逐项需求矩阵、交互增量与验证记录，一律以其目录内的 `README.md`、`RECOVERY-STATUS.md`、`REVIEW-R2.md`、`ONBOARDING.md` 与 `artifacts/` 为准，本页不重复转述。需要如实说明的两点：**R2 的需求矩阵把多条近期决策标为「已实现未测」**；它是可操作原型，不是生产引擎重选或全量 D01–D423 实现的验收。

R2 的依赖（`jsdom 30.1.2`）只服务于 `npm test` 的模型/DOM 测试，**未安装**；浏览器运行不需要它。要跑测试时在 r2 目录执行 `npm ci --ignore-scripts && npm run check && npm test`。

## 已移除的旧主线（2026-10-13，本人决定仅保留 R2）

原「现行首版」是融合开放画布：`canvas-lab`（Excalidraw 0.18.1 SDK 画布 + 本地 HTML 回退），经 `forkwise-step-prototype.html` 的 `#open-research` 进入，约 5300 行在维护代码。该套已于 2026-10-13 从工作区移除，连同其依赖、构建产物、回归脚本与旧插图。

> **删除落点实况（2026-10-13 复核）**：这批文件**没有进入 macOS 废纸篓**，同批次 `/tmp` 的删除却正常进了废纸篓（已用探针文件复验 `trash` 行为本身无异常，差异原因未查明）。因此**工作区里的重构版与未提交新文件已无法从废纸篓取回**；git HEAD 保留的是**重构前**版本，可完整 restore。

| 移除内容 | 规模 | 找回方式 |
|---|---|---|
| `forkwise-step-prototype.html` 及整套 `canvas-lab/` 源码 | 约 5300 行 | git HEAD 有**重构前**版本（256 个文件，含 `objectTools.ts`、`ExcalidrawCanvas.tsx`），`git restore` 可取回；**工作区的重构版已消失** |
| `canvas-lab/node_modules`、`canvas-built/` | 273.7 MB | 可重建（`npm install` / `npm run build`） |
| 10 个 `verify-*.cjs`、3 个 `probe-*.cjs`、`selfcheck-screenshot.cjs` | 约 250 KB | git HEAD 有**重构前**版本；`verify-link-style.cjs` 与 `verify-shell-redesign.cjs` 是未提交新文件，**已消失，无处可取** |
| 历史变体原型 4 份：`forkwise-research-prototype.html`、`open-canvas-20261011/`、`object-identity-ab-prototype/`、`design-trio/` | 9.1 MB | git HEAD 均有副本 |
| `vendor/pdfjs`、旧插图（SVG/PNG/JPG）、`.command` 启动脚本、`serve-canvas-prototype.py` | 约 5.4 MB | git HEAD 有版本 |
| `ui-redesign/` 视觉稿、`outputs/` 三张截图、`screenshots/`、`research-state-tags.css` | 约 0.8 MB | 未提交新文件，**已消失，无处可取** |

> **2026-10-12 在 canvas-lab 上完成的 D417（连线三路径：默认直线／折线避障／曲线）与 D418（端点五选标记＋反转、默认线宽 4px）重构，以及 8 个回归脚本全绿的验证结果，只存在于当时的工作区且未提交，已随删除消失，无法取回。** 如需重看，只能按 `.workbuddy/memory/2026-10-12.md` 与 `2026-10-13.md` 的记录重做；其中 D417/D418 的实现要点（`customData.forkwisePath` 标记、`roundness:{type:2}` 才渲染弧线、切路径必须同时改 points、`pathRevision` 触发重投影）已记录在案。
>
> canvas-lab 时代逐轮（D64–D101）的实现与验证记录此前写在本页，随源码一同移除，不再转述；git 历史保留旧版本文档。涉及已覆盖或取消的决定（立场四态、结构化推导、拖卡建关系、共享前提范围选择等）以 `docs/design-interview.md` 为准。

## 后端与其他目录

`backend/` 仍使用的 Excalidraw 画布源码已迁入 `backend/canvas/`，构建输出为 `backend/web/canvas/`，旧后端入口与正式开放工作台分别保留。迁移测试、迁移 smoke 和图片 smoke 所需的旧研究模型独立保存在 `backend/scripts/fixtures/open-research-model.js`，不再读取已删除的原型页面。迁入内容来自 Git 中已保存的版本，不包含上文丢失的未提交重构。真实 AI、公开查证、账户、发布服务均不在此原型范围内。
