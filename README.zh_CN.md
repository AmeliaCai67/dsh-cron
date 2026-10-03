# dsh-cron-scheduler

[English](./README.md) ｜ **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）的定时任务插件。用标准 5 段 cron 表达式调度 bash 命令 —— 支持任务分级、失败通知、自动重试与冒烟测试。

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-cron
```

装好即用。这条命令会装包、因为它声明了 `dsh.bundle` 而把它注册成 profile bundle，再从**包内自带**的 patch 挂载。**不用改任何 profile 文件。**

---

## 功能

- **定时调度** —— 分钟级精度，15 秒轮询。状态持久化在 `<vaultPath>/memory/scheduled-tasks.json`。
- **任务分级** —— `safe` 安全类（失败静默）/ `important` 重要类（失败通知 + 自动重试）。
- **失败通知** —— 重要任务最终失败时推送微信。未配置发送器时静默降级为日志。
- **自动重试** —— 失败 5 分钟后自动重试 1 次；重试成功也会通知。
- **冒烟测试** —— 上线前用与到点触发**完全相同的生产路径**（同一沙箱 / 工作目录 / 命令）试跑一次。
- **四个入口** —— 设置 →「定时任务」面板、插件页 tab、模型工具 `scheduled_task`、运行时 skill `scheduled-tasks`。

---

## DSH 版本兼容

**要求 DSH ≥ `0.1.0-rc.6`，含 `0.2.0`。**

**`v1.2.0` 在 DSH 0.2.0 上跑不起来** —— 它没适配下面三处 0.2.0 的接口/结构变更。`v1.2.1` 修好了：

| 变更 | 0.1.x | 0.2.0 | 本插件的处理 |
|---|---|---|---|
| **peer 兼容闸门** | 没有 | **新增** | peer 范围从 `^0.1.0-rc.6` 放宽为 `>=0.1.0-rc.6 <0.3.0`。<br>⚠️ **不放宽就会被静默禁用** —— DSH 只打一行 `skipping profile` warning，**退出码仍然是 0**，很容易误判成别的问题。 |
| **shell 服务** | `ctx.shell.run(spec)` 直接返回结果 | `ctx.shell.execute(spec)` 返回**句柄**，要再 `await exec.result()` | 已改。不改的话每次执行都报 `ctx.shell.run is not a function`。 |
| **插件页插槽** | `settings.plugin.item` | 改名 `settings.plugins.tab` | 已改。不改的话插件页那个 tab 不显示（**优雅降级，不崩**）。 |

> 第一条就是本插件在 0.2.0 上「装了但完全没反应」的真正原因 —— 它连加载都没通过。
> 排查方法：`dsh --profile web --help`，看有没有 `skipping profile bundle` / `disabling profile plugin row`。

**`v1.2.2` 在 DSH `0.2.0-rc.2` 及以后【同样跑不起来】** —— 还有第四处破坏性变更，`v1.3.0` 修好：

| 变更 | 以前 | 现在 | 本插件的处理 |
|---|---|---|---|
| **schemastery API** | `z.string().optional()` | **`.optional()` 已移除** —— schema 默认就是可选，要必填才写 `.required()` | 已改。不改的话插件 import 直接失败：`TypeError: z.string(...).optional is not a function`。⚠️ peer 范围（`^3.18.1`）**拦不住**这个，所以它会照常装上，直到你**下一次重启 DSH** 才暴露。 |

> 最后这点值得单独记住：**插件可能已经坏了好几天，却一点症状都没有** ——
> 因为**正在运行**的 DSH 进程一直在用它启动时加载的那份模块图。
> 不重启，日志里什么都不会有。

---

## 安装

### 方式一：一条命令（推荐）

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-cron
```

这条命令会做三件事：

1. 把包装进 profile 的依赖；
2. 因为包里声明了 **`dsh.bundle`**，顺带把 `dsh-cron-scheduler` 加进 `dsh.profile.bundles`；
3. profile 启动时合并**包内自带**的 `cordis.patch.yml` —— 等同于下面那段手写的 `insert`。

> ⚠️ **如果你之前已经手写过下面的 `insert` 行，切换过来之前请先删掉它。**
> 否则会挂载两次：两个调度器实例共用一个任务表，每个任务都会触发两次。

> 📦 **为什么走 GitHub 而不是 npm 包名？** npm 上 `dsh-cron-scheduler` 这个名字已被
> [另一位作者](https://www.npmjs.com/package/dsh-cron-scheduler)占用（同名但不同实现），所以本仓库只能从 GitHub 安装。

`vaultPath` 默认是 `process.env.DSH_CWD ?? homedir()`，**在设置 →「定时任务」里改**。
（包内 patch 刻意不写死路径 —— 否则别的用户装完会指向一个不存在的目录。）

### 方式二：手动挂载

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: cron-scheduler
      name: 'dsh-cron-scheduler'
      config:
        vaultPath: '/path/to/your/vault'   # 任务工作目录 + 状态文件位置
        notifyWechat: true                 # 失败通知总开关
```

改动需重启 DSH 生效。（注意：改插件**源码**必须重启 —— `dsh-hmr` 只监听配置层；只改配置会热重载。）

### 前端面板

`lib/client.js` 提供设置页面板，由上面那条 `dsh.bundle` 声明自动带进 web profile —— **装了就用，不需要额外配置。**

---

## 用法

### 对话中使用

直接说就行，或调用 `scheduled_task` 模型工具：

```
scheduled_task op=add name=备份 schedule="0 9 * * *" command="tar -czf backup.tar.gz ./data" risk=safe
scheduled_task op=list
scheduled_task op=smoke    id=<任务 id>
scheduled_task op=run_now  id=<任务 id>
scheduled_task op=toggle   id=<任务 id>
scheduled_task op=remove   id=<任务 id>
```

cron 表达式为 5 段：`分 时 日 月 周` —— 支持 `*`、`*/n`、区间、列表，以及 Jan–Dec / Sun–Sat 别名。

### 任务分级

| 级别 | 默认行为 |
|---|---|
| `safe` 安全 | 失败不通知、不重试 |
| `important` 重要 | 最终失败微信通知 + 5 分钟后自动重试 1 次 |

### 冒烟测试

上线前建议先冒烟测试一次。它走与到点触发完全相同的生产路径（同一沙箱 / 工作目录 / 命令），但不计入 `runCount`，也不触发重试和通知。

---

## 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `vaultPath` | `string` | `process.env.DSH_CWD ?? homedir()` | 任务工作目录 + 状态文件位置 |
| `notifyWechat` | `boolean` | `true` | 失败通知总开关 |
| `notifySenderPath` | `string?` | — | 显式指定微信发送器模块路径。不填则用内置候选列表。 |

---

## 架构

与其它 DSH 插件一样分两半：

- **`lib/index.js`** —— 宿主半区：cron 解析/匹配、任务状态、通过 `ctx.shell` 执行（显式 `workspace-write` 沙箱策略，见下）、`/cron-api/*` HTTP 路由、`scheduled_task` 模型工具。
- **`lib/client.js`** —— 浏览器半区：设置 →「定时任务」面板 + 插件页 tab。

### 失败通知发送器

插件会加载一个微信发送器（腾讯 iLink 实现里的 `sendMessageWeixin`），并从 `~/.openclaw/openclaw-weixin/accounts/` 读账号凭据。**两者都是可选的**：找不到发送器或账号时，通知静默降级为控制台日志，其余功能不受影响。

发送器候选路径，按优先级：

1. 配置里的 `notifySenderPath`（如果设了）。
2. **[dsh-wechat-bridge](https://github.com/AmeliaCai67/dsh-wechat-bridge)** —— 我们自己维护的桥。`~/.dsh/plugins/dsh-wechat-bridge/vendor/…`
3. web profile `node_modules` 下的同一路径。
4. `@ccchase/dsh-plugin-wechat` —— 更早的第三方桥。**已停更，且在 DSH 0.2.0 上根本起不来**（它注入的 `apiProxy` 服务已被移除）。只作兜底保留。

### 沙箱注意事项

全局插件没有会话，`sandboxPolicy.resolve()` 会落到部署默认的 `read-only`，导致定时命令写文件被拒。因此本插件显式解析 `workspace-write` 策略，并用合成 session 把工作区边界钉到 `vaultPath` —— **定时命令只能在 vault 内写文件。**

---

## 开发

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
npm pack --dry-run                                        # 看 tarball 内容
npm pack                                                  # 打包
```

发布时注意：`cordis.patch.yml` **必须留在 `files` 白名单里** —— 否则 `npm pack` 不会带上它，一条命令安装就会静默挂不上。

---

## 变更记录

### 1.3.0

- **修：在 DSH `0.2.0-rc.2` 及以后加载失败。** `schemastery` 3.18.x 移除了 `.optional()`，而配置 schema 里用了 `z.string().optional()`，import 时直接抛 `TypeError: z.string(...).optional is not a function`。schema 默认就是可选，所以这个调用直接删掉即可。详见 [DSH 版本兼容](#dsh-版本兼容)。
- **设置面板：任务列表改成树状折叠。** 每个任务只显示 名称 / 状态徽章 / cron / 下次执行 + 一行命令预览；点标题行展开完整命令、冒烟结果、上次执行与输出、以及操作按钮。新建表单收在「＋ 新建任务」后面，并加了「全部展开 / 全部折叠」。长输出不再刷屏。
- **命令块和输出块加了「复制」按钮**（右上角；`navigator.clipboard` 不可用时退回 `execCommand`）。
- 删除加了二次确认。

### 1.2.2

- **失败通知的候选路径链。** 原来只从 `@ccchase/dsh-plugin-wechat` 的 vendor 路径加载发送器 —— 那是个已停更、且在 DSH 0.2.0 上根本跑不起来的包。一旦卸载它，失败通知会**静默**退化成只写日志。现在优先用 `dsh-wechat-bridge`，旧包保留作兜底，并新增 `notifySenderPath` 可显式指定。
- 文档拆成英文（`README.md`）和中文（本文件）。
- 修掉过时措辞：插件页那个入口是 **tab**（`settings.plugins.tab`），不是卡片。

### 1.2.1

- **适配 DSH 0.2.0**（`1.2.0` 在它上面跑不起来）：
  - `ctx.shell.run()` → `ctx.shell.execute()` + `await exec.result()`（0.2.0 返回的是句柄）
  - peer 范围 `^0.1.0-rc.6` → `>=0.1.0-rc.6 <0.3.0`（否则被 0.2.0 的兼容闸门静默禁用）
  - 插件页插槽 `settings.plugin.item` → `settings.plugins.tab`
- 无功能变化。

### 1.2.0

- 初始发布：cron 调度、任务分级、失败通知、自动重试、冒烟测试。

---

## 许可证

MIT
