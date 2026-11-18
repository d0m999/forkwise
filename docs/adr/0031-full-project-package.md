# 完整项目包导出

状态：工程采纳；Issue #46。本文件只登记生产实现的格式、包内布局与验证入口；产品措辞以设计访谈为准。`forkwise-project` v1（`backend/src/contracts/assets.ts` 的 `ArchiveSchema`）不因本模型放宽或收紧。ADR 0015 的 tar + age 加密归档仍属 #41，本格式不涉及加密、云端或同步。

## 为什么是 v2

v1 用 `.strict()` 描述既有研究归档，把画布字段塞进 v1 会让旧归档被拒或新字段被丢。v2 另立版本，把 v1 研究归档原样放在 `research` 下；没有旧研究行时为 `null`。开放工作台库与 `research.sqlite` 隔离，画布入口因此写 `research: null`，v1 对象由 `Mapping.fullPackage` 的调用方参数放入。验证器不把 `research` 送进 `ArchiveSchema.parse`。

## 容器

无压缩 ZIP（STORE），不新增 npm 依赖。`forkwise-project.json` 是清单，其余条目是资源字节。

## 清单

顶层：`format` 固定 `forkwise-project`、`schemaVersion` 固定 2、`exportedAt`、`projectId`、`revision`、`research`（v1 对象或 `null`）、`extensions`（本版固定 `{}`）。

`mapping`：

| 键 | 内容 |
| --- | --- |
| `project` | `id`、`name`、`versionId`、`revision` |
| `cards` / `texts` / `shapes` / `strokes` / `images` / `connectors` / `frames` / `groups` / `containment` / `attachments` / `tags` | 当前行原文解析后的对象 |
| `assets` | `mapping_assets` 行原文，含 base64 字节 |
| `versions` | `domain`、`id`、`versionId`、`value` |
| `history` | 撤销栈原文，去掉 `SECRET_KEYS` 键 |
| `changes` | 每条回执的 `revision` 与脱敏后的 `receipt` |
| `archive` | 导入项目带出的旧历史归档（`history`、`changes`）；普通项目为 `null` |
| `editTimes` | `cardId`、`editedAt`；按变更回执与导入时沿用的时间算出的原编辑时间 |
| `membership` | 由 `containment` 算出的分区成员（帧按 `id`，组按 `itemId`） |
| `stack` | 卡片、文本、图形、笔迹、图片按 `item.createdOrder` 叠放 |
| `stored` | 上述十一个集合与 `versions` 的 `json` 原文，与解析值逐条对应 |

查询顺序固定：带 `mapping_*_ids` 的结构按其 `rowid`，其余按自身 `rowid`，标签按 `id`。`stack` 以 `createdOrder`、`kind`、`id` 依次排序。`assets` 同时保留 base64 与 `resources/` 字节，是为了既满足「原件按原结构保留」又满足「资源可随包实际读取」，代价是媒体字节在包内出现两次。

## 资源与脱敏

`resources[]` 只有 `id`、`mime`、`sha256`、`path`；字节条目名与 `path` 相同，形如 `resources/<四位序号>-<sha256>`，序号按资源 `id` 排序后从 0 起。研究原件以 `research:<file.id>` 作为资源 id，文件名不参与路径。

会话与凭证类键（`SECRET_KEYS`，`backend/src/mapping/secret-keys.ts`）不进包：导出脱敏与包级校验共用同一份键集。未知块、未知键留在解析对象与 `stored` 原文里，导出不经 `.strict()`。

## 入口

`GET /api/mapping/projects/:id/export.package?revision=N`。`revision` 可选；与当前已保存版本不一致返回 409 `EXPORT_REVISION_CHANGED`，不生成包。响应 `application/zip`，文件名 `<项目名>-r<revision>.zip`。导出只读，不迁移、不删除、不推进 revision。

界面入口是导出菜单最后一项「下载完整项目包（ZIP）」，与摘要、图像共用菜单的焦点、Esc 与方向键行为。

## 验证

`npx --no-install --prefix backend tsx scripts/verify-package.ts <path>`。缺路径退出码 2，有失败退出码 1，通过为 0；每行失败是 `代码 路径 expected=… actual=…`。

检查项：容器与清单形状、`format` / `schemaVersion`、`mapping.project` 与顶层身份一致、十一个集合与 `versions` 的 `stored` 逐条对应、`membership` 与 `stack` 重算一致、资源字段与 `id` 唯一、路径形状与 `sha256` 后缀绑定、文件存在与哈希、`assetId` / `requiredAssetIds` / 连线端点 / 容器成员与父级 / 附着目标的引用闭合、文字/形状/笔迹/图片 `content` 的已知字段、归属链无环、`archive` / `editTimes` 的形状、`research` 的 v1 形状与项目 ID、`SECRET_KEYS` 扫描、跨项目 ID 扫描。#47 起跨项目检查收窄为顶层 `projectId`、`mapping.project.id`、`research.project.id` 与变更回执 `projectId`；历史归档和未知内容里的旧项目号按原文保留，见 [ADR 0032](0032-isolated-package-import.md)。

验证器不复用导出器的派生实现，也不依赖服务端与数据库。共享的只有 `SECRET_KEYS` 与内容契约的导入检查 schema（`TextContentImportCheck` 等）：前者避免脱敏键集两处漂移后校验静默放行；后者让预览、提交与画布投影按同一份字段形状判断，避免形状漂移，且这些 schema 只描述形状、不引入数据库或服务端依赖（[ADR 0032](0032-isolated-package-import.md) 的 2026-11-18 节）。

## 未纳入

#47 的导入与跨版本迁移不在本模型内；隔离导入的命令、身份映射与归档表见 [ADR 0032](0032-isolated-package-import.md)。研究归档入口尚未实现：产品导出只写 `research: null`，把 `research.sqlite` 的 v1 对象接进入口需要另立票，在此之前 AC1 的「旧研究记录按原结构保留」只能由调用方参数路径满足。后交付新类型由该功能在完成前同时扩展格式与验证器（`extensions` 预留）。是否在清单里去掉 `assets.base64` 让媒体只出现一次，留作待决定项：去掉会缩小包体，但清单不再自足，读取原件必须解 ZIP。
