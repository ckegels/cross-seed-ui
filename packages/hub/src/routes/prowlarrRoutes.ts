/**
 * Prowlarr: global connection settings + per-instance indexer sync policy.
 * Sync rewrites only the Prowlarr entries of an instance's torznab list;
 * manually added Torznab URLs (Jackett, direct trackers) are left alone.
 */
import type { ConfigResponse, SaveConfigResponse } from "@csui/shared";
import { redactString } from "@csui/shared";
import { HttpError, type Router } from "@csui/shared/src/node/http.ts";
import { agentJson, targetOf } from "../agentClient.ts";
import { requireAdmin, requireSession, requireSudo } from "../auth.ts";
import type { HubContext } from "../context.ts";
import { audit, getSetting, type InstanceRow, setSetting } from "../db.ts";
import {
	DEFAULT_SYNC_POLICY,
	desiredIds,
	listProwlarrIndexers,
	mergeTorznab,
	prowlarrIdOf,
	prowlarrStatus,
	type ProwlarrSettings,
	type SyncPolicy,
} from "../prowlarr.ts";
import { getInstance, listInstances } from "./instanceRoutes.ts";

export function loadProwlarr(ctx: HubContext): ProwlarrSettings | null {
	const raw = getSetting(ctx.db, "prowlarr");
	if (!raw) return null;
	const p = JSON.parse(raw) as { url: string; apiKey: string; torznabBaseUrl?: string };
	return { url: p.url, apiKey: ctx.box.decrypt(p.apiKey), torznabBaseUrl: p.torznabBaseUrl };
}

function requireProwlarr(ctx: HubContext): ProwlarrSettings {
	const p = loadProwlarr(ctx);
	if (!p) throw new HttpError(409, "Connect Prowlarr first (Settings → Prowlarr)", "prowlarr_missing");
	return p;
}

function policyOf(inst: InstanceRow): SyncPolicy {
	if (!inst.prowlarr_sync) return { ...DEFAULT_SYNC_POLICY };
	return { ...DEFAULT_SYNC_POLICY, ...(JSON.parse(inst.prowlarr_sync) as Partial<SyncPolicy>) };
}

function cleanUrl(v: unknown, field: string): string {
	if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required`, "bad_request");
	try {
		const u = new URL(v.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
		return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		throw new HttpError(400, `${field} must be a URL like http://192.168.1.10:9696`, "bad_request");
	}
}

export interface SyncOutcome {
	changed: boolean;
	added: string[];
	removed: string[];
	result: SaveConfigResponse | null;
}

/** Apply the instance's policy (or an explicit one). */
export async function syncInstance(
	ctx: HubContext,
	inst: InstanceRow,
	opts: { policy?: SyncPolicy; restart: boolean; dryRun?: boolean; author: string },
): Promise<SyncOutcome> {
	const p = requireProwlarr(ctx);
	const policy = opts.policy ?? policyOf(inst);
	const { indexers } = await listProwlarrIndexers(p);
	const ids = desiredIds(policy, indexers);
	const t = targetOf(inst, ctx.box);
	const current = await agentJson<ConfigResponse>(t, "GET", "/v1/config");
	const torznab = (current.config.torznab as string[] | undefined) ?? [];
	const { next, added, removed } = mergeTorznab(p, torznab, ids);
	const name = (id: number) => indexers.find((i) => i.id === id)?.name ?? `#${id}`;
	// the agent hands out redacted URLs, so compare in redacted form
	const changed = JSON.stringify(next.map(redactString)) !== JSON.stringify(torznab);
	if (!changed || opts.dryRun) {
		return { changed, added: added.map(name), removed: removed.map(name), result: null };
	}
	const result = await agentJson<SaveConfigResponse>(
		t,
		"PUT",
		"/v1/config",
		{
			config: { ...current.config, torznab: next },
			baseHash: current.hash,
			restart: opts.restart,
			autoRollback: true,
			note: `Prowlarr sync (+${added.length} / -${removed.length})`,
			author: opts.author,
		},
		240_000,
	);
	return { changed, added: added.map(name), removed: removed.map(name), result };
}

export function registerProwlarrRoutes(r: Router, ctx: HubContext) {
	const { db, box } = ctx;

	r.get("/api/prowlarr", (req) => {
		requireSession(req);
		const p = loadProwlarr(ctx);
		return p ? { configured: true, url: p.url, torznabBaseUrl: p.torznabBaseUrl ?? null } : { configured: false };
	});

	r.put("/api/prowlarr", async (req) => {
		const s = requireSudo(req);
		const b = (req.body ?? {}) as Record<string, unknown>;
		const url = cleanUrl(b.url, "url");
		const torznabBaseUrl = b.torznabBaseUrl ? cleanUrl(b.torznabBaseUrl, "torznabBaseUrl") : undefined;
		const existing = loadProwlarr(ctx);
		const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : existing?.apiKey;
		if (!apiKey) throw new HttpError(400, "apiKey is required", "bad_request");
		const settings = { url, apiKey, torznabBaseUrl };
		const status = await prowlarrStatus(settings);
		setSetting(db, "prowlarr", JSON.stringify({ url, apiKey: box.encrypt(apiKey), torznabBaseUrl }));
		audit(db, { username: s.user.username, ip: req.ip, action: "prowlarr.configured", detail: url });
		return { ok: true, version: status.version };
	});

	r.delete("/api/prowlarr", (req) => {
		const s = requireSudo(req);
		setSetting(db, "prowlarr", null);
		audit(db, { username: s.user.username, ip: req.ip, action: "prowlarr.removed" });
		return { ok: true };
	});

	r.post("/api/prowlarr/test", async (req) => {
		requireAdmin(req);
		const b = (req.body ?? {}) as Record<string, unknown>;
		const existing = loadProwlarr(ctx);
		const settings = {
			url: b.url ? cleanUrl(b.url, "url") : (existing?.url ?? ""),
			apiKey: typeof b.apiKey === "string" && b.apiKey ? b.apiKey : (existing?.apiKey ?? ""),
		};
		if (!settings.url || !settings.apiKey) throw new HttpError(400, "url and apiKey are required", "bad_request");
		const st = await prowlarrStatus(settings);
		return { ok: true, message: `${st.instanceName ?? st.appName} ${st.version}` };
	});

	r.get("/api/prowlarr/indexers", async (req) => {
		requireSession(req);
		const p = requireProwlarr(ctx);
		const { indexers, tags } = await listProwlarrIndexers(p);
		// which instances use which indexer (match by id in the URL, no secrets needed)
		const usage: Record<number, number[]> = {};
		for (const inst of listInstances(ctx)) {
			try {
				const cfg = await agentJson<ConfigResponse>(targetOf(inst, box), "GET", "/v1/config", undefined, 10_000);
				for (const u of (cfg.config.torznab as string[]) ?? []) {
					const id = prowlarrIdOf(p, u);
					if (id !== null) (usage[id] ??= []).push(inst.id);
				}
			} catch {
				/* offline instance */
			}
		}
		return {
			indexers: indexers.map((i) => ({ ...i, torznabUrl: redactString(i.torznabUrl), usedBy: usage[i.id] ?? [] })),
			tags,
		};
	});

	r.get("/api/instances/:id/prowlarr", (req) => {
		requireSession(req);
		const inst = getInstance(ctx, Number(req.params.id));
		// saved=false: never configured, the UI starts from what is in config.js
		return { ...policyOf(inst), saved: !!inst.prowlarr_sync };
	});

	r.put("/api/instances/:id/prowlarr", (req) => {
		const s = requireAdmin(req);
		const inst = getInstance(ctx, Number(req.params.id));
		const b = (req.body ?? {}) as Partial<SyncPolicy>;
		const mode = b.mode === "all" || b.mode === "tag" ? b.mode : "selected";
		const ints = (v: unknown) => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x)).slice(0, 500) : []) as number[];
		const policy: SyncPolicy = {
			mode,
			indexerIds: ints(b.indexerIds),
			tagIds: ints(b.tagIds),
			privateOnly: b.privateOnly !== false,
			auto: b.auto === true,
		};
		db.prepare("UPDATE instances SET prowlarr_sync = ? WHERE id = ?").run(JSON.stringify(policy), inst.id);
		audit(db, { username: s.user.username, ip: req.ip, action: "prowlarr.policy", instanceId: inst.id, detail: JSON.stringify(policy) });
		return policy;
	});

	r.post("/api/instances/:id/prowlarr/sync", async (req) => {
		const s = requireAdmin(req);
		const inst = getInstance(ctx, Number(req.params.id));
		const b = (req.body ?? {}) as { restart?: boolean; dryRun?: boolean };
		const out = await syncInstance(ctx, inst, { restart: b.restart !== false, dryRun: b.dryRun === true, author: s.user.username });
		if (!b.dryRun && out.changed) {
			audit(db, {
				username: s.user.username,
				ip: req.ip,
				action: "prowlarr.sync",
				instanceId: inst.id,
				detail: `added: ${out.added.join(", ") || "-"} | removed: ${out.removed.join(", ") || "-"}`,
			});
		}
		return out;
	});
}

/** Background auto-sync every 6 hours for instances with policy.auto. */
export function startAutoSync(ctx: HubContext) {
	const run = async () => {
		if (!loadProwlarr(ctx)) return;
		for (const inst of listInstances(ctx)) {
			if (!policyOf(inst).auto) continue;
			try {
				const out = await syncInstance(ctx, inst, { restart: true, author: "auto-sync" });
				if (out.changed) {
					audit(ctx.db, {
						username: "auto-sync",
						ip: null,
						action: "prowlarr.sync",
						instanceId: inst.id,
						detail: `added: ${out.added.join(", ") || "-"} | removed: ${out.removed.join(", ") || "-"}`,
						ok: out.result?.restart?.ok !== false,
					});
				}
			} catch (e) {
				audit(ctx.db, { username: "auto-sync", ip: null, action: "prowlarr.sync", instanceId: inst.id, detail: (e as Error).message, ok: false });
			}
		}
	};
	setTimeout(run, 60_000).unref();
	setInterval(run, 6 * 3600_000).unref();
}
