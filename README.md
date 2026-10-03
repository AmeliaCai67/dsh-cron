# dsh-cron-scheduler

**English** ｜ [中文](./README.zh_CN.md)

A cron scheduler plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH). Schedule bash commands with standard 5-field cron expressions — with task tiers, failure notification, automatic retry, and smoke testing.

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-cron
```

That's the whole install. It installs the package, registers it as a profile bundle (via the `dsh.bundle` metadata this package declares), and mounts it from the patch file shipped inside the package. **No profile files to edit.**

---

## Features

- **Cron scheduling** — minute-level precision, 15s polling. State persisted at `<vaultPath>/memory/scheduled-tasks.json`.
- **Task tiers** — `safe` (fails silently) / `important` (failure notification + one automatic retry).
- **Failure notification** — pushes to WeChat when an `important` task ultimately fails. Silent log-only degradation when no sender is configured.
- **Automatic retry** — one retry 5 minutes after failure; a successful retry also notifies.
- **Smoke testing** — dry-runs a task through the exact same production path (same sandbox, working directory, and command) before it goes live.
- **Four entry points** — Settings → 定时任务 panel, a Plugins page tab, the `scheduled_task` model tool, and the `scheduled-tasks` runtime skill.

---

## DSH version compatibility

**Requires DSH ≥ `0.1.0-rc.6`, including `0.2.0`.**

**`v1.2.0` does not run on DSH 0.2.0** — it predates three interface/shape changes. Fixed in `v1.2.1`:

| Change | 0.1.x | 0.2.0 | What this plugin does |
|---|---|---|---|
| **Peer compatibility gate** | didn't exist | **new** | Peer range widened from `^0.1.0-rc.6` to `>=0.1.0-rc.6 <0.3.0`.<br>⚠️ **Not widening it means silent disablement** — DSH prints one `skipping profile` warning and **still exits 0**, so it's easy to misdiagnose. |
| **shell service** | `ctx.shell.run(spec)` returned the result | `ctx.shell.execute(spec)` returns a **handle**; you must `await exec.result()` | Fixed. Without it every run fails with `ctx.shell.run is not a function`. |
| **Plugins page slot** | `settings.plugin.item` | renamed to `settings.plugins.tab` | Fixed. Without it the Plugins page tab simply doesn't render (**graceful degradation, no crash**). |

> The first row is the real reason this plugin appeared to "install but do nothing" on 0.2.0 — it never got loaded at all.
> To diagnose: run `dsh --profile web --help` and look for `skipping profile bundle` / `disabling profile plugin row`.

**`v1.2.2` also fails on DSH `0.2.0-rc.2` and later** — a fourth breakage, fixed in `v1.3.0`:

| Change | Before | Now | What this plugin does |
|---|---|---|---|
| **schemastery API** | `z.string().optional()` | **`.optional()` removed** — schemas are optional by default; write `.required()` to opt in | Fixed. Without it the plugin fails to import: `TypeError: z.string(...).optional is not a function`. ⚠️ The peer range (`^3.18.1`) does **not** catch this, so it installs fine and only breaks on your **next DSH restart**. |

> That last point is worth remembering generally: **a plugin can be broken for days without any symptom**,
> because a *running* DSH process keeps using the module graph it loaded at startup.
> Nothing shows up in the log until you restart.

---

## Installation

### One command (recommended)

```bash
dsh plugin --profile web add github:AmeliaCai67/dsh-cron
```

Three things happen:

1. The package is added to the profile's dependencies.
2. Because the package declares **`dsh.bundle`**, `dsh-cron-scheduler` is appended to `dsh.profile.bundles`.
3. On profile boot, DSH merges the `cordis.patch.yml` **shipped inside the package** — equivalent to the manual `insert` shown below.

> ⚠️ **If you previously added the manual `insert` line yourself, remove it before switching.**
> Otherwise the plugin mounts twice: two scheduler instances sharing one task file, firing every task twice.

> 📦 **Why GitHub and not an npm name?** The npm name `dsh-cron-scheduler` is already taken by
> [a different implementation](https://www.npmjs.com/package/dsh-cron-scheduler), so this repo installs from GitHub.

`vaultPath` defaults to `process.env.DSH_CWD ?? homedir()`. **Change it in Settings → 定时任务.**
(The in-package patch deliberately hardcodes no path — otherwise other users would end up pointing at a directory that doesn't exist.)

### Manual mount

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: cron-scheduler
      name: 'dsh-cron-scheduler'
      config:
        vaultPath: '/path/to/your/vault'   # task working directory + state file location
        notifyWechat: true                 # master switch for failure notification
```

Restart DSH for the change to take effect. (Note: editing a plugin's **source** requires a restart — `dsh-hmr` only watches configuration layers. Config-only changes hot-reload.)

### Web UI panel

`lib/client.js` provides the settings panel. It is pulled into the web profile automatically by the `dsh.bundle` declaration above — **nothing extra to configure.**

---

## Usage

### From the model

Just ask, or call the `scheduled_task` tool directly:

```
scheduled_task op=add name=backup schedule="0 9 * * *" command="tar -czf backup.tar.gz ./data" risk=safe
scheduled_task op=list
scheduled_task op=smoke    id=<task-id>
scheduled_task op=run_now  id=<task-id>
scheduled_task op=toggle   id=<task-id>
scheduled_task op=remove   id=<task-id>
```

Cron format is 5 fields: `minute hour day-of-month month day-of-week` — supports `*`, `*/n`, ranges, lists, and Jan–Dec / Sun–Sat aliases.

### Task tiers

| Tier | Default behavior |
|---|---|
| `safe` | No notification, no retry |
| `important` | WeChat notification on final failure + one automatic retry after 5 minutes |

### Smoke testing

Always smoke-test a task before relying on it. It runs the exact production path (same sandbox, working directory, and command) but never counts toward `runCount` and never triggers a retry or notification.

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `vaultPath` | `string` | `process.env.DSH_CWD ?? homedir()` | Task working directory + state file location |
| `notifyWechat` | `boolean` | `true` | Master switch for failure notification |
| `notifySenderPath` | `string?` | — | Explicit path to the WeChat sender module. Omit to use the built-in candidate list. |

---

## Architecture

Split into two halves, like other DSH plugins:

- **`lib/index.js`** — host half: cron parsing/matching, task state, execution via `ctx.shell` with an explicit `workspace-write` sandbox policy (see below), the `/cron-api/*` HTTP routes, and the `scheduled_task` model tool.
- **`lib/client.js`** — browser half: the Settings → 定时任务 panel and the Plugins page tab.

### Failure notification sender

The plugin loads a WeChat sender (`sendMessageWeixin` from the Tencent iLink implementation) and reads account credentials from `~/.openclaw/openclaw-weixin/accounts/`. **Both are optional**: with no sender or no account, notifications degrade silently to console logs and everything else keeps working.

Sender candidates, in priority order:

1. `notifySenderPath` from config, if set.
2. **[dsh-wechat-bridge](https://github.com/AmeliaCai67/dsh-wechat-bridge)** — our own, maintained bridge. `~/.dsh/plugins/dsh-wechat-bridge/vendor/…`
3. The same path under the web profile's `node_modules`.
4. `@ccchase/dsh-plugin-wechat` — the older third-party bridge. **Unmaintained, and it cannot start on DSH 0.2.0** (it injects the removed `apiProxy` service). Kept only as a fallback.

### Sandbox note

Global plugins run without a session, so `sandboxPolicy.resolve()` falls back to the deployment default (`read-only`), which rejects any write a scheduled command attempts. This plugin therefore resolves an explicit `workspace-write` policy with a synthetic session whose `cwd` is pinned to `vaultPath` — **scheduled commands can only write inside the vault.**

---

## Development

```bash
node --check lib/index.js && node --check lib/client.js   # syntax
npm pack --dry-run                                        # inspect tarball contents
npm pack                                                  # build tarball
```

When publishing, remember that `cordis.patch.yml` **must stay in the `files` whitelist** — without it `npm pack` omits the file and the one-command install silently fails to mount.

---

## Changelog

### 1.3.0

- **Fixed: the plugin does not load on DSH `0.2.0-rc.2` and later.** `schemastery` 3.18.x removed `.optional()`; the config schema used `z.string().optional()`, which threw at import time (`TypeError: z.string(...).optional is not a function`). Schemas are optional by default, so the call is simply gone. See [DSH version compatibility](#dsh-version-compatibility).
- **Settings panel: the task list is now collapsible (tree-style).** Each task shows name / status badges / cron / next run plus a one-line command preview; click the title row to expand the full command, smoke result, last run + output, and the action buttons. The create form is collapsed behind「＋ 新建任务」, and there are「全部展开 / 全部折叠」buttons. Long output no longer floods the page.
- **Copy buttons** on the command block and the last-run output block (top-right corner; falls back to `execCommand` when `navigator.clipboard` is unavailable).
- Delete now asks for confirmation.

### 1.2.2

- **Notification sender fallback chain.** It used to load the sender only from `@ccchase/dsh-plugin-wechat`'s vendor path — an unmaintained package that cannot run on DSH 0.2.0. Uninstalling it would silently turn failure notifications into log-only output. `dsh-wechat-bridge` is now tried first, the old package remains as a fallback, and `notifySenderPath` lets you pin a path explicitly.
- Documentation split into English (this file) and [Chinese](./README.zh_CN.md).
- Fixed stale wording: the Plugins page entry point is a **tab** (`settings.plugins.tab`), not a card.

### 1.2.1

- **DSH 0.2.0 compatibility** (`1.2.0` does not run on it):
  - `ctx.shell.run()` → `ctx.shell.execute()` + `await exec.result()` (0.2.0 returns a handle)
  - Peer range `^0.1.0-rc.6` → `>=0.1.0-rc.6 <0.3.0` (otherwise the 0.2.0 compatibility gate disables it silently)
  - Plugins page slot `settings.plugin.item` → `settings.plugins.tab`
- No functional changes.

### 1.2.0

- Initial release: cron scheduling, task tiers, failure notification, automatic retry, smoke testing.

---

## License

MIT
