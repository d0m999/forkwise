# 开放工作台：本机第一张卡

本入口使用 ADR0011 已选择的 React Flow。现阶段支持项目创建、重命名、切换，以及普通卡片独立标题和简单正文的 SQLite 自动保存。旧研究入口、原型及其数据库保持原样；不自动导入旧项目。本阶段不提供拖动保存、撤销、富文本、资料迁移或 Agent 写入。

## 安装与启动

需要 Node.js >=22.22.2。在仓库根目录安装锁定依赖：

```sh
npm --prefix frontend ci
npm --prefix backend ci
npm --prefix backend run build:workspace
```

选择一个新的绝对路径作为数据目录，再启动：

```sh
FORKWISE_DATA_DIR="$HOME/Library/Application Support/Forkwise/Open Workspace" npm --prefix backend run start:workspace
```

在本机浏览器打开终端显示的 `http://127.0.0.1:8790`。关闭进程后，以**相同目录**启动即可重开。端口占用时显式设置 `FORKWISE_PORT`。本入口要求独立目录，拒绝旧资料目录、未知格式、符号链接及多硬链接文件；没有自动搬运、覆盖或修复原件操作。

旧 `npm --prefix backend start` / 8787 入口没有改变。不要用旧启动命令验证新卡片，也不要把用户旧 `.data` 指定为本入口目录。新入口的构建或启动失败不会替换旧入口。

## 使用

- 「新建研究」直接打开空画布，顶部项目标签切换项目，「重命名」单独改项目名称。
- 「见岔」展开紧凑项目导航，可固定。项目编号用于区分同名项目。
- 点击底部「卡片」，再点击画布放置；键盘聚焦「卡片」后按 Enter 在可见画布中央创建。
- 卡片标题可独立编辑，Enter 完成、Shift+Enter 换行、Esc 保留。中文组合输入结束前不触发完成。
- 「编辑正文」打开右侧简单正文输入。编辑自动保存；只有 SQLite 写入及回读成功才显示「已保存到本机」。未保存时离开页面有浏览器提示；保存失败保留当前输入。

当前数据只写入专用目录的 `workspace.sqlite` 及其 WAL/SHM。卡片、正文、文本块和画布项有独立稳定身份；标题与正文分别版本化。`Mapping.read/execute/observe` 是本阶段唯一业务读写入口，成功回执和改前改后内容同事务保存，跨重启原命令重试不会重复写入。没有使用 localStorage 保存卡片，没有遥测或模型调用。版本记录与未来的40步撤销功能是不同能力。

## 验证

```sh
npm --prefix backend run check
npm --prefix backend test
npm --prefix backend run build
npm --prefix frontend exec -- playwright test
```

浏览器测试请从 `frontend` 执行 `npx playwright test`，先构建。它自动分配回环端口、新建临时目录、重启正式构建后的服务，并创建全新浏览器上下文；不操作用户浏览器配置或旧存档。可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 使用已安装 Chromium，测试不修改浏览器二进制权限。否则按 Playwright 的标准方式安装测试 Chromium。

浏览器自动输入中文文字不等于真实系统输入法验收；此项应单独记录。完整开放画布能力按后续工单推进，不能从第一张卡的保存成功推定整个引擎适配完成。
