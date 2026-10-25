/**
 * Read-only access to cross-seed.db (schema of cross-seed v6, migrations 00-11).
 * The database is opened with readOnly so this UI can never corrupt it.
 * All maintenance writes go through the official `cross-seed` CLI.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactText, type DecisionRow, type IndexerInfo, type LibraryRow, type Paged } from "@csui/shared";

export const MATCH_DECISIONS = ["MATCH", "MATCH_SIZE_ONLY", "MATCH_PARTIAL"];

type Row = Record<string, unknown>;

function jsonOr<T>(v: unknown, fallback: T): T {
	if (typeof v !== "string") return fallback;
	try {
		return JSON.parse(v) as T;
	} catch {
		return fallback;
	}
}

function bool(v: unknown): boolean | null {
	if (v === null || v === undefined) return null;
	return Boolean(v);
}

export class CrossSeedDb {
	readonly path: string;
	private db: DatabaseSync | null = null;
	private ino: number | null = null;

	constructor(crossSeedDir: string) {
		this.path = join(crossSeedDir, "cross-seed.db");
	}

	exists(): boolean {
		return existsSync(this.path);
	}

	/** Returns a connection or null when the DB doesn't exist yet. Reopens if the file was replaced. */
	private conn(): DatabaseSync | null {
		if (!existsSync(this.path)) {
			this.close();
			return null;
		}
		const ino = statSync(this.path).ino;
		if (this.db && this.ino === ino) return this.db;
		this.close();
		this.db = new DatabaseSync(this.path, { readOnly: true });
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.ino = ino;
		return this.db;
	}

	close() {
		try {
			this.db?.close();
		} catch {
			/* ignore */
		}
		this.db = null;
		this.ino = null;
	}

	private all(sql: string, ...params: (string | number | null)[]): Row[] {
		const db = this.conn();
		if (!db) return [];
		try {
			return db.prepare(sql).all(...params) as Row[];
		} catch (e) {
			// table may not exist on very old / fresh databases
			if (/no such (table|column)/.test((e as Error).message)) return [];
			this.close();
			throw e;
		}
	}

	private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
		return this.all(sql, ...params)[0];
	}

	private num(sql: string, ...params: (string | number | null)[]): number {
		const r = this.get(sql, ...params);
		if (!r) return 0;
		const v = Object.values(r)[0];
		return typeof v === "number" ? v : Number(v ?? 0) || 0;
	}

	apiKey(): string | null {
		const r = this.get("SELECT apikey FROM settings WHERE id = 0");
		return typeof r?.apikey === "string" && r.apikey ? r.apikey : null;
	}

	jobLastRuns(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const r of this.all("SELECT name, last_run FROM job_log")) {
			if (typeof r.name === "string" && typeof r.last_run === "number") out[r.name] = r.last_run;
		}
		return out;
	}

	/** host -> indexer name, like cross-seed's getHostToNameMap */
	hostToName(): Map<string, string> {
		const map = new Map<string, string>();
		for (const r of this.all("SELECT name, url, trackers FROM indexer")) {
			const name = typeof r.name === "string" ? r.name : null;
			if (!name) continue;
			for (const t of jsonOr<string[]>(r.trackers, [])) if (!map.has(t)) map.set(t, name);
			try {
				const host = new URL(String(r.url)).host;
				if (!map.has(host)) map.set(host, name);
			} catch {
				/* ignore */
			}
		}
		return map;
	}

	indexers(configUrls: string[], redact: (u: string) => string): Omit<IndexerInfo, "matches" | "injected">[] {
		const searchCounts = new Map<number, { n: number; last: number | null }>();
		for (const r of this.all(
			"SELECT indexer_id AS id, COUNT(*) AS n, MAX(last_searched) AS last FROM timestamp GROUP BY indexer_id",
		)) {
			searchCounts.set(Number(r.id), { n: Number(r.n), last: (r.last as number) ?? null });
		}
		const rows = this.all("SELECT * FROM indexer ORDER BY active DESC, name, url");
		const dbUrls = rows.map((r) => String(r.url));
		const out: Omit<IndexerInfo, "matches" | "injected">[] = rows.map((r) => {
			const id = Number(r.id);
			const url = String(r.url);
			return {
				id,
				name: (r.name as string) ?? null,
				url: redact(url),
				inConfig: configUrls.some((u) => sameIndexerUrl(u, url)),
				active: Boolean(r.active),
				status: (r.status as string) ?? null,
				retryAfter: (r.retry_after as number) ?? null,
				caps: {
					search: bool(r.search_cap),
					tv: bool(r.tv_search_cap),
					movie: bool(r.movie_search_cap),
					music: bool(r.music_search_cap),
					audio: bool(r.audio_search_cap),
					book: bool(r.book_search_cap),
				},
				tvIdCaps: jsonOr(r.tv_id_caps, null),
				movieIdCaps: jsonOr(r.movie_id_caps, null),
				categories: jsonOr(r.cat_caps, null),
				limits: jsonOr(r.limits_caps, null),
				trackers: jsonOr(r.trackers, null),
				searchees: searchCounts.get(id)?.n ?? 0,
				lastSearched: searchCounts.get(id)?.last ?? null,
			};
		});
		// indexers present in config but not yet seen by cross-seed (added since last restart)
		for (const u of configUrls) {
			if (dbUrls.some((d) => sameIndexerUrl(u, d))) continue;
			out.push({
				id: -1 - out.length,
				name: null,
				url: redact(u),
				inConfig: true,
				active: false,
				status: "PENDING_RESTART",
				retryAfter: null,
				caps: { search: null, tv: null, movie: null, music: null, audio: null, book: null },
				tvIdCaps: null,
				movieIdCaps: null,
				categories: null,
				limits: null,
				trackers: null,
				searchees: 0,
				lastSearched: null,
			});
		}
		return out;
	}

	library(): { searchees: number; clientTorrents: number; byClient: { host: string; count: number }[]; totalBytes: number; dataEntries: number; ensembleEntries: number } {
		const byClient = this.all(
			"SELECT client_host AS host, COUNT(*) AS count FROM client_searchee GROUP BY client_host ORDER BY count DESC",
		).map((r) => ({ host: String(r.host), count: Number(r.count) }));
		return {
			searchees: this.num("SELECT COUNT(*) FROM searchee"),
			clientTorrents: byClient.reduce((a, b) => a + b.count, 0),
			byClient,
			totalBytes: this.num("SELECT COALESCE(SUM(length), 0) FROM client_searchee"),
			dataEntries: this.num("SELECT COUNT(*) FROM data"),
			ensembleEntries: this.num("SELECT COUNT(*) FROM ensemble"),
		};
	}

	searchStats(now = Date.now()) {
		return {
			searched: this.num("SELECT COUNT(DISTINCT searchee_id) FROM timestamp"),
			neverSearched: this.num(
				"SELECT COUNT(*) FROM searchee s WHERE NOT EXISTS (SELECT 1 FROM timestamp t WHERE t.searchee_id = s.id)",
			),
			searched24h: this.num(
				"SELECT COUNT(DISTINCT searchee_id) FROM timestamp WHERE last_searched >= ?",
				now - 86_400_000,
			),
			searched7d: this.num(
				"SELECT COUNT(DISTINCT searchee_id) FROM timestamp WHERE last_searched >= ?",
				now - 7 * 86_400_000,
			),
			lastSearchAt: (this.get("SELECT MAX(last_searched) AS m FROM timestamp")?.m as number) ?? null,
		};
	}

	decisionStats(now = Date.now()) {
		const byDecision: Record<string, number> = {};
		let total = 0;
		for (const r of this.all("SELECT decision, COUNT(*) AS n FROM decision GROUP BY decision")) {
			byDecision[String(r.decision)] = Number(r.n);
			total += Number(r.n);
		}
		const inList = MATCH_DECISIONS.map(() => "?").join(",");
		const matchesSince = (ms: number) =>
			this.num(`SELECT COUNT(*) FROM decision WHERE decision IN (${inList}) AND first_seen >= ?`, ...MATCH_DECISIONS, now - ms);
		return {
			total,
			byDecision,
			matches: MATCH_DECISIONS.reduce((a, d) => a + (byDecision[d] ?? 0), 0),
			matches24h: matchesSince(86_400_000),
			matches7d: matchesSince(7 * 86_400_000),
			matches30d: matchesSince(30 * 86_400_000),
		};
	}

	/** matches per local day since `since` */
	matchesPerDay(since: number): Map<string, number> {
		const inList = MATCH_DECISIONS.map(() => "?").join(",");
		const out = new Map<string, number>();
		for (const r of this.all(
			`SELECT strftime('%Y-%m-%d', first_seen / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
			 FROM decision WHERE decision IN (${inList}) AND first_seen >= ? GROUP BY day`,
			...MATCH_DECISIONS,
			since,
		)) {
			out.set(String(r.day), Number(r.n));
		}
		return out;
	}

	/** decision history (what cross-seed concluded for each candidate) */
	decisions(opts: { search?: string; decision?: string; matchesOnly?: boolean; limit: number; offset: number }): Paged<DecisionRow> {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.search) {
			where.push("(s.name LIKE ? ESCAPE '\\' OR d.info_hash = ?)");
			params.push(`%${escapeLike(opts.search)}%`, opts.search.toLowerCase());
		}
		if (opts.decision) {
			where.push("d.decision = ?");
			params.push(opts.decision);
		} else if (opts.matchesOnly) {
			where.push(`d.decision IN (${MATCH_DECISIONS.map(() => "?").join(",")})`);
			params.push(...MATCH_DECISIONS);
		}
		const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
		const total = this.num(`SELECT COUNT(*) FROM decision d LEFT JOIN searchee s ON s.id = d.searchee_id ${w}`, ...params);
		const hostMap = this.hostToName();
		const rows = this.all(
			`SELECT d.id, s.name AS searchee, d.guid, d.info_hash, d.decision, d.first_seen, d.last_seen
			 FROM decision d LEFT JOIN searchee s ON s.id = d.searchee_id ${w}
			 ORDER BY COALESCE(d.last_seen, d.first_seen) DESC LIMIT ? OFFSET ?`,
			...params,
			opts.limit,
			opts.offset,
		).map((r) => {
			const guid = String(r.guid ?? "");
			let tracker: string | null = null;
			try {
				const host = new URL(guid).host;
				tracker = hostMap.get(host) ?? host;
			} catch {
				/* not a url */
			}
			return {
				id: Number(r.id),
				searchee: String(r.searchee ?? ""),
				tracker,
				guid: redactText(guid),
				infoHash: (r.info_hash as string) ?? null,
				decision: String(r.decision),
				firstSeen: (r.first_seen as number) ?? null,
				lastSeen: (r.last_seen as number) ?? null,
			};
		});
		return { rows, total, offset: opts.offset, limit: opts.limit };
	}

	libraryRows(opts: { search?: string; client?: string; sort?: string; limit: number; offset: number }): Paged<LibraryRow> {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.search) {
			where.push("(c.name LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.info_hash = ?)");
			const like = `%${escapeLike(opts.search)}%`;
			params.push(like, like, opts.search.toLowerCase());
		}
		if (opts.client) {
			where.push("c.client_host = ?");
			params.push(opts.client);
		}
		const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
		const order =
			{
				name: "c.name COLLATE NOCASE ASC",
				size: "c.length DESC",
				lastSearched: "last_searched DESC NULLS LAST",
				matches: "matches DESC",
			}[opts.sort ?? "name"] ?? "c.name COLLATE NOCASE ASC";
		const total = this.num(`SELECT COUNT(*) FROM client_searchee c ${w}`, ...params);
		const inList = MATCH_DECISIONS.map(() => "?").join(",");
		const rows = this.all(
			`SELECT c.*, s.id AS sid,
				(SELECT MIN(first_searched) FROM timestamp t WHERE t.searchee_id = s.id) AS first_searched,
				(SELECT MAX(last_searched) FROM timestamp t WHERE t.searchee_id = s.id) AS last_searched,
				(SELECT COUNT(*) FROM decision d WHERE d.searchee_id = s.id AND d.decision IN (${inList})) AS matches
			 FROM client_searchee c LEFT JOIN searchee s ON s.name = c.title
			 ${w} ORDER BY ${order} LIMIT ? OFFSET ?`,
			...MATCH_DECISIONS,
			...params,
			opts.limit,
			opts.offset,
		).map((r) => ({
			infoHash: String(r.info_hash),
			name: String(r.name ?? ""),
			title: String(r.title ?? ""),
			clientHost: String(r.client_host ?? ""),
			category: (r.category as string) ?? null,
			tags: jsonOr<string[]>(r.tags, []),
			trackers: jsonOr<string[]>(r.trackers, []).map((t) => {
				try {
					return new URL(t).host;
				} catch {
					return redactText(t);
				}
			}),
			length: Number(r.length ?? 0),
			savePath: String(r.save_path ?? ""),
			firstSearched: (r.first_searched as number) ?? null,
			lastSearched: (r.last_searched as number) ?? null,
			matches: Number(r.matches ?? 0),
		}));
		return { rows, total, offset: opts.offset, limit: opts.limit };
	}

	clientHosts(): string[] {
		return this.all("SELECT DISTINCT client_host FROM client_searchee ORDER BY client_host").map((r) => String(r.client_host));
	}
}

function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** cross-seed stores the configured URL; compare ignoring a trailing slash */
function sameIndexerUrl(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
