# 隔离导入完整项目包

状态：工程采纳；Issue #47。本文件登记导入命令、预览入口、身份映射、归档表与失败边界。包容器、清单布局与校验口径仍按 [ADR 0031](0031-full-project-package.md)，本模型不改 v2 格式、不加密、不同步。产品措辞以设计访谈为准；本文不写入 `docs/architecture/mapping-contract-v0.1/` 的参考契约。

## 为什么先预览再提交

导入会把另一份项目的行、资源和身份带进当前库。用户需要在写入前看到校验结果、范围、缺口和将要创建的新研究，并明确提交；预览不写 SQLite，提交时服务端再次完整校验，不信任预览结果。

包内撤销栈不能装回可执行历史：源项目通常还在，旧动作会按原全局主键写回并改到源对象。因此新项目的 `mapping_history` 从空栈开始，导入这一步本身不进入 40 步研究历史。包内撤销/重做记录只作为归档说明保留。

## 入口与命令

- 预览：`POST /api/mapping/import.preview`，本人会话，请求体 `{ base64 }`。只解包与校验，返回建议名称、源项目编号与修订、各集合条数、资源与版本条数、是否带 v1 研究归档、扩展键、撤销/重做条数、缺口说明和失败列表。
- 提交：`POST /api/mapping/execute`，命令 `project.import`：

```json
{
  "commandId": "…",
  "projectId": "<新项目编号>",
  "type": "project.import",
  "expected": null,
  "payload": { "name": "<项目名称>", "base64": "<ZIP>" }
}
```

形状与 `project.create` 对齐：`expected` 为 `null`，`projectId` 由调用方给出，`commandId` 承担幂等键。同一 `commandId` 加同一请求重试返回原回执，不建第二个项目；请求内容不同返回 `IDEMPOTENCY_MISMATCH`。导入与 `project.create`、撤销/重做一样只允许本人会话。

请求体沿用现有上限：超过 1 MiB 的命令只有 `asset.save`、`canvas.paste` 和 `project.import` 可以继续，硬顶 48 MiB，超过返回 `TOO_LARGE` 且不建项目。48 MiB 是 JSON 请求体上限，base64 膨胀后可用 ZIP 约 36 MiB；这是现成上限，不是新的容量承诺。预览路由使用同一硬顶。这个上限是现成的原件/粘贴上限，不是新的产品容量承诺。导出响应带 `X-Forkwise-Package-Restorable` 与 `X-Forkwise-Package-Limit`；超过上限的包仍可下载，但界面在下载前说明它无法从本入口恢复。

## 身份映射

全局主键必须换新编号：卡片、独立文字、形状、笔迹、图片、普通连线、分区、组合、标签。按类型各建一张旧→新映射，使用随机 UUID；同类型重复旧编号在校验阶段以 `DUPLICATE_ID` 拒绝。

必须跟着改的引用：

| 位置 | 映射 |
| --- | --- |
| `cards[].cardTags.tagIds[]` | 标签 |
| `cards[].appearance.id` / `cardTags.id` / `attachments.id` | 新卡号派生的 `appearance:<新卡号>` / `cardTags:<新卡号>` / `attachments:<新卡号>` |
| `connectors[].start/end`（`kind=bound` 且 `targetKind='frame'`） | 分区 |
| `containment[].id`（成员本身是分区时） | 分区 |
| `containment[].parent.id`（`kind='frame'`） | 分区 |
| `versions[]` 中 `tag` / `shape` / `stroke` / `image` / `connector` / `group` / `frame` / `text` 的行 `id` 与 `value.id` | 对应类型；`connector.value` 的分区端点与 `cardTags.value.tagIds` 同步改写 |
| `versions[]` 中 `appearance` / `cardTags` / `attachments` 的行 `id` 与 `value.id` | 新卡号的派生编号 |
| `versions[]` 中 `containment` 的行 `id`、`value.id` 与 `value.parent.id`（分区） | 分区 |
| `research.project.id` | 新项目编号；其余研究字段原样保留 |

版本行是 append-only 的历史快照：对象删除后版本仍留在包内。导入只对仍在当前集合里的身份换号；已删除对象的版本行保留旧编号，作为历史原文。派生编号（外观、卡内标签集、卡内附件集）必须随新卡号改写，否则卡内撤销用 `appearance:<新卡号>` 找不到对应变更。

同一类型内的旧编号必须唯一；`item.id` 在卡片/文字/形状/笔迹/图片之间共用一个命名空间，组合的 `itemId` 在组合之间唯一。分区 id 允许与某个 item id 同串（生产已按类型区分普通连线端点）：普通连线端点的 `targetKind` 必须与目标身份集合一致（`item` / `group` / `frame`），缺省按 `item`；归属行成员同串时按普通 item 处理，不误当分区换号。

保持原样：资源身份（`assets[].id`、`assetId`、`requiredAssetIds[]`、`research.files[].id`）；对象内部编号（正文块、摆放、`group.itemId`、全部版本编号、普通归属行与被批注 item 身份）；普通连线指向 item/group 的端点。未知键、未知正文块和 `extensions` 原样保留，不补默认正文或默认值，不改个人判断；例外是 `mapping.archive` 顶层与 `editTimes` 行，它们只保留已知字段（见「写入顺序与闭合」第 8 条）。

改写按字段路径结构化进行，不做整段字符串替换，避免短编号撞进正文。`200` 这类编号也不会被改写。

## 写入顺序与闭合

新增 `mapping_import_archive(project_id PRIMARY KEY, research TEXT, history TEXT, changes TEXT, extensions TEXT)`，只在导入项目上有行；四个列存 JSON 原文，允许 `null`。普通项目没有这行，导出行为不变。

一个 Mapping 事务内按顺序：

1. 再次校验包；失败抛 `INVALID_PACKAGE`，事务回滚，失败列表与预览同码。
2. 确认新 `projectId` 未使用，否则 `ID_CONFLICT`。
3. 插入项目行：名称用提交值，`revision` 从 1 开始，`version_id` 新生成；包内旧修订只进归档。
4. 按全局主键生成新身份，改写已知身份与已知引用字段。
5. 按包内数组顺序写各集合与 id 表，保持 `rowid` 顺序；资源 id、正文块 id、摆放 id、版本 id 保持。
6. 资源字节写入 `mapping_assets`，内容指纹用现有 `assetHash`；清单里的 `base64` 必须与 `resources/` 字节同哈希，入库以资源字节为准。资源记录缺 `hash`、MIME 不合形、图片缺正尺寸、图片超过 512 KiB、文件超过 10 MiB 都在校验阶段拒绝；被引用资产可以只有清单 base64，也可以只有 `resources/` 字节。研究文件 `base64` 为空但带 v1 `omission` 声明时按原文保留；既无字节又无省略才拒绝。
7. 版本行按包内顺序写入；domain 限定为已知集合，`value.id` 必须等于行 `id`；当前对象（含 tag、归属行与批注附着）的版本必须存在（`VERSION_MISSING`），版本主键重复在预览阶段拒绝。
8. 研究归档与 `extensions` 写入归档表；研究对象只改 `project.id`，嵌套的旧 `projectId` 是历史原文。`mapping.archive` 存在时把它的 `history`、`changes` 作为不可执行归档原样转存，只有首次导入才把包内的活历史当作归档。归档表的列只承接 `history`、`changes`，`mapping.archive` 顶层与 `editTimes` 行内除已知字段外的键不落库，重导出按已知字段重建：这两个块由导出器按固定形状生成，额外的键按噪声丢弃，不适用「未知键原样保留」。`editTimes` 按新卡号写入 `mapping_import_edit_times`，供搜索排序沿用原编辑时间，只写包内当前集合里仍存在的卡；已删除卡的时间行随删除丢弃，即使源包 `contentEditTimes` 仍保留它。包里的旧动作不重放，`mapping_history` 写空栈。
9. 由现有执行尾部写变更行与回执；导入不调用 `recordAction`，不占 40 步研究历史。回执的请求指纹只存 ZIP 的 SHA-256 与 base64 长度，不把整包 base64 落库。

写入后再导出一次并核对：引用闭合、各集合与版本条数、当前对象版本存在；失败抛 `IMPORT_CLOSURE_FAILED` 并回滚，不把「已经插入一半」返回给界面。包级跨项目深扫收窄为顶层 `projectId`、`mapping.project.id`、`research.project.id` 与变更回执的 `projectId`；历史归档和未知内容里的旧项目号按原文保留。凭证明文扫描与资源引用检查跳过历史归档、`extensions` 和正文未知块；未知块里的 `token`、`assetId` 不按已知引用解释。

`buildFullPackage` 在调用方没有传入研究参数时，读取归档行，把归档中的 `research` 与 `extensions` 放进清单；同时把归档里的 `history`、`changes` 作为 `mapping.archive` 导出，并把 `contentEditTimes` 的结果作为 `mapping.editTimes` 导出。活表 `history`/`changes` 仍按当前项目写，因此刚导入的重导出撤销栈为空、旧历史只存在于 `mapping.archive` 里，再次往返不会丢。调用方显式传入 `null` 表示本次导出不带研究归档；归档中的 `extensions` 仍随清单导出，避免扩展丢失。

## 界面

顶栏「新建研究」旁增加「导入项目包」。选择 ZIP 后打开预览对话框，说明目标、范围、缺口与身份；校验失败时列出 `代码 路径 expected actual`，提交按钮不可用。预览失败仍以 200 返回失败列表，提交才以 400 `INVALID_PACKAGE` 拒绝。校验阶段是只读的：Esc 与「关闭」都能退出，迟到的校验结果直接丢弃；只有已提交的请求不能再被 Esc 打断。取消、关闭与 Esc 不发提交请求，焦点回到触发按钮；Tab 在对话框内循环。对话框打开期间画布撤销快捷键不生效，名称输入框的原生撤销保留。

缺口列表除「有没有旧研究归档」外，还要列出归档里因权利限制只保留索引的原件数量、名称与 `omission` 原因。

成功后项目标签增加新研究并切过去，源项目标签仍在；失败时对话框保留，展示服务端代码与路径。重试按包保留身份：请求完全相同时复用原 `commandId` 与原 `projectId`，换看另一个包不会丢掉上一份待确认的请求。5xx 或传输失败保留原请求，关闭对话框后重新选择同一文件仍保留；确定性 4xx 才清空该包的重试身份。若项目编号已存在（上次响应丢失后已提交，或改名重试），直接打开该项目，不再建第二份。

## 未纳入

- 不读 `research.sqlite`，不把研究归档接上「下载完整项目包」；画布菜单导出的 `research: null` 仍是缺口，需要另立票。
- 不覆盖、不合并进当前项目，不提供「导入到当前画布」。
- 不把包内撤销栈装回可执行历史；不恢复搜索历史、剪切暂存、媒体处理票据、会话和 `SECRET_KEYS`。
- 不实现跨版本迁移，不放宽 v1 `ArchiveSchema`；D131 的旧原型迁移是另一条入口。
- 不决定 ADR 0031 的待决定项「清单是否去掉 `assets.base64`」。导入同时接受清单 base64 与 `resources/` 字节。
- 不新增 npm 依赖，不改 `package.json`。
- 归档表的 `history`/`changes` 只作历史留档，不在界面回放；包内旧 `revision` 由 `changes` 的逐条 revision 间接保留，不另设列。

## 2026-11-18 审查修复

同一提交（`8bb76bd1`）的两轴审查发现以下边界不够紧，均在本文件口径内收紧，不改变容器、身份映射与入口：

- 文字、形状、笔迹、图片的 `content` 在预览与提交都按现有内容契约（`TextContentImportCheck` 等）校验已知字段；不符返回 `CONTENT_FIELD`。校验只读，不改写记录，未知键随原文保留。此前只要求 `content` 是对象，缺 `runs` 的文字能入库，但画布投影读 `runs.length`，导入的研究会打不开。
- 归属链必须无环（`CONTAINMENT_CYCLE`，D416）。循环归属能入库，但随后调整分区会卡在祖先遍历；普通连线的几何闭环不受限制（D403）。
- 被引用的资产必须落在 `mapping.assets` 行上（仍是 `REFERENCE`）；原件字节可以只在 ZIP 的 `resources/` 里，导入只为资产行入库，此前只指向资源目录的引用会预览放行、提交回滚。
- `mapping.history`、`mapping.changes`、`mapping.archive`、`mapping.editTimes` 的形状在预览阶段校验（`HISTORY_FIELD` / `CHANGES_FIELD` / `ARCHIVE_FIELD` / `EDIT_TIMES`），保证预览通过的包在提交后的闭合复验里也能通过。
- 提交时 ZIP 只解码一次：回执指纹与 `importPackage` 共用同一段 `Buffer`，提交侧仍独立完整校验一次。

## 2026-11-18 复审修复

对上一节修复（`51c7dc69`）的复审补齐以下口径，同样不改容器、身份映射与入口：

- `CONTAINMENT_CYCLE` 按环本身的成员去重：同一个环即使从环外的尾节点进入，也只报一次，不再随进入路径重复计数。
- `mapping.archive` 顶层与 `editTimes` 行内的未知键不落库；`editTimes` 只保留仍在包内当前集合的卡，已删除卡的时间丢弃。两条都写入「身份映射」与「写入顺序与闭合」第 8 条，不再只由代码注释声明。
