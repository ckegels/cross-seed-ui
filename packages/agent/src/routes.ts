/**
 * Agent HTTP API (/v1/*). Every request must carry a valid HMAC signature
 * from the hub (see shared/src/node/hmac.ts).
 */
import { readdir, readFile, statfs } from "node:fs/promises";
import { hostname, loadavg, totalmem, freemem, uptime } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	AGENT_API_VERSION,
	type AgentInfo,
	type ConfigResponse,
	type CrossSeedConfig,
	type JobInfo,
	type SaveConfigRequest,
	type SaveConfigResponse,
	type TestKind,
	effectiveValue,
	parseDuration,
	redactConfig,
	redactString,
	redactText,
	restoreSecrets,
	SecretRestoreError,
	validateConfig,
} from "@csui/shared";
import { NonceCache, verifyRequest } from "@csui/shared/src/node/hmac.ts";
import { HttpError, NO_RESPONSE, type Req, Router, startSse } from "@csui/shared/src/node/http.ts";
import { runTest } from "./connTests.ts";
import type { ConfigManager } from "./crossSeedConfig.ts";
import type { CrossSeedDb } from "./crossSeedDb.ts";
import { type CrossSeedDaemon, JOB_NAMES, type JobName, MAINTENANCE_COMMANDS, type MaintenanceCommand } from "./daemon.ts";
import { type LogKind, type LogTailer, queryLogs } from "./logs.ts";
import { restartAndVerify } from "./restart.ts";
import type { ServiceController } from "./service.ts";
import type { AgentSettings } from "./settings.ts";
import type { StateDb } from "./state.ts";
import { computeStats, dailyCounters, eventFeed, matchEvents } from "./stats.ts";

export interface AgentContext {
	settings: AgentSettings;
	version: string;
	config: ConfigManager;
	csdb: CrossSeedDb;
	daemon: CrossSeedDaemon;
	service: ServiceController;
	tailer: LogTailer;
	state: StateDb;
}

const DAY = 86_400_000;

/** cross-seed CLI runs other than the daemon (e.g. a `cross-seed search` started in a terminal). Linux /proc only. */
async function manualRuns(): Promise<{ pid: number; command: string; startedAt: number | null }[]> {
	const out: { pid: number; command: string; startedAt: number | null }[] = [];
	const pids = (await readdir("/proc").catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
	let bootTime = 0;
	try {
		bootTime = Number(/btime (\d+)/.exec(await readFile("/proc/stat", "utf8"))?.[1] ?? 0) * 1000;
	} catch {
		/* not linux */
	}
	for (const pid of pids) {
		const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
		if (!cmd) continue;
		const args = cmd.split("\0").filter(Boolean);
		const i = args.findIndex((a) => /(^|\/)cross-seed(\.js|\/dist\/cmd\.js)?$/.test(a));
		const sub = i >= 0 ? args[i + 1] : undefined;
		if (!sub || !["search", "rss", "inject", "restore"].includes(sub)) continue;
		let startedAt: number | null = null;
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
			if (bootTime && Number.isFinite(ticks)) startedAt = bootTime + (ticks / 100) * 1000;
		} catch {
			/* ignore */
		}
		out.push({ pid: Number(pid), command: `cross-seed ${args.slice(i + 1).join(" ")}`.slice(0, 200), startedAt });
	}
	return out;
}

function ipAllowed(ip: string, allowed: string[]): boolean {
	if (!allowed.length) return true;
	return allowed.some((rule) => {
		if (!rule.includes("/")) return rule === ip;
		const [base, bitsStr] = rule.split("/");
		const bits = Number(bitsStr);
		const toInt = (a: string) => a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return (toInt(ip) & mask) === (toInt(base) & mask);
	});
}

function intParam(req: Req, name: string, def: number, min: number, max: number): number {
	const v = Number(req.query.get(name) ?? def);
	if (!Number.isFinite(v)) return def;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

function bodyObj(req: Req): Record<string, unknown> {
	if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
		throw new HttpError(400, "JSON object body expected", "bad_request");
	}
	return req.body as Record<string, unknown>;
}

export function buildRouter(ctx: AgentContext): Router {
	const r = new Router({ bodyLimit: 2 * 1024 * 1024 });
	const nonces = new NonceCache();
	const { settings } = ctx;

	r.use((req) => {
		if (!ipAllowed(req.ip, settings.allowedIps)) {
			throw new HttpError(403, "Your IP is not allowed to use this agent", "forbidden");
		}
		const v = verifyRequest(settings.secret, req.method, req.raw.url ?? "/", req.headers, req.rawBody, nonces);
		if (!v.ok) {
			console.warn(`[auth] rejected ${req.method} ${req.path} from ${req.ip}: ${v.reason}`);
			throw new HttpError(401, `Unauthorized: ${v.reason}`, "unauthorized");
		}
	});

	// Unauthenticated liveness probe (no information disclosed)
	r.get("/healthz", () => ({ ok: true }), { public: true });

	const loadConfig = () => ctx.config.load();

	async function jobs(config: CrossSeedConfig): Promise<JobInfo[]> {
		const last = ctx.csdb.jobLastRuns();
		const running = ctx.tailer.activity.running;
		const dur = (k: string) => {
			const v = effectiveValue(config, k);
			return typeof v === "string" ? parseDuration(v) : null;
		};
		const torznab = (effectiveValue(config, "torznab") as string[] | undefined) ?? [];
		const defs: { name: JobName; enabled: boolean; cadence: number | null }[] = [
			{ name: "rss", enabled: !!dur("rssCadence"), cadence: dur("rssCadence") },
			{ name: "search", enabled: !!dur("searchCadence"), cadence: dur("searchCadence") },
			{ name: "updateIndexerCaps", enabled: torznab.length > 0, cadence: DAY },
			{ name: "inject", enabled: effectiveValue(config, "action") === "inject", cadence: 3600_000 },
			{ name: "cleanup", enabled: true, cadence: DAY },
		];
		const now = Date.now();
		return defs.map((d) => {
			const stored = last[d.name] ?? null;
			const cadence = d.cadence && Number.isFinite(d.cadence) ? d.cadence : null;
			// after an early run cross-seed stores last_run = now + cadence ("delay next run")
			const lastRun = stored !== null && cadence && stored > now ? stored - cadence : stored;
			return {
				name: d.name,
				enabled: d.enabled,
				cadenceMs: cadence,
				lastRun,
				nextRun: d.enabled && cadence ? (stored ?? now) + cadence : null,
				running: running.has(d.name),
				runningSince: running.get(d.name) ?? null,
			};
		});
	}

	// ------------------------------------------------------------- info
	r.get("/v1/info", async (): Promise<AgentInfo> => {
		const loaded = await loadConfig().catch(() => null);
		const config = loaded?.config ?? {};
		const [version, service, ping, apiKey] = await Promise.all([
			ctx.daemon.version(),
			ctx.service.status(),
			ctx.daemon.ping(config),
			ctx.daemon.apiKey(config).catch(() => null),
		]);
		const dirs: { path: string; label: string }[] = [{ path: settings.crossSeedDir, label: "config" }];
		for (const d of (effectiveValue(config, "linkDirs") as string[] | undefined) ?? []) dirs.push({ path: d, label: "linkDir" });
		for (const d of (effectiveValue(config, "dataDirs") as string[] | undefined) ?? []) dirs.push({ path: d, label: "dataDir" });
		const disks = [];
		for (const d of dirs) {
			const st = await statfs(d.path).catch(() => null);
			if (st) disks.push({ path: d.path, label: d.label, totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize });
		}
		return {
			agentVersion: ctx.version,
			apiVersion: AGENT_API_VERSION,
			hostname: hostname(),
			nodeVersion: process.version,
			uptimeSec: Math.round(uptime()),
			loadavg: loadavg(),
			memory: { totalBytes: totalmem(), freeBytes: freemem() },
			crossSeed: {
				version,
				binary: settings.crossSeedBin,
				configDir: settings.crossSeedDir,
				configExists: !!loaded?.exists,
				dbExists: ctx.csdb.exists(),
				manualRuns: await manualRuns(),
			},
			service,
			daemon: {
				reachable: ping.reachable,
				port: ctx.daemon.baseUrl(config) ? Number((effectiveValue(config, "port") as number) ?? 2468) : null,
				apiKeyAvailable: !!apiKey,
				latencyMs: ping.latencyMs,
				error: ping.error,
			},
			disks,
			time: Date.now(),
		};
	});

	r.get("/v1/activity", async () => {
		const st = await ctx.service.status();
		const active = st.manager === "none" ? true : st.state === "active";
		const starting = (st.state === "activating" || st.state === "deactivating") && st.subState !== "auto-restart";
		let snap = ctx.tailer.activity.snapshot(active, starting);
		if (snap.state === "starting" && !starting) {
			// confirm with the API: a running daemon is not "starting"
			const config = (await loadConfig().catch(() => null))?.config ?? {};
			if ((await ctx.daemon.ping(config)).reachable) {
				ctx.tailer.activity.markOnline();
				snap = ctx.tailer.activity.snapshot(active, starting);
			}
		}
		return snap;
	});

	// ------------------------------------------------------------- config
	r.get("/v1/config", async (req): Promise<ConfigResponse> => {
		const loaded = await loadConfig();
		const reveal = req.query.get("reveal") === "1";
		return {
			config: reveal ? loaded.config : redactConfig(loaded.config),
			revealed: reveal,
			hash: loaded.hash,
			mtime: loaded.mtime,
			exists: loaded.exists,
			usesDynamicCode: loaded.usesDynamicCode,
			unknownKeys: loaded.unknownKeys,
			legacyKeys: loaded.legacyKeys,
			validation: validateConfig(loaded.config, { configDir: settings.crossSeedDir }),
			configDir: settings.crossSeedDir,
			path: loaded.path,
		};
	});

	r.get("/v1/config/raw", async (req) => {
		const loaded = await loadConfig();
		return {
			text: req.query.get("reveal") === "1" ? loaded.source : redactText(loaded.source),
			hash: loaded.hash,
			revealed: req.query.get("reveal") === "1",
		};
	});

	const withSecrets = async (incoming: unknown) => {
		if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
			throw new HttpError(400, "config must be an object", "bad_request");
		}
		const current = await loadConfig();
		try {
			return { config: restoreSecrets(incoming as CrossSeedConfig, current.config), current };
		} catch (e) {
			if (e instanceof SecretRestoreError) throw new HttpError(422, e.message, "secret_restore", { key: e.key, index: e.index });
			throw e;
		}
	};

	r.post("/v1/config/validate", async (req) => {
		const { config } = await withSecrets(bodyObj(req).config);
		return validateConfig(config, { configDir: settings.crossSeedDir });
	});

	async function maybeRestart(restart: boolean, autoRollback: boolean, backupId: string | null) {
		if (!restart) return null;
		if (settings.service.manager === "none") {
			return { ok: false, rolledBack: false, message: "Service control is disabled on this agent; restart cross-seed manually.", logTail: [] };
		}
		const result = await restartAndVerify(ctx.service, settings.crossSeedDir);
		ctx.daemon.invalidateVersion();
		if (!result.ok && autoRollback && backupId) {
			await ctx.config.restoreBackup(backupId);
			const again = await restartAndVerify(ctx.service, settings.crossSeedDir);
			return {
				...result,
				rolledBack: true,
				message: `${result.message}\n\nThe previous config.js was restored automatically${again.ok ? " and cross-seed is running again." : `, but cross-seed still did not start: ${again.message}`}`,
			};
		}
		return result;
	}

	r.put("/v1/config", async (req): Promise<SaveConfigResponse> => {
		const body = bodyObj(req) as unknown as SaveConfigRequest & { author?: string };
		const { config } = await withSecrets(body.config);
		const { hash, backupId } = await ctx.config.write(config, {
			baseHash: String(body.baseHash ?? ""),
			note: typeof body.note === "string" ? body.note.slice(0, 200) : undefined,
			force: body.force === true,
			author: typeof body.author === "string" ? body.author.slice(0, 64) : undefined,
		});
		const restart = await maybeRestart(body.restart === true, body.autoRollback !== false, backupId);
		return { hash, backupId, validation: validateConfig(config, { configDir: settings.crossSeedDir }), restart };
	});

	r.put("/v1/config/raw", async (req): Promise<SaveConfigResponse> => {
		const body = bodyObj(req);
		if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text required", "bad_request");
		const current = await loadConfig();
		if (current.exists && body.baseHash !== current.hash) {
			throw new HttpError(409, "config.js changed since you loaded it. Reload first.", "config_conflict");
		}
		if (body.text.includes("__CSUI_REDACTED__")) {
			throw new HttpError(422, "The text still contains hidden secrets. Reveal secrets before editing the raw file.", "secret_restore");
		}
		const { hash, backupId } = await ctx.config.writeText(body.text, current, "before: raw edit");
		const loaded = await loadConfig();
		const restart = await maybeRestart(body.restart === true, body.autoRollback !== false, backupId);
		return { hash, backupId, validation: validateConfig(loaded.config, { configDir: settings.crossSeedDir }), restart };
	});

	r.get("/v1/config/backups", () => ctx.config.listBackups());
	r.get("/v1/config/backups/:id", async (req) => {
		const text = await ctx.config.readBackup(req.params.id);
		return { id: req.params.id, text: req.query.get("reveal") === "1" ? text : redactText(text) };
	});
	r.post("/v1/config/backups/:id/restore", async (req) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const { hash, backupId } = await ctx.config.restoreBackup(req.params.id);
		const restart = await maybeRestart(body.restart === true, false, backupId);
		return { hash, backupId, restart };
	});

	// ------------------------------------------------------------- service
	r.post("/v1/service/:action", async (req) => {
		const action = req.params.action;
		if (action === "restart") {
			const result = await restartAndVerify(ctx.service, settings.crossSeedDir);
			return result;
		}
		if (action === "start") await ctx.service.start();
		else if (action === "stop") await ctx.service.stop();
		else throw new HttpError(400, "action must be start, stop or restart", "bad_request");
		return { ok: true, message: `cross-seed ${action === "start" ? "started" : "stopped"}` };
	});

	r.get("/v1/service/journal", async (req) => ({
		lines: (await ctx.service.recentOutput(intParam(req, "lines", 200, 1, 2000))).map(redactText),
	}));

	// ------------------------------------------------------------- jobs & actions
	r.get("/v1/jobs", async () => jobs((await loadConfig()).config));

	r.post("/v1/jobs/:name", async (req) => {
		const name = req.params.name as JobName;
		if (!JOB_NAMES.includes(name)) throw new HttpError(400, "Unknown job", "bad_request");
		const body = (req.body ?? {}) as Record<string, unknown>;
		const config = (await loadConfig()).config;
		return ctx.daemon.triggerJob(config, name, {
			ignoreExcludeRecentSearch: body.ignoreExcludeRecentSearch === true,
			ignoreExcludeOlder: body.ignoreExcludeOlder === true,
		});
	});

	r.post("/v1/search", async (req) => {
		const body = bodyObj(req);
		const payload: Record<string, unknown> = {};
		if (typeof body.infoHash === "string" && /^[a-f0-9]{40}$/i.test(body.infoHash)) payload.infoHash = body.infoHash.toLowerCase();
		else if (typeof body.path === "string" && isAbsolute(body.path)) payload.path = body.path;
		else throw new HttpError(400, "Provide a 40-character infoHash or an absolute path", "bad_request");
		for (const k of ["ignoreCrossSeeds", "ignoreExcludeRecentSearch", "ignoreExcludeOlder", "ignoreBlockList", "includeSingleEpisodes", "includeNonVideos"]) {
			if (typeof body[k] === "boolean") payload[k] = body[k];
		}
		return ctx.daemon.searchTorrent((await loadConfig()).config, payload);
	});

	r.get("/v1/maintenance", () =>
		Object.entries(MAINTENANCE_COMMANDS).map(([id, c]) => ({ id, label: c.label, description: c.description })),
	);
	r.post("/v1/maintenance/:cmd", async (req) => {
		const cmd = MAINTENANCE_COMMANDS[req.params.cmd as MaintenanceCommand];
		if (!cmd) throw new HttpError(400, "Unknown maintenance command", "bad_request");
		const res = await ctx.daemon.runCli([...cmd.args]);
		const output = redactText(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim()).slice(-8000);
		return { ok: res.code === 0, message: res.code === 0 ? `${cmd.label}: done` : `${cmd.label} failed (exit ${res.code})`, output };
	});

	r.post("/v1/test", async (req) => {
		const body = bodyObj(req);
		const kind = body.kind as TestKind;
		if (!["torznab", "sonarr", "radarr", "client", "notification"].includes(kind)) {
			throw new HttpError(400, "Unknown test kind", "bad_request");
		}
		if (typeof body.value !== "string" || body.value.length > 4096) throw new HttpError(400, "value required", "bad_request");
		let value = body.value;
		if (value.includes("__CSUI_REDACTED__")) {
			// testing an existing entry: restore its hidden credentials first
			const keys: Record<string, string> = { torznab: "torznab", sonarr: "sonarr", radarr: "radarr", client: "torrentClients", notification: "notificationWebhookUrls" };
			const key = keys[kind];
			const { config } = await withSecrets({ [key]: [value] });
			value = (config[key] as string[])[0];
		}
		return runTest(kind, value);
	});

	// ------------------------------------------------------------- data
	r.get("/v1/stats", async (req) => {
		const config = (await loadConfig().catch(() => null))?.config ?? {};
		return computeStats(ctx.csdb, ctx.state, settings.crossSeedDir, (config.torznab as string[]) ?? [], intParam(req, "days", 30, 1, 365));
	});

	r.get("/v1/indexers", async () => {
		const config = (await loadConfig()).config;
		const torznab = (config.torznab as string[]) ?? [];
		const list = ctx.csdb.indexers(torznab, redactString);
		const per = ctx.state
			.prepare("SELECT tracker, result, COUNT(DISTINCT COALESCE(name, '') || '|' || COALESCE(tracker, '')) AS n FROM events WHERE type = 'match' GROUP BY tracker, result")
			.all() as { tracker: string; result: string; n: number }[];
		return list.map((i) => {
			const mine = per.filter((p) => p.tracker === i.name);
			return {
				...i,
				matches: mine.reduce((a, p) => a + p.n, 0),
				injected: mine.filter((p) => p.result === "injected").reduce((a, p) => a + p.n, 0),
			};
		});
	});

	r.get("/v1/decisions", (req) =>
		ctx.csdb.decisions({
			search: req.query.get("search") || undefined,
			decision: req.query.get("decision") || undefined,
			matchesOnly: req.query.get("matchesOnly") === "1",
			limit: intParam(req, "limit", 50, 1, 500),
			offset: intParam(req, "offset", 0, 0, 10_000_000),
		}),
	);

	r.get("/v1/matches", (req) =>
		matchEvents(ctx.state, {
			search: req.query.get("search") || undefined,
			tracker: req.query.get("tracker") || undefined,
			result: req.query.get("result") || undefined,
			via: req.query.get("via") || undefined,
			limit: intParam(req, "limit", 50, 1, 500),
			offset: intParam(req, "offset", 0, 0, 10_000_000),
		}),
	);

	r.get("/v1/events", (req) =>
		eventFeed(ctx.state, {
			types: req.query.get("types")?.split(",").filter(Boolean),
			limit: intParam(req, "limit", 100, 1, 1000),
			before: req.query.get("before") ? Number(req.query.get("before")) : undefined,
		}),
	);

	r.get("/v1/counters", (req) => dailyCounters(ctx.state, req.query.get("kind") ?? "searches", intParam(req, "days", 30, 1, 365)));

	r.get("/v1/library", (req) => ({
		...ctx.csdb.libraryRows({
			search: req.query.get("search") || undefined,
			client: req.query.get("client") || undefined,
			sort: req.query.get("sort") || undefined,
			limit: intParam(req, "limit", 50, 1, 500),
			offset: intParam(req, "offset", 0, 0, 10_000_000),
		}),
		clients: ctx.csdb.clientHosts(),
	}));

	r.get("/v1/logs", (req) => {
		const kind = (req.query.get("kind") ?? "info") as LogKind;
		if (!["info", "verbose", "error"].includes(kind)) throw new HttpError(400, "kind must be info, verbose or error", "bad_request");
		const date = req.query.get("date") ?? undefined;
		if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "bad date", "bad_request");
		return queryLogs(ctx.tailer.logsDir, {
			kind,
			date,
			level: req.query.get("level") ?? undefined,
			label: req.query.get("label") ?? undefined,
			search: req.query.get("search") ?? undefined,
			limit: intParam(req, "limit", 500, 1, 5000),
		});
	});

	r.get("/v1/logs/stream", (req, res) => {
		const RANK: Record<string, number> = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };
		const max = RANK[req.query.get("level") ?? "info"] ?? 2;
		const sse = startSse(req, res);
		// initial backlog so the view is not empty
		const backlog = ctx.tailer.live.filter((l) => (RANK[l.level] ?? 6) <= max).slice(-intParam(req, "backlog", 200, 0, 1000));
		sse.send("backlog", backlog);
		const unsubscribe = ctx.tailer.subscribe((line) => {
			if ((RANK[line.level] ?? 6) <= max) sse.send("line", line);
		});
		const activityTimer = setInterval(async () => {
			const st = await ctx.service.status();
			sse.send("activity", ctx.tailer.activity.snapshot(st.manager === "none" || st.state === "active", (st.state === "activating" || st.state === "deactivating") && st.subState !== "auto-restart"));
		}, 3000);
		sse.onClose(() => {
			unsubscribe();
			clearInterval(activityTimer);
		});
		return NO_RESPONSE;
	});

	// Directory browser for picking linkDirs / dataDirs (directories only)
	r.get("/v1/fs/dirs", async (req) => {
		const p = resolve(req.query.get("path") || "/");
		const entries = await readdir(p, { withFileTypes: true }).catch((e) => {
			throw new HttpError(400, `Cannot read ${p}: ${(e as Error).message}`, "fs_error");
		});
		const dirs = entries
			.filter((e) => e.isDirectory() || e.isSymbolicLink())
			.map((e) => e.name)
			.filter((n) => !n.startsWith("."))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 500);
		const st = await statfs(p).catch(() => null);
		return {
			path: p,
			parent: p === "/" ? null : resolve(p, ".."),
			dirs: dirs.map((n) => ({ name: n, path: join(p, n) })),
			freeBytes: st ? st.bavail * st.bsize : null,
		};
	});

	return r;
}
