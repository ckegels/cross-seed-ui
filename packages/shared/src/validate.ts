/**
 * Port of cross-seed v6.13.9 src/configSchema.ts (zod schema + refinements).
 * Browser-safe: no node imports. Each rule references the option keys involved
 * so the UI can show the message next to the right fields.
 *
 * Input is the *effective* config (file values with CLI defaults applied), see
 * `toEffectiveConfig`.
 */
import { parseDuration } from "./duration.ts";
import {
	type CrossSeedConfig,
	OPTIONS,
	TORRENT_CLIENT_TYPES,
	effectiveValue,
	parseBlocklistEntry,
	parseClientEntry,
} from "./options.ts";

export interface ValidationIssue {
	level: "error" | "warning";
	keys: string[];
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

const DOCS = "https://www.cross-seed.org/docs";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function toEffectiveConfig(config: CrossSeedConfig): CrossSeedConfig {
	const out: CrossSeedConfig = {};
	for (const o of OPTIONS) out[o.key] = effectiveValue(config, o.key);
	return out;
}

function isUrl(v: unknown): boolean {
	if (typeof v !== "string") return false;
	try {
		new URL(v);
		return true;
	} catch {
		return false;
	}
}

const IPV4 =
	/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 =
	/^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/i;

export function isIp(v: string): boolean {
	return IPV4.test(v) || IPV6.test(v);
}

/** Minimal posix path normalisation (cross-seed runs on Linux in our setup). */
export function normalizePath(p: string, cwd = "/"): string {
	const abs = p.startsWith("/") ? p : `${cwd.replace(/\/$/, "")}/${p}`;
	const parts: string[] = [];
	for (const seg of abs.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return `/${parts.join("/")}`;
}

/** True if child is inside (or equal to) any parent. Same semantics as cross-seed's isChildPath. */
export function isChildPath(child: string, parents: string[]): boolean {
	const c = normalizePath(child);
	return parents.some((parent) => {
		const p = normalizePath(parent);
		return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
	});
}

type Durationish = number | null | undefined;

export interface ValidateOptions {
	/** cross-seed config directory, used to resolve the default outputDir. */
	configDir?: string;
}

export function validateConfig(
	fileConfig: CrossSeedConfig,
	opts: ValidateOptions = {},
): ValidationResult {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];
	const err = (keys: string[], message: string) =>
		errors.push({ level: "error", keys, message });
	const warn = (keys: string[], message: string) =>
		warnings.push({ level: "warning", keys, message });

	const c = toEffectiveConfig(fileConfig);

	// ---- per-field type checks -------------------------------------------
	const isBool = (k: string, optional = true) => {
		const v = c[k];
		if (v === undefined || v === null) {
			if (!optional) err([k], `${k} is required (true or false).`);
			return;
		}
		if (typeof v !== "boolean") err([k], `${k} must be true or false.`);
	};
	const strArray = (k: string, nullable = true): string[] => {
		const v = c[k];
		if (v === undefined || v === null) {
			if (!nullable) err([k], `${k} must be a list.`);
			return [];
		}
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
			err([k], `${k} must be a list of strings.`);
			return [];
		}
		return v as string[];
	};
	const duration = (k: string): Durationish => {
		const v = c[k];
		if (v === undefined || v === null || v === false) return null;
		if (v === true) {
			err([k], `${k}: expected a duration string, received true.`);
			return null;
		}
		if (typeof v !== "string") {
			err([k], `${k} must be a duration string like "2 weeks".`);
			return null;
		}
		if (!v.length) {
			err([k], `${k} cannot be an empty string. To unset it use null.`);
			return null;
		}
		const parsed = parseDuration(v);
		if (Number.isNaN(parsed)) {
			err(
				[k],
				`${k}: "${v}" is not a valid duration (examples: "30 minutes", "1 day", "2 weeks").`,
			);
			return null;
		}
		return parsed;
	};

	// delay
	if (typeof c.delay !== "number" || Number.isNaN(c.delay)) {
		err(["delay"], "delay must be a number of seconds.");
	} else if (c.delay < 0) {
		err(["delay"], "delay is in seconds, you can't travel back in time.");
	} else if (c.delay < 30 || c.delay > 3600) {
		err(["delay"], `delay must be 30 seconds to 1 hour. (${DOCS}/basics/options#delay)`);
	}

	// torznab
	const torznab = strArray("torznab", false);
	torznab.forEach((u, i) => {
		if (!isUrl(u)) err(["torznab"], `Indexer #${i + 1} is not a valid URL.`);
		else if (torznab.indexOf(u) !== i) warn(["torznab"], `Indexer #${i + 1} is listed twice (same as #${torznab.indexOf(u) + 1}); remove one.`);
	});

	isBool("useClientTorrents");
	const dataDirs = strArray("dataDirs");

	// matchMode
	const matchModeRaw = c.matchMode;
	let matchMode = matchModeRaw as string;
	if (matchModeRaw === "safe") matchMode = "strict";
	else if (matchModeRaw === "risky") matchMode = "flexible";
	else if (!["strict", "flexible", "partial"].includes(String(matchModeRaw))) {
		err(["matchMode"], 'matchMode must be one of "strict", "flexible" or "partial".');
	}
	if (matchModeRaw === "safe" || matchModeRaw === "risky") {
		warn(["matchMode"], `matchMode "${matchModeRaw}" is a legacy value; it means "${matchMode}".`);
	}

	isBool("skipRecheck");

	const armd = c.autoResumeMaxDownload;
	if (
		typeof armd !== "number" ||
		!Number.isInteger(armd) ||
		armd < 0 ||
		armd > 52428800
	) {
		err(
			["autoResumeMaxDownload"],
			"autoResumeMaxDownload must be an integer of bytes between 0 and 52428800 (50 MiB).",
		);
	}
	isBool("ignoreNonRelevantFilesToResume");

	if (c.linkCategory !== undefined && c.linkCategory !== null && typeof c.linkCategory !== "string") {
		err(["linkCategory"], "linkCategory must be text.");
	}
	let linkDirs = strArray("linkDirs");
	if (typeof c.linkDir === "string" && c.linkDir) {
		if (linkDirs.length) {
			err(["linkDir", "linkDirs"], "You cannot have both linkDir and linkDirs, use linkDirs only.");
		} else {
			warn(["linkDir"], "linkDir is deprecated, use linkDirs instead.");
			linkDirs = [c.linkDir];
		}
	}
	if (!["symlink", "hardlink", "reflink", "reflinkOrCopy"].includes(String(c.linkType))) {
		err(["linkType"], 'linkType must be "hardlink", "symlink", "reflink" or "reflinkOrCopy".');
	}
	isBool("flatLinking");

	if (typeof c.maxDataDepth !== "number" || c.maxDataDepth < 1) {
		err(["maxDataDepth"], "maxDataDepth must be a number of at least 1.");
	} else if (c.maxDataDepth > 3) {
		warn(
			["maxDataDepth"],
			`Your maxDataDepth is most likely incorrect, please read ${DOCS}/tutorials/data-based-matching#setting-up-data-based-matching`,
		);
	}

	const torrentDir =
		typeof c.torrentDir === "string" && c.torrentDir ? (c.torrentDir as string) : null;
	if (c.torrentDir !== undefined && c.torrentDir !== null && typeof c.torrentDir !== "string") {
		err(["torrentDir"], "torrentDir must be a path or null.");
	}

	let outputDir: string;
	if (typeof c.outputDir === "string" && c.outputDir) {
		outputDir = c.outputDir;
		warn(
			["outputDir"],
			`Set outputDir to null to prevent issues unless you really need a custom location (${DOCS}/basics/options#outputdir).`,
		);
	} else {
		outputDir = `${(opts.configDir ?? "/root/.cross-seed").replace(/\/$/, "")}/cross-seeds`;
	}

	isBool("includeSingleEpisodes", false);
	isBool("includeNonVideos", false);

	const fst = c.fuzzySizeThreshold;
	if (typeof fst !== "number" || fst <= 0 || fst > 1) {
		err(["fuzzySizeThreshold"], "fuzzySizeThreshold must be between 0 and 1.");
	}

	let sfe: number | null = null;
	if (c.seasonFromEpisodes === true) {
		err(["seasonFromEpisodes"], "seasonFromEpisodes: expected a number or null, received true.");
	} else if (c.seasonFromEpisodes !== undefined && c.seasonFromEpisodes !== null && c.seasonFromEpisodes !== false) {
		if (
			typeof c.seasonFromEpisodes !== "number" ||
			c.seasonFromEpisodes <= 0 ||
			c.seasonFromEpisodes > 1
		) {
			err(["seasonFromEpisodes"], "seasonFromEpisodes must be between 0 and 1 (or null to disable).");
		} else {
			sfe = c.seasonFromEpisodes;
		}
	}

	const excludeOlder = duration("excludeOlder");
	const excludeRecentSearch = duration("excludeRecentSearch");

	if (c.action !== "save" && c.action !== "inject") {
		err(["action"], 'action must be "inject" or "save".');
	}

	// torrentClients (+ legacy URLs)
	let torrentClients = strArray("torrentClients");
	torrentClients.forEach((entry) => {
		const parsed = parseClientEntry(entry);
		if (
			!parsed ||
			!(TORRENT_CLIENT_TYPES as readonly string[]).includes(parsed.clientType)
		) {
			err(
				["torrentClients"],
				`"${redactForMessage(entry)}": torrent client must start with qbittorrent:, rtorrent:, transmission: or deluge: (optionally followed by readonly:).`,
			);
		} else if (!isUrl(parsed.url)) {
			err(["torrentClients"], `"${redactForMessage(entry)}": the URL is not valid.`);
		}
	});
	const legacyClientKeys = [
		["qbittorrentUrl", "qbittorrent"],
		["rtorrentRpcUrl", "rtorrent"],
		["transmissionRpcUrl", "transmission"],
		["delugeRpcUrl", "deluge"],
	] as const;
	for (const [key, type] of legacyClientKeys) {
		const v = c[key];
		if (typeof v !== "string" || !v) continue;
		if (!isUrl(v)) err([key], `${key} must be a valid URL.`);
		if (torrentClients.length) {
			err(
				[key, "torrentClients"],
				"Cannot use qbittorrentUrl, rtorrentRpcUrl, transmissionRpcUrl, or delugeRpcUrl with torrentClients. Only use torrentClients.",
			);
		} else {
			warn([key], `${key} is deprecated, use torrentClients instead.`);
			torrentClients = [`${type}:${v}`];
		}
	}

	isBool("duplicateCategories", false);

	let notificationWebhookUrls = strArray("notificationWebhookUrls");
	notificationWebhookUrls.forEach((u, i) => {
		if (!isUrl(u)) err(["notificationWebhookUrls"], `Notification URL #${i + 1} is not a valid URL.`);
	});
	if (typeof c.notificationWebhookUrl === "string" && c.notificationWebhookUrl) {
		if (notificationWebhookUrls.length) {
			err(
				["notificationWebhookUrl", "notificationWebhookUrls"],
				"You cannot have both notificationWebhookUrl and notificationWebhookUrls, use notificationWebhookUrls only.",
			);
		} else {
			warn(["notificationWebhookUrl"], "notificationWebhookUrl is deprecated, use notificationWebhookUrls instead.");
			notificationWebhookUrls = [c.notificationWebhookUrl];
		}
	}

	// port / host
	if (c.port !== undefined && c.port !== null && c.port !== false) {
		if (typeof c.port !== "number" || c.port <= 0 || c.port > 65535 || !Number.isInteger(c.port)) {
			err(["port"], "port must be a number between 1 and 65535 (or false to disable).");
		}
	}
	if (c.host !== undefined && c.host !== null) {
		if (typeof c.host !== "string" || !isIp(c.host)) {
			err(["host"], 'host must be an IP address, e.g. "0.0.0.0" or "127.0.0.1".');
		}
	}

	const rssCadence = duration("rssCadence");
	if (rssCadence && (rssCadence < 10 * MIN || rssCadence > 2 * HOUR)) {
		err(["rssCadence"], "rssCadence must be 10-120 minutes.");
	}
	const searchCadence = duration("searchCadence");
	if (searchCadence && searchCadence < DAY) {
		err(["searchCadence"], "searchCadence must be at least 1 day.");
	}
	duration("snatchTimeout");
	duration("searchTimeout");

	if (c.searchLimit !== undefined && c.searchLimit !== null) {
		if (typeof c.searchLimit !== "number" || c.searchLimit < 0) {
			err(["searchLimit"], "searchLimit must be a number of 0 or more (or null for no limit).");
		}
	}

	// blockList
	const blockList = strArray("blockList");
	let sizeBelow = 0;
	let sizeAbove = 0;
	const sizeErr = `Blocklist size must be an integer for the number of bytes. You can only have one sizeBelow, one sizeAbove, and sizeBelow <= sizeAbove.`;
	for (const raw of blockList) {
		if (!raw.trim().length) {
			err(["blockList"], "Blocklist items cannot be empty.");
			continue;
		}
		const { type, value } = parseBlocklistEntry(raw);
		switch (type) {
			case "name":
				if (!value.length) err(["blockList"], `"${raw}": must have a value after the colon.`);
				break;
			case "folder":
				if (!value.length) err(["blockList"], `"${raw}": must have a value after the colon.`);
				if (/[/\\]/.test(value)) err(["blockList"], `"${raw}": folder must not contain path separators.`);
				break;
			case "nameRegex":
			case "folderRegex":
				if (!value.length) err(["blockList"], `"${raw}": must have a value after the colon.`);
				try {
					new RegExp(value);
				} catch {
					err(["blockList"], `"${raw}": not a valid regular expression.`);
				}
				break;
			case "category":
			case "tag":
				if (!value.length) {
					warn(["blockList"], `"${raw}": blocks every torrent without a ${type}.`);
				}
				break;
			case "tracker":
				if (!value.length) err(["blockList"], `"${raw}": must have a value after the colon.`);
				else if (/[/@]|^[^.]*$/.test(value)) {
					err(
						["blockList"],
						`"${raw}": tracker must be a URL host, e.g. "tracker:tracker.example.com:8080" (no scheme, path or passkey).`,
					);
				}
				break;
			case "infoHash":
				if (!/^[a-z0-9]{40}$/i.test(value)) {
					err(["blockList"], `"${raw}": info hash must be 40 alphanumeric characters.`);
				}
				break;
			case "sizeBelow":
			case "sizeAbove": {
				const existing = type === "sizeBelow" ? sizeBelow : sizeAbove;
				if (!existing && /^\d+$/.test(value)) {
					if (type === "sizeBelow") sizeBelow = parseInt(value);
					else sizeAbove = parseInt(value);
				} else {
					err(["blockList"], `"${raw}": ${sizeErr}`);
				}
				break;
			}
			case "legacy":
				warn(
					["blockList"],
					`"${raw}": legacy style blocklist is deprecated, use a prefix such as name: or infoHash:.`,
				);
				break;
			default:
				err(
					["blockList"],
					`"${raw}": unknown type "${type}". Use name, nameRegex, folder, folderRegex, category, tag, tracker, infoHash, sizeBelow or sizeAbove.`,
				);
		}
	}
	if (sizeBelow && sizeAbove && sizeBelow > sizeAbove) {
		err(["blockList"], sizeErr);
	}

	if (c.apiKey !== undefined && c.apiKey !== null) {
		if (typeof c.apiKey !== "string" || c.apiKey.length < 24) {
			err(["apiKey"], "apiKey must be at least 24 characters (or empty to use the auto-generated key).");
		}
	}
	for (const k of ["radarr", "sonarr"]) {
		strArray(k).forEach((u, i) => {
			if (!isUrl(u)) err([k], `${k} URL #${i + 1} is not a valid URL.`);
		});
	}

	// ---- cross-field refinements (same order as cross-seed) --------------
	const useClientTorrents = c.useClientTorrents === true;
	const action = c.action;

	if (torrentDir && useClientTorrents) {
		err(["torrentDir", "useClientTorrents"], "You cannot have both torrentDir and useClientTorrents.");
	}
	if (useClientTorrents && !torrentClients.length) {
		err(["useClientTorrents", "torrentClients"], "You need to have a client configured for useClientTorrents.");
	}
	if (useClientTorrents && torrentClients.some((x) => x.startsWith("deluge"))) {
		warn(
			["useClientTorrents"],
			"Deluge can desync with its WebUI daemon after long uptime with useClientTorrents; switch to torrentDir if you see strange behaviour.",
		);
	}
	if (action === "inject" && !torrentClients.some((x) => !x.includes(":readonly:"))) {
		if (torrentClients.length) {
			err(
				["torrentClients", "action"],
				'You must have at least one non-readonly torrent client when using action: "inject".',
			);
		}
	}
	if (torrentClients.length > 1 && torrentDir) {
		err(
			["torrentClients", "torrentDir"],
			"torrentDir does not support multiple clients, use useClientTorrents instead.",
		);
	}
	if (torrentClients.length > 1 && !linkDirs.length && dataDirs.length) {
		err(
			["torrentClients", "dataDirs", "linkDirs"],
			"dataDirs is not supported with multiple clients if not linking. Configure linkDirs.",
		);
	}
	if (!clientsAreUnique(torrentClients)) {
		err(["torrentClients"], "Duplicate torrent client URLs are not allowed.");
	}
	if (searchCadence && excludeRecentSearch && 3 * searchCadence > excludeRecentSearch) {
		err(
			["searchCadence", "excludeRecentSearch"],
			"excludeRecentSearch must be at least 3x searchCadence.",
		);
	}
	if (
		searchCadence &&
		!(
			excludeOlder &&
			excludeRecentSearch &&
			excludeOlder >= 2 * excludeRecentSearch &&
			excludeOlder <= 5 * excludeRecentSearch
		)
	) {
		err(
			["excludeOlder", "excludeRecentSearch", "searchCadence"],
			"excludeOlder and excludeRecentSearch must be defined for searching. excludeOlder must be 2-5x excludeRecentSearch.",
		);
	}
	if (typeof fst === "number" && fst > 0.1 && (searchCadence || rssCadence)) {
		err(
			["fuzzySizeThreshold"],
			"fuzzySizeThreshold cannot be greater than 0.1 when using searchCadence or rssCadence.",
		);
	}
	if ((searchCadence || rssCadence) && sfe && sfe < 0.5) {
		err(
			["seasonFromEpisodes"],
			"seasonFromEpisodes cannot be less than 0.5 when using searchCadence or rssCadence.",
		);
	}
	if (action === "save" && linkDirs.length) {
		warn(
			["action", "linkDirs"],
			"You cannot use action 'save' with linkDirs (cross-seed logs this as an error). Use 'inject' for cross-seed to perform linking.",
		);
	}
	if (
		action === "inject" &&
		torrentClients.some((x) => x.startsWith("qbittorrent")) &&
		!c.flatLinking &&
		linkDirs.length
	) {
		warn(
			["linkDirs"],
			`If using Automatic Torrent Management in qBittorrent, please read ${DOCS}/v6-migration#new-folder-structure-for-links`,
		);
	}
	if (c.includeSingleEpisodes === true && rssCadence) {
		warn(
			["includeSingleEpisodes"],
			"includeSingleEpisodes is not recommended when using announce/RSS.",
		);
	}
	if (action !== "inject" && c.injectDir !== undefined && c.injectDir !== null) {
		err(["injectDir"], "injectDir requires the 'inject' action.");
	}
	if (!torrentClients.length && action === "inject") {
		err(["torrentClients", "action"], "You need to specify torrentClients when using 'inject'.");
	}
	if (
		torrentClients.length &&
		torrentClients.every((x) => x.startsWith("deluge")) &&
		blockList.some((b) => b.startsWith("tag:"))
	) {
		warn(["blockList"], "tag: blocklisting is deprecated for Deluge, cross-seed converts it to category:.");
	}
	if (
		torrentClients.length &&
		torrentClients.every((x) => x.startsWith("rtorrent") || x.startsWith("transmission")) &&
		blockList.some((b) => b.startsWith("category:"))
	) {
		err(["blockList"], "Your client does not support category: blocklisting, use tag: instead for labels.");
	}
	if (
		blockList.some((b) => /^(category|tag|tracker):/.test(b)) &&
		(!torrentClients.length || !(useClientTorrents || torrentDir))
	) {
		warn(["blockList"], "Blocklist category:, tag: and tracker: require torrentDir or useClientTorrents.");
	}
	if (blockList.some((b) => /^(folder|folderRegex):/.test(b)) && !dataDirs.length) {
		warn(["blockList"], "Blocklist folder: and folderRegex: only apply to searchees from dataDirs.");
	}
	if (!(useClientTorrents || torrentDir || dataDirs.length || (!rssCadence && !searchCadence))) {
		err(
			["useClientTorrents", "torrentDir", "dataDirs"],
			"You need to have torrentDir, useClientTorrents or dataDirs for search/rss/announce matching to work.",
		);
	}
	if (!(linkDirs.length || matchMode === "strict" || action === "save")) {
		err(
			["matchMode", "linkDirs"],
			`When using action "inject", you need to set linkDirs for flexible and partial matchMode. If you cannot use linking, use matchMode "strict". (${DOCS}/tutorials/linking)`,
		);
	}
	if (sfe && torrentDir && !torrentClients.length) {
		err(
			["seasonFromEpisodes", "torrentClients"],
			"seasonFromEpisodes requires a torrent client to connect to when using torrentDir or useClientTorrents.",
		);
	}
	if (sfe) {
		if (action === "save") {
			warn(
				["seasonFromEpisodes", "action"],
				"Using action 'save' with seasonFromEpisodes is not recommended; you will need to run 'cross-seed inject' to add them to the client.",
			);
		} else if (!linkDirs.length) {
			err(
				["seasonFromEpisodes", "linkDirs"],
				"When using action 'inject', you need to set linkDirs for seasonFromEpisodes. If you cannot use linking, disable it (null).",
			);
		}
		if (sfe < 1 && matchMode !== "partial") {
			err(
				["seasonFromEpisodes", "matchMode"],
				"seasonFromEpisodes below 1 requires matchMode partial.",
			);
		}
	}
	if (dataDirs.length && (sfe || c.includeSingleEpisodes === true)) {
		warn(
			["dataDirs"],
			`Using seasonFromEpisodes or includeSingleEpisodes with dataDirs requires a specific data structure${typeof c.maxDataDepth === "number" && c.maxDataDepth < 3 ? " and likely needs a maxDataDepth of 3" : ""}.`,
		);
	}
	for (const linkDir of linkDirs) {
		if (
			isChildPath(linkDir, [outputDir]) ||
			isChildPath(linkDir, dataDirs) ||
			(torrentDir && isChildPath(linkDir, [torrentDir]))
		) {
			err(
				["linkDirs"],
				"You cannot have your linkDirs inside of your torrentDir/dataDirs/outputDir.",
			);
			break;
		}
	}
	for (const dataDir of dataDirs) {
		if (
			isChildPath(dataDir, [outputDir]) ||
			(torrentDir && isChildPath(dataDir, [torrentDir])) ||
			isChildPath(dataDir, linkDirs)
		) {
			err(
				["dataDirs"],
				"You cannot have your dataDirs inside of your torrentDir/linkDirs/outputDir.",
			);
			break;
		}
	}
	if (
		torrentDir &&
		(isChildPath(torrentDir, [outputDir]) ||
			isChildPath(torrentDir, dataDirs) ||
			isChildPath(torrentDir, linkDirs))
	) {
		err(["torrentDir"], "You cannot have your torrentDir inside of your dataDirs/linkDirs/outputDir.");
	}
	if (
		(torrentDir && isChildPath(outputDir, [torrentDir])) ||
		isChildPath(outputDir, dataDirs) ||
		isChildPath(outputDir, linkDirs)
	) {
		err(["outputDir"], "You cannot have your outputDir inside of your torrentDir/dataDirs/linkDirs.");
	}
	const allPaths = [outputDir, ...linkDirs, ...dataDirs, ...(torrentDir ? [torrentDir] : [])];
	if (allPaths.some((p) => !p.startsWith("/"))) {
		warn(
			["torrentDir", "linkDirs", "dataDirs", "outputDir"],
			"Absolute paths for torrentDir, linkDirs, dataDirs, and outputDir are recommended.",
		);
	}

	return { ok: errors.length === 0, errors, warnings };
}

function clientsAreUnique(entries: string[]): boolean {
	const urls = entries
		.map((e) => parseClientEntry(e)?.url)
		.map((u) => {
			try {
				return u ? new URL(u) : null;
			} catch {
				return null;
			}
		});
	if (urls.some((u) => !u)) return true; // reported elsewhere
	const hosts = new Set(urls.map((u) => u!.host));
	if (hosts.size === entries.length) return true;
	const withPath = new Set(
		urls.map((u) => `${u!.host}${u!.pathname.replace(/\/+/g, "/").replace(/\/$/, "")}`),
	);
	return withPath.size === entries.length;
}

/** Strip credentials from a string before echoing it in an error. */
export function redactForMessage(s: string): string {
	return s
		.replace(/\/\/([^/@]*)@/, "//***@")
		.replace(/(apikey|api_key|passkey|key|pass)=[^&]+/gi, "$1=***");
}
