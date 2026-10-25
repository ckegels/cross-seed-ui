/**
 * Port of vercel/ms parsing (the library cross-seed uses for every duration
 * option such as "2 weeks" or "30 minutes"). Kept browser-safe so the web UI
 * can validate exactly like cross-seed does.
 */

const s = 1000;
const m = s * 60;
const h = m * 60;
const d = h * 24;
const w = d * 7;
const y = d * 365.25;

const DURATION_REGEX =
	/^(?<value>-?\d*\.?\d+) *(?<type>milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/** Parse a duration string to milliseconds. Returns NaN when unparsable. */
export function parseDuration(str: string): number {
	if (typeof str !== "string" || str.length === 0 || str.length > 100) {
		return NaN;
	}
	const match = DURATION_REGEX.exec(str);
	if (!match?.groups) return NaN;
	const n = parseFloat(match.groups.value);
	const type = (match.groups.type || "ms").toLowerCase();
	switch (type) {
		case "years":
		case "year":
		case "yrs":
		case "yr":
		case "y":
			return n * y;
		case "weeks":
		case "week":
		case "w":
			return n * w;
		case "days":
		case "day":
		case "d":
			return n * d;
		case "hours":
		case "hour":
		case "hrs":
		case "hr":
		case "h":
			return n * h;
		case "minutes":
		case "minute":
		case "mins":
		case "min":
		case "m":
			return n * m;
		case "seconds":
		case "second":
		case "secs":
		case "sec":
		case "s":
			return n * s;
		case "milliseconds":
		case "millisecond":
		case "msecs":
		case "msec":
		case "ms":
			return n;
		default:
			return NaN;
	}
}

export const DURATION = { s, m, h, d, w, y } as const;

/** Human friendly rendering, e.g. 90061000 -> "1d 1h 1m". */
export function formatDuration(msValue: number, maxParts = 2): string {
	if (!Number.isFinite(msValue)) return "∞";
	const negative = msValue < 0;
	let rest = Math.abs(msValue);
	const parts: string[] = [];
	for (const [label, size] of [
		["d", d],
		["h", h],
		["m", m],
		["s", s],
	] as const) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${label}`);
			rest %= size;
		}
		if (parts.length >= maxParts) break;
	}
	if (!parts.length) parts.push(msValue === 0 ? "0s" : "<1s");
	return (negative ? "-" : "") + parts.join(" ");
}
