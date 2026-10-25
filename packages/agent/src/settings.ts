/**
 * Agent settings, read from a JSON file (default /etc/cross-seed-ui/agent.json).
 * Created by deploy/install.sh. Every field has a sane default for the Proxmox
 * community-script install (cross-seed as root, config in /root/.cross-seed).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentSettings {
	listen: string;
	port: number;
	/** shared HMAC secret, must match the hub's copy */
	secret: string;
	/** optional allow-list of hub IPs (exact match or CIDR); empty = any */
	allowedIps: string[];
	crossSeedDir: string;
	/** address of cross-seed's API when it isn't on this host (docker: http://cross-seed:2468) */
	crossSeedUrl?: string;
	/** cross-seed executable (resolved via PATH when not absolute) */
	crossSeedBin: string;
	service: {
		/** systemd: control `name` via systemctl. docker: container `name` via the Docker API. process: spawn `command` (dev). none: no control */
		manager: "systemd" | "process" | "docker" | "none";
		name: string;
		/** docker only: unix:///var/run/docker.sock or tcp://socket-proxy:2375 */
		dockerHost?: string;
		command?: string[];
		env?: Record<string, string>;
	};
	stateDir: string;
	/** keep this many config backups */
	maxBackups: number;
	/** events older than this many days are pruned */
	eventRetentionDays: number;
	/** parse existing rotated logs on first start */
	backfillLogs: boolean;
}

export const DEFAULT_SETTINGS: Omit<AgentSettings, "secret"> = {
	listen: "0.0.0.0",
	port: 2469,
	allowedIps: [],
	crossSeedDir: "/root/.cross-seed",
	crossSeedBin: "cross-seed",
	service: { manager: "systemd", name: "cross-seed" },
	stateDir: "/var/lib/cross-seed-ui/agent",
	maxBackups: 50,
	eventRetentionDays: 365,
	backfillLogs: true,
};

/**
 * Settings from environment variables (used by the Docker image when no
 * settings file exists). Every variable is optional except the secret.
 */
export function settingsFromEnv(env = process.env): Partial<AgentSettings> {
	const out: Partial<AgentSettings> = {};
	if (env.CSUI_LISTEN) out.listen = env.CSUI_LISTEN;
	if (env.CSUI_PORT) out.port = Number(env.CSUI_PORT);
	if (env.CSUI_AGENT_SECRET) out.secret = env.CSUI_AGENT_SECRET;
	if (env.CSUI_ALLOWED_IPS) out.allowedIps = env.CSUI_ALLOWED_IPS.split(",").map((x) => x.trim()).filter(Boolean);
	if (env.CSUI_CROSS_SEED_DIR) out.crossSeedDir = env.CSUI_CROSS_SEED_DIR;
	if (env.CSUI_CROSS_SEED_URL) out.crossSeedUrl = env.CSUI_CROSS_SEED_URL;
	if (env.CSUI_CROSS_SEED_BIN) out.crossSeedBin = env.CSUI_CROSS_SEED_BIN;
	if (env.CSUI_STATE_DIR) out.stateDir = env.CSUI_STATE_DIR;
	if (env.CSUI_SERVICE_MANAGER || env.CSUI_CROSS_SEED_CONTAINER) {
		out.service = {
			manager: (env.CSUI_SERVICE_MANAGER as AgentSettings["service"]["manager"]) ?? "docker",
			name: env.CSUI_CROSS_SEED_CONTAINER ?? env.CSUI_SERVICE_NAME ?? "cross-seed",
			dockerHost: env.DOCKER_HOST,
		};
	}
	return out;
}

export function loadSettings(path: string): AgentSettings {
	let raw: Partial<AgentSettings>;
	if (!existsSync(path) && process.env.CSUI_AGENT_SECRET) {
		raw = settingsFromEnv();
	} else {
		try {
			raw = { ...JSON.parse(readFileSync(path, "utf8")), ...settingsFromEnv() };
		} catch (e) {
			throw new Error(`Cannot read agent settings ${path}: ${(e as Error).message}`);
		}
	}
	const s: AgentSettings = {
		...DEFAULT_SETTINGS,
		...raw,
		service: { ...DEFAULT_SETTINGS.service, ...(raw.service ?? {}) },
	} as AgentSettings;
	if (!s.secret || s.secret.length < 32) {
		throw new Error(`Agent settings ${path}: "secret" must be at least 32 characters`);
	}
	s.crossSeedDir = resolve(s.crossSeedDir);
	s.stateDir = resolve(s.stateDir);
	return s;
}

export function settingsPathFromArgs(argv: string[]): string {
	const i = argv.indexOf("--config");
	if (i >= 0 && argv[i + 1]) return argv[i + 1];
	return process.env.CSUI_AGENT_CONFIG ?? "/etc/cross-seed-ui/agent.json";
}
