# ADR 0002：统一命令、细域版本与持久幂等
状态：工程采纳（参考实现），未迁移生产

## 背景
整项目revision写锁会让无关编辑冲突；正文/pose混合快照覆盖会丢数据；撤销后复用旧版本ID会产生ABA问题。

## 决定
read/execute/observe构成一个深Module的Interface。UI/Agent越过同一seam。execute原子保存领域变化、不可变版本、40步研究历史、receipt及delta；按实际写域校验expected。commandId重试先于并发校验，但在可信授权之后。undo是新写入，不回退revision。资料导入/Asset创建持久保留、不进入研究undo。

2026-10-12 评审补充（待实现）：标题、标签定义、单卡标签关联、独立对象内容、Pose 与 StackOrder 分域。标签删除包含所有受影响关联；文字角点缩放包含字号和 Pose；图片应用/恢复裁剪包含 crop、Pose 与附着图片必要的 offset；创建/删除四类内容包含排序增删。expected 除修改域外还校验计算影响范围所依赖的只读版本，跨域失败不部分提交。排序域版本只协调排序相关命令，不把项目 revision 变为全项目写锁。具体闭包、无变化与历史分组见[字段映射](../STORAGE-MAPPING.md)；新增域尚未包含在原参考验证中。

批注目标删除/解除附着还需原子更新 Attachment 与批注自由 Pose，保留批注内容并纳入同一步撤销；关系范围及计算世界位置所依赖的版本一并校验。此新增闭包未接入参考模型，不沿用普通 Connector 删除测试作为通过证据。

裁剪/恢复 P2 补充：位置由目标锚点与 offset 派生时，必要 offset 变化与 crop/几何同事务、同历史动作；不能只写 Pose.x/y 或只校验已改变的 offset。offset 未变则保留为读依赖、不推进其版本。图片、附着状态或目标锚点依赖过期时整体拒绝，undo/redo原子恢复实际变化；量化和并发场景见[验证说明](../../VALIDATION.md#附着图片裁剪与恢复待验场景)，仍未实现/验证。

## 替代方案
UI与Agent各自写库会分散约束；全图事件溯源可统一历史但迁移与回放成本过大；一个全局锁对小demo简单，却制造虚假冲突。此包选择可替换的JSON Adapter演示事务，不声称替代生产SQLite。

## 后果
调用方只学三入口和命令语义，删除级联、版本、幂等集中维护，具备Depth、Leverage和Locality。删除该Module会让复杂性回流到UI/Agent/存储，而非消失。JSON Adapter只允许一个进程写入；多进程须真实DB事务与锁，绝不可把os.replace当跨进程并发控制。
