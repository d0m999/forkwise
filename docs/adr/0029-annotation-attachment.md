# 显式附着批注

状态：工程采纳；Issue #35。依据 D78、D84、D421。产品措辞以设计访谈为准；本文件只登记生产实现的字段、命令、随动与历史约束。参考契约 `docs/architecture/mapping-contract-v0.1/CONTRACT.md` 不登记本模型。

## 关系

附着是批注 `itemId` 到卡片 `itemId` 的单父关系，不存 offset，也不存 `target: null` 的行。表 `mapping_attachments(project_id, item_id, value)` 与 `mapping_containment` 同构，整行 JSON，`ORDER BY rowid`。批注世界坐标始终是它自己的 `item.pose`。

目标只允许卡片。批注只允许 `text` / `shape` / `image` / `stroke`。附着层不按 `penKind` 分支。批注已有非空 containment 时 `attachment.attach` 返回 400，提示先移出框架或组合。`frame.create` / `group.create` 的成员里出现已附着批注同样返回 400。

`attachment.detach` 只删附着行，不改批注 pose。`expected.target.versionId` 与当前卡片 pose 版本不一致时返回 409。

## 随动

有附着的卡片不能走 `pose.move`，调用方改发 `pose.batch`。`pose.batch`、`card.layout`、`canvas.move`、`canvas.move-selection`、`group.move`、`frame.move`、`group.scale` 在 `expected` 与 `payload` 同级携带成对的 `followers` 与 `expectedFollowers`。漏带、多带或只给一半返回 400 `ATTACHMENT_NOT_MOVED`。版本过期返回 409。闸门在上述外层命令进入 `moveCanvas` / `writeGeometry` 之前，不放进这两个内部入口，也不把批注注入 `selectionMembers()`。

必带集合是本次中心或高度实际变化的卡片的全部附着批注，减去已经作为本次移动目标出现的批注。随动只平移。`card.layout` 的中心差是高度差的一半。图片随动走保留 rotation 的 pose 写入。

## 删除、复制与历史

删除卡片会删除指向它的附着行，批注留在原世界位置。删除批注会删除它自己的行。变更记在 `Change.attachmentChanges`，undo/redo 经 `restoreAttachments` 写回。`attachment.attach` 与 `attachment.detach` 有独立历史分支。

身份复制不带附着。同项目 `canvas.paste-cut` 仅在剪切仍是首次搬动、目标卡还在、批注当前无附着时恢复原行；缺任一条只恢复内容。跨项目粘贴不读附着，也不查询源项目剪切状态。

## 读合同

`ProjectState.attachments` 返回附着行。compact 增加与 `containment` 并列的 `attachment-index`，项为批注 `id`、附着行 `versionId` 与 `targetItemId`。`versionId` 是形成 `attachment.attach` / `attachment.detach` 的 `expected.attachment` 所必需的，与 containment 视图携带版本同一理由；不另存 offset。不扩展 `forkwise-project` v1，不读写 `layout.canvas.attachments`。

## 取代与依据

本 ADR 取代或修订下列已采纳原文，避免实现与 ADR 互相否定：

- 取代 ADR 0024「单卡普通移动保留 `pose.move` 兼容路径」的无条件兼容：`pose.move` 只适用于没有附着的卡片。
- 修订 ADR 0024 对 `pose.batch` 严格载荷的描述：旁路 `followers` 与 `expectedFollowers` 不进入 `expected`，`writeGeometry` 不把它们当卡片读取。
- 修订 ADR 0025 对 `card.layout` 载荷的描述：增加同级 `expectedFollowers`，它校验的是批注自己的 pose 版本。
- 扩展 ADR 0025「派生测量同时更新它所属创建或几何动作的 after Pose」：随动批注的 pose 变更并进同一条 action 的文字、形状、图片、笔迹变更；不能合并时单独保留一条可撤销记录。

下列 ADR 只作依据，不改正文：ADR 0019 的同事务操作栈，ADR 0012 的版本不符返回 409，ADR 0022 的尚不存在对象由其拥有者票扩展投影。漏带随动使用 400 而不是 409，因为重读后同一条请求仍然失败。
