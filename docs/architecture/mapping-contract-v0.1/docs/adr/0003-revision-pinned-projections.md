# ADR 0003：同revision投影与有预算的逐层读取
状态：工程采纳（参考实现）

## 背景
截屏与自然语言摘要无法稳定寻址节点；分页跨写入会混合事实；固定token预算与无限全图承诺互相冲突。

## 决定
权威存储一份，Frontend和Agent共享identity/version拓扑。正文与资料detail按固定snapshot无损JSON片段展开。observe返回同revision token，防止delta读取竞争。整个响应UTF-8字节计预算；超长不可拆结构项明确失败。summary默认null；不推断用户连线含义。

## 替代方案
每次返回全图最简单，但大正文不可控；仅Markdown摘要便宜却丢ID与拓扑；每页取最新数据无需快照但无法称一致结果。

## 后果
Agent可以先选择局部再取细节，代价是调用方维护快照/分页和组装。生产要定义snapshot TTL、授权变更、changefeed保留与背压；参考模型snapshot仅在内存中，重启即明确过期。未测性能与模型token消耗。
