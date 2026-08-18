window.__ModuleLoader__.load({
	id: "dsh-cron-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const el = React.createElement;

		const CSS = [
			'.cronx-root { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 28px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
			'.cronx-h { margin: 0; font-size: 16px; font-weight: 600; }',
			'.cronx-sub { margin: 0 0 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
			'.cronx-err { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12px; }',
			'.cronx-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }',
			'.cronx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
			'.cronx-name { font-weight: 600; }',
			'.cronx-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); }',
			'.cronx-badge.on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }',
			'.cronx-badge.off { color: var(--dsw-alias-label-secondary); }',
			'.cronx-badge.important { color: var(--dsw-alias-state-warning-primary, #d97706); border-color: var(--dsw-alias-state-warning-primary, #d97706); }',
			'.cronx-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
			'.cronx-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; word-break: break-all; }',
			'.cronx-out { max-height: 80px; overflow-y: auto; }',
			'.cronx-label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }',
			'.cronx-input { width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; }',
			'.cronx-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
			'.cronx-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }',
			'.cronx-btn { padding: 6px 12px; border: none; border-radius: 8px; background: var(--dsw-alias-brand-primary); color: #ffffff; font-size: 12px; cursor: pointer; }',
			'.cronx-btn:hover { opacity: 0.9; }',
			'.cronx-btn:disabled { opacity: 0.5; cursor: default; }',
			'.cronx-btn.ghost { background: transparent; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); }',
			'.cronx-btn.danger { background: transparent; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }',
			'.cronx-radio { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; margin-right: 14px; }',
		].join("\n");

		async function api(method, path, body) {
			const opts = method === "GET" ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
			const res = await fetch(path, opts);
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		}

		function fmtTime(ts) {
			if (!ts) return "—";
			try { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return String(ts); }
		}

		function Badge(props) {
			return el("span", { className: "cronx-badge " + (props.on ? "on" : "off") }, props.on ? "运行中" : "已停用");
		}

		function LevelBadge(props) {
			const important = props.risk === "important";
			return el("span", { className: "cronx-badge " + (important ? "important" : "off") }, important ? "重要" : "安全");
		}

		function smokeLine(t) {
			const s = t.smoke;
			if (!s) return el("div", { className: "cronx-meta" }, "冒烟: 未测试（上线前建议点一次「冒烟测试」）");
			return el("div", { className: "cronx-meta" }, "冒烟 " + fmtTime(s.time) + " → " + (s.ok ? "通过" : "失败") + ((s.exitCode === null || s.exitCode === undefined) ? "" : " (exit " + s.exitCode + ")") + (s.denied ? " [被沙箱拒绝]" : ""));
		}

		function TaskCard(props) {
			const t = props.task;
			const lr = t.lastRun;
			return el("div", { className: "cronx-card" },
				el("div", { className: "cronx-row" },
					el("span", { className: "cronx-name" }, t.name),
					el(Badge, { on: !!t.enabled }),
					el(LevelBadge, { risk: t.risk }),
					el("span", { className: "cronx-badge off" }, t.notify ? "失败通知" : "静默"),
					el("span", { className: "cronx-mono" }, t.schedule),
				),
				el("div", { className: "cronx-meta" }, "下次执行: " + fmtTime(t.nextRun) + " · 已执行 " + (t.runCount || 0) + " 次" + (t.retry.enabled ? " · 失败重试 " + t.retry.count + " 次(" + t.retry.delayMin + "分钟后)" : "")),
				el("div", { className: "cronx-mono" }, t.command),
				smokeLine(t),
				lr
					? el("div", null,
						el("div", { className: "cronx-meta" }, "上次执行 " + fmtTime(lr.time) + " → " + (lr.ok ? "成功" : "失败") + ((lr.exitCode === null || lr.exitCode === undefined) ? "" : " (exit " + lr.exitCode + ")") + (lr.timedOut ? " [超时]" : "") + (lr.denied ? " [被沙箱拒绝]" : "")),
						lr.output ? el("div", { className: "cronx-mono cronx-out" }, lr.output) : null,
					)
					: el("div", { className: "cronx-meta" }, "尚未执行过"),
				el("div", { className: "cronx-row" },
					el("button", { className: "cronx-btn", onClick: () => props.onAction("smoke", t) }, "冒烟测试"),
					el("button", { className: "cronx-btn ghost", onClick: () => props.onAction("run", t) }, "立即执行"),
					el("button", { className: "cronx-btn ghost", onClick: () => props.onAction("toggle", t) }, t.enabled ? "停用" : "启用"),
					el("button", { className: "cronx-btn danger", onClick: () => props.onAction("remove", t) }, "删除"),
				),
			);
		}

		function Page() {
			const [tasks, setTasks] = React.useState(null);
			const [debug, setDebug] = React.useState(null);
			const [error, setError] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [name, setName] = React.useState("");
			const [schedule, setSchedule] = React.useState("0 9 * * *");
			const [command, setCommand] = React.useState("");
			const [enabled, setEnabled] = React.useState(true);
			const [risk, setRisk] = React.useState("safe");
			const [notify, setNotify] = React.useState(false);
			const [retry, setRetry] = React.useState(false);
			const [preview, setPreview] = React.useState(null);

			function refresh() {
				api("GET", "/cron-api/list").then((data) => {
					setTasks(Array.isArray(data.tasks) ? data.tasks : []);
					setError("");
				}).catch((err) => { setError("加载失败: " + String((err && err.message) || err)); });
				api("GET", "/cron-api/debug").then((data) => { setDebug(data); }).catch(() => {});
			}
			React.useEffect(() => { refresh(); }, []);

			React.useEffect(() => {
				const s = String(schedule || "").trim();
				if (!s) { setPreview(null); return; }
				const id = setTimeout(() => {
					api("GET", "/cron-api/preview?schedule=" + encodeURIComponent(s)).then((data) => {
						if (data && data.ok) setPreview({ next: data.next, error: null });
						else setPreview({ next: null, error: (data && data.error) || "无效表达式" });
					}).catch(() => { setPreview({ next: null, error: "无法预览" }); });
				}, 350);
				return () => clearTimeout(id);
			}, [schedule]);

			function pickRisk(r) {
				setRisk(r);
				if (r === "important") { setNotify(true); setRetry(true); }
				else { setNotify(false); setRetry(false); }
			}

			function onAction(kind, task) {
				if (busy) return;
				setBusy(true);
				setError("");
				let p;
				if (kind === "remove") p = api("POST", "/cron-api/remove", { id: task.id });
				else if (kind === "toggle") p = api("POST", "/cron-api/toggle", { id: task.id, enabled: !task.enabled });
				else if (kind === "smoke") p = api("POST", "/cron-api/smoke", { id: task.id });
				else p = api("POST", "/cron-api/run", { id: task.id });
				p.then((data) => {
					setBusy(false);
					if (data && data.ok) refresh();
					else setError((data && data.error) || "操作失败");
				}).catch((err) => { setBusy(false); setError("操作失败: " + String((err && err.message) || err)); });
			}

			function submit() {
				if (!name.trim()) { setError("请填写任务名称"); return; }
				if (!command.trim()) { setError("请填写要执行的命令"); return; }
				setBusy(true);
				setError("");
				api("POST", "/cron-api/add", { name: name.trim(), schedule: schedule.trim(), command: command.trim(), enabled: enabled, risk: risk, notify: notify, retry: retry }).then((data) => {
					setBusy(false);
					if (data && data.ok) { setName(""); setCommand(""); refresh(); }
					else setError((data && data.error) || "创建失败");
				}).catch((err) => { setBusy(false); setError("创建失败: " + String((err && err.message) || err)); });
			}

			const statusLine = debug
				? "状态: 已加载 " + (typeof debug.taskCount === "number" ? debug.taskCount : "?") + " 个任务" + (debug.statePath ? " · 状态文件: " + debug.statePath : " · 状态文件: 未找到")
				: "状态: 连接中…";

			return el("div", { className: "cronx-root" },
				el("h3", { className: "cronx-h" }, "定时任务"),
				el("p", { className: "cronx-sub" }, "创建周期任务, 到点自动执行命令。也可以直接在对话中说「创建一个每天 9 点的定时任务」。"),
				el("p", { className: "cronx-sub" }, statusLine),
				error ? el("div", { className: "cronx-err" }, error) : null,

				el("div", { className: "cronx-card" },
					el("label", { className: "cronx-label" }, "任务名称"),
					el("input", { className: "cronx-input", value: name, placeholder: "如: 每日备份", onChange: (e) => setName(e.target.value) }),
					el("label", { className: "cronx-label" }, "cron 表达式 (分 时 日 月 周)"),
					el("input", { className: "cronx-input", value: schedule, placeholder: "如: 0 9 * * *", onChange: (e) => setSchedule(e.target.value) }),
					el("div", { className: "cronx-meta" }, preview ? (preview.error ? preview.error : "下次执行: " + fmtTime(preview.next)) : " "),
					el("label", { className: "cronx-label" }, "要执行的命令 (bash)"),
					el("textarea", { className: "cronx-input", rows: 2, value: command, placeholder: "如: echo hello", onChange: (e) => setCommand(e.target.value) }),
					el("div", { className: "cronx-row" },
						el("label", { className: "cronx-radio" },
							el("input", { type: "radio", name: "risk", checked: risk === "safe", onChange: () => pickRisk("safe") }),
							"安全类（本地整理，失败不打扰）"),
						el("label", { className: "cronx-radio" },
							el("input", { type: "radio", name: "risk", checked: risk === "important", onChange: () => pickRisk("important") }),
							"重要类（发消息/邮件等，失败要通知）"),
					),
					el("div", { className: "cronx-row" },
						el("label", { className: "cronx-check" },
							el("input", { type: "checkbox", checked: notify, onChange: (e) => setNotify(e.target.checked) }),
							"失败微信通知"),
						el("label", { className: "cronx-check" },
							el("input", { type: "checkbox", checked: retry, onChange: (e) => setRetry(e.target.checked) }),
							"自动重试 1 次（5 分钟后）"),
						el("label", { className: "cronx-check" },
							el("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }),
							"创建后立即启用"),
					),
					el("div", { className: "cronx-row" },
						el("button", { className: "cronx-btn", disabled: busy, onClick: submit }, busy ? "处理中…" : "添加任务"),
						el("span", { className: "cronx-meta" }, "创建后建议先「冒烟测试」再等它到点跑"),
					),
				),

				tasks === null
					? el("div", { className: "cronx-meta" }, "加载中…")
					: tasks.length === 0
						? el("div", { className: "cronx-card" }, el("div", { className: "cronx-meta" }, "暂无定时任务。在上方表单添加, 或直接对我说「创建一个定时任务」。"))
						: tasks.map((t) => el(TaskCard, { task: t, onAction: onAction, key: t.id })),
			);
		}

		const inject = ["slots"];
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-cron-scheduler");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "scheduled-tasks", order: 30, label: "定时任务" },
				() => el(Page, null),
			));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
				{ name: "settings.plugin.item", id: "cron-scheduler", order: 30, label: "cron-scheduler" },
				() => el(Page, null),
			));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
