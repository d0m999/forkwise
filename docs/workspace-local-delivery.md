# 见岔（Forkwise）本机启动、备份与恢复

## 启动工作台

在 macOS 终端使用 Node.js 22.22.2 或更新版本。在同一个见岔版本目录中安装已锁定的依赖并构建工作台。

```sh
npm --prefix frontend ci
npm --prefix backend ci
npm --prefix backend run build:workspace
```

将路径换成本机账户独占的新目录。初次启动会创建目录（0700）和数据库（0600）。以后继续使用同一个目录。

```sh
FORKWISE_DATA_DIR="$HOME/ForkwiseWorkspace" npm --prefix backend run start:workspace
```

用本机账户打开数据目录下 `local-access.json` 中的 `url`。工作台默认使用 `http://127.0.0.1:8790`，由本机账户和私有启动文件完成访问校验，无需注册。端口冲突时可设置 `FORKWISE_PORT`。终端启动行和项目导航中的「备份与恢复」都显示应用版本及 12 位构建摘要，例如 `0.1.0 (a1b2c3d4e5f6)`。记下这两部分，可识别备份来源和需要重开的旧版本。

画布、写字板和保存无需模型或 API 凭据。当前版本支持模拟整理和查看历史。卡片的真实 AI 整理仍待 #39 接通工作台，并核验目标 OpenAI API 项目的零数据留存、不用于训练、数据共享设置、适用协议和固定模型快照。[模型启用条件](adr/0033-openai-organize-responses-candidate.md)

## 下载加密备份

备份使用 macOS 的 `/usr/bin/tar` 和 `PATH` 中的原生 `age`，验证版本为 age 1.3.2。用 `age-keygen -o <私钥文件>` 生成一对 X25519 密钥，确保私钥文件仅当前账户可读写（0600），放在工作台数据目录之外。用 `age-keygen -y <私钥文件>` 取得 `age1…` 公钥。

在启动工作台的本机进程环境中设置以下配置，再重开工作台。

- `FORKWISE_BACKUP_RECIPIENT` 填备份公钥，供加密使用。
- `FORKWISE_BACKUP_IDENTITY` 填私钥文件的绝对路径，供恢复使用。私钥内容留在文件里。

在「项目导航 → 备份与恢复」点击「下载加密备份」，浏览器会下载 `forkwise-workspace-….tar.age`。备份包含同一 SQLite 快照中的所有项目、版本、原件、旧研究导入归档和可撤销的历史。受限旧材料沿归档中的省略记录保留索引。备份中排除启动凭据、会话、历史中的内部会话指纹和旧归档任务的运行凭据。独立的旧研究数据库 `research.sqlite` 继续用原研究工具单独管理。下载后的加密副本由本人管理，恢复时需要对应的私钥。

## 校验恢复和回退

1. 在「备份与恢复」选择已下载的 `.tar.age`，点击「校验并恢复副本」。工作台先完整解密，再检查归档条目、版本、数据库摘要、完整性和已知资源。
2. 校验成功后，界面显示备份来源版本和新目录的启动命令。副本生成在当前数据目录旁。已有同一备份的恢复目录时，界面会提示检查该副本。失败时界面显示停止的步骤。
3. 用界面给出的命令和一个空闲端口启动新目录，再打开新目录里的 `local-access.json`。核对项目、版本、历史及原件后，才选择日常使用哪个目录。浏览器本机缓存中的未保存编辑需先保存。
4. 升级前记录上一个版本的 Git 提交和构建摘要，准备一份可打开的隔离数据副本。在副本上试启动新构建并核验数据。若升级或启动失败，可从上一个 Git 提交重建工作台，核对构建摘要，再用原数据目录或升级前已核验的副本启动。打开新生成的本机网址。若仍有服务在运行，按终端 Ctrl+C 停止自己的旧进程，或另选空闲端口。

## 依赖许可

见岔代码和仓库内的 `public-data-core` 使用 Apache-2.0。Node.js 使用 MIT 及随发布包提供的第三方许可。工作台直接运行依赖中，React、React Flow、html-to-image、Hono 及其 Node 和 OpenAPI 适配、MCP SDK、better-sqlite3、@napi-rs/canvas 和 Zod 使用 MIT，LinkeDOM 使用 ISC，Drizzle ORM、PDF.js 和 `@ai-sdk/openai` 使用 Apache-2.0。age 1.3.2 使用 BSD-3-Clause，macOS 自带 tar 的条款随系统提供。构建使用的搜索词典和分词组件许可随 `backend/dist/search-vendor` 提供。完整归属以实际锁文件、依赖各自的许可证和仓库 [NOTICE](../NOTICE) 为准。
