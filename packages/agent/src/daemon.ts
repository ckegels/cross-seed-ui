/**
 * Talks to the local cross-seed daemon (HTTP API on its port) and runs the
 * official `cross-seed` CLI for maintenance commands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CrossSeedConfig } from "@csui/shared";
import { HttpError } from "@csui/shared/src/node/http.ts";
import type { CrossSeedDb } from "./crossSeedDb.ts";
import { type ServiceController, stripAnsi } from "./service.ts";

const execFileP = promisify(execFile);

export const JOB_NAMES = ["rss", "search", "updateIndexerCaps", "inject", "cleanup"] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** CLI subcommands the UI may run (fixed list, no user-provided arguments except validated ones). */
export const MAINTENANCE_COMMANDS = {
	"clear-indexer-failures": {
		label: "Clear indexer failures",
		description: "Forget rate limits / failures and cached caps of all indexers so they are retried right away.",
		args: ["clear-indexer-failures"],
	},
	"clear-cache": {
		label: "Clear search cache",
		description:
			"Reset the timestamps used by excludeOlder and excludeRecentSearch (everything becomes searchable again) without re-snatching torrents.",
		args: ["clear-cache"],
	},
	"clear-client-cache": {
		label: "Clear client cache",
		description: "Clear cross-seed's cache of your client's torrents. Only needed after changing clients or moving torrents.",
		args: ["clear-client-cache"],
	},
	"test-notification": {
		label: "Send test notification",
		description: "Send a test message to every notificationWebhookUrls entry.",
		args: ["test-notification"],
	},
} as const;
export type MaintenanceCommand = keyof typeof MAINTENANCE_COMMANDS;

export class CrossSeedDaemon {
	private versionCache: { v: string | null; at: number } | null = null;
	private cliApiKey: string | null = null;

	constructor(
		private bin: string,
		private crossSeedDir: string,
		private db: CrossSeedDb,
		private opts: { url?: string; exec?: ServiceController["exec"]; version?: ServiceController["crossSeedVersion"] } = {},
	) {}

	private env() {
		return { ...process.env, CONFIG_DIR: this.crossSeedDir, FORCE_COLOR: "0", NO_COLOR: "1" };
	}

	async runCli(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
		if (this.opts.exec) {
			// docker: run the CLI inside the cross-seed container (same version, same /config)
			try {
				const r = await this.opts.exec(["cross-seed", ...args], timeoutMs);
				return { ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
			} catch (e) {
				throw new HttpError(502, `Could not run cross-seed in its container: ${(e as Error).message}`, "exec_failed");
			}
		}
		try {
			const { stdout, stderr } = await execFileP(this.bin, args, {
				env: this.env(),
				timeout: timeoutMs,
				maxBuffer: 16 * 1024 * 1024,
				cwd: this.crossSeedDir,
			});
			return { stdout, stderr, code: 0 };
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; code?: number | string; message: string };
			if (err.code === "ENOENT") {
				throw new HttpError(500, `cross-seed executable not found (${this.bin}). Check crossSeedBin in the agent settings.`, "no_binary");
			}
			return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, code: typeof err.code === "number" ? err.code : 1 };
		}
	}

	async version(): Promise<string | null> {
		if (this.versionCache && Date.now() - this.versionCache.at < 5 * 60_000) return this.versionCache.v;
		let v: string | null = null;
		if (this.opts.version) {
			v = await this.opts.version().catch(() => null);
			this.versionCache = { v, at: Date.now() };
			return v;
		}
		try {
			const r = await this.runCli(["--version"], 20_000);
			v = /(\d+\.\d+\.\d+[\w.-]*)/.exec(r.stdout)?.[1] ?? null;
		} catch {
			v = null;
		}
		this.versionCache = { v, at: Date.now() };
		return v;
	}

	invalidateVersion() {
		this.versionCache = null;
	}

	/** Key precedence like cross-seed: config.apiKey, then the DB settings row, then the CLI (which generates one). */
	async apiKey(config: CrossSeedConfig): Promise<string | null> {
		if (typeof config.apiKey === "string" && config.apiKey.length >= 24) return config.apiKey;
		const fromDb = this.db.apiKey();
		if (fromDb) return fromDb;
		if (this.cliApiKey) return this.cliApiKey;
		if (this.opts.url) {
			// remote/container cross-seed: any authenticated request makes it generate
			// and store its key, which we then read from the database (read-only)
			const base = this.baseUrl(config);
			if (base) {
				await fetch(`${base}/api/status`, { headers: { "x-api-key": "csui-key-bootstrap" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
				const generated = this.db.apiKey();
				if (generated) return generated;
			}
		}
		const r = await this.runCli(["api-key"], 30_000).catch(() => null);
		const key = r?.stdout.trim().split("\n").at(-1)?.trim();
		if (key && /^[a-f0-9]{24,}$/i.test(key)) this.cliApiKey = key;
		return this.cliApiKey;
	}

	baseUrl(config: CrossSeedConfig): string | null {
		const port = config.port === undefined ? 2468 : config.port;
		if (port === null || port === false || typeof port !== "number") return null;
		if (this.opts.url) return this.opts.url.replace(/\/+$/, "");
		let host = typeof config.host === "string" && config.host && config.host !== "0.0.0.0" ? config.host : "127.0.0.1";
		if (host === "::") host = "::1";
		if (host.includes(":")) host = `[${host}]`;
		return `http://${host}:${port}`;
	}

	async ping(config: CrossSeedConfig): Promise<{ reachable: boolean; latencyMs: number | null; error: string | null }> {
		const base = this.baseUrl(config);
		if (!base) return { reachable: false, latencyMs: null, error: "HTTP server disabled (port: false)" };
		const t = Date.now();
		try {
			const res = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(3000) });
			return { reachable: res.ok, latencyMs: Date.now() - t, error: res.ok ? null : `HTTP ${res.status}` };
		} catch (e) {
			return { reachable: false, latencyMs: null, error: (e as Error).cause ? String((e as { cause: Error }).cause.message) : (e as Error).message };
		}
	}

	private async call(config: CrossSeedConfig, path: string, body: unknown): Promise<{ status: number; text: string }> {
		const base = this.baseUrl(config);
		if (!base) throw new HttpError(409, "The cross-seed HTTP server is disabled (port: false), jobs can't be triggered.", "daemon_disabled");
		const key = await this.apiKey(config);
		if (!key) throw new HttpError(500, "Could not determine the cross-seed API key", "no_api_key");
		try {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": key },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			return { status: res.status, text: await res.text() };
		} catch (e) {
			throw new HttpError(502, `cross-seed daemon is not reachable: ${(e as Error).message}`, "daemon_unreachable");
		}
	}

	async triggerJob(config: CrossSeedConfig, name: JobName, opts: { ignoreExcludeRecentSearch?: boolean; ignoreExcludeOlder?: boolean }) {
		const r = await this.call(config, "/api/job", { name, ...opts });
		return { ok: r.status === 200, status: r.status, message: r.text || `HTTP ${r.status}` };
	}

	async searchTorrent(config: CrossSeedConfig, body: Record<string, unknown>) {
		const r = await this.call(config, "/api/webhook", body);
		return {
			ok: r.status === 204 || r.status === 200,
			status: r.status,
			message: r.status === 204 ? "Search queued. Watch the activity feed for results." : r.text || `HTTP ${r.status}`,
		};
	}
}
