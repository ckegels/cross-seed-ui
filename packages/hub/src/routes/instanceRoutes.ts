/**
 * Instances (agents) registry + the proxy that exposes agent endpoints to the UI.
 *
 * UI calls /api/instances/:id/<path> -> agent /v1/<path>. Only whitelisted
 * paths are forwarded, each with a minimum permission level:
 *   viewer  read-only data
 *   admin   changes (config, jobs, service, tests)
 *   sudo    admin + recent password confirmation (secrets, raw config.js)
 */
import type { AgentInfo } from "@csui/shared";
import { HttpError, NO_RESPONSE, type Req, type Router } from "@csui/shared/src/node/http.ts";
import { agentJson, pipeAgentSse, targetOf } from "../agentClient.ts";
import { requireAdmin, requireSession, requireSudo, type SessionInfo } from "../auth.ts";
import type { HubContext } from "../context.ts";
import { audit, type InstanceRow } from "../db.ts";

type Level = "viewer" | "admin" | "sudo";

const RULES: { method: string; path: RegExp; level: Level; audit?: string }[] = [
	{ method: "GET", path: /^info$/, level: "viewer" },
	{ method: "GET", path: /^activity$/, level: "viewer" },
	{ method: "GET", path: /^config$/, level: "viewer" },
	{ method: "GET", path: /^config\/raw$/, level: "admin" },
	{ method: "GET", path: /^config\/backups$/, level: "admin" },
	{ method: "GET", path: /^config\/backups\/[\w.-]+$/, level: "admin" },
	{ method: "GET", path: /^jobs$/, level: "viewer" },
	{ method: "GET", path: /^maintenance$/, level: "viewer" },
	{ method: "GET", path: /^stats$/, level: "viewer" },
	{ method: "GET", path: /^indexers$/, level: "viewer" },
	{ method: "GET", path: /^decisions$/, level: "viewer" },
	{ method: "GET", path: /^matches$/, level: "viewer" },
	{ method: "GET", path: /^events$/, level: "viewer" },
	{ method: "GET", path: /^counters$/, level: "viewer" },
	{ method: "GET", path: /^library$/, level: "viewer" },
	{ method: "GET", path: /^logs$/, level: "viewer" },
	{ method: "GET", path: /^logs\/stream$/, level: "viewer" },
	{ method: "GET", path: /^service\/journal$/, level: "admin" },
	{ method: "GET", path: /^fs\/dirs$/, level: "admin" },
	{ method: "POST", path: /^config\/validate$/, level: "admin" },
	{ method: "PUT", path: /^config$/, level: "admin", audit: "config.saved" },
	{ method: "PUT", path: /^config\/raw$/, level: "sudo", audit: "config.raw_saved" },
	{ method: "POST", path: /^config\/backups\/[\w.-]+\/restore$/, level: "admin", audit: "config.restored" },
	{ method: "POST", path: /^service\/(start|stop|restart)$/, level: "admin", audit: "service" },
	{ method: "POST", path: /^jobs\/\w+$/, level: "admin", audit: "job.triggered" },
	{ method: "POST", path: /^search$/, level: "admin", audit: "search.triggered" },
	{ method: "POST", path: /^maintenance\/[\w-]+$/, level: "admin", audit: "maintenance" },
	{ method: "POST", path: /^test$/, level: "admin" },
];

export function getInstance(ctx: HubContext, id: number): InstanceRow {
	const row = ctx.db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as unknown as InstanceRow | undefined;
	if (!row) throw new HttpError(404, "Instance not found", "not_found");
	return row;
}

export function listInstances(ctx: HubContext): InstanceRow[] {
	return ctx.db.prepare("SELECT * FROM instances ORDER BY sort, id").all() as unknown as InstanceRow[];
}

function publicInstance(i: InstanceRow) {
	return { id: i.id, name: i.name, url: i.url, color: i.color, sort: i.sort, createdAt: i.created_at };
}

function check(level: Level, req: Req): SessionInfo {
	if (level === "sudo") return requireSudo(req);
	if (level === "admin") return requireAdmin(req);
	return requireSession(req);
}

function validUrl(v: unknown): string {
	if (typeof v !== "string") throw new HttpError(400, "url is required", "bad_request");
	let u: URL;
	try {
		u = new URL(v.trim());
	} catch {
		throw new HttpError(400, "url must look like http://192.168.1.20:2469", "bad_request");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "url must be http(s)", "bad_request");
	if (u.username || u.password) throw new HttpError(400, "url must not contain credentials", "bad_request");
	return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export function registerInstanceRoutes(r: Router, ctx: HubContext) {
	const { db, box } = ctx;

	r.get("/api/instances", (req) => {
		requireSession(req);
		return listInstances(ctx).map(publicInstance);
	});

	/** Test agent credentials before saving. */
	r.post("/api/instances/test", async (req) => {
		requireSudo(req);
		const b = (req.body ?? {}) as Record<string, unknown>;
		const url = validUrl(b.url);
		if (typeof b.secret !== "string" || b.secret.length < 32) throw new HttpError(400, "secret must be at least 32 characters", "bad_request");
		const info = await agentJson<AgentInfo>({ id: 0, url, secret: b.secret }, "GET", "/v1/info", undefined, 15_000);
		return { ok: true, info };
	});

	r.post("/api/instances", async (req) => {
		const s = requireSudo(req);
		const b = (req.body ?? {}) as Record<string, unknown>;
		const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
		if (!name) throw new HttpError(400, "name is required", "bad_request");
		const url = validUrl(b.url);
		if (typeof b.secret !== "string" || b.secret.length < 32) throw new HttpError(400, "secret must be at least 32 characters", "bad_request");
		const color = typeof b.color === "string" && COLOR.test(b.color) ? b.color : "#6366f1";
		// must work before we store it
		await agentJson({ id: 0, url, secret: b.secret }, "GET", "/v1/info", undefined, 15_000);
		const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM instances").get() as { n: number }).n;
		const res = db
			.prepare("INSERT INTO instances (name, url, secret, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(name, url, box.encrypt(b.secret), color, sort, Date.now());
		audit(db, { username: s.user.username, ip: req.ip, action: "instance.added", instanceId: Number(res.lastInsertRowid), detail: `${name} ${url}` });
		return publicInstance(getInstance(ctx, Number(res.lastInsertRowid)));
	});

	r.put("/api/instances/:id", async (req) => {
		const s = requireSudo(req);
		const inst = getInstance(ctx, Number(req.params.id));
		const b = (req.body ?? {}) as Record<string, unknown>;
		const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : inst.name;
		const url = b.url !== undefined ? validUrl(b.url) : inst.url;
		const color = typeof b.color === "string" && COLOR.test(b.color) ? b.color : inst.color;
		let secret = inst.secret;
		if (typeof b.secret === "string" && b.secret) {
			if (b.secret.length < 32) throw new HttpError(400, "secret must be at least 32 characters", "bad_request");
			secret = box.encrypt(b.secret);
		}
		if (url !== inst.url || secret !== inst.secret) {
			await agentJson({ id: inst.id, url, secret: box.decrypt(secret) }, "GET", "/v1/info", undefined, 15_000);
		}
		const sort = typeof b.sort === "number" ? Math.floor(b.sort) : inst.sort;
		db.prepare("UPDATE instances SET name = ?, url = ?, secret = ?, color = ?, sort = ? WHERE id = ?").run(name, url, secret, color, sort, inst.id);
		audit(db, { username: s.user.username, ip: req.ip, action: "instance.updated", instanceId: inst.id, detail: name });
		return publicInstance(getInstance(ctx, inst.id));
	});

	r.delete("/api/instances/:id", (req) => {
		const s = requireSudo(req);
		const inst = getInstance(ctx, Number(req.params.id));
		db.prepare("DELETE FROM instances WHERE id = ?").run(inst.id);
		audit(db, { username: s.user.username, ip: req.ip, action: "instance.removed", instanceId: inst.id, detail: inst.name });
		return { ok: true };
	});

	/** Everything the overview page needs, for every instance, in one call. */
	r.get("/api/overview", async (req) => {
		requireSession(req);
		const days = Math.min(90, Math.max(7, Number(req.query.get("days") ?? 30) || 30));
		const list = listInstances(ctx);
		return Promise.all(
			list.map(async (inst) => {
				const t = targetOf(inst, box);
				const settle = async <T>(p: Promise<T>) => {
					try {
						return { ok: true as const, value: await p };
					} catch (e) {
						return { ok: false as const, error: (e as Error).message };
					}
				};
				const [info, activity, stats, jobs] = await Promise.all([
					settle(agentJson(t, "GET", "/v1/info", undefined, 10_000)),
					settle(agentJson(t, "GET", "/v1/activity", undefined, 10_000)),
					settle(agentJson(t, "GET", `/v1/stats?days=${days}`, undefined, 20_000)),
					settle(agentJson(t, "GET", "/v1/jobs", undefined, 10_000)),
				]);
				return {
					instance: publicInstance(inst),
					online: info.ok,
					error: info.ok ? null : info.error,
					info: info.ok ? info.value : null,
					activity: activity.ok ? activity.value : null,
					stats: stats.ok ? stats.value : null,
					jobs: jobs.ok ? jobs.value : null,
				};
			}),
		);
	});

	// ---------------------------------------------------------------- proxy
	const proxy = async (req: Req, res: import("node:http").ServerResponse) => {
		const inst = getInstance(ctx, Number(req.params.id));
		const sub = req.params["*"] ?? "";
		const rule = RULES.find((x) => x.method === req.method && x.path.test(sub));
		if (!rule) throw new HttpError(404, "Unknown instance endpoint", "not_found");
		const reveal = req.query.get("reveal") === "1";
		const s = check(reveal ? "sudo" : rule.level, req);
		const t = targetOf(inst, box);
		// forward the raw (still encoded) path so the signed path is exactly what is sent
		const rawSub = req.url.pathname.split("/").slice(4).join("/");
		const agentPath = `/v1/${rawSub}${req.url.search}`;

		if (sub === "logs/stream") {
			await pipeAgentSse(t, agentPath, res, (cb) => req.raw.on("close", cb));
			return NO_RESPONSE;
		}

		let body: unknown = req.body;
		if (rule.audit === "config.saved" && body && typeof body === "object") {
			body = { ...(body as object), author: s.user.username };
		}
		const long = sub.startsWith("config") || sub.startsWith("service") || sub.startsWith("maintenance") || sub === "test";
		try {
			const result = await agentJson(t, req.method, agentPath, body, long ? 240_000 : 30_000);
			if (rule.audit) {
				const b = (req.body ?? {}) as Record<string, unknown>;
				const restart = (result as { restart?: { ok: boolean; rolledBack: boolean } } | undefined)?.restart;
				audit(db, {
					username: s.user.username,
					ip: req.ip,
					action: rule.audit,
					instanceId: inst.id,
					detail: [
						`${req.method} ${sub}`,
						typeof b.note === "string" ? `note: ${b.note}` : "",
						restart ? `restart: ${restart.ok ? "ok" : "failed"}${restart.rolledBack ? " (rolled back)" : ""}` : "",
					]
						.filter(Boolean)
						.join(" | "),
				});
			}
			if (reveal) {
				audit(db, { username: s.user.username, ip: req.ip, action: "secrets.revealed", instanceId: inst.id, detail: sub });
			}
			return result;
		} catch (e) {
			if (rule.audit) {
				audit(db, {
					username: s.user.username,
					ip: req.ip,
					action: rule.audit,
					instanceId: inst.id,
					detail: `${req.method} ${sub} failed: ${(e as Error).message}`.slice(0, 500),
					ok: false,
				});
			}
			throw e;
		}
	};
	for (const m of ["GET", "POST", "PUT"]) r.add(m, "/api/instances/:id/*", proxy, { bodyLimit: 2 * 1024 * 1024 });
}
