# 正文块原件复制：生产接口增补（#13）

本文件说明 #13 落地的 `body.edit` 增量；验收状态以对应提交和实施记录为准。[参考契约](../CONTRACT.md)中其余提案保持原状态，不据此恢复未采用能力。

## 命令字段

`body.edit.payload.copyOriginals?: true` 是可选的显式原件复制标记；省略保持原有编辑行为，`false` 不是合法值。完整 `blocks` 分支使用它处理未知原件的独立副本。它不是权限授权：`commandId`、`projectId`、目标正文 `expected` 版本及可信 actor 校验继续生效。`text` 分支仍遵守旧单段文字约束，携带标记也不能把未知内容降级成文字。

## 身份与完整内容

- UI 的粘贴／创建副本分配新的 block 身份及已有 inline 身份的独立副本；重排保留身份，undo/redo 恢复动作对应的身份。列表仅重建复制范围内部的父子指向，范围外父项不随副本加入；后续修改相互独立。
- 省略标记时，不允许创建新未知块。无论是否携带标记，目标正文已有未知／不支持块的原身份、全部内容和原件相对顺序均须保留，不能改写、删除、降级或暗排。
- 携带标记时，服务端只从当前项目已持有的不可变 body 版本中查找依据。新未知块移除 `id`、`inlineId` 后，须与一个既有块的规范化 JSON 完全一致；其字段、类型、数组顺序及原字符串保持不变。找不到依据则拒绝，不因为剪贴板自带标记就信任未知 JSON。
- 历史 body 版本可作为复制时固定内容的依据；复制不形成共享正文。未知内容的副本仍是只读原件，不因复制获得新的转换、剪切或删除能力。已有资源标识随完整 JSON 保留，引用同一资源不表示正文共享。

## 原子写入、历史与读取

正文版本、身份归属或列表结构校验失败时不写入。成功副本／粘贴通过同一 Mapping.execute 事务更新 body、不可变版本、回执、changefeed 和统一历史；一个实际结构动作一次撤销。UI 与已授权 Agent 可以从同一 revision 读取完整 JSON；observe 返回相应变化。

标记不注册资源，不改变 `requiredAssetIds` 的持久化前置条件，新媒体导入仍须走资源接口。可编辑块的剪切只在真实浏览器剪贴板写成功、原编辑器仍存续且原正文未变时删除；拒绝写入、正文变化或编辑器关闭时保留原文。真实浏览器 API 证据与注入拒绝、合成 composition、系统剪贴板及系统 IME 的证据分别记录。

实现：`backend/src/mapping/contracts.ts`、`body.ts`、`mapping.ts`、`frontend/src/block-clipboard.ts`、`paragraph-editor.tsx`。公共行为回归：`backend/tests/mapping-block-transfer.test.ts`、`frontend/tests/block-transfer*.spec.ts`；所有查询和断言经正式 Mapping/HTTP/MCP 或真实浏览器入口。
