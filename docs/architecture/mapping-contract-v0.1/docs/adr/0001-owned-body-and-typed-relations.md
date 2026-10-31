# ADR 0001：正文独占与三类关系分离
状态：工程表达采纳；一正文一摆放与资料卡UX仍为待确认产品提案

## 背景
旧 entities/links 术语承载论证语义，不能直接等同当前自由思维地图；复用资料也不等于共享可编辑正文。

## 决定
Thought拥有Body与一个CanvasItem；Block ID跨编辑稳定、跨复制新建。Reference、Connector、Containment分别表示正文指向、用户连线与空间归属。不可变Asset/MaterialVersion可共享；Body不共享。

2026-10-12 评审补充（文档要求，未实现）：Thought 只对应普通卡片，独立保存 title；项目 Tag 与每卡 CardTags 分别承载共享名称/颜色和单卡关联顺序。Shape、Text、Image、Stroke 是独立 CanvasItem 类型，使用各自内容记录，不继承 Body 或卡片标签能力。文字每对象统一字号、独立图片不提供替换、首版无转卡；依据 D167、D185–D195、D355–D406、D422。此补充不把一正文一摆放或 MaterialCard 产品提案升级为用户已确认决定。

后续文档评审补齐 D78/D84/D421 随动批注：Attachment 另行表达目标身份与偏移，不并入 Reference、Connector 或 Containment；删目标保留批注并解绑，复制为自由副本。字段与旧目标/新类型适配均待实现验证，详见[字段映射](../STORAGE-MAPPING.md)。

## 替代方案
所有边统一links表：表面简洁，但DAG、删除、布局与语义会互相污染。正文与摆放多对多：适合镜像内容，代价是需要明确新UX语义、共享编辑与恢复规则。选择保守一对一，不默许该功能。

## 后果
用户连线环不会触发旧推导防环；删除规则可按关系类型定义。未来支持多摆放须升级基数与用户交互，不能仅添加第二条布局记录。物理数据库仍可通用表存储，但必须保存typed identity与验证。
