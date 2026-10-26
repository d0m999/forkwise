# 旧研究工作台画布

此包服务于旧后端的 `/canvas/index.html` 与 `forkwise-study` / `forkwise-canvas` 消息接口，保留旧结构化研究和画布资产的使用入口。正式开放工作台继续使用根目录 `frontend/` 的 React Flow。

源码与锁定依赖从 Git `f2768cbc` 的 `prototype/canvas-lab` 迁入；其引用的卡片和样式模块一并移到 `src/`。迁移不恢复原型主页面，也不包含已删除且未提交的重构。字体使用同一锁定版本的 Excalidraw 安装包：开发服务器直接在 `/excalidraw/fonts/` 提供本地字体，构建时复制到 `../web/canvas/excalidraw/fonts/`，无需从 CDN 获取。

```sh
npm ci
cd ..
npm run build:canvas
```

完整安装与旧入口启动见 [后端说明](../README.md)。

在本目录运行 `npm run dev` 可启动回环开发服务器；此独立画布仍通过父页面的消息接口接收研究内容。
