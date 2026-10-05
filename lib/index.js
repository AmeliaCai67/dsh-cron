// dsh-cron-scheduler — 全局定时任务插件 (host half)。
// 组合行: { id: cron-scheduler, name: 'dsh-cron-scheduler', config: { vaultPath } }
// v1.2.0 (2026-08-18):
//   - 任务分级 risk: safe(安全类) / important(重要类)
//   - 失败微信通知 notify（重要类默认开启；复用 wechat-bridge 的账号与发送实现）
//   - 自动重试 retry（重要类默认 1 次 / 5 分钟后）
//   - 冒烟测试 smoke（走与到点触发完全相同的生产路径，测试环境 = 生产环境）
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "cron-scheduler";
const inject = ["webServer", "timer", "shell", "sandboxPolicy", "tools", "skills"];

const Config = z.object({
  // 默认用环境变量 DSH_CWD，否则落到用户主目录；生产使用请在挂载时显式配置 vaultPath。
  vaultPath: z.string().default(process.env.DSH_CWD ?? homedir()),
  /** 失败/恢复时是否尝试通过微信桥账号推送通知（默认开启；找不到账号时静默降级为日志） */
  notifyWechat: z.boolean().default(true),
  /**
   * 显式指定微信发送器模块路径（可选）。不填则按内置候选列表自动找。
   * 见 loadWechatSender() 里的 candidates。
   */
  notifySenderPath: z.string(),
});

/* ---------- tiny cron lib ---------- */
const DOW_ALIAS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, 7: 0 };
const MON_ALIAS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function resolveToken(tok, alias) {
  tok = String(tok).trim().toLowerCase();
  if (alias && Object.prototype.hasOwnProperty.call(alias, tok)) return alias[tok];
  if (!/^\d+$/.test(tok)) return null;
  const n = parseInt(tok, 10);
  return Number.isFinite(n) ? n : null;
}

function parseField(field, min, max, alias) {
  const parts = String(field).trim().toLowerCase().split(",");
  const values = new Set();
  for (const raw of parts) {
    if (raw === "") return null;
    let range = raw;
    let step = 1;
    const slash = raw.indexOf("/");
    if (slash !== -1) {
      range = raw.slice(0, slash);
      step = parseInt(raw.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step < 1) return null;
    }
    let start, end;
    if (range === "*") { start = min; end = max; }
    else {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        start = resolveToken(range.slice(0, dash), alias);
        end = resolveToken(range.slice(dash + 1), alias);
      } else {
        start = resolveToken(range, alias);
        end = start;
      }
      if (start === null || end === null) return null;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

function parseCron(schedule) {
  if (typeof schedule !== "string") return null;
  const parts = schedule.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59, null);
  const hour = parseField(parts[1], 0, 23, null);
  const dom = parseField(parts[2], 1, 31, null);
  const month = parseField(parts[3], 1, 12, MON_ALIAS);
  const dow = parseField(parts[4], 0, 7, DOW_ALIAS);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

function cronMatches(cron, date) {
  if (!cron) return false;
  const m = date.getMinutes(), h = date.getHours(), d = date.getDate();
  const mo = date.getMonth() + 1, w = date.getDay();
  if (!cron.minute.has(m) || !cron.hour.has(h) || !cron.month.has(mo)) return false;
  const domMatch = cron.dom.has(d);
  const dowMatch = cron.dow.has(w);
  const domRestricted = cron.dom.size < 31;
  const dowRestricted = cron.dow.size < 7;
  if (domRestricted && dowRestricted) { if (!domMatch && !dowMatch) return false; }
  else if (domRestricted) { if (!domMatch) return false; }
  else if (dowRestricted) { if (!dowMatch) return false; }
  return true;
}

function nextOccurrence(cron, afterTs) {
  if (!cron) return null;
  const start = new Date(afterTs + 60000);
  start.setSeconds(0, 0);
  const limit = start.getTime() + 366 * 24 * 60 * 60000;
  for (let t = start.getTime(); t <= limit; t += 60000) {
    if (cronMatches(cron, new Date(t))) return t;
  }
  return null;
}

function minuteKey(date) {
  return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate() + " " + date.getHours() + ":" + date.getMinutes();
}

/* ---------- plugin ---------- */
function apply(ctx, config) {
  const vaultPath = String(config.vaultPath).replace(/\/+$/, "");
  const statePath = join(vaultPath, "memory", "scheduled-tasks.json");
  let tasks = [];
  const now = () => Date.now();

  /* ---------- 微信通知（复用 wechat-bridge 的账号凭据与 vendor 发送实现） ---------- */
  let wechatSender = null;
  let wechatSenderTried = false;

  async function loadWechatSender() {
    if (wechatSenderTried) return wechatSender;
    wechatSenderTried = true;
    // 候选顺序 = 优先级。都指向同一个腾讯发送实现（sendMessageWeixin），只是所在位置不同。
    // ① 我们自己的桥（dsh-wechat-bridge）—— 2026-10-02 起首选。
    // ② 旧的第三方桥 @ccchase/dsh-plugin-wechat —— 作者已停更，且它用 apiProxy 在 DSH 0.2.0 上
    //    根本起不来。放在这里只作兜底：**一旦卸载它，这个候选就消失，通知会静默降级为日志**，
    //    所以不能只依赖它（这正是加 ① 的原因）。
    const candidates = [
      ...(typeof config.notifySenderPath === "string" && config.notifySenderPath !== ""
        ? [config.notifySenderPath]
        : []),
      join(homedir(), ".dsh", "plugins", "dsh-wechat-bridge", "vendor", "weixin-dist", "src", "messaging", "send.js"),
      join(homedir(), ".dsh", "profiles", "web", "node_modules", "dsh-wechat-bridge", "vendor", "weixin-dist", "src", "messaging", "send.js"),
      join(homedir(), ".dsh", "profiles", "web", "node_modules", "@ccchase", "dsh-plugin-wechat", "vendor", "weixin", "dist", "src", "messaging", "send.js"),
    ].filter((p) => typeof p === "string" && p !== "");
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        const mod = await import(pathToFileURL(p).href);
        if (typeof mod.sendMessageWeixin === "function") { wechatSender = mod.sendMessageWeixin; break; }
      } catch (err) {
        console.error("[cron] load wechat sender failed:", err);
      }
    }
    if (!wechatSender) console.log("[cron] 找不到可用的微信发送器（试过 " + candidates.length + " 个路径）；失败通知降级为仅日志");
    return wechatSender;
  }

  async function notifyWechat(text) {
    if (config.notifyWechat === false) return false;
    try {
      const sendFn = await loadWechatSender();
      if (!sendFn) return false;
      const accDir = join(homedir(), ".openclaw", "openclaw-weixin", "accounts");
      const accFiles = readdirSync(accDir).filter((f) => f.endsWith(".json") && !f.includes("context-tokens") && !f.includes("sync"));
      if (accFiles.length === 0) { console.error("[cron] no wechat account found"); return false; }
      const accPath = join(accDir, accFiles[0]);
      const acc = JSON.parse(readFileSync(accPath, "utf8"));
      const to = typeof acc.userId === "string" && acc.userId ? acc.userId : null;
      if (!to) { console.error("[cron] wechat account missing userId"); return false; }
      let contextToken;
      try {
        const ctPath = join(accDir, accFiles[0].replace(/\.json$/, ".context-tokens.json"));
        const ct = JSON.parse(readFileSync(ctPath, "utf8"));
        contextToken = ct[to] || undefined;
      } catch { /* 无 context token 时降级发送 */ }
      await sendFn({ to, text, opts: { contextToken, baseUrl: acc.baseUrl, token: acc.token, timeoutMs: 60_000 } });
      console.log("[cron] wechat notified: " + String(text).slice(0, 60).replace(/\n/g, " "));
      return true;
    } catch (err) {
      console.error("[cron] wechat notify failed:", err);
      return false;
    }
  }

  function describeFailure(record) {
    const bits = [];
    if (record.timedOut) bits.push("超时");
    if (record.denied) bits.push("被沙箱拒绝");
    if (record.exitCode !== null && record.exitCode !== undefined) bits.push("exit " + record.exitCode);
    return bits.length ? bits.join(" · ") : "执行失败";
  }

  /* ---------- state ---------- */
  function normalizeTask(t) {
    if (!t || typeof t !== "object") return null;
    if (typeof t.id !== "string" || !t.id) return null;
    if (typeof t.schedule !== "string" || !parseCron(t.schedule)) return null;
    if (typeof t.command !== "string" || !t.command.trim()) return null;
    const risk = t.risk === "important" ? "important" : "safe";
    const retry = (t.retry && typeof t.retry === "object") ? t.retry : {};
    return {
      id: t.id,
      name: typeof t.name === "string" && t.name.trim() ? t.name : "定时任务",
      schedule: t.schedule.trim(),
      command: t.command,
      enabled: t.enabled !== false,
      risk: risk,
      notify: typeof t.notify === "boolean" ? t.notify : risk === "important",
      retry: {
        enabled: typeof retry.enabled === "boolean" ? retry.enabled : risk === "important",
        count: typeof retry.count === "number" && retry.count >= 0 ? Math.min(5, Math.floor(retry.count)) : 1,
        delayMin: typeof retry.delayMin === "number" && retry.delayMin >= 1 ? Math.floor(retry.delayMin) : 5,
      },
      retryAttempts: typeof t.retryAttempts === "number" ? t.retryAttempts : 0,
      retryDueAt: typeof t.retryDueAt === "number" ? t.retryDueAt : null,
      notifiedKey: typeof t.notifiedKey === "string" ? t.notifiedKey : null,
      smoke: (t.smoke && typeof t.smoke === "object") ? {
        time: typeof t.smoke.time === "number" ? t.smoke.time : 0,
        ok: !!t.smoke.ok,
        exitCode: (t.smoke.exitCode === null || typeof t.smoke.exitCode === "number") ? t.smoke.exitCode : null,
        timedOut: !!t.smoke.timedOut,
        denied: !!t.smoke.denied,
        output: typeof t.smoke.output === "string" ? t.smoke.output.slice(-2000) : "",
      } : null,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : now(),
      lastFiredKey: typeof t.lastFiredKey === "string" ? t.lastFiredKey : null,
      runCount: typeof t.runCount === "number" ? t.runCount : 0,
      lastRun: (t.lastRun && typeof t.lastRun === "object") ? {
        time: typeof t.lastRun.time === "number" ? t.lastRun.time : 0,
        ok: !!t.lastRun.ok,
        exitCode: (t.lastRun.exitCode === null || typeof t.lastRun.exitCode === "number") ? t.lastRun.exitCode : null,
        timedOut: !!t.lastRun.timedOut,
        denied: !!t.lastRun.denied,
        output: typeof t.lastRun.output === "string" ? t.lastRun.output.slice(-2000) : "",
      } : null,
    };
  }

  function loadState() {
    try {
      if (existsSync(statePath)) {
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        if (Array.isArray(parsed)) tasks = parsed.map(normalizeTask).filter(Boolean);
      }
    } catch (err) {
      console.error("[cron] state load failed:", err);
    }
    console.log("[cron] loaded " + tasks.length + " task(s) from " + statePath);
  }
  loadState();

  function persist() {
    try {
      mkdirSync(join(vaultPath, "memory"), { recursive: true });
      writeFileSync(statePath, JSON.stringify(tasks, null, 2) + "\n");
    } catch (err) {
      console.error("[cron] persist failed:", err);
    }
  }

  /* ---------- execution ---------- */
  async function fireTask(task, source) {
    const started = now();
    let record;
    try {
      const spec = ctx.shell.resolve({
        command: task.command,
        workdir: vaultPath,
        timeoutMs: 300000,
        sandboxPolicy: ctx.sandboxPolicy.resolve({
          // 全局插件没有会话：resolve() 会落到部署默认 read-only（fail-safe），
          // 导致定时命令写文件被拒（2026-08-16 04:00 验收失败根因）。
          // 显式给 workspace-write，并用合成 session 把工作区边界钉到 vaultPath。
          mode: "workspace-write",
          session: { header: { cwd: vaultPath }, events: [] },
        }),
      });
      // 0.2.0: execute() 返回句柄（ShellExecution extends ShellProcess），
      // 要再 await .result() 才拿到 ShellRunResult（0.1.x 的 run() 直接返回结果）。
      const exec = await ctx.shell.execute(spec);
      const result = await exec.result();
      const stdout = result.stdout && typeof result.stdout.text === "string" ? result.stdout.text : "";
      const stderr = result.stderr && typeof result.stderr.text === "string" ? result.stderr.text : "";
      const combined = (stderr ? "STDERR:\n" + stderr + "\n" : "") + stdout;
      record = {
        time: started,
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
        exitCode: result.exitCode,
        timedOut: !!result.timedOut,
        denied: !!(result.sandbox && result.sandbox.denied),
        output: combined.slice(-2000),
        source: source,
      };
    } catch (err) {
      record = { time: started, ok: false, exitCode: null, timedOut: false, denied: false, output: "执行失败: " + String((err && err.message) || err).slice(0, 1900), source: source };
    }

    if (source === "smoke") {
      // 冒烟：与到点触发走完全相同的生产路径（同一个 fireTask/沙箱/工作目录），但不计入 runCount、不触发重试/通知
      task.smoke = record;
      console.log('[cron] smoke "' + task.name + '" ok=' + record.ok + " exit=" + record.exitCode);
      persist();
      return record;
    }

    task.lastRun = record;
    task.runCount = (task.runCount || 0) + 1;
    console.log('[cron] fired "' + task.name + '" ok=' + record.ok + " exit=" + record.exitCode + " src=" + source);
    handleOutcome(task, record, source);
    persist();
    return record;
  }

  function handleOutcome(task, record, source) {
    if (record.ok) {
      const recovered = source === "retry";
      task.retryAttempts = 0;
      task.retryDueAt = null;
      task.notifiedKey = null;
      if (recovered && task.notify) {
        notifyWechat("✅ 定时任务恢复\n「" + task.name + "」上次执行失败后，自动重试已成功 (exit " + record.exitCode + ")。");
      }
      return;
    }
    // 失败分支
    if (task.retry.enabled && source !== "retry" && task.retryAttempts < task.retry.count) {
      task.retryAttempts += 1;
      task.retryDueAt = now() + task.retry.delayMin * 60000;
      console.log('[cron] task "' + task.name + '" failed; retry #' + task.retryAttempts + " at " + new Date(task.retryDueAt).toISOString());
      return;
    }
    if (source === "retry" && task.retry.enabled && task.retryAttempts < task.retry.count) {
      task.retryAttempts += 1;
      task.retryDueAt = now() + task.retry.delayMin * 60000;
      console.log('[cron] task "' + task.name + '" retry failed again; scheduling retry #' + task.retryAttempts);
      return;
    }
    // 重试已耗尽（或未开启）→ 最终失败：通知
    if (task.notify) {
      const key = task.id + ":" + record.time;
      if (task.notifiedKey !== key) {
        task.notifiedKey = key;
        const lines = [
          "⏰ 定时任务告警",
          "「" + task.name + "」执行失败",
          "时间: " + new Date(record.time).toLocaleString("zh-CN", { hour12: false }),
          "原因: " + describeFailure(record),
        ];
        if (task.retryAttempts > 0) lines.push("已自动重试 " + task.retryAttempts + " 次，仍未成功");
        lines.push("请在 设置 → 定时任务 页面查看输出。");
        notifyWechat(lines.join("\n"));
      }
    }
  }

  let firing = false;
  async function tick() {
    if (firing) return;
    firing = true;
    try {
      const date = new Date();
      const key = minuteKey(date);
      for (const task of tasks) {
        if (!task.enabled) continue;
        // 1) 重试到点优先
        if (task.retryDueAt && task.retryDueAt <= date.getTime()) {
          task.retryDueAt = null;
          await fireTask(task, "retry");
          continue;
        }
        // 2) 正常 cron 触发
        if (task.lastFiredKey === key) continue;
        const cron = parseCron(task.schedule);
        if (!cron || !cronMatches(cron, date)) continue;
        task.lastFiredKey = key;
        await fireTask(task, "tick");
      }
    } catch (err) {
      console.error("[cron] tick failed:", err);
    } finally {
      firing = false;
    }
  }
  const stopTick = ctx.timer.interval(() => { tick(); }, 15000);
  const firstTick = ctx.timer.timeout(() => { tick(); }, 2000);
  ctx.effect(() => () => { stopTick(); firstTick(); });

  /* ---------- views & mutations ---------- */
  function publicView(task, at) {
    const cron = parseCron(task.schedule);
    const next = cron && task.enabled ? nextOccurrence(cron, at || now()) : null;
    return {
      id: task.id,
      name: task.name,
      schedule: task.schedule,
      command: task.command,
      enabled: !!task.enabled,
      risk: task.risk,
      notify: !!task.notify,
      retry: { enabled: !!task.retry.enabled, count: task.retry.count, delayMin: task.retry.delayMin },
      retryAttempts: task.retryAttempts,
      retryDueAt: task.retryDueAt,
      smoke: task.smoke,
      createdAt: task.createdAt,
      runCount: task.runCount,
      lastRun: task.lastRun,
      nextRun: next,
    };
  }

  function listView() {
    const at = now();
    return { ok: true, tasks: tasks.map((t) => publicView(t, at)) };
  }

  async function addTask(input) {
    const name_ = (typeof input.name === "string" && input.name.trim()) ? input.name.trim() : "定时任务";
    const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!parseCron(schedule)) return { ok: false, error: 'cron 表达式无效: "' + schedule + '"。请使用 5 段格式: 分 时 日 月 周, 如 "0 9 * * *"' };
    if (!command) return { ok: false, error: "命令不能为空" };
    const risk = input.risk === "important" ? "important" : "safe";
    const task = {
      id: "t" + now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: name_,
      schedule: schedule,
      command: command,
      enabled: input.enabled !== false,
      risk: risk,
      notify: typeof input.notify === "boolean" ? input.notify : risk === "important",
      retry: {
        enabled: typeof input.retry === "boolean" ? input.retry : risk === "important",
        count: 1,
        delayMin: 5,
      },
      retryAttempts: 0,
      retryDueAt: null,
      notifiedKey: null,
      smoke: null,
      createdAt: now(),
      lastFiredKey: null,
      runCount: 0,
      lastRun: null,
    };
    tasks.push(task);
    persist();
    console.log('[cron] added task "' + name_ + '" [' + schedule + "] risk=" + risk + " notify=" + task.notify + " retry=" + task.retry.enabled);
    return { ok: true, task: publicView(task, now()) };
  }

  async function removeTask(id) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return { ok: false, error: "未找到任务: " + id };
    const removed = tasks.splice(idx, 1)[0];
    persist();
    console.log('[cron] removed task "' + removed.name + '"');
    return { ok: true, id: removed.id };
  }

  async function toggleTask(input) {
    const task = tasks.find((t) => t.id === input.id);
    if (!task) return { ok: false, error: "未找到任务: " + input.id };
    task.enabled = typeof input.enabled === "boolean" ? input.enabled : !task.enabled;
    persist();
    console.log('[cron] task "' + task.name + '" ' + (task.enabled ? "enabled" : "disabled"));
    return { ok: true, task: publicView(task, now()) };
  }

  async function runTaskNow(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { ok: false, error: "未找到任务: " + id };
    const record = await fireTask(task, "run");
    return { ok: record.ok, task: publicView(task, now()), lastRun: record };
  }

  async function smokeTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { ok: false, error: "未找到任务: " + id };
    const record = await fireTask(task, "smoke");
    return { ok: true, task: publicView(task, now()), smoke: record };
  }

  function preview(input) {
    const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
    const cron = parseCron(schedule);
    if (!cron) return { ok: false, error: 'cron 表达式无效: "' + schedule + '"' };
    return { ok: true, next: nextOccurrence(cron, now()), schedule: schedule };
  }

  /* ---------- HTTP API (client 半区同源调用) ---------- */
  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  async function api(req, res) {
    try {
      const u = new URL(req.url, "http://localhost");
      const p = u.pathname;
      if (req.method === "GET" && p === "/cron-api/list") return json(res, 200, listView());
      if (req.method === "GET" && p === "/cron-api/debug") return json(res, 200, { ok: true, taskCount: tasks.length, statePath: statePath, vaultPath: vaultPath });
      if (req.method === "GET" && p === "/cron-api/preview") return json(res, 200, preview({ schedule: u.searchParams.get("schedule") || "" }));
      if (req.method === "POST" && p === "/cron-api/add") return json(res, 200, await addTask(await readBody(req)));
      if (req.method === "POST" && p === "/cron-api/remove") { const b = await readBody(req); return json(res, 200, await removeTask(b.id)); }
      if (req.method === "POST" && p === "/cron-api/toggle") { const b = await readBody(req); return json(res, 200, await toggleTask(b)); }
      if (req.method === "POST" && p === "/cron-api/run") { const b = await readBody(req); return json(res, 200, await runTaskNow(b.id)); }
      if (req.method === "POST" && p === "/cron-api/smoke") { const b = await readBody(req); return json(res, 200, await smokeTask(b.id)); }
      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      json(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/cron-api", handler: api }), "cron: api route");

  /* ---------- model tool ---------- */
  const tool = defineTool({
    name: "scheduled_task",
    description: '管理定时任务 (cron)。op=list 列出全部任务; op=add 创建任务 (需 name/schedule/command, 可选 risk/notify/retry/enabled); op=remove 按 id 删除; op=toggle 启用或停用; op=run_now 立即执行一次; op=smoke 冒烟测试 (走与到点触发完全相同的生产路径)。任务分两级: risk=safe 安全类 (失败不通知不重试) / risk=important 重要类 (默认失败微信通知 + 5 分钟后自动重试 1 次)。schedule 为 5 段 cron 表达式 (分 时 日 月 周), 例: "0 9 * * *" 每天 09:00, "*/30 * * * *" 每 30 分钟, "0 9 * * 1-5" 工作日 09:00。当用户希望设置定时或周期执行的任务时使用。',
    parameters: {
      op: { type: "string", enum: ["list", "add", "remove", "toggle", "run_now", "smoke"], required: true, description: "操作类型" },
      name: { type: "string", description: "任务名称, 仅 op=add 需要" },
      schedule: { type: "string", description: "5 段 cron 表达式 (分 时 日 月 周), 仅 op=add 需要" },
      command: { type: "string", description: "到点执行的 bash 命令, 仅 op=add 需要" },
      risk: { type: "string", enum: ["safe", "important"], description: "任务级别: safe 安全类(默认) / important 重要类(失败会微信通知并自动重试), 仅 op=add 可选" },
      notify: { type: "boolean", description: "失败时是否微信通知, 默认: 重要类 true / 安全类 false, 仅 op=add 可选" },
      retry: { type: "boolean", description: "失败后是否自动重试 1 次(5 分钟后), 默认: 重要类 true / 安全类 false, 仅 op=add 可选" },
      enabled: { type: "boolean", description: "创建后是否启用, 默认 true, 仅 op=add 可选" },
      id: { type: "string", description: "任务 id, op=remove/toggle/run_now/smoke 需要" },
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => {
        let text = "";
        try {
          if (!value || typeof value !== "object") { text = JSON.stringify(value); return [{ type: "text", text }]; }
          if (value.ok === false) { text = value.error || "操作失败"; return [{ type: "text", text }]; }
          if (Array.isArray(value.tasks)) {
            if (value.tasks.length === 0) text = "当前没有定时任务。";
            else text = "定时任务 (共 " + value.tasks.length + " 个):\n" + value.tasks.map((t) => {
              const next = t.nextRun ? new Date(t.nextRun).toLocaleString("zh-CN", { hour12: false }) : "—";
              const level = t.risk === "important" ? "重要(失败通知+重试)" : "安全";
              return "- [" + (t.enabled ? "启用" : "停用") + "] " + t.name + " | " + level + " | cron: " + t.schedule + " | 下次: " + next + " | 命令: " + t.command + " | id: " + t.id;
            }).join("\n");
          } else if (value.smoke) {
            const s = value.smoke;
            text = (s.ok ? "冒烟通过" : "冒烟失败") + "「" + (value.task && value.task.name) + "」\n  exit=" + s.exitCode + (s.denied ? " · 被沙箱拒绝" : "") + (s.timedOut ? " · 超时" : "") + "\n  输出: " + String(s.output || "").slice(0, 500);
          } else if (value.task) {
            const t = value.task;
            const next = t.nextRun ? new Date(t.nextRun).toLocaleString("zh-CN", { hour12: false }) : "—";
            const level = t.risk === "important" ? "重要" : "安全";
            text = t.name + " (id: " + t.id + ")\n  cron: " + t.schedule + " | " + level + " | 启用: " + (t.enabled ? "是" : "否") + " | 下次执行: " + next + "\n  命令: " + t.command + "\n  已执行 " + t.runCount + " 次";
            if (t.smoke) text += "\n  冒烟: " + (t.smoke.ok ? "通过" : "失败 (exit=" + t.smoke.exitCode + ")") + " @ " + new Date(t.smoke.time).toLocaleString("zh-CN", { hour12: false });
            else text += "\n  冒烟: 未测试 (建议 op=smoke 上线前先测一次)";
            if (t.lastRun) {
              const lr = t.lastRun;
              text += "\n  上次执行: " + new Date(lr.time).toLocaleString("zh-CN", { hour12: false }) + " → " + (lr.ok ? "成功" : "失败") + " (exit=" + lr.exitCode + ")";
              if (lr.output) text += "\n  输出: " + String(lr.output).slice(0, 500);
            }
          } else { text = "完成"; }
        } catch (err) {
          text = "操作完成: " + JSON.stringify(value);
        }
        return [{ type: "text", text: String(text).slice(0, 6000) }];
      },
    },
    execute: async (args) => {
      switch (args.op) {
        case "list": return listView();
        case "add": return addTask({ name: args.name, schedule: args.schedule, command: args.command, risk: args.risk, notify: args.notify, retry: args.retry, enabled: args.enabled });
        case "remove": return removeTask(args.id);
        case "toggle": return toggleTask({ id: args.id, enabled: args.enabled });
        case "run_now": return runTaskNow(args.id);
        case "smoke": return smokeTask(args.id);
        default: return { ok: false, error: "未知操作: " + args.op };
      }
    },
  });
  ctx.effect(() => ctx.tools.register(tool), "cron: tool");

  /* ---------- runtime skill ---------- */
  ctx.effect(() => ctx.skills.register({
    name: "scheduled-tasks",
    description: "创建与管理定时任务 (cron)：查看、创建、删除、启停、立即执行、冒烟测试；支持任务分级（安全/重要）、失败微信通知与自动重试。",
    whenToUse: '当用户希望设置定时/周期执行的任务 (如"每天 9 点执行某命令"、"每小时跑一次") 或管理现有定时任务时使用。',
    // `ctx.skills.register()` 只给 `provider` 兜底，不给 `source` 兜底；而读取时
    // `Skills.get()` 会拿 provider-definition 校验器校验这条记录，要求 `source`
    // 是字符串，否则抛 `loaded skill "..." source must be a string`。
    // 列表阶段不校验 runtime 条目，所以症状是「skill 页能列出、点开就报错」。
    // 这里必须显式给 `source`，不要当成冗余字段删掉。官方 skill 传的是 "bundled"。
    source: "dsh-cron-scheduler",
    content: [
      "# 定时任务 (scheduled-tasks)",
      "",
      "本 skill 指导如何使用 `scheduled_task` 工具管理定时任务。任务到点后, 插件会在宿主机执行任务的 bash 命令并把结果记录在任务卡片上。",
      "",
      "## 触发场景",
      '- 用户说"创建一个定时任务 / 计划任务 / cron"',
      '- 用户说"每天/每小时/每周 X 点执行 Y / 提醒我 Y"',
      "- 用户要查看、删除、暂停、立即执行或测试已有定时任务",
      "",
      "## 工具用法",
      '1. 先 `op: "list"` 查看现有任务, 避免重复创建。',
      '2. 创建: `op: "add"`, 传入 `name`, `schedule`, `command`, 可选 `enabled` / `risk` / `notify` / `retry`。',
      '3. 删除: `op: "remove"` + `id`; 启停: `op: "toggle"` + `id`; 立即执行: `op: "run_now"` + `id`。',
      '4. **上线前冒烟**: `op: "smoke"` + `id` —— 与到点触发走完全相同的生产路径, 通过后再放心等它到点跑。',
      "",
      "## 任务分级 (risk)",
      "- `safe` 安全类 (默认): 失败静默记录, 不通知不重试。适合无副作用的本地整理类任务 (同步笔记/备份等)。",
      "- `important` 重要类: 失败会**微信通知**并**自动重试 1 次 (5 分钟后)**; 重试成功也会通知。适合发推文/发邮件等不可逆或有截止时间的任务。",
      "- 经验法则: 任务有外部副作用 (发消息/发邮件/转账) 或失败代价高 → `important`; 否则 `safe`。",
      "",
      "## cron 表达式 (5 段: 分 时 日 月 周)",
      "- `0 9 * * *` — 每天 09:00",
      "- `*/30 * * * *` — 每 30 分钟",
      "- `30 9 * * 1-5` — 工作日 (周一至周五) 09:30",
      "- `0 12 1 * *` — 每月 1 号 12:00",
      "- `0 0 * * mon` — 每周一 00:00 (星期可用 mon-sun, 月份可用 jan-dec)",
      '- 支持 `*`、`*/n`、`a-b`、`a,b`、`a-b/n`; 日与周同时限定时为"或"关系',
      "",
      "## 执行语义",
      "- 到点 (分钟级精度, 每 15 秒轮询) 时, 插件以 bash 执行 `command`, 工作目录为配置的 Vault。",
      "- 结果 (成功/失败、退出码、输出片段) 记录在任务卡片, 可在 设置 → 定时任务 页面查看; 任务状态持久化于 Vault 的 `memory/scheduled-tasks.json`。",
    ].join("\n"),
  }), "cron: skill");
}

export { Config, apply, inject, name };
