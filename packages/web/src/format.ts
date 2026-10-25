export function bytes(n: number | null | undefined, digits = 1): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

const nf = new Intl.NumberFormat();
const cf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function num(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	return nf.format(n);
}

export function compact(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	return n < 10_000 ? nf.format(n) : cf.format(n);
}

export function duration(ms: number | null | undefined, parts = 2): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
	const neg = ms < 0;
	let rest = Math.abs(ms);
	const out: string[] = [];
	for (const [label, size] of [
		["d", 86_400_000],
		["h", 3_600_000],
		["m", 60_000],
		["s", 1000],
	] as const) {
		if (rest >= size) {
			out.push(`${Math.floor(rest / size)}${label}`);
			rest %= size;
		}
		if (out.length >= parts) break;
	}
	if (!out.length) return "0s";
	return (neg ? "-" : "") + out.join(" ");
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
	if (!ts) return "never";
	const d = now - ts;
	if (d < 0) return `in ${duration(-d, 1)}`;
	if (d < 45_000) return "just now";
	return `${duration(d, 1)} ago`;
}

export function until(ts: number | null | undefined, now = Date.now()): string {
	if (!ts) return "–";
	const d = ts - now;
	if (d <= 0) return "due now";
	return `in ${duration(d, 2)}`;
}

export function dateTime(ts: number | null | undefined): string {
	if (!ts) return "–";
	return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function time(ts: number | null | undefined): string {
	if (!ts) return "–";
	return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortDay(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function pct(part: number, whole: number): string {
	if (!whole) return "0%";
	const p = (part / whole) * 100;
	return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export const DECISION_LABELS: Record<string, string> = {
	MATCH: "Match",
	MATCH_SIZE_ONLY: "Match (size only)",
	MATCH_PARTIAL: "Partial match",
	FUZZY_SIZE_MISMATCH: "Size too different",
	SIZE_MISMATCH: "Size mismatch",
	PARTIAL_SIZE_MISMATCH: "Partial size mismatch",
	NO_DOWNLOAD_LINK: "No download link",
	DOWNLOAD_FAILED: "Download failed",
	MAGNET_LINK: "Magnet link",
	RATE_LIMITED: "Rate limited",
	SAME_INFO_HASH: "Same torrent",
	INFO_HASH_ALREADY_EXISTS: "Already in client",
	FILE_TREE_MISMATCH: "Files differ",
	RELEASE_GROUP_MISMATCH: "Release group differs",
	BLOCKED_RELEASE: "Blocklisted",
	PROPER_REPACK_MISMATCH: "Proper/repack differs",
	RESOLUTION_MISMATCH: "Resolution differs",
	SOURCE_MISMATCH: "Source differs",
};

export const MATCH_DECISIONS = new Set(["MATCH", "MATCH_SIZE_ONLY", "MATCH_PARTIAL"]);

export const RESULT_LABELS: Record<string, string> = {
	injected: "Injected",
	saved: "Saved",
	exists: "Already exists",
	incomplete: "Saved (source incomplete)",
	failed: "Injection failed",
};

export const JOB_LABELS: Record<string, string> = {
	rss: "RSS scan",
	search: "Bulk search",
	updateIndexerCaps: "Indexer caps",
	inject: "Retry injections",
	cleanup: "Cleanup",
};

export const VIA_LABELS: Record<string, string> = {
	search: "Search",
	rss: "RSS",
	announce: "Announce",
	webhook: "Webhook",
	inject: "Inject job",
};
