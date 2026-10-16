# 正文媒体：生产接口增补（#16）

本文仅描述 #16 工程形状，不将参考契约的其他提案改为生产已实现。验收结果由本票私有实施记录承接。#17 的调宽、图注/alt 编辑、大图、GIF 播放控制保持后续范围。

## 原件与读取

`asset.save` 经同一 Mapping.execute 接受 `expected:null`、`payload:{id,name,mime,base64}`，严格检查编码和真实字节、受支持格式、尺寸、完整文件与像素解码。不可变资产以项目和 ID 寻址；同 ID 不同内容拒绝。资产含原始 base64、SHA-256、原文件名、MIME、自然尺寸；不删除原件、不执行资源 GC。

`Mapping.read({type:"asset",projectId,id})`、`GET /api/mapping/projects/{projectId}/assets/{id}` 与只读 MCP `forkwise_read_asset` 显式返回完整原件 JSON。普通地图不会自动展开媒体字节。`.../content` 返回原始二进制，仍验证当前项目授权，并带独立 CSP sandbox、nosniff、no-store。图片 URL 不是授权凭证。资源不可改写，因此正文快照中的 assetId 在后续显式读取中仍对应同一字节与元数据。

图片每次合计最多 512 KiB；保留原 HTTP 1000000 字节边界，UI 合并正文使用 850000 字节暂存预算。最多 4000 万自然像素；GIF 全帧累计解码像素也受 4000 万保护。解码子进程限时 5 秒。JPEG/PNG/WebP/GIF 检查完整容器并实际等待像素加载、解码与绘制；PNG 另校验 CRC、解压及扫描行，GIF 逐帧校验 LZW，JPEG 校验扫描标记闭合。损坏、超界或不能解码时给出原因，不把元数据成功当已保存。

SVG 只接受明确的静态元素/属性子集：路径、基本形状、文字、分组、渐变、局部定义/引用、裁剪等；拒绝脚本、事件、嵌入对象、样式、动效、外部引用、DTD/entity 声明与未知结构。先校验，再交解码器；不清洗后冒充原图，不联网取图。拒绝保留文件名与具体原因。

## 正文与任务

- `image` 块保存 `id,type,assetId,name,mime,naturalWidth,naturalHeight` 和兼容的可选 `inlineId,width,caption,alt`。`width/caption/alt` 在替换时原样保留；本票不提供其编辑控件。纯文投影只包含图注，不包含文件名、alt、图片或 SVG 图内文字；不执行 OCR。
- `imageTask` 保存 `id,type,ticket,name,mime,byteLength,base64,width,height,status`，可带 `inlineId,reason`。`status` 为 queued/failed；尺寸为明确标注的预留尺寸。替换期间旧 image 保留，任务置于可选 `image.request`，失败继续显示旧原件。
- 旧 `pendingImage` 字节表示继续保真；新粘贴直接转 imageTask，旧保留块提供明确处理入口。未知扩展 JSON 仍沿原件规则，不以图片识别放宽未知内容删除或改写。

插入或开始替换通过带 Body expected 的 `body.edit` 固定原项目、卡、块及全新 ticket；服务端持久登记其原始请求，不能复用 ticket 改写目标或字节。`media.finish`/`media.fail` 的 expected 为原 ticket，payload 固定 id/card、blockId 及 assetId/reason；仅仍有效的请求可完成。完成不依赖当前面板或光标，修改的仅是当前原块，不覆盖并发保存的其他文字。

`media.retry` 接受旧 ticket 和新 ticket，只在同一块重试，旧请求永久退休。删除/取消/撤销占位或原卡使 ticket 不可恢复；redo 可恢复带失败提示的占位，须明确重试。旧晚到结果拒绝，不能复活目标。替换成功只替换原处资源，失败保留旧图；另一次有效替换使前次请求失效。

## 历史与保存

资源创建不增加研究 revision 或40步栈，也不清 redo。插入、替换、删除各沿原用户动作历史；异步完成/失败/重试不增加额外步骤，精确更新仍持有该 ticket 的历史快照并保留新的不可变版本，避免跨卡操作拆步或倒序。完成仍与 Body、receipt、changefeed、版本在同一事务；同 revision 的 UI snapshot、HTTP/MCP detail 保留完整块 JSON。

客户端先保存占位，再后台上传原字节；切卡不改变目标。完成前排空草稿并与既有历史路由串行，IME 组合输入期间不提交结果；旧 ACK 仍只确认其覆盖的草稿 generation。素材、Body 均持久确认且无未完成媒体任务才显示已保存；失败可重试或移除。媒体命令身份由原项目、卡、块与ticket稳定推导，重开仍复用原请求；上传ACK丢失可用完整不可变资产读回确认，无法确认时保持未知而不冒充解码失败。丢失完成回执保留原命令以明确重试；服务端幂等回执先于有效期检查，重复请求不产生重复插图。
