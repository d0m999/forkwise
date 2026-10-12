# ADR 0002：统一命令、细域版本与持久幂等
状态：工程采纳（参考实现），未迁移生产

## 背景
整项目revision写锁会让无关编辑冲突；正文/pose混合快照覆盖会丢数据；撤销后复用旧版本ID会产生ABA问题。

## 决定
read/execute/observe构成一个深Module的Interface。UI/Agent越过同一seam。execute原子保存领域变化、不可变版本、40步研究历史、receipt及delta；按实际写域校验expected。commandId重试先于并发校验，但在可信授权之后。undo是新写入，不回退revision。资料导入/Asset创建持久保留、不进入研究undo。

## 替代方案
UI与Agent各自写库会分散约束；全图事件溯源可统一历史但迁移与回放成本过大；一个全局锁对小demo简单，却制造虚假冲突。此包选择可替换的JSON Adapter演示事务，不声称替代生产SQLite。

## 后果
调用方只学三入口和命令语义，删除级联、版本、幂等集中维护，具备Depth、Leverage和Locality。删除该Module会让复杂性回流到UI/Agent/存储，而非消失。JSON Adapter只允许一个进程写入；多进程须真实DB事务与锁，绝不可把os.replace当跨进程并发控制。
