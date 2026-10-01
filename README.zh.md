# dsh-resend

[English](<README.md>) · [设计说明](<DESIGN.md>) · [版本记录](<CHANGELOG.md>)

为 **DeepSeek Harness 桌面端**增加「重新生成」「编辑」按钮。使用宿主真实 V4 替换协议修改上下文，聊天隐藏旧轮，轨迹和磁盘日志保留原始记录。

**版本 0.2.0；已验证 Windows 桌面 DSH 0.2.0-rc.2；Node 24+；MIT 许可。** 这是社区插件，并非 DeepSeek 官方版本。其他 Harness 版本及 macOS/Linux 原生界面未完成实机验证，因此声明精确的可选 DSH peer 兼容范围，不自动安装另一套宿主。

## 功能与限制

| 消息 | 重新生成 | 编辑 |
| --- | --- | --- |
| 用户消息 | 用原提问文本重跑 | 读取原始 Markdown，保存后用新提问重跑 |
| 助手回复 | 用该轮原提问重跑 | **只替换这一条回复，不重发** |

- 按钮放在原生「分支」后、用量和时间前。用户、主会话和侧栏子会话分别定位，不猜轮号。
- 保留编辑原文的 Markdown、换行和空白；复制助手回复时返回修改后的文本。
- 旧轮仅在聊天中可逆隐藏，不删除日志；其他消息不应被合并进替换区间。
- 正在回复、已被替换或压缩、无法可靠定位的目标会被禁用或拒绝。

**必须知道：**

1. 助手编辑保存为明确标注的「用户编辑后的助手回复」上下文载体，模型侧是 **user 角色 / model 来源**，不是原生 assistant 角色。当前 V4 协议不允许助手事件直接携带替换所需的来源引用。界面在原回复位置显示编辑后的文本，提问和其他消息保留。
2. 含工具调用块的助手节点拒绝文字替换，防止留下没有调用来源的工具结果。
3. 重新生成目前**只重发文本，不带图片或附件**；不撤回工具创建的文件、网络请求或其他外部效果；后续其他轮不会自动重算。
4. 预校验和同步成对写入不是文件系统事务。持久化或重发失败时可能已经部分提交，请看清错误再重试。
5. 本插件会改变会话上下文；重要会话请备份，并先在可丢弃会话里试用。

## 安装发布包

先等所有任务结束。在**现有桌面应用 → 插件 → 添加插件**中输入 `dsh-resend-0.2.0.tgz` 的完整本地路径。如果管理器不接受本地压缩包，使用解包后的 package 目录，或用下面的桌面内置命令。将安装包保存在稳定位置，不要安装后立即删除：profile 可能仍引用该本地文件。

通过应用菜单管理/启用 **Desktop 自带的 dsh 命令**后，可执行：

```powershell
dsh plugin --profile desktop add "<dsh-resend-0.2.0.tgz 的完整路径>"
```

不要改用另装的 npm 版 `dsh` 管理桌面 profile，它可能明确拒绝这一操作。正常安装会同时更新依赖及 bundles；仅复制文件或只写 bundles 包名不算安装成功。之后确认插件已启用、用户和助手两种工具条都有按钮。

发布包已包含可运行产物，不需要安装时构建，不需启动 Web/Vite 服务器。若宿主要求下次启动生效，等任务全部结束再正常退出重开，**不要刷新正在工作的窗口**。

### 从本地开发版升级

不要让两个同名插件实例同时挂载。先备份旧插件和 profile，在空闲时通过管理器卸载旧副本，再安装新压缩包。早期开发版可能在卸载后遗留同前缀路由；如遇 duplicate-route，应在空闲时完整退出应用后正常启动。公开版**不会自动抢占遗留路由，也不会替你重启**。

### 卸载

通过桌面插件管理器，或：

```powershell
dsh plugin --profile desktop remove dsh-resend
```

卸载不删除会话历史，也不撤销已经保存的上下文替换。显示层移除后，原始日志内容可能重新显示在聊天中。

## 排查

- 路由前缀 `/api/plugins/resend`，状态/操作接口均采用 POST。只读 `status` 校验当前宿主 V4 运行时；`inspect` 读取原文；`marks` 返回精确展示数据。
- `inspect` 不存在表示旧宿主逻辑仍缓存，新客户端会拒绝继续写入。
- 诊断默认写入 `$DSH_HOME/logs/dsh-resend/breadcrumbs.jsonl`；未设 DSH_HOME 时优先 `$DSH_PROFILE_DIR/logs/dsh-resend/`，否则 `~/.dsh/logs/dsh-resend/`，不写安装包目录。`DSH_RESEND_BREADCRUMB` 可指定完整文件，显式空值禁用日志。单文件上限 256 KiB，旧诊断可能被丢弃；过大 payload 截断。分享前请检查个人信息。
- 看不到「轨迹」先检查通用设置的**显示代码工作视图**，当前版本对应 `ui-settings.config.enabled`。本插件不自动修改该开关，不依赖 `dsh-desktop-context`。
- 发布包不含真实会话、个人路径、日志、备份或会话磁盘修复脚本。

## 源码测试

完整源码交付包含测试；运行安装包不包含开发测试。

```powershell
pnpm install --ignore-scripts
pnpm check
pnpm test
pnpm test:client
$env:DSH_TEST_RUNTIME_ROOT = '<已核对的可读 DSH runtime 根目录>'
pnpm test:runtime
pnpm test:all
pnpm pack --pack-destination ../../dist
```

runtime 根目录下需有宿主 node_modules；不能把 ASAR 虚拟路径交给普通 Node 当目录读取。若使用提取镜像，应先与当前归档对应成员逐字节比对。回归使用合成事件、detached Session 与隔离日志，不遍历或修改真实用户会话。
