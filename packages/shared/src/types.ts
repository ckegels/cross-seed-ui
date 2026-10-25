/**
 * API contract between agent -> hub -> web. Browser-safe.
 * Agent routes are under /v1/*, the hub exposes them to the UI as
 * /api/instances/:id/* (same payloads).
 */
import type { CrossSeedConfig } from "./options.ts";
import type { ValidationResult } from "./validate.ts";

export const AGENT_API_VERSION = 1;

export interface ServiceStatus {
	manager: "systemd" | "process" | "none";
	name: string;
	/** active | inactive | failed | activating | deactivating | unknown */
	state: string;
	subState: string | null;
	since: number | null;
	pid: number | null;
	memoryBytes: number | null;
	restarts: number | null;
}

export interface DiskInfo {
	path: string;
	label: string;
	totalBytes: number;
	freeBytes: number;
}

export interface AgentInfo {
	agentVersion: string;
	apiVersion: number;
	hostname: string;
	nodeVersion: string;
	uptimeSec: number;
	loadavg: number[];
	memory: { totalBytes: number; freeBytes: number };
	crossSeed: {
		version: string | null;
		binary: string;
		configDir: string;
		configExists: boolean;
		dbExists: boolean;
	};
	service: ServiceStatus;
	daemon: {
		reachable: boolean;
		port: number | null;
		apiKeyAvailable: boolean;
		latencyMs: number | null;
		error: string | null;
	};
	disks: DiskInfo[];
	time: number;
}

export interface ConfigResponse {
	/** Redacted unless `revealed` */
	config: CrossSeedConfig;
	revealed: boolean;
	hash: string;
	mtime: number | null;
	exists: boolean;
	/** config.js contains code (process.env, require, functions...) that saving will flatten */
	usesDynamicCode: boolean;
	unknownKeys: string[];
	legacyKeys: string[];
	validation: ValidationResult;
	configDir: string;
	path: string;
}

export interface SaveConfigRequest {
	config: CrossSeedConfig;
	/** hash from ConfigResponse, protects against overwriting concurrent edits */
	baseHash: string;
	restart: boolean;
	/** restore the previous file automatically if cross-seed fails to start */
	autoRollback: boolean;
	note?: string;
	/** save even when validation reports errors */
	force?: boolean;
}

export interface RestartResult {
	ok: boolean;
	rolledBack: boolean;
	message: string;
	logTail: string[];
}

export interface SaveConfigResponse {
	hash: string;
	backupId: string | null;
	validation: ValidationResult;
	restart: RestartResult | null;
}

export interface BackupInfo {
	id: string;
	createdAt: number;
	size: number;
	note: string;
	hash: string;
}

export interface JobInfo {
	name: string;
	enabled: boolean;
	cadenceMs: number | null;
	lastRun: number | null;
	nextRun: number | null;
	running: boolean;
	runningSince: number | null;
}

export interface IndexerInfo {
	id: number;
	name: string | null;
	url: string;
	inConfig: boolean;
	active: boolean;
	status: string | null;
	retryAfter: number | null;
	caps: {
		search: boolean | null;
		tv: boolean | null;
		movie: boolean | null;
		music: boolean | null;
		audio: boolean | null;
		book: boolean | null;
	};
	tvIdCaps: Record<string, boolean> | null;
	movieIdCaps: Record<string, boolean> | null;
	categories: Record<string, boolean> | null;
	limits: { default: number; max: number } | null;
	trackers: string[] | null;
	searchees: number;
	lastSearched: number | null;
	matches: number;
	injected: number;
}

export interface DayBucket {
	day: string; // YYYY-MM-DD (agent local time)
	matches: number;
	injected: number;
	saved: number;
	failed: number;
	searches: number;
}

export interface TrackerStat {
	tracker: string;
	injected: number;
	saved: number;
	exists: number;
	failed: number;
	incomplete: number;
}

export interface MatchEvent {
	id: number;
	ts: number;
	via: string;
	name: string;
	tracker: string;
	decision: string;
	result: string;
	source: string;
	searchee: string;
}

export interface InstanceStats {
	generatedAt: number;
	library: {
		searchees: number;
		clientTorrents: number;
		byClient: { host: string; count: number }[];
		totalBytes: number;
		dataEntries: number;
		ensembleEntries: number;
	};
	searches: {
		searched: number;
		neverSearched: number;
		searched24h: number;
		searched7d: number;
		lastSearchAt: number | null;
	};
	decisions: {
		total: number;
		byDecision: Record<string, number>;
		matches: number;
		matches24h: number;
		matches7d: number;
		matches30d: number;
	};
	results: {
		injected: number;
		saved: number;
		exists: number;
		failed: number;
		incomplete: number;
		injected24h: number;
		injected7d: number;
		injected30d: number;
		since: number | null;
	};
	byTracker: TrackerStat[];
	timeline: DayBucket[];
	torrentCache: { files: number; bytes: number };
	indexers: { total: number; inConfig: number; ok: number; rateLimited: number; failing: number };
}

export interface Activity {
	/** idle | searching | rss | injecting | cleanup | caps | starting | stopped */
	state: string;
	runningJobs: { name: string; since: number }[];
	progress: {
		via: string;
		index: number;
		total: number;
		name: string;
		ts: number;
		etaMs: number | null;
	} | null;
	lastEvent: { ts: number; text: string } | null;
	lastMatch: MatchEvent | null;
	lastError: { ts: number; text: string } | null;
	lastLogAt: number | null;
}

export interface DecisionRow {
	id: number;
	searchee: string;
	tracker: string | null;
	guid: string;
	infoHash: string | null;
	decision: string;
	firstSeen: number | null;
	lastSeen: number | null;
}

export interface LibraryRow {
	infoHash: string;
	name: string;
	title: string;
	clientHost: string;
	category: string | null;
	tags: string[];
	trackers: string[];
	length: number;
	savePath: string;
	firstSearched: number | null;
	lastSearched: number | null;
	matches: number;
}

export interface Paged<T> {
	rows: T[];
	total: number;
	offset: number;
	limit: number;
}

export interface LogLine {
	ts: number;
	level: string;
	label: string | null;
	message: string;
}

export type TestKind = "torznab" | "sonarr" | "radarr" | "client" | "notification" | "prowlarr";

export interface TestResult {
	ok: boolean;
	message: string;
	latencyMs: number | null;
	details?: Record<string, unknown>;
}

export interface ActionResponse {
	ok: boolean;
	message: string;
	output?: string;
}
