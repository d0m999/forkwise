# ADR 0026：写字板、简单段落与完整 Body 保全

状态：已采用；日期：2026-10-14

依据：Issue #10；D152–157、D257–266、D270–271、D278–279、D284–285；受 D151、D256、D283、D301–302、D307–308 及 Mapping CONTRACT、STORAGE-MAPPING 约束。沿用 ADR 0010/0011/0012/0015/0019/0022–0025 的本机、草稿、事务历史、观察、尺寸与外观所有权。

## 工程决定

沿用 React 和 Chromium 原生 contenteditable，不添加编辑器库、CRDT 或远端依赖。当前仅编辑无其他字段的 `text` 段落：`{id,type:"text",text,inlineId?}`。一个段落一个稳定 Block ID、一个文字片段的 inlineId；原有单块没有 inlineId 时，第一次实际文字变更才附加身份，不因打开、选择或 metadata 补齐产生正文版本或研究历史。分块新增身份，合并保留前块身份；浏览器文本 undo 对原生 DOM 对象保持身份，项目 undo 通过 immutable Body 版本还原身份。退休身份的归属通过 `mapping_versions` 校验，不能移到另一 Body 或另一块。

Body 仍是独立有版本实体，以完整 JSON blocks 数组往返 SQLite、HTTP、MCP、草稿与历史；不另建摘要或 HTML 权威。段落顺序由数组保存，块内软换行是 text 中的 `\n`，段落界限是相邻块，末尾空段独立保留。Enter 在光标处分块，Shift+Enter 仍同块，块首 Backspace 合并相邻兼容段落。基础文本 paste 仅输入 literal plain text；复杂 paste 属于 #14。

`body.edit` 与既有 `card.edit` 接受完整 blocks 或旧 text 二选一，后者仍在同一事务中验证并更新 Body 与 Pose，沿用原 Body expected、commandId 重试和 editGroup；旧 text 仅能编辑已有单一普通文本块，不能截断多段或未知内容。全正文文字及段落界限合计沿用 200000 UTF-16 单元上限。旧草稿 schema 与原 command 保持可读；新增草稿携带完整 blocks，明确恢复仍提交原卡、原 expected、原请求。预览从同一完整 Body/当前完整草稿派生，沿用卡片尺寸预算。

未知类型、媒体、未知内联字段或其他扩展内容在 read DTO 中透传 JSON；完整正文 UI 显示只读原件，禁止自动迁移、截断或降级。服务端 blocks 编辑要求未知块及扩展内容逐项保持；旧字符串写入未知/多块正文明确拒绝。保全是 JSON 数据值、身份与顺序，不承诺 JSON 对象键顺序或旧序列化字节一致。媒体资源仍经过既有 requiredAssetIds 保存门禁，本票不实现媒体显示/编辑。

## 生命周期与历史

写字板绑定项目和当前卡身份。正文双击或菜单打开，从开头展示且不创建插入光标；单卡明确选择才跟随，重复当前卡和保存重绘不重置阅读位置，空白/取消/多选保留当前对象。删除导致的系统选区过滤不是明确选择；删除/直接撤销期间保留当前对象，随后明确单卡选择才跟随。切卡保存和迟到 ACK 仍绑定原卡；项目切换以原项目身份和 editor epoch 拒绝晚到打开。

新增必要的 `thought.delete`，完整 thought/body/pose/appearance expected 在同一事务验证，删除当前 projection，保留身份、ordinal、immutable versions 与资源。沿用统一 40 步 action history，删除记录 before→null；恢复分配新的实体版本而保留实体身份，旧保存不能复活或覆盖恢复的版本。

写字板删除态保留正文、退出编辑，显示这次删除 actionId 对应的直接撤销入口。入口要求当前历史顶仍是该操作、版本与权限仍有效；服务端 history.undo/redo 的可选 actionId 再验证，不能误撤后续操作。原创建撤销导致删除的恢复仍走绑定 redo。关闭仅收起，继续保存/保留恢复记录。文本原生 undo/redo 与项目历史各由既有单一路由处理，IME 优先；合成 composition 只验证事件处理，不证明真实 OSIME。

## 几何与阅读状态

W 为工作区可用宽度；W>=960 常态初值 clamp(0.4W,420,560)，再受 min(800,W−480) 上限，最小360。项目宽度偏好仅存本机 localStorage，切卡不重置；读取/悬停不写后端或研究历史。调宽支持指针和键盘。W<960 同一视图全宽并可返回画布；主动展开/还原与自动窄窗状态分开。展开版心最大760，正文16/28。写字板对象标题的视觉标签最多两行，完整标题仍在 DOM、可访问名称及原生 title 提示中；不修改标题字段或卡片的完整标题测量，保证窄且短窗口的正文及返回/关闭按钮可达。

阅读锚点只在 UI 内存，保存稳定 Block ID、块内 UTF-16 位置及相对 viewport Y。调宽/展开/还原/窄窗转换按该锚点恢复；普通重新打开、切另一单卡从开头。原项目浮动导航仍遵守已有行为；窄窗隐藏画布卡片 portal 菜单，避免覆盖写字板按钮。

## 交付与验证边界

真实本机 Web UI、临时 SQLite、Mapping read/execute/observe、实际 HTTP 和实际 MCP 同 snapshot 往返纳入本票测试。保留 RED/中间 FAIL 和对应源码身份，最终候选固定 Git tree 后重新亲跑七组。root 的全基线双轴审查与远端交付另行完成。本票不交付 #11–17 的格式菜单、列表、折叠、拖块、复杂 paste、表格或媒体编辑；真实 OSIME、系统剪贴板、物理设备、读屏、本人 UX、第二 OS、生产用户数据及备份验收未执行。
