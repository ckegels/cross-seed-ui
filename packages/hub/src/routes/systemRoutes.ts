/**
 * Audit log, version and update information.
 */
import { readFileSync } from "node:fs";
import type { Router } from "@csui/shared/src/node/http.ts";
import { requireAdmin, requireSession } from "../auth.ts";
import type { HubContext } from "../context.ts";

let releaseCache: { at: number; latest: string | null; url: string | null; error: string | null } | null = null;

async function latestRelease(ctx: HubContext) {
	if (releaseCache && Date.now() - releaseCache.at < 6 * 3600_000) return releaseCache;
	let token = "";
	try {
		token = readFileSync(ctx.settings.githubTokenFile, "utf8").trim();
	} catch {
		/* optional */
	}
	try {
		const res = await fetch(`https://api.github.com/repos/${ctx.settings.githubRepo}/releases/latest`, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "cross-seed-ui",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			releaseCache = {
				at: Date.now(),
				latest: null,
				url: null,
				error: res.status === 404 ? "No release found (private repo needs a token in the github-token file)" : `GitHub HTTP ${res.status}`,
			};
		} else {
			const j = (await res.json()) as { tag_name: string; html_url: string };
			releaseCache = { at: Date.now(), latest: j.tag_name.replace(/^v/, ""), url: j.html_url, error: null };
		}
	} catch (e) {
		releaseCache = { at: Date.now(), latest: null, url: null, error: (e as Error).message };
	}
	return releaseCache;
}

export function newerVersion(a: string, b: string): boolean {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	}
	return false;
}

export function registerSystemRoutes(r: Router, ctx: HubContext) {
	r.get("/api/system", async (req) => {
		requireSession(req);
		const rel = req.query.get("checkUpdates") === "1" ? await latestRelease(ctx) : releaseCache;
		return {
			version: ctx.version,
			node: process.version,
			latest: rel?.latest ?? null,
			releaseUrl: rel?.url ?? null,
			updateAvailable: !!rel?.latest && ctx.version !== "dev" && newerVersion(rel.latest, ctx.version),
			updateError: rel?.error ?? null,
			updateCommand: "cross-seed-ui update",
		};
	});

	r.get("/api/audit", (req) => {
		requireAdmin(req);
		const limit = Math.min(500, Math.max(1, Number(req.query.get("limit") ?? 100) || 100));
		const offset = Math.max(0, Number(req.query.get("offset") ?? 0) || 0);
		const instance = req.query.get("instance");
		const where = instance ? "WHERE instance_id = ?" : "";
		const params = instance ? [Number(instance)] : [];
		const rows = ctx.db
			.prepare(`SELECT a.*, i.name AS instance_name FROM audit a LEFT JOIN instances i ON i.id = a.instance_id ${where} ORDER BY a.ts DESC LIMIT ? OFFSET ?`)
			.all(...params, limit, offset);
		const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit ${where}`).get(...params) as { n: number }).n;
		return { rows, total, limit, offset };
	});
}
