# 基础形状与笔迹生产契约增量

本文描述实际实现的 Mapping 与本机工作台增量，依据 D402、D404–D406、D422 及当前产品基线。原 CONTRACT、GLOSSARY 与参考提案的其他字段不因此成为生产能力；局部行为验证也不证明未覆盖的能力。

读取协议沿 [ADR0022](../../../adr/0022-compact-map-read-contract.md) 与 [ADR0023](../../../adr/0023-changefeed-recovery.md)，以下只说明 Shape、Stroke 的实际扩展，不修改原卡片 scope。

## 对象、内容与世界姿态

`CanvasShape` 是 `kind: shape` 的独立对象。`content.shapeType` 仅接受 `rectangle`、`roundedRectangle`、`ellipse`、`diamond`、`triangle`；`shortText` 为原样保留换行与 Unicode 的字符串，空字符串合法，不设产品字数上限。它不是 Thought，不拥有 Body 或完整写字板，也没有转卡入口。

Shape 基础外观为可选 `fill`、`stroke` 与 `strokeWidth`：颜色为六位 `#RRGGBB`，轮廓宽为有限正数。`content.stroke` 是轮廓颜色字段，与独立 Stroke 对象不同。未给出的字段保持省略；打开面板不会把渲染 fallback 写回权威内容。当前合同没有形状透明度、透明色值或新的粗细硬上限。

`CanvasStroke` 是 `kind: stroke` 的独立笔迹，不是普通 Connector、正文、卡片或标签，也不作为 Connector 端点。本票未新增普通连线实现，不以此宣称已运行未来连线端点拒绝测试。其完整内容为 `penKind: pen | highlighter`、至少一个有限坐标点的 `path`、六位颜色 `color`、有限正数 `width` 及 0–1 的 `opacity`。没有固定点数上限，不截断点列。

两种对象各有稳定内容 `id` 与画布 `item.id`；内容 `versionId` 与 `item.versionId` 分域。`item.pose` 保存世界坐标 `x/y` 和正尺寸 `width/height`，不增加旋转。`item.createdOrder` 在创建时固定，撤销恢复原序位与身份；它不是完整持久 StackOrder。删除保留身份记录，之后不能以 create 复用该 ID。

Stroke 点列是局部坐标，世界点由 `item.pose.x/y` 各平移一次得到，不能再次按框宽高缩放路径。绘制先取得世界点，再以含半笔宽的包围盒归一化；水平线、竖线与单点仍有正尺寸。单点显式画圆点，避免仅有 SVG `M` 而不可见。当前绘制层适配不增加层级菜单、持久层字段或永久类型优先规则。

## 公共命令与事务

| 命令 | expected | 实际变化 |
| --- | --- | --- |
| `shape.create` | `null` | 新内容与 item 身份、完整内容、世界 Pose、创建序位 |
| `shape.edit` | Shape 内容版本 | 完整 content 替换；不改 item、Pose 或 Pose 版本 |
| `shape.move` | Pose 版本 | 仅 x/y；保内容及其版本、宽高 |
| `shape.transform` | Pose 版本 | 完整 x/y/width/height；保内容及其版本 |
| `shape.delete` | `{ shape, pose }` 双版本 | 只移除目标当前投影，保留历史与身份 |
| `canvas.move` | 每个 item.id 的 Pose 版本 | Card/Text/Shape 整组同位移；任一版本过期整组拒绝 |
| `stroke.create` | `null` | 新 Stroke 与 item 身份、完整 path/styles/Pose |
| `stroke.delete` | `{ stroke, pose }` 双版本 | 只移除目标当前投影，保留历史与身份 |

所有命令共用项目权限、真实 SQLite 事务及统一历史。对象、不可变版本、project revision、change 与持久 receipt 同事务提交；确定失败不改变公开状态或历史，也不占用失败 commandId。成功原请求按 `commandId` 与完整 payload 幂等重放，跨重开仍返回原 receipt；不能以同键改写请求。

`shapeVersions`、`strokeVersions` 的内容/Pose 版本对属于该次 receipt 的确认事实；后续 head 更新不改写旧 receipt。内容版本的完整值为 `{ id, versionId, content }`，不是含 Pose 的整对象；Pose 版本按 `item.id` 查询完整 item。历史恢复沿实际改变的域生成新版本，不能倒退为旧版本时钟。Shape 内容 undo 保留独立 Pose，几何 undo 保留独立内容；创建、删除的 undo/redo 恢复原内容/item 身份与创建序位。

一笔 pointer-up 对应一次 `stroke.create` 与一步历史。Card/Text/Shape 混合移动是一条完整 `canvas.move`，一次 undo/redo 作用整组；不允许 Card-only 支路部分写入。保留原统一历史窗口，本票不新增另一套撤销栈。

## 项目、版本与紧凑读取

公共 `Mapping.read({ type: project, projectId })` 增加 `shapes` 与 `strokes`。版本读取沿 `type: version` 及 HTTP `GET /api/mapping/projects/{projectId}/versions/{domain}/{id}/{versionId}`，新增 `shape`、`stroke` 内容域并复用 `pose` 域。每次校验当前会话与项目权限；无鉴权、无项目权限、跨项目或错误 domain/id/version 组合不能读取版本。删除后旧版本仍可读，真实 SQLite 重开保持。

紧凑 HTTP 仍为 `GET /api/mapping/projects/{projectId}/map`。根 `index` 只含 Card，`scope.types: [thought]` 不表示其他对象为空。完整地图使用同一个 snapshot/revision，分别收集 `index`、`tags`、`text-index`、`shape-index`、`stroke-index` 五个 scoped view，每个 view 从 0 连续分页至 complete，再按需无损展开各对象。

首次根 snapshot 已固定 Shape/Stroke 的索引与 known IDs；不能等第一次请求其 scoped index 时才补读 live 数据。`shape-index` 含稳定身份、内容版本引用、完整 item/Pose、创建序位及有界外观，`content.availability: not_fetched`，不塞无限长 shortText。`stroke-index` 对应保留 penKind/color/width/opacity/pointCount，不塞完整 path。分页按 type/id 的索引序位，不从分页顺序推断层级。

`shape-detail` 携 `shapeId`，`stroke-detail` 携 `strokeId`，均要求原 snapshot。详情从已 pin 的不可变内容版本读取，按 128 Unicode code point 生成 JSON 文本块；连续核对 `chunkIndex/chunkCount/id` 后拼接全部 `jsonText`，最后一次 JSON 解码，完整结果为 `{ id, versionId, content }`。coverage 与 totalItems 在 detail 中计分片数，不计 path 点数或字素数。完整世界姿态取同 snapshot 的索引 item，不把内容版本伪装成完整对象。

每页完整 Mapping JSON 的实际 UTF-8 字节计入 `bytes` 自身、游标与 coverage，不能只预算 items。cursor 绑定 snapshot、view、目标与位置；改 view 或目标拒绝。旧 snapshot 不混入后续 edit/move/delete/create，旧 token 下不存在的身份与当前已知删除分别为 `not_found`／`deleted`。token 仅在 Mapping 进程内有效，重开返回 `SNAPSHOT_EXPIRED`，须重新从无 token 根 index 开始；持久历史版本不因此丢失。

本机工作台收齐各类型的同 snapshot/revision 索引与完整详情，验证版本、coverage、分片身份和 pointCount 后才一次发布。任一范围不完整或失败，不拼接 live project 冒充同修订地图，也不发布半份混合投影。

## Observe、HTTP 与 MCP 恢复

`Mapping.observe` 明确投影 `shape`／`stroke`／`pose` 域、完整 before/after、changedIds 与 deletedIds；Shape 数组的混合移动也覆盖全部成员，不落 project fallback 或伪 Card/Body/Tag 变化。分页固定终点 revision，首页后的写入不污染续页；调用方连续应用到该终点，再另开一轮接收后续变化。

变更断档、保留窗口不足等沿 ADR0023 返回 `RESET_REQUIRED` 及同一根恢复 token。不可拆长变化超过预算时明确 413 `ITEM_EXCEEDS_BUDGET`，元数据也放不下时为 `BUDGET_TOO_SMALL`；保留 `details.recovery`，不截 path 或 shortText，也不把失败伪装成空变化。按恢复 token 重新读五个 scoped view 与需要的全部 detail，才能继续该修订。

只读 MCP `forkwise_read_map` 广告并接通 Shape/Stroke views 与 `shapeId/strokeId`；`forkwise_observe_map` 共用上述 HTTP 权限和恢复协议。真实 MCP SDK 调用成功仍返回原 `structuredContent.response`；明确传输错误返回 `isError` 与 `structuredContent.error` 中的 status/code/message/details，文本 Error.message 保持兼容。调用方从 MCP 错误自身取得 recovery token，不用额外直接 HTTP 请求补造。MCP 协议外壳不计入 Mapping JSON 预算。

HTTP 继续沿 1,000,000-byte 单请求资源边界，超限明确拒绝而不截断；它不是新的笔迹点数或短文字产品上限。持久数据与版本不会因分页预算被裁剪。本票只扩既有读取工具，不新增通用 Agent 写工具；通用 Agent 写及委托承接留给实施票 #38，整体系统剪贴板留给 #32–#34。

## 工作台交互与保存边界

形状工具仅五个已定预设，点击放置后回选择。Shape 支持指针/键盘选择、轻量 textarea 短文字与基础外观面板、单对象指针移动、角点 resize、删除及统一 undo/redo；正常同步保留仍存在的选区，整页 reload 不持久化 selection。角点为具名键盘可达按钮，方向键按世界单位调整，Shift 加速；IME 与原生文字 undo 优先，不穿透为画布动作。

Shape 预览不写领域状态；非默认 zoom/pan 的几何由世界坐标计算，取消同步失效活动手势，晚到 move/up 不复活。短文字、外观、几何与历史/切项目/选中切换沿既有保存屏障。删除使用用户已捕获快照及自己的 ACK 版本，真实拒绝后须刷新展示、由用户新明确删除，不自动取 fresh peer 版本重删。

“画笔”子菜单含普通笔与荧光笔，无橡皮。当前工程初始样式为普通笔 `#403b36 / 2 / 1`、荧光笔 `#f4e9b9 / 10 / 0.4`（color/width/opacity）；不是 D405 已确认的用户默认参数，也未采纳研究提案的 12px/35%。按住只采点与预览，抬起提交一笔；Esc 在提交前取消，清预览且晚到 up 不补写，之后可重新绘制。

Stroke 可实际点选细笔迹、通过 Tab/Enter 选择并得到可见反馈，单笔 Delete 或“删除笔迹”接同一删除命令。透明命中路径沿实际 path，容差随 zoom 折算，当前为至少 12 CSS px 的命中宽；单点对应圆形命中区，不改可见线宽。它是工程命中适配，不是新的产品笔宽。笔迹仍不可拖动或缩放；含 Stroke 的混选拒绝不支持的删除/移动，不能只处理其中 Card 或其他成员。本票未实施批量笔迹删除、笔迹移动/resize、附着或层级菜单。

## 失败、冲突与显式恢复

未知结果始终保留原 commandId、projectId、expected 与完整 payload 重试，不能换新键补画，也不能借一次 fresh read 为旧草稿背书。Shape 短文字与外观失败后仍可继续输入；冻结 pending 与后来 raw 输入分离，自己的旧 ACK 不清掉新输入，后代命令仅沿自己已确认的内容版本推进。

Shape 内容真实409时展示双方，用户明确保留 peer 原件，并将完整本地内容、原 preset/style/worldPose 恢复为独立新身份。恢复 create 的未知 ACK 仍原键重试；其间继续输入的后代只用自己 create ACK 版本编辑新副本，不改 peer 原件。外观非法 raw 与合法 Shape 快照分离，允许在原界面修正，不将非法字段封入不可恢复的合法内容记录。

Shape 文字/外观恢复记录保存原项目/目标、最新输入、冻结 pending、已确认版本与恢复副本阶段。刷新后只在当前授权项目明确接管；接管新 owner 耐久成功才删除旧记录，任何 await 前同步占用并 finally 释放，避免两份草稿并发覆盖。读取失败、坏记录或失去权限不按“无草稿”删除。几何真实409则比较本次与 peer 布局，只有用户明确确认才以所展示 peer Pose 版本生成新命令重申；未知结果不走自动换版本路径。混合移动真实409保留整组比较/放弃语义，不逐成员补写。

Stroke create 在发送前持久保存经 `StrokeCreateCommand` 校验的完整原请求；写入失败不先发请求。ACK 与必要重读确认后才清记录。丢 ACK 后原请求可重试；真实同库服务重开及页面 reload 不自动发送，由当前项目“恢复未确认笔迹”入口明确接管并重放原请求，得到原 receipt 后清提示/预览，不另增对象、revision 或历史。接管先持久写新 owner，再移除旧记录；坏记录及存储读取失败保留。此恢复记录不是另一份权威库。

以上是实际实现与已覆盖公开行为的边界，不等于所有故障组合均获验证。Stroke 删除未知结果的刷新恢复、存储故障注入、真实 OS IME/系统剪贴板等不由局部 headless 结果代证。
