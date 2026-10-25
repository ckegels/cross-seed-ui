/**
 * Statistics: cross-seed.db (library, searches, decisions, indexers)
 * combined with the agent's events parsed from logs (injections, saves...).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DayBucket, InstanceStats, MatchEvent, TrackerStat } from "@csui/shared";
import type { CrossSeedDb } from "./crossSeedDb.ts";
import { dayOf } from "./logs.ts";
import type { StateDb } from "./state.ts";

const DAY = 86_400_000;

let cacheInfo: { at: number; files: number; bytes: number } | null = null;

async function torrentCacheInfo(crossSeedDir: string) {
	if (cacheInfo && Date.now() - cacheInfo.at < 10 * 60_000) return cacheInfo;
	const dir = join(crossSeedDir, "torrent_cache");
	let files = 0;
	let bytes = 0;
	for (const f of await readdir(dir).catch(() => [] as string[])) {
		if (!f.endsWith(".torrent")) continue;
		const st = await stat(join(dir, f)).catch(() => null);
		if (!st) continue;
		files++;
		bytes += st.size;
	}
	cacheInfo = { at: Date.now(), files, bytes };
	return cacheInfo;
}

type Row = Record<string, unknown>;

export function resultCounts(state: StateDb, since = 0) {
	const out = { injected: 0, saved: 0, exists: 0, failed: 0, incomplete: 0 };
	for (const r of state
		.prepare("SELECT result, COUNT(*) AS n FROM events WHERE type = 'match' AND ts >= ? GROUP BY result")
		.all(since) as Row[]) {
		const k = String(r.result) as keyof typeof out;
		if (k in out) out[k] += Number(r.n);
	}
	// retries performed by the hourly inject job
	for (const r of state
		.prepare("SELECT result, COUNT(*) AS n FROM events WHERE type = 'inject-job' AND ts >= ? GROUP BY result")
		.all(since) as Row[]) {
		if (r.result === "injected") out.injected += Number(r.n);
	}
	return out;
}

export async function computeStats(
	csdb: CrossSeedDb,
	state: StateDb,
	crossSeedDir: string,
	configTorznab: string[],
	days = 30,
): Promise<InstanceStats> {
	const now = Date.now();
	const since = now - days * DAY;

	const timeline = new Map<string, DayBucket>();
	for (let i = days - 1; i >= 0; i--) {
		const day = dayOf(now - i * DAY);
		timeline.set(day, { day, matches: 0, injected: 0, saved: 0, failed: 0, searches: 0 });
	}
	for (const [day, n] of csdb.matchesPerDay(since)) {
		const b = timeline.get(day);
		if (b) b.matches = n;
	}
	for (const r of state
		.prepare(
			`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, type, result, COUNT(*) AS n
			 FROM events WHERE type IN ('match', 'inject-job') AND ts >= ? GROUP BY day, type, result`,
		)
		.all(since) as Row[]) {
		const b = timeline.get(String(r.day));
		if (!b) continue;
		const n = Number(r.n);
		if (r.result === "injected") b.injected += n;
		else if (r.type === "match" && (r.result === "saved" || r.result === "incomplete")) b.saved += n;
		else if (r.result === "failed") b.failed += n;
	}
	for (const r of state
		.prepare("SELECT day, SUM(n) AS n FROM daily_counts WHERE kind = 'searches' AND day >= ? GROUP BY day")
		.all(dayOf(since)) as Row[]) {
		const b = timeline.get(String(r.day));
		if (b) b.searches = Number(r.n);
	}

	const byTracker = new Map<string, TrackerStat>();
	for (const r of state
		.prepare("SELECT tracker, result, COUNT(*) AS n FROM events WHERE type = 'match' GROUP BY tracker, result")
		.all() as Row[]) {
		const t = String(r.tracker);
		const s = byTracker.get(t) ?? { tracker: t, injected: 0, saved: 0, exists: 0, failed: 0, incomplete: 0 };
		const k = String(r.result) as keyof Omit<TrackerStat, "tracker">;
		if (k in s) s[k] += Number(r.n);
		byTracker.set(t, s);
	}

	const all = resultCounts(state);
	const firstEvent = state.prepare("SELECT MIN(ts) AS m FROM events WHERE type = 'match'").get() as Row | undefined;

	const indexers = csdb.indexers(configTorznab, (u) => u);
	const nowMs = Date.now();
	const isLimited = (i: (typeof indexers)[number]) =>
		i.status === "RATE_LIMITED" && (i.retryAfter ?? 0) > nowMs;
	const isFailing = (i: (typeof indexers)[number]) =>
		i.status === "UNKNOWN_ERROR" && (i.retryAfter ?? 0) > nowMs;

	return {
		generatedAt: now,
		library: csdb.library(),
		searches: csdb.searchStats(now),
		decisions: csdb.decisionStats(now),
		results: {
			...all,
			injected24h: resultCounts(state, now - DAY).injected,
			injected7d: resultCounts(state, now - 7 * DAY).injected,
			injected30d: resultCounts(state, now - 30 * DAY).injected,
			since: (firstEvent?.m as number) ?? null,
		},
		byTracker: [...byTracker.values()].sort((a, b) => b.injected + b.saved - (a.injected + a.saved)),
		timeline: [...timeline.values()],
		torrentCache: await torrentCacheInfo(crossSeedDir).then(({ files, bytes }) => ({ files, bytes })),
		indexers: {
			total: indexers.length,
			inConfig: indexers.filter((i) => i.inConfig).length,
			ok: indexers.filter((i) => i.inConfig && !isLimited(i) && !isFailing(i) && i.status !== "PENDING_RESTART").length,
			rateLimited: indexers.filter((i) => i.inConfig && isLimited(i)).length,
			failing: indexers.filter((i) => i.inConfig && isFailing(i)).length,
		},
	};
}

export function matchEvents(
	state: StateDb,
	opts: { search?: string; tracker?: string; result?: string; via?: string; limit: number; offset: number },
): { rows: MatchEvent[]; total: number; offset: number; limit: number } {
	const where = ["type = 'match'"];
	const params: (string | number)[] = [];
	if (opts.search) {
		where.push("(name LIKE ? ESCAPE '\\' OR searchee LIKE ? ESCAPE '\\')");
		const like = `%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		params.push(like, like);
	}
	if (opts.tracker) {
		where.push("tracker = ?");
		params.push(opts.tracker);
	}
	if (opts.result) {
		where.push("result = ?");
		params.push(opts.result);
	}
	if (opts.via) {
		where.push("via = ?");
		params.push(opts.via);
	}
	const w = where.join(" AND ");
	const total = (state.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${w}`).get(...params) as Row).n as number;
	const rows = (state
		.prepare(`SELECT id, ts, via, name, tracker, decision, result, source, searchee FROM events WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`)
		.all(...params, opts.limit, opts.offset) as Row[]).map((r) => ({
		id: Number(r.id),
		ts: Number(r.ts),
		via: String(r.via ?? ""),
		name: String(r.name ?? ""),
		tracker: String(r.tracker ?? ""),
		decision: String(r.decision ?? ""),
		result: String(r.result ?? ""),
		source: String(r.source ?? ""),
		searchee: String(r.searchee ?? ""),
	}));
	return { rows, total, offset: opts.offset, limit: opts.limit };
}

export function eventFeed(state: StateDb, opts: { types?: string[]; limit: number; before?: number }) {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (opts.types?.length) {
		where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
		params.push(...opts.types);
	}
	if (opts.before) {
		where.push("ts < ?");
		params.push(opts.before);
	}
	const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
	return (state
		.prepare(`SELECT id, ts, type, via, name, tracker, decision, result, source, searchee, data FROM events ${w} ORDER BY ts DESC, id DESC LIMIT ?`)
		.all(...params, opts.limit) as Row[]).map((r) => ({
		...r,
		data: typeof r.data === "string" && r.data.startsWith("{") ? JSON.parse(r.data) : r.data,
	}));
}

export function dailyCounters(state: StateDb, kind: string, days: number) {
	const since = dayOf(Date.now() - days * DAY);
	return state
		.prepare("SELECT day, key, n FROM daily_counts WHERE kind = ? AND day >= ? ORDER BY day")
		.all(kind, since) as { day: string; key: string; n: number }[];
}
