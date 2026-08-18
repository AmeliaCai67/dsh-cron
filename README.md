# dsh-cron-scheduler

A cron scheduler plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH). Schedule bash commands with standard 5-field cron expressions, with task tiers, failure notification, automatic retry, and smoke testing.

DSH 定时任务插件：用标准 5 段 cron 表达式调度 bash 命令，支持任务分级、失败通知、自动重试与冒烟测试。

## Features / 功能

- **Cron scheduling** — minute-level precision, 15s polling; state persisted at `<vaultPath>/memory/scheduled-tasks.json`
  - **定时调度** — 分钟级精度，15 秒轮询；状态持久化在 `<vaultPath>/memory/scheduled-tasks.json`
- **Task tiers** — `safe` (fail silently) / `important` (fail notification + auto retry by default)
  - **任务分级** — `safe` 安全类（失败静默）/ `important` 重要类（默认失败通知 + 自动重试）
- **Failure notification** — pushes to WeChat (or any channel via a pluggable sender) when an important task ultimately fails; silent log-only degradation when no sender is configured
  - **失败通知** — 重要任务最终失败时推送微信通知（发送器可插拔；未配置时静默降级为日志）
- **Automatic retry** — 1 retry 5 minutes after failure for important tasks; success on retry also notifies
  - **自动重试** — 重要任务失败后 5 分钟自动重试 1 次；重试成功也会通知
- **Smoke testing** — dry-run a task through the exact same production path (same `fireTask` / sandbox / working directory) before it goes live
  - **冒烟测试** — 上线前用与到点触发完全相同的生产路径（同一 fireTask / 沙箱 / 工作目录）试跑一次
- **Entry points** — Settings page management panel + Plugins page card + model tool `scheduled_task` + runtime skill `scheduled-tasks`
  - **入口** — 设置页管理面板 + Plugins 页卡片 + 模型工具 `scheduled_task` + 运行时 skill `scheduled-tasks`

## Installation / 安装

### 1. Mount the plugin / 挂载插件

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: cron-scheduler
      name: 'dsh-cron-scheduler'
      config:
        vaultPath: '/path/to/your/vault'   # task working directory + state file location
        notifyWechat: true                 # master switch for failure notification
```

> `vaultPath` defaults to `process.env.DSH_CWD ?? homedir()` when omitted — set it explicitly in production.
> 未配置时 `vaultPath` 默认取 `process.env.DSH_CWD ?? homedir()`——生产环境请显式配置。

Restart DSH for the change to take effect. / 改动需重启 DSH 生效。

### 2. Client bundle (web UI) / 前端面板（可选）

The settings panel requires the client half to be bundled into the web profile. The plugin ships `lib/client.js` for this purpose; wire it through your profile's bundle patch (`dsh.bundle.patch` / `dsh.profile.bundles`) as you would for any other plugin with a client.

设置页面板需要将客户端半区打进 web profile 的 bundle（通过 `dsh.bundle.patch` / `dsh.profile.bundles`，与其它带 client 的插件一致）。

## Usage / 用法

### From the model / 对话中使用

Tell the agent, or call the `scheduled_task` model tool directly:

直接说「创建一个每天 9 点的定时任务」，或调用 `scheduled_task` 模型工具：

```
scheduled_task op=add name=backup schedule="0 9 * * *" command="tar -czf backup.tar.gz ./data" risk=safe
scheduled_task op=list
scheduled_task op=smoke id=<task-id>
scheduled_task op=run_now id=<task-id>
scheduled_task op=toggle id=<task-id>
scheduled_task op=remove id=<task-id>
```

Cron expression format: 5 fields — `minute hour day-of-month month day-of-week` (supports `*`, `*/n`, ranges, lists, and Jan–Dec / Sun–Sat aliases).

cron 表达式为 5 段：`分 时 日 月 周`（支持 `*`、`*/n`、区间、列表，以及 Jan–Dec / Sun–Sat 别名）。

### Task tiers / 任务分级

| tier / 级别 | default behavior / 默认行为 |
|---|---|
| `safe` 安全 | no notification, no retry / 失败不通知不重试 |
| `important` 重要 | WeChat notification on final failure + 1 auto retry after 5 min / 最终失败微信通知 + 5 分钟后自动重试 1 次 |

### Smoke testing / 冒烟测试

Always smoke-test a task before relying on it: it runs the exact production path (same sandbox, working directory, and command) but never counts toward `runCount` and never triggers retry/notification.

上线前建议先冒烟测试：走与到点触发完全相同的生产路径（同一沙箱/工作目录/命令），但不计入 `runCount`，不触发重试/通知。

## Architecture / 架构

The plugin is split into two halves like other DSH plugins:

- `lib/index.js` — host half: cron parsing/matching, task state, execution via `ctx.shell` with an explicit `workspace-write` sandbox policy (required for global plugins that have no session — see below), the `/cron-api/*` HTTP routes, and the `scheduled_task` model tool.
- `lib/client.js` — browser half: the Settings → 定时任务 management panel and the Plugins page card.

`lib/index.js` 为宿主半区（调度、状态、执行、HTTP API、模型工具）；`lib/client.js` 为浏览器半区（设置页管理面板 + Plugins 页卡片）。

### Failure notification sender / 失败通知发送器

By default the plugin tries to load a WeChat sender from the `@ccchase/dsh-plugin-wechat` vendor path and account credentials under `~/.openclaw/openclaw-weixin/accounts/`. **Both are optional**: if no sender or account is found, notifications degrade silently to console logs and the plugin keeps working.

默认会尝试从 `@ccchase/dsh-plugin-wechat` 的 vendor 路径加载微信发送器，并读取 `~/.openclaw/openclaw-weixin/accounts/` 下的账号凭据。**两者均为可选依赖**：找不到时静默降级为日志，插件功能不受影响。

### Sandbox note / 沙箱注意事项

Global plugins run without a session, so `sandboxPolicy.resolve()` falls back to the deployment default (`read-only`), which rejects any write the scheduled command attempts. This plugin therefore resolves an explicit `workspace-write` policy with a synthetic session whose `cwd` is pinned to `vaultPath` — scheduled commands can only write inside the vault.

全局插件没有会话，`sandboxPolicy.resolve()` 会落到部署默认的 `read-only`，导致定时命令写文件被拒。因此本插件显式解析 `workspace-write` 策略，并用合成 session 把工作区边界钉到 `vaultPath`——定时命令只能在 vault 内写文件。

## Configuration / 配置项

| key / 键 | type / 类型 | default / 默认 | description / 说明 |
|---|---|---|---|
| `vaultPath` | `string` | `process.env.DSH_CWD ?? homedir()` | task working directory + state file location / 任务工作目录 + 状态文件位置 |
| `notifyWechat` | `boolean` | `true` | master switch for failure notification / 失败通知总开关 |

## Development / 开发

```bash
node --check lib/index.js && node --check lib/client.js   # syntax
npm pack --dry-run                                        # inspect tarball contents
npm pack                                                  # build tarball
```

## License / 许可证

MIT
