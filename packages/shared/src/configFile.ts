/**
 * Render a cross-seed config.js from a config object.
 * Output order follows cross-seed's config.template.cjs; each option gets its
 * description as a comment so the file stays readable when edited by hand.
 * Browser-safe (used for the "preview file" view too).
 */
import { type CrossSeedConfig, OPTIONS, OPTION_BY_KEY } from "./options.ts";

const TEMPLATE_ORDER = [
	"apiKey",
	"torznab",
	"sonarr",
	"radarr",
	"host",
	"port",
	"notificationWebhookUrls",
	"torrentClients",
	"useClientTorrents",
	"delay",
	"dataDirs",
	"linkCategory",
	"linkDirs",
	"linkType",
	"flatLinking",
	"matchMode",
	"skipRecheck",
	"autoResumeMaxDownload",
	"ignoreNonRelevantFilesToResume",
	"maxDataDepth",
	"torrentDir",
	"outputDir",
	"includeSingleEpisodes",
	"includeNonVideos",
	"seasonFromEpisodes",
	"fuzzySizeThreshold",
	"excludeOlder",
	"excludeRecentSearch",
	"action",
	"duplicateCategories",
	"rssCadence",
	"searchCadence",
	"snatchTimeout",
	"searchTimeout",
	"searchLimit",
	"blockList",
];

function literal(v: unknown, indent: string): string {
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (Array.isArray(v)) {
		if (!v.length) return "[]";
		const inner = `${indent}\t`;
		return `[\n${v.map((x) => `${inner}${literal(x, inner)},`).join("\n")}\n${indent}]`;
	}
	if (typeof v === "object") {
		const inner = `${indent}\t`;
		const entries = Object.entries(v as Record<string, unknown>);
		if (!entries.length) return "{}";
		return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${literal(x, inner)},`).join("\n")}\n${indent}}`;
	}
	return "undefined";
}

function wrap(text: string, width = 76): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if ((cur + " " + w).trim().length > width) {
			if (cur) lines.push(cur);
			cur = w;
		} else {
			cur = cur ? `${cur} ${w}` : w;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

export interface RenderOptions {
	/** Short header note, e.g. who saved it and when. */
	note?: string;
}

export function renderConfigFile(config: CrossSeedConfig, opts: RenderOptions = {}): string {
	const out: string[] = [];
	out.push("// cross-seed configuration (v6)");
	out.push("// Managed by cross-seed-ui. Hand edits are fine: the UI reads this file");
	out.push("// before every change and keeps a backup of every previous version.");
	if (opts.note) out.push(`// ${opts.note}`);
	out.push("// Option reference: https://www.cross-seed.org/docs/basics/options");
	out.push("");
	out.push("module.exports = {");

	const keys = [
		...TEMPLATE_ORDER,
		// legacy / extra known keys that are present
		...OPTIONS.map((o) => o.key).filter((k) => !TEMPLATE_ORDER.includes(k) && config[k] !== undefined),
	];
	// unknown keys are kept (cross-seed ignores them) so nothing is lost
	for (const k of Object.keys(config)) {
		if (!keys.includes(k) && config[k] !== undefined) keys.push(k);
	}

	for (const key of keys) {
		const meta = OPTION_BY_KEY[key];
		out.push("\t/**");
		if (meta) {
			for (const l of wrap(meta.description)) out.push(`\t * ${l.replace(/\*\//g, "* /")}`);
			if (meta.docs) out.push(`\t * ${meta.docs}`);
		} else {
			out.push("\t * Unknown option (not used by cross-seed v6), kept as-is.");
		}
		out.push("\t */");
		// a missing key keeps its effective (CLI) default so behaviour doesn't change
		const value = Object.prototype.hasOwnProperty.call(config, key) ? config[key] : meta?.cliDefault;
		out.push(`\t${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${literal(value, "\t")},`);
		out.push("");
	}
	if (out[out.length - 1] === "") out.pop();
	out.push("};");
	out.push("");
	return out.join("\n");
}
