/**
 * Parser for cross-seed v6 log files (winston, see src/logger.ts):
 *   "YYYY-MM-DD HH:mm:ss.SSS <level>: [<label>] <message>"
 * Lines that don't match are continuation lines (stack traces, multi-line messages).
 *
 * `extractEvent` recognises the messages that matter for statistics and the
 * "what is it doing" view. Patterns come from cross-seed v6.13.9 sources:
 * action.ts (logActionResultImpl), inject.ts, torznab.ts, pipeline.ts, jobs.ts.
 * Browser-safe.
 */

export interface LogEntry {
	/** epoch ms (local time of the LXC as written by winston) */
	ts: number;
	level: string;
	label: string | null;
	message: string;
}

const LINE_REGEX =
	/^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})(?:\.(?<ms>\d{3}))? (?<level>[a-z]+): (?:\[(?<label>[^\]]+)\] )?(?<message>.*)$/;

export function parseLogLine(line: string): LogEntry | null {
	const m = LINE_REGEX.exec(line);
	if (!m?.groups) return null;
	const { date, time, ms, level, label, message } = m.groups;
	const ts = new Date(`${date}T${time}.${ms ?? "000"}`).getTime();
	return { ts, level, label: label ?? null, message };
}

/** Parse a chunk of text into entries, folding continuation lines. */
export function parseLogText(text: string): LogEntry[] {
	const out: LogEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const entry = parseLogLine(line);
		if (entry) out.push(entry);
		else if (out.length) out[out.length - 1].message += `\n${line}`;
	}
	return out;
}

export type MatchResult = "injected" | "saved" | "exists" | "incomplete" | "failed";

export type LogEvent =
	| {
			type: "match";
			/** search | rss | announce | webhook | inject */
			via: string;
			name: string;
			tracker: string;
			decision: string;
			source: string;
			searchee: string;
			result: MatchResult;
	  }
	| {
			type: "inject-job";
			name: string;
			result: "injected" | "failed" | "rechecking" | "other";
			detail: string;
	  }
	| { type: "job-start"; job: string }
	| { type: "job-schedule"; job: string; lastRun: string; nextRun: string }
	| {
			type: "search-progress";
			via: string;
			index: number;
			total: number;
			name: string;
			skipped: boolean;
			mediaType: string;
			ids: string;
	  }
	| { type: "search-start"; torrents: number; suitable: number; queries: number }
	| { type: "search-complete"; found: number; searched: number }
	| { type: "rss-complete"; candidates: number }
	| { type: "announce"; tracker: string; name: string }
	| { type: "webhook"; criteria: string }
	| { type: "indexer-error"; indexer: string; message: string }
	| { type: "rate-limited"; indexer: string; message: string }
	| { type: "server-start"; port: number }
	| { type: "error"; label: string | null; message: string };

const MATCH_RESULT: Record<string, MatchResult> = {
	injected: "injected",
	saved: "saved",
	exists: "exists",
	"source is incomplete, saving...": "incomplete",
	"failed to inject, saving...": "failed",
};

const MATCH_REGEX =
	/^Found (?<name>.+) on (?<tracker>.+?) by (?<decision>MATCH|MATCH_SIZE_ONLY|MATCH_PARTIAL) from (?<source>\S+) \((?<searchee>.*)\) - (?<result>injected|saved|exists|source is incomplete, saving\.\.\.|failed to inject, saving\.\.\.)$/;
const PROGRESS_REGEX =
	/^\((?<i>\d+)\/(?<n>\d+)\) (?<what>Searching for|Skipped searching on indexers for) (?<name>.+?)(?: \(filtered by .+?\))? \| MediaType: (?<media>\S+) \| IDs: (?<ids>.*)$/;
const INJECT_JOB_REGEX = /^\((?<i>\d+)\/(?<n>\d+)\) (?<rest>.+)$/;

/** Remove the dim "[name [hash...@host]]" suffix cross-seed appends to titles. */
export function cleanTitle(s: string): string {
	let out = s;
	// strip a trailing balanced [...] group
	if (out.endsWith("]")) {
		let depth = 0;
		for (let i = out.length - 1; i >= 0; i--) {
			if (out[i] === "]") depth++;
			else if (out[i] === "[") {
				depth--;
				if (depth === 0) {
					const head = out.slice(0, i).trimEnd();
					if (head) out = head;
					break;
				}
			}
		}
	}
	return out;
}

export function extractEvent(e: LogEntry): LogEvent | null {
	const msg = e.message;
	const label = e.label ?? "";

	if (msg.startsWith("Found ")) {
		const m = MATCH_REGEX.exec(msg);
		if (m?.groups) {
			return {
				type: "match",
				via: label,
				name: cleanTitle(m.groups.name),
				tracker: m.groups.tracker,
				decision: m.groups.decision,
				source: m.groups.source,
				searchee: cleanTitle(m.groups.searchee),
				result: MATCH_RESULT[m.groups.result],
			};
		}
		const s = /^Found (\d+) cross seeds from (\d+) original torrents/.exec(msg);
		if (s) return { type: "search-complete", found: +s[1], searched: +s[2] };
		const st = /^Found (\d+) torrents, (\d+) suitable to search for matches using (\d+) unique queries/.exec(msg);
		if (st) return { type: "search-start", torrents: +st[1], suitable: +st[2], queries: +st[3] };
	}

	if (msg.startsWith("(")) {
		const p = PROGRESS_REGEX.exec(msg);
		if (p?.groups) {
			return {
				type: "search-progress",
				via: label,
				index: +p.groups.i,
				total: +p.groups.n,
				name: cleanTitle(p.groups.name),
				skipped: p.groups.what.startsWith("Skipped"),
				mediaType: p.groups.media,
				ids: p.groups.ids,
			};
		}
		if (label === "inject") {
			const ij = INJECT_JOB_REGEX.exec(msg);
			if (ij?.groups) {
				const rest = ij.groups.rest;
				let result: "injected" | "failed" | "rechecking" | "other" = "other";
				if (/^Injected /.test(rest)) result = "injected";
				else if (/^(Failed|Unable) to inject/.test(rest)) result = "failed";
				else if (/^Rechecking /.test(rest)) result = "rechecking";
				const nm = /^(?:Injected|Failed to inject|Unable to inject|Rechecking) (?<n>.+?)(?: using stalled source.*)? - [A-Z_]+/.exec(rest);
				return {
					type: "inject-job",
					name: nm?.groups ? cleanTitle(nm.groups.n) : rest,
					result,
					detail: rest,
				};
			}
		}
	}

	if (label === "scheduler") {
		const js = /^starting job: (\w+)/.exec(msg);
		if (js) return { type: "job-start", job: js[1] };
		const sch = /^(\w+): last run (.+), next run (.+)$/.exec(msg);
		if (sch) return { type: "job-schedule", job: sch[1], lastRun: sch[2], nextRun: sch[3] };
	}

	if (label === "rss") {
		const r = /^RSS scan complete - checked (\d+) new candidates/.exec(msg);
		if (r) return { type: "rss-complete", candidates: +r[1] };
	}

	if (label === "announce") {
		const a = /^Received announce from (.+?): (.+)$/.exec(msg);
		if (a) return { type: "announce", tracker: a[1], name: a[2] };
	}

	if (label === "webhook") {
		const w = /^Received search request: (.+)$/s.exec(msg);
		if (w) return { type: "webhook", criteria: w[1] };
	}

	if (label === "server") {
		const s = /^Server is running on port (\d+)/.exec(msg);
		if (s) return { type: "server-start", port: +s[1] };
	}

	const reach = /^Failed to reach (.+?): (.+)$/s.exec(msg);
	if (reach) return { type: "indexer-error", indexer: reach[1], message: reach[2] };
	if (/rate limit/i.test(msg) || /snoozing until/.test(msg)) {
		const ix = /^(.+?) was rate limited/.exec(msg);
		return { type: "rate-limited", indexer: ix ? ix[1] : label, message: msg };
	}

	if (e.level === "error") return { type: "error", label: e.label, message: msg };
	return null;
}
