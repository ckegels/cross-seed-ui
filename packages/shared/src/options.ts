/**
 * Metadata for every cross-seed v6 config.js option (verified against
 * cross-seed v6.13.9: src/config.template.cjs, src/configSchema.ts, src/cmd.ts).
 *
 * - `templateDefault`: what `cross-seed gen-config` writes.
 * - `cliDefault`: the effective value when the key is missing from config.js.
 * The UI renders forms from this list, the validator reads constraints from it
 * and the config writer uses its order + descriptions for comments.
 */

export type OptionType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "duration"
	| "enum"
	| "stringList"
	| "urlList"
	| "path"
	| "pathList";

export type GroupId =
	| "connections"
	| "daemon"
	| "sources"
	| "scheduling"
	| "matching"
	| "injection"
	| "blocklist"
	| "legacy";

export interface EnumChoice {
	value: string;
	label: string;
	description?: string;
}

export interface OptionMeta {
	key: string;
	label: string;
	group: GroupId;
	type: OptionType;
	description: string;
	docs?: string;
	templateDefault: unknown;
	cliDefault: unknown;
	/** null is a valid value (usually meaning "disabled" / "auto"). */
	nullable?: boolean;
	nullLabel?: string;
	choices?: EnumChoice[];
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	placeholder?: string;
	/** Contains credentials (whole value, or credentials inside URLs). */
	secret?: boolean;
	advanced?: boolean;
	/** Deprecated key; value is migrated to `replacedBy`. */
	deprecated?: { replacedBy: string; note: string };
}

export interface GroupMeta {
	id: GroupId;
	label: string;
	description: string;
}

export const GROUPS: GroupMeta[] = [
	{
		id: "connections",
		label: "Connections",
		description:
			"Indexers, torrent clients, Sonarr/Radarr and notification targets.",
	},
	{
		id: "sources",
		label: "Sources",
		description:
			"Where cross-seed finds the torrents and data you already have.",
	},
	{
		id: "scheduling",
		label: "Searching & RSS",
		description:
			"How often and how aggressively cross-seed searches your indexers.",
	},
	{
		id: "matching",
		label: "Matching",
		description: "How strict cross-seed is when deciding something is a match.",
	},
	{
		id: "injection",
		label: "Injection & linking",
		description:
			"What happens when a match is found: inject into the client, link files, save .torrent files.",
	},
	{
		id: "blocklist",
		label: "Blocklist",
		description: "Torrents, data and trackers cross-seed should ignore.",
	},
	{
		id: "daemon",
		label: "Daemon",
		description: "The cross-seed HTTP server used by autobrr, webhooks and this UI.",
	},
	{
		id: "legacy",
		label: "Legacy",
		description:
			"Deprecated options. cross-seed still accepts them but they should be migrated.",
	},
];

const DOCS = "https://www.cross-seed.org/docs";

export const OPTIONS: OptionMeta[] = [
	// ---------------------------------------------------------------- daemon
	{
		key: "apiKey",
		label: "API key override",
		group: "daemon",
		type: "string",
		description:
			"Provide your own API key instead of the auto-generated one (stored in cross-seed.db). Not recommended. Must be at least 24 characters. Leave empty to use the auto-generated key.",
		docs: `${DOCS}/basics/options#apikey`,
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		nullLabel: "Use auto-generated key",
		secret: true,
		advanced: true,
		min: 24,
	},
	// ----------------------------------------------------------- connections
	{
		key: "torznab",
		label: "Indexers (Torznab URLs)",
		group: "connections",
		type: "urlList",
		description:
			"Torznab URLs including the apikey. For Prowlarr: http://prowlarr:9696/<id>/api?apikey=<key>. Use the Indexers page to sync from Prowlarr.",
		docs: `${DOCS}/basics/options#torznab`,
		templateDefault: [],
		cliDefault: [],
		secret: true,
		placeholder: "http://prowlarr:9696/1/api?apikey=...",
	},
	{
		key: "sonarr",
		label: "Sonarr",
		group: "connections",
		type: "urlList",
		description:
			"Sonarr URL(s) with apikey, e.g. http://sonarr:8989/?apikey=KEY. Used to look up IDs (TVDB/TMDB/IMDB) for better searches. Ordered most to least likely to match; searched sequentially.",
		docs: `${DOCS}/tutorials/id-searching`,
		templateDefault: [],
		cliDefault: [],
		secret: true,
		placeholder: "http://sonarr:8989/?apikey=...",
	},
	{
		key: "radarr",
		label: "Radarr",
		group: "connections",
		type: "urlList",
		description:
			"Radarr URL(s) with apikey, e.g. http://radarr:7878/?apikey=KEY. Used to look up IDs for better searches. Ordered most to least likely to match.",
		docs: `${DOCS}/tutorials/id-searching`,
		templateDefault: [],
		cliDefault: [],
		secret: true,
		placeholder: "http://radarr:7878/?apikey=...",
	},
	{
		key: "host",
		label: "Bind address",
		group: "daemon",
		type: "string",
		description:
			'IP address the daemon listens on. Do not change without a good reason. Use "0.0.0.0" for all interfaces or "127.0.0.1" for local only (the agent runs locally, so local-only works with this UI).',
		docs: `${DOCS}/basics/options#host`,
		templateDefault: "0.0.0.0",
		cliDefault: undefined,
		nullable: true,
		nullLabel: "All interfaces (default)",
		advanced: true,
	},
	{
		key: "port",
		label: "Port",
		group: "daemon",
		type: "integer",
		description:
			"Port the daemon listens on (API for autobrr, webhooks and this UI). Set to false/null to disable the HTTP server (not recommended: the UI uses it to trigger jobs).",
		docs: `${DOCS}/basics/options#port`,
		templateDefault: 2468,
		cliDefault: 2468,
		min: 1,
		max: 65535,
		nullable: true,
		nullLabel: "HTTP server disabled",
	},
	{
		key: "notificationWebhookUrls",
		label: "Notification webhooks",
		group: "connections",
		type: "urlList",
		description:
			"cross-seed POSTs a JSON payload ({ title, body, extra }) to these URLs when it injects/saves a match or an injection fails. Works with Apprise, Notifiarr, ntfy bridges, etc.",
		docs: `${DOCS}/basics/options#notificationwebhookurls`,
		templateDefault: [],
		cliDefault: [],
		secret: true,
		placeholder: "http://apprise:8000/notify/cross-seed",
	},
	{
		key: "torrentClients",
		label: "Torrent clients",
		group: "connections",
		type: "stringList",
		description:
			'Torrent clients as "<type>:<url>" with type qbittorrent, rtorrent, transmission or deluge. Add "readonly:" after the type to only use a client as a source. URL-encode special characters in usernames/passwords.',
		docs: `${DOCS}/basics/options#torrentclients`,
		templateDefault: [],
		cliDefault: [],
		secret: true,
		placeholder: "qbittorrent:http://user:pass@localhost:8080",
	},
	// ---------------------------------------------------------------- sources
	{
		key: "useClientTorrents",
		label: "Use client torrents",
		group: "sources",
		type: "boolean",
		description:
			"Use the torrents already in your torrent client(s) to find matches. This is the preferred method. Only disable if you exclusively want to use dataDirs. Cannot be combined with torrentDir.",
		docs: `${DOCS}/basics/options#useclienttorrents`,
		templateDefault: true,
		cliDefault: false,
	},
	{
		key: "delay",
		label: "Delay between searches",
		group: "scheduling",
		type: "number",
		unit: "seconds",
		description:
			"Pause at least this many seconds between each search. Higher is safer for you and friendlier to trackers. 30 to 3600.",
		docs: `${DOCS}/basics/options#delay`,
		templateDefault: 30,
		cliDefault: 30,
		min: 30,
		max: 3600,
	},
	{
		key: "dataDirs",
		label: "Data directories",
		group: "sources",
		type: "pathList",
		description:
			"Find matches based on the data in these directories (data-based matching). Usually not needed with useClientTorrents. Read the docs before setting this up.",
		docs: `${DOCS}/tutorials/data-based-matching`,
		templateDefault: [],
		cliDefault: [],
		placeholder: "/data/media/movies",
	},
	{
		key: "linkCategory",
		label: "Link category",
		group: "injection",
		type: "string",
		description:
			"qBittorrent/Deluge category set on linked torrents. With linking enabled in qBittorrent, all injected torrents go to this category.",
		docs: `${DOCS}/basics/options#linkcategory`,
		templateDefault: "cross-seed-link",
		cliDefault: "cross-seed-link",
		nullable: true,
	},
	{
		key: "linkDirs",
		label: "Link directories",
		group: "injection",
		type: "pathList",
		description:
			"cross-seed creates links to matched files in these directories. Needed for flexible/partial matching and seasonFromEpisodes. With hardlinks, each must be on the same filesystem as the data it links (one linkDir per drive/volume).",
		docs: `${DOCS}/tutorials/linking`,
		templateDefault: [],
		cliDefault: [],
		placeholder: "/data/torrents/cross-seed-links",
	},
	{
		key: "linkType",
		label: "Link type",
		group: "injection",
		type: "enum",
		description: "Type of link used when injecting matches.",
		docs: `${DOCS}/tutorials/linking#hardlinks-vs-symlinks-vs-reflinks`,
		templateDefault: "hardlink",
		cliDefault: "symlink",
		choices: [
			{
				value: "hardlink",
				label: "Hardlink",
				description: "Recommended. Same filesystem required, no extra space used.",
			},
			{
				value: "symlink",
				label: "Symlink",
				description: "Works across filesystems, breaks if the original is removed.",
			},
			{
				value: "reflink",
				label: "Reflink",
				description: "Copy-on-write (btrfs, XFS, ZFS 2.2+). Fails if unsupported.",
			},
			{
				value: "reflinkOrCopy",
				label: "Reflink or copy",
				description: "Reflink when possible, otherwise a full copy (uses disk space).",
			},
		],
	},
	{
		key: "flatLinking",
		label: "Flat linking",
		group: "injection",
		type: "boolean",
		description:
			"Use v5's flat folder style instead of one folder per tracker inside each linkDir. Not recommended. Relevant if you use qBittorrent Automatic Torrent Management.",
		docs: `${DOCS}/v6-migration#new-folder-structure-for-links`,
		templateDefault: false,
		cliDefault: false,
		advanced: true,
	},
	{
		key: "matchMode",
		label: "Match mode",
		group: "matching",
		type: "enum",
		description:
			"Flexibility of the matching algorithm. All modes are equally safe; partial finds the most cross-seeds. Flexible and partial require linkDirs when injecting.",
		docs: `${DOCS}/tutorials/partial-matching`,
		templateDefault: "flexible",
		cliDefault: "strict",
		choices: [
			{
				value: "strict",
				label: "Strict",
				description: "All file names must match exactly. Required if not linking.",
			},
			{
				value: "flexible",
				label: "Flexible",
				description: "Allows renamed files / naming inconsistencies.",
			},
			{
				value: "partial",
				label: "Partial",
				description:
					"Like flexible, but also matches when small files (.nfo, .srt, samples) are missing. Recommended.",
			},
		],
	},
	{
		key: "skipRecheck",
		label: "Skip recheck",
		group: "injection",
		type: "boolean",
		description:
			"Skip rechecking on injection when unnecessary. Partial matches are always rechecked. Disable to recheck every torrent before resuming.",
		docs: `${DOCS}/basics/options#skiprecheck`,
		templateDefault: true,
		cliDefault: true,
	},
	{
		key: "autoResumeMaxDownload",
		label: "Auto-resume max download",
		group: "injection",
		type: "integer",
		unit: "bytes",
		description:
			"Maximum remaining size for a torrent to be resumed automatically after injection. 0 to 52428800 (50 MiB).",
		docs: `${DOCS}/basics/options#autoresumemaxdownload`,
		templateDefault: 52428800,
		cliDefault: 52428800,
		min: 0,
		max: 52428800,
	},
	{
		key: "ignoreNonRelevantFilesToResume",
		label: "Ignore non-relevant files to resume",
		group: "injection",
		type: "boolean",
		description:
			"If the remaining amount is above autoResumeMaxDownload, still resume when the missing files are smaller than the known-irrelevant files (nfo, samples, subs, proofs, extras) in the torrent.",
		docs: `${DOCS}/basics/options#ignorenonrelevantfilestoresume`,
		templateDefault: false,
		cliDefault: false,
		advanced: true,
	},
	{
		key: "maxDataDepth",
		label: "Max data depth",
		group: "sources",
		type: "integer",
		description:
			"How deep into dataDirs to look for searchees. Read the data-based matching docs before changing. Usually 1–3.",
		docs: `${DOCS}/tutorials/data-based-matching#setting-up-data-based-matching`,
		templateDefault: 2,
		cliDefault: 2,
		min: 1,
		max: 10,
	},
	{
		key: "torrentDir",
		label: "Torrent directory",
		group: "sources",
		type: "path",
		description:
			"Directory containing your client's internal .torrent files. Unnecessary (and not allowed) with useClientTorrents.",
		docs: `${DOCS}/basics/options#torrentdir`,
		templateDefault: null,
		cliDefault: null,
		nullable: true,
		nullLabel: "Not used",
		advanced: true,
	},
	{
		key: "outputDir",
		label: "Output directory",
		group: "injection",
		type: "path",
		description:
			"With action inject, failed injections are saved here and retried. With action save, .torrent files are saved here. Leave empty to use <config dir>/cross-seeds. NEVER use this as a client watch folder.",
		docs: `${DOCS}/basics/options#outputdir`,
		templateDefault: null,
		cliDefault: null,
		nullable: true,
		nullLabel: "Default (<config>/cross-seeds)",
		advanced: true,
	},
	{
		key: "includeSingleEpisodes",
		label: "Include single episodes",
		group: "matching",
		type: "boolean",
		description:
			"Include single-episode torrents in search/webhook/RSS. Does not affect announce matching. Not recommended together with RSS/announce.",
		docs: `${DOCS}/v6-migration#updated-includesingleepisodes-behavior`,
		templateDefault: false,
		cliDefault: false,
	},
	{
		key: "includeNonVideos",
		label: "Include non-videos",
		group: "matching",
		type: "boolean",
		description:
			"Include torrents/data that are mostly non-video (music, books, games...). When off, anything where non-video files exceed fuzzySizeThreshold of the size is skipped.",
		docs: `${DOCS}/basics/options#includenonvideos`,
		templateDefault: false,
		cliDefault: false,
	},
	{
		key: "seasonFromEpisodes",
		label: "Season packs from episodes",
		group: "matching",
		type: "number",
		description:
			"Match season packs from individual episodes you already have. 1 = all episodes required, 0.8 = at least 80% (values below 1 need matchMode partial). Requires linking when injecting.",
		docs: `${DOCS}/basics/options#seasonfromepisodes`,
		templateDefault: 1,
		cliDefault: null,
		nullable: true,
		nullLabel: "Disabled",
		min: 0.5,
		max: 1,
		step: 0.05,
	},
	{
		key: "fuzzySizeThreshold",
		label: "Fuzzy size threshold",
		group: "matching",
		type: "number",
		description:
			"Preliminary size difference allowed for comparison (0.02 = 2%). Do not change without a good reason. Max 0.1 when RSS or search cadence is set.",
		docs: `${DOCS}/basics/options#fuzzysizethreshold`,
		templateDefault: 0.02,
		cliDefault: 0.02,
		min: 0.001,
		max: 1,
		step: 0.005,
		advanced: true,
	},
	{
		key: "excludeOlder",
		label: "Exclude older than",
		group: "scheduling",
		type: "duration",
		description:
			'Skip torrents/data first seen by cross-seed more than this long ago. Must be 2–5× excludeRecentSearch. Examples: "2 weeks" (search often), "450 days" (spread out).',
		docs: `${DOCS}/basics/options#excludeolder`,
		templateDefault: "2 weeks",
		cliDefault: undefined,
		nullable: true,
		nullLabel: "No limit",
		placeholder: "2 weeks",
	},
	{
		key: "excludeRecentSearch",
		label: "Exclude recently searched",
		group: "scheduling",
		type: "duration",
		description:
			'Skip torrents/data searched more recently than this. Previously failed searches ignore this per tracker. Must be at least 3× searchCadence. Examples: "3 days", "90 days".',
		docs: `${DOCS}/basics/options#excluderecentsearch`,
		templateDefault: "3 days",
		cliDefault: undefined,
		nullable: true,
		nullLabel: "No limit",
		placeholder: "3 days",
	},
	{
		key: "action",
		label: "Action on match",
		group: "injection",
		type: "enum",
		description: "What to do when a match is found.",
		docs: `${DOCS}/tutorials/injection`,
		templateDefault: "inject",
		cliDefault: "save",
		choices: [
			{
				value: "inject",
				label: "Inject",
				description: "Add the torrent to your client (recommended).",
			},
			{
				value: "save",
				label: "Save",
				description: "Only save the .torrent file to outputDir.",
			},
		],
	},
	{
		key: "duplicateCategories",
		label: "Duplicate categories",
		group: "injection",
		type: "boolean",
		description:
			'qBittorrent/Deluge: inject using the original category with ".cross-seed" appended (e.g. "Movies.cross-seed"). With linking in qBittorrent the category is always linkCategory and this adds a tag instead.',
		docs: `${DOCS}/basics/options#duplicatecategories`,
		templateDefault: false,
		cliDefault: false,
	},
	{
		key: "rssCadence",
		label: "RSS cadence",
		group: "scheduling",
		type: "duration",
		description:
			'Scan indexer RSS feeds on this schedule (10 minutes – 2 hours). Disable with null. For instant matches on new uploads use autobrr announce instead. Example: "30 minutes".',
		docs: `${DOCS}/basics/options#rsscadence`,
		templateDefault: "30 minutes",
		cliDefault: undefined,
		nullable: true,
		nullLabel: "Disabled",
		placeholder: "30 minutes",
	},
	{
		key: "searchCadence",
		label: "Search cadence",
		group: "scheduling",
		type: "duration",
		description:
			'Run a bulk search of your library on this schedule (at least 1 day). excludeRecentSearch must be at least 3× this. Example: "1 day".',
		docs: `${DOCS}/basics/options#searchcadence`,
		templateDefault: "1 day",
		cliDefault: undefined,
		nullable: true,
		nullLabel: "Disabled",
		placeholder: "1 day",
	},
	{
		key: "snatchTimeout",
		label: "Snatch timeout",
		group: "scheduling",
		type: "duration",
		description:
			'Fail .torrent downloads that have not responded after this long. null = no timeout. Example: "30 seconds".',
		docs: `${DOCS}/basics/options#snatchtimeout`,
		templateDefault: "30 seconds",
		cliDefault: "30 seconds",
		nullable: true,
		nullLabel: "No timeout",
		advanced: true,
	},
	{
		key: "searchTimeout",
		label: "Search timeout",
		group: "scheduling",
		type: "duration",
		description:
			'Fail searches that have not responded after this long. null = no timeout. Example: "2 minutes".',
		docs: `${DOCS}/basics/options#searchtimeout`,
		templateDefault: "2 minutes",
		cliDefault: "2 minutes",
		nullable: true,
		nullLabel: "No timeout",
		advanced: true,
	},
	{
		key: "searchLimit",
		label: "Search limit per run",
		group: "scheduling",
		type: "integer",
		description:
			"Number of searches (unique queries) per indexer in one run. Remaining searches wait for the next searchCadence. null = no limit.",
		docs: `${DOCS}/basics/options#searchlimit`,
		templateDefault: 400,
		cliDefault: 0,
		nullable: true,
		nullLabel: "No limit",
		min: 0,
	},
	{
		key: "blockList",
		label: "Blocklist",
		group: "blocklist",
		type: "stringList",
		description:
			"Ignore torrents/data matching any entry. Each entry is <type>:<value>, e.g. name:Sample, nameRegex:(?i)\\bCAM\\b, category:music, tag:no-xseed, tracker:tracker.example.com, infoHash:<40 hex>, sizeBelow:<bytes>, sizeAbove:<bytes>, folder:, folderRegex:.",
		docs: `${DOCS}/basics/options#blocklist`,
		templateDefault: [],
		cliDefault: [],
	},
	// ---------------------------------------------------------------- legacy
	{
		key: "injectDir",
		label: "Inject directory (deprecated)",
		group: "legacy",
		type: "path",
		description: "Deprecated. Only used by `cross-seed inject`. Use outputDir.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		advanced: true,
	},
	{
		key: "ignoreTitles",
		label: "Ignore titles (inject command)",
		group: "legacy",
		type: "boolean",
		description:
			"Only for the manual `cross-seed inject` command: skip the fuzzy title check. May cause false positives.",
		templateDefault: undefined,
		cliDefault: false,
		nullable: true,
		advanced: true,
	},
	{
		key: "linkDir",
		label: "linkDir (deprecated)",
		group: "legacy",
		type: "path",
		description: "Deprecated. Use linkDirs.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		deprecated: { replacedBy: "linkDirs", note: "Moved into linkDirs" },
	},
	{
		key: "notificationWebhookUrl",
		label: "notificationWebhookUrl (deprecated)",
		group: "legacy",
		type: "string",
		description: "Deprecated. Use notificationWebhookUrls.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		secret: true,
		deprecated: {
			replacedBy: "notificationWebhookUrls",
			note: "Moved into notificationWebhookUrls",
		},
	},
	{
		key: "qbittorrentUrl",
		label: "qbittorrentUrl (deprecated)",
		group: "legacy",
		type: "string",
		description: "Deprecated. Use torrentClients.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		secret: true,
		deprecated: { replacedBy: "torrentClients", note: "qbittorrent:<url>" },
	},
	{
		key: "rtorrentRpcUrl",
		label: "rtorrentRpcUrl (deprecated)",
		group: "legacy",
		type: "string",
		description: "Deprecated. Use torrentClients.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		secret: true,
		deprecated: { replacedBy: "torrentClients", note: "rtorrent:<url>" },
	},
	{
		key: "transmissionRpcUrl",
		label: "transmissionRpcUrl (deprecated)",
		group: "legacy",
		type: "string",
		description: "Deprecated. Use torrentClients.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		secret: true,
		deprecated: { replacedBy: "torrentClients", note: "transmission:<url>" },
	},
	{
		key: "delugeRpcUrl",
		label: "delugeRpcUrl (deprecated)",
		group: "legacy",
		type: "string",
		description: "Deprecated. Use torrentClients.",
		templateDefault: undefined,
		cliDefault: undefined,
		nullable: true,
		secret: true,
		deprecated: { replacedBy: "torrentClients", note: "deluge:<url>" },
	},
];

export const OPTION_BY_KEY: Record<string, OptionMeta> = Object.fromEntries(
	OPTIONS.map((o) => [o.key, o]),
);

/** Keys cross-seed reads from config.js. Anything else is ignored by cross-seed. */
export const KNOWN_KEYS = new Set(OPTIONS.map((o) => o.key));

export type CrossSeedConfig = Record<string, unknown>;

/** Effective value: the file value if present, otherwise the CLI default. */
export function effectiveValue(config: CrossSeedConfig, key: string): unknown {
	const v = config[key];
	return v === undefined ? OPTION_BY_KEY[key]?.cliDefault : v;
}

/** Fresh config with the same defaults as `cross-seed gen-config`. */
export function templateConfig(): CrossSeedConfig {
	const out: CrossSeedConfig = {};
	for (const o of OPTIONS) {
		if (o.group === "legacy") continue;
		out[o.key] = structuredClone(o.templateDefault);
	}
	return out;
}

export const TORRENT_CLIENT_TYPES = [
	"qbittorrent",
	"rtorrent",
	"transmission",
	"deluge",
] as const;
export type TorrentClientType = (typeof TORRENT_CLIENT_TYPES)[number];

export const CLIENT_URL_HINTS: Record<TorrentClientType, string> = {
	qbittorrent: "http://username:password@localhost:8080",
	rtorrent: "http://username:password@localhost:1234/RPC2",
	transmission: "http://username:password@localhost:9091/transmission/rpc",
	deluge: "http://:password@localhost:8112/json",
};

export interface ParsedClientEntry {
	clientType: string;
	readonly: boolean;
	url: string;
}

/** Same regex as cross-seed's parseClientEntry. */
export function parseClientEntry(entry: string): ParsedClientEntry | null {
	const match = /^(?<clientType>.+?):(?:(?<readonly>readonly):)?(?<url>.*)$/.exec(
		entry,
	);
	if (!match?.groups) return null;
	return {
		clientType: match.groups.clientType,
		readonly: Boolean(match.groups.readonly),
		url: match.groups.url,
	};
}

export function formatClientEntry(e: ParsedClientEntry): string {
	return `${e.clientType}:${e.readonly ? "readonly:" : ""}${e.url}`;
}

export const BLOCKLIST_TYPES = [
	{ value: "name", label: "Name contains", hint: "Case-insensitive substring of the torrent name" },
	{ value: "nameRegex", label: "Name regex", hint: "JavaScript regular expression on the name" },
	{ value: "folder", label: "Folder name", hint: "dataDirs only, folder name without slashes" },
	{ value: "folderRegex", label: "Folder regex", hint: "dataDirs only, regex on the folder path" },
	{ value: "category", label: "Category", hint: "qBittorrent/Deluge category (empty = no category)" },
	{ value: "tag", label: "Tag", hint: "Client tag/label (empty = no tags)" },
	{ value: "tracker", label: "Tracker host", hint: "Announce host[:port], e.g. tracker.example.com" },
	{ value: "infoHash", label: "Info hash", hint: "40-character info hash" },
	{ value: "sizeBelow", label: "Size below (bytes)", hint: "Ignore anything smaller than this many bytes" },
	{ value: "sizeAbove", label: "Size above (bytes)", hint: "Ignore anything larger than this many bytes" },
] as const;

export function parseBlocklistEntry(entry: string): { type: string; value: string } {
	const match = /^(?<type>.+?):(?<value>.*)$/.exec(entry);
	if (match?.groups) return { type: match.groups.type, value: match.groups.value };
	return { type: "legacy", value: entry };
}

/** Migrate deprecated keys the same way cross-seed does at startup. */
export function migrateLegacy(config: CrossSeedConfig): {
	config: CrossSeedConfig;
	notes: string[];
} {
	const c: CrossSeedConfig = { ...config };
	const notes: string[] = [];
	const clients = Array.isArray(c.torrentClients) ? [...(c.torrentClients as string[])] : [];
	for (const [key, type] of [
		["qbittorrentUrl", "qbittorrent"],
		["rtorrentRpcUrl", "rtorrent"],
		["transmissionRpcUrl", "transmission"],
		["delugeRpcUrl", "deluge"],
	] as const) {
		if (typeof c[key] === "string" && c[key]) {
			if (!clients.length) clients.push(`${type}:${c[key]}`);
			notes.push(`${key} moved into torrentClients`);
		}
		delete c[key];
	}
	c.torrentClients = clients;
	if (typeof c.linkDir === "string" && c.linkDir) {
		const dirs = Array.isArray(c.linkDirs) ? [...(c.linkDirs as string[])] : [];
		if (!dirs.length) dirs.push(c.linkDir);
		c.linkDirs = dirs;
		notes.push("linkDir moved into linkDirs");
	}
	delete c.linkDir;
	if (typeof c.notificationWebhookUrl === "string" && c.notificationWebhookUrl) {
		const urls = Array.isArray(c.notificationWebhookUrls)
			? [...(c.notificationWebhookUrls as string[])]
			: [];
		if (!urls.length) urls.push(c.notificationWebhookUrl);
		c.notificationWebhookUrls = urls;
		notes.push("notificationWebhookUrl moved into notificationWebhookUrls");
	}
	delete c.notificationWebhookUrl;
	return { config: c, notes };
}
