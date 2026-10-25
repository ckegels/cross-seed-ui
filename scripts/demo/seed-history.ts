/**
 * Demo-only: give a fresh cross-seed config dir two weeks of believable
 * history, in cross-seed's own formats:
 *   - logs/info|verbose|error.<date>.log for the previous 13 days
 *   - cross-seed.db rows: indexers, searchees, per-indexer timestamps,
 *     decisions (matches + rejections), job_log
 * Run after `cross-seed api-key` created the database and before the daemon starts.
 *
 *   node --import tsx scripts/demo/seed-history.ts <crossSeedDir> <a|b> <mockBaseUrl>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIBRARY, LISTINGS, prowlarrName, rng, sha1, TRACKERS } from "./catalog.ts";

const [dir, inst, mockBase] = process.argv.slice(2) as [string, "a" | "b", string];
if (!dir || !inst || !mockBase) throw new Error("usage: seed-history.ts <crossSeedDir> <a|b> <mockBaseUrl>");
const PROWLARR_KEY = "demo0prowlarr0key0123456789abcdef";
const DAY = 86_400_000;
const lib = LIBRARY.filter((r) => r.instance === inst);
const exact = LISTINGS.filter((l) => l.release.instance === inst && l.kind === "exact");
const rejects = LISTINGS.filter((l) => l.release.instance === inst && l.kind !== "exact");
const R = rng(`history-${inst}`);
const pick = <T>(arr: T[]) => arr[Math.floor(R() * arr.length)];

const p2 = (n: number, l = 2) => String(n).padStart(l, "0");
const stamp = (t: number) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`;
};
const dayKey = (t: number) => stamp(t).slice(0, 10);
const human = (t: number) => stamp(t).slice(0, 19);

type Line = { t: number; level: string; label: string | null; msg: string };
const lines: Line[] = [];
const log = (t: number, level: string, label: string | null, msg: string) => lines.push({ t, level, label, msg });

const client = `qbittorrent:127.0.0.1:${new URL(mockBase).port}`;
const short = (h: string) => `${h.slice(0, 8)}...`;

// ---------------------------------------------------------------- database
const db = new DatabaseSync(join(dir, "cross-seed.db"));
db.exec("PRAGMA foreign_keys = OFF");
const insIndexer = db.prepare(
	`INSERT OR REPLACE INTO indexer (id, name, url, apikey, active, status, retry_after, search_cap, tv_search_cap, movie_search_cap, music_search_cap, audio_search_cap, book_search_cap, tv_id_caps, movie_id_caps, cat_caps, limits_caps, trackers)
	 VALUES (?, ?, ?, ?, 1, NULL, NULL, 1, 1, 1, 0, 0, 0, ?, ?, ?, ?, ?)`,
);
for (const t of TRACKERS) {
	insIndexer.run(
		t.id,
		prowlarrName(t),
		`${mockBase}/${t.id}/api`,
		PROWLARR_KEY,
		JSON.stringify({ tvdbId: true, imdbId: true }),
		JSON.stringify({ tmdbId: true, imdbId: true }),
		JSON.stringify({ tv: true, movie: true, anime: true, xxx: false, audio: false, book: false, additional: false }),
		JSON.stringify({ default: 100, max: 100 }),
		JSON.stringify([t.host]),
	);
}
const insSearchee = db.prepare("INSERT OR IGNORE INTO searchee (name) VALUES (?)");
const searcheeId = (name: string): number => {
	insSearchee.run(name);
	return (db.prepare("SELECT id FROM searchee WHERE name = ?").get(name) as { id: number }).id;
};
const insTs = db.prepare(
	"INSERT INTO timestamp (searchee_id, indexer_id, first_searched, last_searched) VALUES (?, ?, ?, ?) ON CONFLICT(searchee_id, indexer_id) DO UPDATE SET last_searched = excluded.last_searched",
);
const insDecision = db.prepare(
	"INSERT OR REPLACE INTO decision (searchee_id, guid, info_hash, decision, first_seen, last_seen, fuzzy_size_factor) VALUES (?, ?, ?, ?, ?, ?, 0.02)",
);
const REJECT_DECISION = { size: "SIZE_MISMATCH", group: "RELEASE_GROUP_MISMATCH" } as const;

// ---------------------------------------------------------------- 13 days of activity
const now = Date.now();
const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const injectedNames = new Set<string>();
let failedOnce = false;

for (let d = 13; d >= 1; d--) {
	const day0 = midnight - d * DAY;
	// startup on the first day
	if (d === 13) {
		log(day0 + 60_000, "info", null, "cross-seed v6.13.9");
		log(day0 + 60_100, "info", null, "Validating your configuration...");
		log(day0 + 60_400, "info", null, "Your configuration is valid!");
		log(day0 + 61_000, "info", "server", "Server is running on port 2468, ^C to stop.");
	}
	// RSS every 30 minutes
	for (let m = 0; m < 24 * 60; m += 30) {
		const t = day0 + m * 60_000 + Math.floor(R() * 20_000);
		log(t, "info", "scheduler", "starting job: rss");
		const n = 8 + Math.floor(R() * 40);
		if (R() < 0.12 && exact.length) {
			const l = pick(exact);
			if (!injectedNames.has(`${l.release.key}${l.tracker.id}`)) {
				injectedNames.add(`${l.release.key}${l.tracker.id}`);
				log(t + 4000, "info", "rss", `Found ${l.name} on ${prowlarrName(l.tracker)} by MATCH from torrentClient (${l.release.name} [${short(l.release.hash)}@${client}]) - injected`);
				const sid = searcheeId(l.release.name);
				insDecision.run(sid, l.guid, sha1(l.guid), "MATCH", t + 4000, t + 4000);
			}
		}
		log(t + 6000, "info", "rss", `RSS scan complete - checked ${n} new candidates since ${human(t - 30 * 60_000)}`);
		log(t + 6010, "info", "scheduler", "rss: last run 6s ago, next run in 30m");
		// announces from autobrr between scans
		for (let a = 0; a < 6 + Math.floor(R() * 10); a++) {
			const l = pick(LISTINGS);
			log(t + 60_000 + a * 90_000, "verbose", "announce", `Received announce from ${prowlarrName(l.tracker)}: ${l.name}`);
		}
	}
	// hourly inject job
	for (let h = 0; h < 24; h++) {
		const t = day0 + h * 3_600_000 + 1_200_000;
		log(t, "info", "scheduler", "starting job: inject");
		log(t + 50, "info", "inject", `No torrent files are awaiting injection in ${join(dir, "cross-seeds")}`);
		log(t + 60, "info", "scheduler", "inject: last run 60ms ago, next run in 1h");
	}
	// nightly bulk search at ~03:00
	const s0 = day0 + 3 * 3_600_000 + Math.floor(R() * 600_000);
	const batch = [...lib].sort(() => R() - 0.5).slice(0, 25 + Math.floor(R() * 25));
	log(s0, "info", "scheduler", "starting job: search");
	log(s0 + 100, "info", "search", "Gathering searchees...");
	log(s0 + 900, "info", "search", "Filtering searchees based on config...");
	log(s0 + 1500, "info", "search", `Found ${lib.length} torrents, ${batch.length} suitable to search for matches using ${batch.length} unique queries`);
	let found = 0;
	batch.forEach((rel, i) => {
		const t = s0 + 2000 + i * 31_000;
		const media = rel.category.startsWith("movies") ? "MOVIE" : rel.category === "anime" ? "ANIME" : "SEASON";
		const ids = media === "MOVIE" ? `TMDB: ${100000 + parseInt(rel.hash.slice(0, 5), 16) % 800000}` : media === "SEASON" ? `TVDB: ${300000 + parseInt(rel.hash.slice(0, 5), 16) % 99999}` : "NONE";
		log(t, "info", "search", `(${i + 1}/${batch.length}) Searching for ${rel.name} [${short(rel.hash)}@${client}] | MediaType: ${media} | IDs: ${ids}`);
		const sid = searcheeId(rel.name);
		for (const tr of TRACKERS) insTs.run(sid, tr.id, t - 30 * DAY, t);
		for (const l of LISTINGS.filter((x) => x.release.key === rel.key)) {
			if (l.kind === "exact") {
				const key = `${l.release.key}${l.tracker.id}`;
				let result = injectedNames.has(key) ? "exists" : "injected";
				if (!failedOnce && result === "injected" && d === 4) {
					result = "failed to inject, saving...";
					failedOnce = true;
				}
				injectedNames.add(key);
				if (result === "exists") continue;
				found++;
				log(t + 3000, result.startsWith("failed") ? "error" : "info", "search", `Found ${l.name} on ${prowlarrName(l.tracker)} by MATCH from torrentClient (${rel.name} [${short(rel.hash)}@${client}]) - ${result}`);
				if (result.startsWith("failed")) log(t + 3010, "error", "qbittorrent", `[qbittorrent@127.0.0.1] Injection failed for ${l.name}: Failed to retrieve torrent after adding`);
				insDecision.run(sid, l.guid, sha1(l.guid), "MATCH", t + 3000, t + 3000);
			} else {
				insDecision.run(sid, l.guid, sha1(l.guid), REJECT_DECISION[l.kind], t + 2500, t + 2500);
				log(t + 2500, "verbose", "decide", `${rel.name} - no match for ${prowlarrName(l.tracker)} torrent ${l.name} - ${REJECT_DECISION[l.kind]}`);
			}
		}
		// occasional rate limit on Lumen
		if (R() < 0.05) {
			log(t + 1000, "error", "search", `Failed to reach Lumen (Prowlarr): request failed with code 429 due to rate limiting, snoozing until ${human(t + 1_800_000)}`);
		}
	});
	const sEnd = s0 + 2000 + batch.length * 31_000 + 5000;
	log(sEnd, "info", "search", `Found ${found} cross seeds from ${batch.length} original torrents`);
	log(sEnd + 10, "info", "scheduler", `search: last run ${Math.round((sEnd - s0) / 60_000)}m ago, next run in 24h`);
	// daily cleanup + caps
	log(day0 + 4 * 3_600_000, "info", "scheduler", "starting job: cleanup");
	log(day0 + 4 * 3_600_000 + 8000, "info", "scheduler", "cleanup: last run 8s ago, next run in 24h");
	log(day0 + 4 * 3_600_000 + 9000, "info", "scheduler", "starting job: updateIndexerCaps");
	log(day0 + 4 * 3_600_000 + 12000, "info", "scheduler", "updateIndexerCaps: last run 3s ago, next run in 24h");
}

// rejections recorded for the rest of the library too, so the decision chart is meaningful
for (const l of rejects) {
	const t = now - Math.floor(R() * 13 * DAY);
	insDecision.run(searcheeId(l.release.name), l.guid, sha1(l.guid), REJECT_DECISION[l.kind as "size" | "group"], t, t);
}

const yesterdaySearch = midnight - DAY + 3 * 3_600_000;
for (const [name, lastRun] of [
	["rss", now - 25 * 60_000],
	["search", yesterdaySearch],
	["inject", now - 30 * 60_000],
	["cleanup", midnight - DAY + 4 * 3_600_000],
	["updateIndexerCaps", midnight - DAY + 4 * 3_600_000],
] as const) {
	db.prepare("INSERT INTO job_log (name, last_run) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run").run(name, lastRun);
}
db.close();

// ---------------------------------------------------------------- write logs
const RANK: Record<string, number> = { error: 0, warn: 1, info: 2, verbose: 4 };
const byDay = new Map<string, Line[]>();
for (const l of lines.sort((a, b) => a.t - b.t)) {
	const k = dayKey(l.t);
	(byDay.get(k) ?? byDay.set(k, []).get(k)!).push(l);
}
const logs = join(dir, "logs");
mkdirSync(logs, { recursive: true });
const fmt = (l: Line) => `${stamp(l.t)} ${l.level}: ${l.label ? `[${l.label}] ` : ""}${l.msg}\n`;
for (const [day, ls] of byDay) {
	writeFileSync(join(logs, `verbose.${day}.log`), ls.map(fmt).join(""));
	writeFileSync(join(logs, `info.${day}.log`), ls.filter((l) => RANK[l.level] <= 2).map(fmt).join(""));
	writeFileSync(join(logs, `error.${day}.log`), ls.filter((l) => l.level === "error").map(fmt).join(""));
}
console.log(`[seed ${inst}] ${lines.length} log lines over ${byDay.size} days, ${injectedNames.size} cross-seeds, library ${lib.length}`);
