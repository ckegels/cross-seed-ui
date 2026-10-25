/**
 * Follows cross-seed's log files, turns lines into events/statistics and
 * keeps a live picture of what the daemon is doing.
 *
 * cross-seed writes logs/<level>.<YYYY-MM-DD>.log (winston daily rotate,
 * 14 days). The verbose file contains every level, so it is the one we follow
 * (falls back to info.* if verbose files are missing).
 *
 * Progress is stored per file (byte offset) in the agent DB, in the same
 * transaction as the extracted events, so each line is processed exactly once.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type Activity,
	type LogEntry,
	type LogEvent,
	type LogLine,
	type MatchEvent,
	extractEvent,
	parseLogLine,
	redactText,
} from "@csui/shared";
import type { StateDb } from "./state.ts";

const POLL_MS = 2000;
const MAX_CHUNK = 8 * 1024 * 1024;
const LIVE_BUFFER = 1000;

export type LogKind = "verbose" | "info" | "error";
const FILE_RE = /^(verbose|info|error)\.(\d{4}-\d{2}-\d{2})\.log$/;

export interface LogFile {
	kind: LogKind;
	date: string;
	name: string;
	path: string;
	size: number;
}

export async function listLogFiles(logsDir: string): Promise<LogFile[]> {
	const names = await readdir(logsDir).catch(() => [] as string[]);
	const out: LogFile[] = [];
	for (const name of names) {
		const m = FILE_RE.exec(name);
		if (!m) continue;
		const st = await stat(join(logsDir, name)).catch(() => null);
		if (!st?.isFile()) continue;
		out.push({ kind: m[1] as LogKind, date: m[2], name, path: join(logsDir, name), size: st.size });
	}
	return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function dayOf(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- activity

export class ActivityTracker {
	running = new Map<string, number>();
	progress: Activity["progress"] = null;
	private avgGap: number | null = null;
	private lastProgressTs: number | null = null;
	lastEvent: Activity["lastEvent"] = null;
	lastMatch: MatchEvent | null = null;
	lastError: Activity["lastError"] = null;
	lastLogAt: number | null = null;
	/** set while cross-seed validates its config / indexes torrents after a (re)start */
	bootingSince: number | null = null;

	feed(e: LogEntry, ev: LogEvent | null) {
		this.lastLogAt = e.ts;
		if (e.label === null && e.message === "Validating your configuration...") {
			this.bootingSince = e.ts;
			this.running.clear();
			this.resetProgress();
		}
		if (e.message.includes("Your configuration is invalid")) this.bootingSince = null;
		// the daemon is evidently running (CLI runs like test-notification also log "Validating...")
		if (this.bootingSince !== null && e.label && ["scheduler", "rss", "announce", "webhook", "server"].includes(e.label)) {
			this.bootingSince = null;
		}
		if (["info", "warn", "error"].includes(e.level)) {
			this.lastEvent = { ts: e.ts, text: shorten(`${e.label ? `[${e.label}] ` : ""}${e.message}`) };
		}
		if (!ev) return;
		switch (ev.type) {
			case "server-start":
				this.running.clear();
				this.progress = null;
				this.bootingSince = null;
				break;
			case "job-start":
				this.running.set(ev.job, e.ts);
				if (ev.job === "search" || ev.job === "rss") this.resetProgress();
				break;
			case "job-schedule":
				this.running.delete(ev.job);
				if (ev.job === "search") this.resetProgress();
				break;
			case "search-complete":
				this.resetProgress();
				break;
			case "search-progress": {
				if (this.lastProgressTs !== null && this.progress && ev.index === this.progress.index + 1) {
					const gap = e.ts - this.lastProgressTs;
					this.avgGap = this.avgGap === null ? gap : this.avgGap * 0.8 + gap * 0.2;
				}
				this.lastProgressTs = e.ts;
				this.progress = {
					via: ev.via,
					index: ev.index,
					total: ev.total,
					name: ev.name,
					ts: e.ts,
					etaMs: this.avgGap !== null ? Math.round(this.avgGap * (ev.total - ev.index)) : null,
				};
				break;
			}
			case "match":
				this.lastMatch = {
					id: 0,
					ts: e.ts,
					via: ev.via,
					name: ev.name,
					tracker: ev.tracker,
					decision: ev.decision,
					result: ev.result,
					source: ev.source,
					searchee: ev.searchee,
				};
				break;
			case "error":
				this.lastError = { ts: e.ts, text: shorten(e.message) };
				break;
		}
	}

	/** called when the daemon API answers: whatever logged "Validating..." isn't a boot in progress */
	markOnline() {
		this.bootingSince = null;
	}

	private resetProgress() {
		this.progress = null;
		this.avgGap = null;
		this.lastProgressTs = null;
	}

	snapshot(serviceActive: boolean, serviceStarting = false): Activity {
		const runningJobs = [...this.running].map(([name, since]) => ({ name, since }));
		let state = "idle";
		const booting = this.bootingSince !== null && Date.now() - this.bootingSince < 30 * 60_000;
		if (serviceStarting || (serviceActive && booting)) state = "starting";
		else if (!serviceActive) state = "stopped";
		else if (this.running.has("search")) state = "searching";
		else if (this.running.has("rss")) state = "rss";
		else if (this.running.has("inject")) state = "injecting";
		else if (this.running.has("cleanup")) state = "cleanup";
		else if (this.running.has("updateIndexerCaps")) state = "caps";
		// a webhook/announce triggered search shows progress without a job
		if (state === "idle" && this.progress) {
			const age = Date.now() - this.progress.ts;
			const finished = this.progress.index >= this.progress.total;
			if (age < (finished ? 30_000 : 5 * 60_000)) state = "searching";
		}
		return {
			state,
			runningJobs,
			progress: state === "searching" || state === "rss" ? this.progress : null,
			lastEvent: this.lastEvent,
			lastMatch: this.lastMatch,
			lastError: this.lastError,
			lastLogAt: this.lastLogAt,
		};
	}
}

function shorten(s: string, n = 300) {
	const one = redactText(s.split("\n")[0]);
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

// ---------------------------------------------------------------- tailer

type Listener = (line: LogLine) => void;

/** Events stored one row each; high-volume ones only as daily counters. */
const STORED_EVENTS = new Set([
	"match",
	"inject-job",
	"job-start",
	"job-schedule",
	"search-start",
	"search-complete",
	"rss-complete",
	"indexer-error",
	"server-start",
	"error",
]);

export class LogTailer {
	readonly logsDir: string;
	readonly activity = new ActivityTracker();
	private listeners = new Set<Listener>();
	private timer: NodeJS.Timeout | null = null;
	private busy = false;
	private kind: LogKind = "verbose";
	readonly live: LogLine[] = [];

	constructor(
		crossSeedDir: string,
		private db: StateDb,
		private opts: { backfill: boolean; retentionDays: number },
	) {
		this.logsDir = join(crossSeedDir, "logs");
	}

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	async start() {
		await this.prime();
		await this.poll();
		this.timer = setInterval(() => void this.poll(), POLL_MS);
		this.timer.unref();
		setInterval(() => this.prune(), 6 * 3600_000).unref();
		this.prune();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
	}

	/** First run: decide where to start, and rebuild the activity view. */
	private async prime() {
		const files = await listLogFiles(this.logsDir);
		this.kind = files.some((f) => f.kind === "verbose") ? "verbose" : "info";
		const mine = files.filter((f) => f.kind === this.kind);
		const hasCursors = (this.db.prepare("SELECT COUNT(*) AS n FROM log_cursor").get() as { n: number }).n > 0;
		if (!hasCursors && !this.opts.backfill) {
			const ins = this.db.prepare(
				"INSERT OR REPLACE INTO log_cursor (file, inode, offset, updated_at) VALUES (?, NULL, ?, ?)",
			);
			for (const f of mine) ins.run(f.name, f.size, Date.now());
		}
		// rebuild live activity from the tail of the newest file (not stored again)
		const newest = mine.at(-1);
		if (newest) {
			const cursor = this.cursor(newest.name);
			const end = cursor ?? newest.size;
			const start = Math.max(0, end - 2 * 1024 * 1024);
			const text = await readRange(newest.path, start, end);
			const lines = text.split("\n");
			if (start > 0) lines.shift();
			for (const line of lines) {
				const e = parseLogLine(line);
				if (!e) continue;
				this.activity.feed(e, extractEvent(e));
				this.pushLive(e, false);
			}
		}
	}

	private cursor(file: string): number | null {
		const r = this.db.prepare("SELECT offset FROM log_cursor WHERE file = ?").get(file) as { offset: number } | undefined;
		return r ? r.offset : null;
	}

	async poll() {
		if (this.busy) return;
		this.busy = true;
		try {
			const files = (await listLogFiles(this.logsDir)).filter((f) => f.kind === this.kind);
			if (!files.length) {
				// verbose may appear later (first daemon start)
				const all = await listLogFiles(this.logsDir);
				if (all.some((f) => f.kind === "verbose")) this.kind = "verbose";
				return;
			}
			for (const f of files) {
				let offset = this.cursor(f.name) ?? 0;
				if (f.size < offset) offset = 0; // truncated / replaced
				while (offset < f.size) {
					const end = Math.min(f.size, offset + MAX_CHUNK);
					const text = await readRange(f.path, offset, end);
					const lastNl = text.lastIndexOf("\n");
					if (lastNl < 0) {
						if (end === f.size) break; // partial line, wait for more
						offset = end; // absurdly long line, skip
						continue;
					}
					const complete = text.slice(0, lastNl + 1);
					const consumed = Buffer.byteLength(complete);
					this.processChunk(f.name, complete, offset + consumed);
					offset += consumed;
				}
			}
		} catch (e) {
			console.error("[logs] poll failed:", (e as Error).message);
		} finally {
			this.busy = false;
		}
	}

	private processChunk(file: string, text: string, newOffset: number) {
		const insertEvent = this.db.prepare(
			`INSERT OR IGNORE INTO events (ts, type, via, name, tracker, decision, result, source, searchee, data, fingerprint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const bump = this.db.prepare(
			`INSERT INTO daily_counts (day, kind, key, n) VALUES (?, ?, ?, 1)
			 ON CONFLICT(day, kind, key) DO UPDATE SET n = n + 1`,
		);
		let last: LogEntry | null = null;
		this.db.exec("BEGIN");
		try {
			for (const line of text.split("\n")) {
				if (!line) continue;
				const e = parseLogLine(line);
				if (!e) {
					// continuation line (stack trace...) - live view only
					if (last) this.emit({ ts: last.ts, level: last.level, label: last.label, message: redactText(line) });
					continue;
				}
				last = e;
				const ev = extractEvent(e);
				this.activity.feed(e, ev);
				this.pushLive(e, true);
				if (!ev) continue;
				const day = dayOf(e.ts);
				switch (ev.type) {
					case "search-progress":
						if (!ev.skipped) bump.run(day, "searches", ev.via);
						break;
					case "announce":
						bump.run(day, "announces", ev.tracker);
						break;
					case "webhook":
						bump.run(day, "webhooks", "");
						break;
					case "rate-limited":
						bump.run(day, "rate_limited", ev.indexer);
						break;
					case "indexer-error":
						bump.run(day, "indexer_errors", ev.indexer);
						break;
					case "error":
						bump.run(day, "errors", e.label ?? "");
						break;
				}
				if (!STORED_EVENTS.has(ev.type)) continue;
				const fp = `${e.ts}|${e.message.slice(0, 200)}`;
				if (ev.type === "match") {
					insertEvent.run(e.ts, "match", ev.via, ev.name, ev.tracker, ev.decision, ev.result, ev.source, ev.searchee, null, fp);
				} else if (ev.type === "inject-job") {
					insertEvent.run(e.ts, "inject-job", "inject", ev.name, null, null, ev.result, null, null, redactText(ev.detail), fp);
				} else if (ev.type === "error" || ev.type === "indexer-error") {
					insertEvent.run(e.ts, ev.type, e.label, null, ev.type === "indexer-error" ? ev.indexer : null, null, null, null, null, redactText(e.message.slice(0, 4000)), fp);
				} else {
					insertEvent.run(e.ts, ev.type, e.label, null, null, null, null, null, null, JSON.stringify(ev), fp);
				}
			}
			this.db
				.prepare(
					"INSERT INTO log_cursor (file, inode, offset, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at",
				)
				.run(file, newOffset, Date.now());
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	private pushLive(e: LogEntry, emit: boolean) {
		const line: LogLine = { ts: e.ts, level: e.level, label: e.label, message: redactText(e.message) };
		this.live.push(line);
		if (this.live.length > LIVE_BUFFER) this.live.splice(0, this.live.length - LIVE_BUFFER);
		if (emit) this.emit(line);
	}

	private emit(line: LogLine) {
		for (const l of this.listeners) {
			try {
				l(line);
			} catch {
				/* listener errors must not break tailing */
			}
		}
	}

	private prune() {
		const now = Date.now();
		this.db.prepare("DELETE FROM events WHERE ts < ? AND type NOT IN ('error', 'indexer-error')").run(now - this.opts.retentionDays * 86_400_000);
		this.db.prepare("DELETE FROM events WHERE ts < ? AND type IN ('error', 'indexer-error')").run(now - 30 * 86_400_000);
		this.db.prepare("DELETE FROM daily_counts WHERE day < ?").run(dayOf(now - this.opts.retentionDays * 86_400_000));
		// forget cursors of files cross-seed already deleted
		const keep = this.db.prepare("SELECT file FROM log_cursor").all() as { file: string }[];
		void listLogFiles(this.logsDir).then((files) => {
			const present = new Set(files.map((f) => f.name));
			const del = this.db.prepare("DELETE FROM log_cursor WHERE file = ?");
			for (const { file } of keep) if (!present.has(file)) del.run(file);
		});
	}
}

export async function readRange(path: string, start: number, end: number): Promise<string> {
	if (end <= start) return "";
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(end - start);
		const { bytesRead } = await fh.read(buf, 0, buf.length, start);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
}

const LEVEL_RANK: Record<string, number> = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };

export interface LogQuery {
	kind: LogKind;
	date?: string;
	level?: string;
	label?: string;
	search?: string;
	limit: number;
}

/** Read and filter one log file (newest entries last). */
export async function queryLogs(logsDir: string, q: LogQuery): Promise<{ lines: LogLine[]; files: { date: string; kind: LogKind; size: number }[]; truncated: boolean }> {
	const files = await listLogFiles(logsDir);
	const ofKind = files.filter((f) => f.kind === q.kind);
	const file = q.date ? ofKind.find((f) => f.date === q.date) : ofKind.at(-1);
	const fileList = files.map((f) => ({ date: f.date, kind: f.kind, size: f.size }));
	if (!file) return { lines: [], files: fileList, truncated: false };
	const MAX = 24 * 1024 * 1024;
	const start = Math.max(0, file.size - MAX);
	const text = await readRange(file.path, start, file.size);
	const raw = text.split("\n");
	if (start > 0) raw.shift();
	const maxRank = q.level ? (LEVEL_RANK[q.level] ?? 6) : 6;
	const search = q.search?.toLowerCase();
	const out: LogLine[] = [];
	let last: LogLine | null = null;
	for (const lineText of raw) {
		if (!lineText) continue;
		const e = parseLogLine(lineText);
		if (!e) {
			if (last) last.message += `\n${redactText(lineText)}`;
			continue;
		}
		last = null;
		if ((LEVEL_RANK[e.level] ?? 6) > maxRank) continue;
		if (q.label && e.label !== q.label) continue;
		if (search && !e.message.toLowerCase().includes(search)) continue;
		last = { ts: e.ts, level: e.level, label: e.label, message: redactText(e.message) };
		out.push(last);
	}
	return { lines: out.slice(-q.limit), files: fileList, truncated: start > 0 || out.length > q.limit };
}
