/**
 * Agent settings, read from a JSON file (default /etc/cross-seed-ui/agent.json).
 * Created by deploy/install.sh. Every field has a sane default for the Proxmox
 * community-script install (cross-seed as root, config in /root/.cross-seed).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentSettings {
	listen: string;
	port: number;
	/** shared HMAC secret, must match the hub's copy */
	secret: string;
	/** optional allow-list of hub IPs (exact match or CIDR); empty = any */
	allowedIps: string[];
	crossSeedDir: string;
	/** cross-seed executable (resolved via PATH when not absolute) */
	crossSeedBin: string;
	service: {
		/** systemd: control `name` via systemctl. process: spawn `command` (dev). none: no control */
		manager: "systemd" | "process" | "none";
		name: string;
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

export function loadSettings(path: string): AgentSettings {
	let raw: Partial<AgentSettings>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`Cannot read agent settings ${path}: ${(e as Error).message}`);
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
