# @dsh-external/dsh-token-ledger

> **非官方插件。** 由社区开发者独立编写与维护，与 DeepSeek 官方（`@deepseek-ai/*` 包）无隶属关系，也未获其背书。`lib/` 已随仓库提交，开箱即用，无需构建步骤。

DeepSeek Harness 的累积 token 账本：读取兼容的 usage 事件与历史日志，提供统计工具、Web 面板和 HTTP API。**需要 DSH；没有第三方运行时依赖，不等于独立运行或兼容所有 DSH 版本。**

## 前提

- Windows，Windows PowerShell 5.1 或 PowerShell 7；本地文件系统支持 junction 与原子文件替换，用户有目标目录写权限。
- 已初始化目标 profile，且 DSH 的 **bundle loader 兼容此插件**：能读取 profile `package.json` 的 `dsh.profile.bundles`，通过 `node_modules` 解析此类插件包的 host/client。部分版本可能只接受含 composition 的 bundle；仅写入字段不能保证加载。
- DSH 使用的 Node.js 提供 `node:zlib.zstdDecompressSync`，并具备兼容的会话、工具、HTTP、客户端 Slot 契约。安装脚本不验证这些运行时能力。
- **会话日志双格式兼容**：同时支持 DSH ≤ 0.1.4 的 `session.jsonl.zstd`（水位记全局 seq）与 DSH ≥ 0.1.5 的 `session.v3.jsonl.zstd`（水位记日志下标）。两种格式的序号空间互不兼容，账本按来源分别记录水位；检测到来源切换时会先撤销该会话的旧贡献再从新日志重扫，避免整段历史被重复计入。跨大版本升级后首次启动会自动做一次全量重建（账本 version 2 → 3），期间面板数字会短暂为空，通常十几秒内补齐。
- 完整保留 `package.json`、`lib/index.js`、`lib/client.js`、`install.ps1`、`uninstall.ps1`（以及一键脚本 `install.bat` / `uninstall.bat` / `install-auto.ps1` 和 `安装说明.txt`）。解压到稳定目录，安装后不要移动。当前 npm `files` 只列出 `lib`，不能假定 `npm pack` 会包含安装脚本和本指南。

## 一键安装（推荐，给不熟悉命令行的使用者）

把整个文件夹解压到一个**固定目录**（安装后不要移动），然后：

1. **完全退出 DSH**（含托盘图标）。
2. 双击 `install.bat`：自动识别 profile；若存在多个 profile 会列出让你输入编号；安装前自动备份 profile 配置。
3. 用原桌面快捷方式重启 DSH。网页右下角出现「📊 用量」按钮即为成功。

卸载：双击 `uninstall.bat`，再重启 DSH。

`install.bat` / `uninstall.bat` 只是自动定位 profile 并调用下面的 `install.ps1` / `uninstall.ps1`，自身不创建 profile、不单独写文件。面向收件人的逐步说明见 `安装说明.txt`。

## 手动安装（高级）

先保存工作并正常退出 DSH，避免其他进程并发写 profile。打开 PowerShell，进入插件目录，明确填写实际 profile 名称：

```powershell
.\install.ps1 -Profile web
# 自定义 DSH 根目录，也可用于隔离测试
.\install.ps1 -Profile my-profile -DshHome 'D:\DSH data'
```

`-Profile` 必填；不任选第一个 profile，也不创建 profile。`-DshHome` 默认依次取环境变量 `DSH_HOME`、`$env:USERPROFILE\.dsh`。只操作 `<DshHome>\profiles\<Profile>`，不改变环境变量或迁移数据。使用绝对 `link:` 路径，支持跨盘符，不依赖 `Path.GetRelativePath`。

脚本不修改全局/用户 execution policy。若已审阅脚本被本机策略阻止，可在组织策略允许时仅为本次进程使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
# PowerShell 7 可将 powershell.exe 换成 pwsh.exe
```

安装成功只表示配置和链接写入完成。随后从原桌面入口完全冷启动 DSH，检查启动日志、现有会话、`token_ledger_stats` 和 Web 用量按钮。**热加载、HTTP 200、离线 fixture 通过均不等于真实冷启动验收。**

## 卸载

保持两个脚本在同一目录，使用安装时的根目录和 profile：

```powershell
.\uninstall.ps1 -Profile web
.\uninstall.ps1 -Profile my-profile -DshHome 'D:\DSH data'
```

卸载复用 `install.ps1` 的事务实现，只移除本包依赖、bundle 条目和目标匹配的 junction，之后正常重启。它不调用超级注入器、不修改 `cordis.patch.yml`，不停止已加载实例；曾经通过其他方式注入/安装的注册需另行核查。

## 备份、回滚与边界

- 每次实际变更前在目标 profile 的 `.token-ledger-backups\<时间>-<随机ID>` 保存原始 `package.json` 字节和 `junction.json` 原链接状态。重复无变更操作不重写 JSON。备份可能含私人配置，不应公开分享。
- 拒绝普通目录/文件、符号链接、不同目标的 junction、冲突依赖，以及目标路径的 reparse-point 祖先。不会递归删除目录、插件源码、账本或会话。
- JSON 用 UTF-8 **无 BOM**，可供 Node 直接 `JSON.parse`。先写同目录临时文件，再原子替换；可捕获失败会回滚本次 junction/空目录变更并保留旧 JSON。回滚本身失败会明确报告备份位置。
- 不提供跨进程锁或断电恢复。不要并发安装/卸载或编辑 profile；强杀、断电、磁盘/权限异常可能需要人工恢复。
- 人工回滚：退出 DSH，将选定备份 `package.json` 原样复制回 profile，并按 `junction.json` 恢复链接状态。只允许移除核实过的 junction；遇到真实目录或未知目标应停止。
- 默认账本在运行时 `DSH_HOME`（未设则用户 `.dsh`）的 `token-ledger\ledger.json`；插件配置可改变账本位置。两脚本均不删除账本、显示名缓存或历史日志。`-DshHome` 仅选择安装目标，不改变运行时数据根。

## 功能与统计范围

- 实时观察兼容的 `session/event` 用量事件，启动时尝试回填可读取的 `session.jsonl.zstd` / `session.jsonl`。日志缺失、损坏、格式不兼容、无 usage 或回填未完成都会影响结果。
- usage 来自 DSH/provider 记录，不是服务商账单。**不保证所有 API、所有历史、外部调用或所有缓存 token 都能统计**；字段、重试语义、忽略列表和 DSH 版本均可能影响结果。
- 查看方式：`token_ledger_stats` 工具、Web「用量」按钮/悬浮面板、当前 DSH 地址下 `GET /@dsh-external/dsh-token-ledger/api`（默认部署常为 `http://127.0.0.1:3080`）。按钮位置依客户端布局。
- 总输入/输出/缓存读/缓存写，按 provider/model 和日期汇总，界面以亿 tokens 显示。provider 显示名可从本机设置读取并缓存；`ignored-providers.json` 可排除提供商。
- 以只读观察会话为目标，但写自身账本和显示名缓存；不能承诺统计错误永不影响运行。

## 测试与验收

隔离 fixture 可验证安装、幂等、卸载、危险路径拒绝、UTF-8 JSON 及受控失败回滚，不需 DSH 运行。它不能证明 bundle 被加载、UI 正常、历史回填准确或桌面冷启动成功。真实冷启动及 provider 对账需在收件人的兼容 DSH 上另行验证。
