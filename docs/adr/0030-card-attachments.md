# 普通卡片附件

状态：工程采纳；Issue #36。依据 D425。产品措辞以设计访谈为准；本文件只登记生产实现的字段、命令与打开方式。参考契约 `docs/architecture/mapping-contract-v0.1/CONTRACT.md` 不登记本模型，沿用 ADR 0028、0029：生产规则不进参考契约。`forkwise-project` v1 不扩展，附件不是该研究域导出包的消费者。

## 与批注附着分开

卡片附件是卡片上的文件关联。批注附着是绘图层对象跟着卡片走，已经占用 `Attachment`、`attachment.attach`、`attachment.detach` 和 `mapping_attachments`。本模型使用 `CardAttachmentSet`、`card.attachment.add`、`card.attachment.remove`，不读写那一组名字，也不读写 `layout.canvas.attachments`。

## 字段与命令

附件是 `Card.attachments`，不是正文块，也不新增 file 块。集合身份固定为 `attachments:{cardId}`，条目只有 `id`、`assetId`、`name`。MIME、大小和内容指纹只放在 `mapping_assets`。

`card.attachment.add` 与 `card.attachment.remove` 是独立命令，不进入 `card.edit`。`expected` 只比较附件集合版本；卡片还没有集合时，添加用 `null`。同一张卡不能重复关联同一个 `assetId`，返回 400 `INVALID_ATTACHMENT`。卡片、资产或附件条目不存在返回 404。无变化走与 `card.tags` 相同的早退。拖入空白画布建卡时，`thought.create` 可以带可选 `attachment`（`assetId`、`name`），卡片和这份附件同一次写入；资产不存在则整次失败，不留下没有附件的卡。已有卡片追加或解除附件仍只走上面两条命令。

历史复用动作上的整卡 `before` / `after`，不新增 `cardAttachmentChanges`，也不写入 `cardChanges`。`cardChanges` 的撤销只回写几何，不能把附件集合写回去。撤销和重做按当时的快照写回 `attachments`，不重新分配 `attachments.versionId`。附件集合与其他卡片子域一样写入 `mapping_versions`，`mapping.read` 的 `version` 可按 `attachments` 域读回当时那一版。

## 原件

`asset.save` 增加可选 `kind`。缺省仍是图片，图片校验保持原样。`kind: 'file'` 只检查 base64 往返、10 MiB 上限和 `type/subtype` 形状，不写宽高，错误码为 `INVALID_FILE`。`text/html`、`application/xhtml+xml`、`image/svg+xml` 允许存成文件；下载响应强制 `attachment`。`MediaAsset.width` / `height` 改为可选，图片消费方仍只读带尺寸的原件。

`/api/mapping/execute` 的绝对上限是 48 MiB，以便 `asset.save` 和 `canvas.paste` 一次携带最多三个达上限的文件。其余命令和其余 Mapping 路由仍是 1 MiB，超出返回 413 `TOO_LARGE`，不进入字段校验。图片响应保持原来的沙箱 CSP。可内联的 PDF、纯文本和图片类型去掉 `sandbox`；HTML、SVG、XML、脚本和未知类型强制下载。

解除附件和删除卡片都不删除 `mapping_assets` 行。不引入引用计数或回收。`asset.save` 仍不进入研究历史、不推进 revision。

## 拖入空白画布

非图片文件逐个建卡，卡片标题取文件名去掉最后一段扩展名；没有可用名称时保留原名。图片仍走既有图片导入，不建卡。每个文件是独立动作：先保存原件，再以一次 `thought.create` 写下卡片和附件。这一次失败则这张卡不出现，已成功的其他文件不回滚。草稿未保存时整批取消，一张卡也不建。

## 打开

点击时同步 `window.open('')` 拿到空白标签，再向 `/content?disposition=inline` 取一次状态码与 `Content-Disposition`。预检不读正文，避免同一份原件为一次打开下载两遍。预检失败则关掉空白标签，并按不可访问、无权限、服务端错误、其他拒绝和网络失败分别说明。服务端判定为 `attachment` 时，把这次点击拿到的空白标签导航到 `?disposition=attachment`，不在预检返回后再用脚本点击另起下载；导航抛错则关掉标签并报告下载失败。当时没有拿到标签时直接下载，下载动作抛错同样报告失败，不把失败报成已打开。其余类型把空白标签导航到内联地址，再把 `opener` 置空。`window.open` 不带 `noopener` 特性——带它时按规范恒返回 `null`，「被拦截」就分不出来。点击当时没有拿到句柄且仍需内联时，才算被拦截，改用 `?disposition=attachment` 下载，并说明弹窗被拦截。

## 复制与投影

同项目复制让两张卡引用同一个 `assetId`，显示名称各自拷贝。跨项目粘贴沿用内容指纹：同身份同内容复用，异内容新建身份。剪贴板包 `forkwise-canvas-snapshot` 不升版本；附件资产补进 `library.assets`，旧包没有该字段时按空处理。

紧凑索引在卡片上增加 `attachments.count`，并带上打开和解除所需的集合身份与条目。这不是新的关系分区。`ProjectState.cards` 直接带出附件集合。

## 依据

ADR 0012 的版本不符返回 409，以及一次业务操作返回受影响对象。ADR 0022 的尚不存在对象由其拥有者票扩展投影。ADR 0024 的单卡写入仍按独立版本域提交，附件不塞进正文和位置共用的 `expected`。ADR 0025 的卡面必要高度继续由真实行盒测量，附件行计入该高度。
