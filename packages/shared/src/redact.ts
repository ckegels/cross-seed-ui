/**
 * Secret redaction for config values that leave the agent.
 *
 * Credentials inside URLs (user:password@, ?apikey=, long tokens in the path)
 * and whole-value secrets (apiKey) are replaced by REDACTED. When the UI sends
 * a config back, `restoreSecrets` puts the original values back.
 *
 * Works on the raw string (no URL normalisation) so untouched values round-trip
 * byte for byte. Browser-safe.
 */
import { type CrossSeedConfig, OPTIONS } from "./options.ts";

export const REDACTED = "__CSUI_REDACTED__";

const SECRET_PARAM_NAMES = "api_?key|apitoken|token|passkey|pass|password|key|secret|auth";

interface Span {
	start: number;
	end: number;
	/** Identifies the position: "password", "query:apikey", "path:3". */
	kind: string;
}

function isTokenSegment(seg: string): boolean {
	if (seg === REDACTED) return true;
	return /^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
}

/** Locate every secret inside a string (URL or "type:readonly:url" entry). */
function secretSpans(value: string): Span[] {
	const spans: Span[] = [];
	const schemeIdx = value.search(/https?:\/\//i);
	if (schemeIdx < 0) return spans;
	const afterScheme = value.indexOf("//", schemeIdx) + 2;
	// authority = up to first / ? # after the scheme
	const rest = value.slice(afterScheme);
	const authEnd = rest.search(/[/?#]/);
	const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
	const at = authority.lastIndexOf("@");
	if (at >= 0) {
		const userinfo = authority.slice(0, at);
		const colon = userinfo.indexOf(":");
		if (colon >= 0 && colon < userinfo.length - 1) {
			spans.push({
				start: afterScheme + colon + 1,
				end: afterScheme + at,
				kind: "password",
			});
		}
	}
	const pathStart = afterScheme + (authEnd < 0 ? rest.length : authEnd);
	const tail = value.slice(pathStart);
	const qIdx = tail.search(/[?#]/);
	const path = qIdx < 0 ? tail : tail.slice(0, qIdx);
	let offset = pathStart;
	path.split("/").forEach((seg, i) => {
		if (seg && isTokenSegment(seg)) {
			spans.push({ start: offset, end: offset + seg.length, kind: `path:${i}` });
		}
		offset += seg.length + 1;
	});
	if (qIdx >= 0) {
		const queryStart = pathStart + qIdx;
		const re = new RegExp(`([?&])(${SECRET_PARAM_NAMES})=([^&#]*)`, "gi");
		const query = value.slice(queryStart);
		let m: RegExpExecArray | null;
		while ((m = re.exec(query))) {
			if (!m[3]) continue;
			const start = queryStart + m.index + m[1].length + m[2].length + 1;
			spans.push({ start, end: start + m[3].length, kind: `query:${m[2].toLowerCase()}` });
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

function replaceSpans(value: string, spans: Span[], replacer: (s: Span) => string): string {
	let out = "";
	let last = 0;
	for (const s of spans) {
		out += value.slice(last, s.start) + replacer(s);
		last = s.end;
	}
	return out + value.slice(last);
}

/** Redact credentials in a single string. */
export function redactString(value: string): string {
	return replaceSpans(value, secretSpans(value), () => REDACTED);
}

export function hasRedaction(v: unknown): boolean {
	if (typeof v === "string") return v.includes(REDACTED);
	if (Array.isArray(v)) return v.some(hasRedaction);
	return false;
}

const SECRET_KEYS = OPTIONS.filter((o) => o.secret).map((o) => o.key);
const WHOLE_VALUE_SECRETS = new Set(["apiKey"]);

export function redactConfig(config: CrossSeedConfig): CrossSeedConfig {
	const out: CrossSeedConfig = { ...config };
	for (const key of SECRET_KEYS) {
		const v = out[key];
		if (v === undefined || v === null) continue;
		if (WHOLE_VALUE_SECRETS.has(key)) {
			if (typeof v === "string" && v) out[key] = REDACTED;
			continue;
		}
		if (typeof v === "string") out[key] = redactString(v);
		else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === "string" ? redactString(x) : x));
	}
	return out;
}

export class SecretRestoreError extends Error {
	constructor(
		public key: string,
		public index: number,
	) {
		super(
			`Cannot restore the hidden credentials of ${key}${index >= 0 ? ` #${index + 1}` : ""}. Please re-enter the full value including its password/API key.`,
		);
	}
}

function hostOf(value: string): string | null {
	const m = /https?:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(value);
	return m ? m[1].toLowerCase() : null;
}

/** Copy each redacted part of `value` from the same position in `original`. */
function restoreFrom(value: string, original: string): string | null {
	const origSpans = new Map(secretSpans(original).map((s) => [s.kind, original.slice(s.start, s.end)]));
	const spans = secretSpans(value).filter((s) => value.slice(s.start, s.end) === REDACTED);
	let failed = false;
	const result = replaceSpans(value, spans, (s) => {
		const o = origSpans.get(s.kind);
		if (o === undefined || o === REDACTED) {
			failed = true;
			return REDACTED;
		}
		return o;
	});
	return failed || result.includes(REDACTED) ? null : result;
}

function restoreOne(value: string, key: string, index: number, originals: string[]): string {
	if (!value.includes(REDACTED)) return value;
	// 1. untouched entry
	for (const o of originals) {
		if (redactString(o) === value) return o;
	}
	// Never hand a secret to a different host: that would let a hijacked
	// session exfiltrate API keys by editing the hostname only.
	const host = hostOf(value);
	// 2. same position in the list (edited entry)
	if (originals[index] !== undefined && hostOf(originals[index]) === host) {
		const r = restoreFrom(value, originals[index]);
		if (r) return r;
	}
	// 3. any entry on the same host that can satisfy every redacted part
	for (const o of originals) {
		if (hostOf(o) !== host) continue;
		const r = restoreFrom(value, o);
		if (r) return r;
	}
	throw new SecretRestoreError(key, index);
}

/**
 * Put real secrets back into a config coming from the UI.
 * Throws SecretRestoreError when a redacted value can't be resolved.
 */
export function restoreSecrets(incoming: CrossSeedConfig, current: CrossSeedConfig): CrossSeedConfig {
	const out: CrossSeedConfig = { ...incoming };
	for (const [key, v] of Object.entries(out)) {
		if (!hasRedaction(v)) continue;
		const cur = current[key];
		if (typeof v === "string") {
			if (v === REDACTED && typeof cur === "string") {
				out[key] = cur;
				continue;
			}
			out[key] = restoreOne(v, key, 0, typeof cur === "string" ? [cur] : []);
			continue;
		}
		if (Array.isArray(v)) {
			const originals = Array.isArray(cur) ? (cur.filter((x) => typeof x === "string") as string[]) : [];
			out[key] = v.map((x, i) => (typeof x === "string" ? restoreOne(x, key, i, originals) : x));
		}
	}
	return out;
}

/** Hide credentials in free text (log lines, error messages). */
export function redactText(text: string): string {
	return text
		.replace(/(https?:\/\/[^:/\s@]*:)[^@\s/]+@/gi, `$1${REDACTED}@`)
		.replace(new RegExp(`([?&](?:${SECRET_PARAM_NAMES})=)[^&\\s"']+`, "gi"), `$1${REDACTED}`);
}
