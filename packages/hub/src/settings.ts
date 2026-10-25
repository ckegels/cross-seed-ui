/**
 * Hub settings, read from JSON (default /etc/cross-seed-ui/hub.json).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface HubSettings {
	listen: string;
	port: number;
	stateDir: string;
	/** directory with the built web UI (index.html + assets) */
	webDir: string;
	/** trust X-Forwarded-For / X-Forwarded-Proto (only behind your own reverse proxy) */
	trustProxy: boolean;
	/** "auto" = Secure cookie when the request arrived over HTTPS */
	secureCookies: "auto" | boolean;
	/** optional built-in HTTPS */
	tls?: { certFile: string; keyFile: string };
	sessionIdleHours: number;
	sessionMaxDays: number;
	/** minutes a password re-confirmation ("sudo") stays valid for sensitive actions */
	sudoMinutes: number;
	/** where `cross-seed-ui update` gets releases (owner/repo) */
	githubRepo: string;
	/** file with a GitHub token, only needed for a private fork (optional) */
	githubTokenFile: string;
}

export const DEFAULT_HUB_SETTINGS: HubSettings = {
	listen: "0.0.0.0",
	port: 2470,
	stateDir: "/var/lib/cross-seed-ui/hub",
	webDir: "/opt/cross-seed-ui/current/web",
	trustProxy: false,
	secureCookies: "auto",
	sessionIdleHours: 24 * 7,
	sessionMaxDays: 30,
	sudoMinutes: 10,
	githubRepo: "ckegels/cross-seed-ui",
	githubTokenFile: "/etc/cross-seed-ui/github-token",
};

/** Settings from environment variables (Docker image). */
export function hubSettingsFromEnv(env = process.env): Partial<HubSettings> {
	const out: Partial<HubSettings> = {};
	if (env.CSUI_LISTEN) out.listen = env.CSUI_LISTEN;
	if (env.CSUI_PORT) out.port = Number(env.CSUI_PORT);
	if (env.CSUI_STATE_DIR) out.stateDir = env.CSUI_STATE_DIR;
	if (env.CSUI_WEB_DIR) out.webDir = env.CSUI_WEB_DIR;
	if (env.CSUI_TRUST_PROXY) out.trustProxy = env.CSUI_TRUST_PROXY === "true";
	if (env.CSUI_SECURE_COOKIES) out.secureCookies = env.CSUI_SECURE_COOKIES === "auto" ? "auto" : env.CSUI_SECURE_COOKIES === "true";
	if (env.CSUI_GITHUB_TOKEN_FILE) out.githubTokenFile = env.CSUI_GITHUB_TOKEN_FILE;
	return out;
}

/**
 * Agents to register automatically at startup (Docker compose):
 * CSUI_AGENT_URL / CSUI_AGENT_SECRET / CSUI_AGENT_NAME, and CSUI_AGENT_2_URL ... _9_.
 */
export function agentsFromEnv(env = process.env): { name: string; url: string; secret: string }[] {
	const out: { name: string; url: string; secret: string }[] = [];
	for (const p of ["CSUI_AGENT", ...Array.from({ length: 8 }, (_, i) => `CSUI_AGENT_${i + 2}`)]) {
		const url = env[`${p}_URL`];
		const secret = env[`${p}_SECRET`];
		if (url && secret) out.push({ url: url.replace(/\/+$/, ""), secret, name: env[`${p}_NAME`] || new URL(url).hostname });
	}
	return out;
}

export function loadHubSettings(path: string): HubSettings {
	let raw: Partial<HubSettings> = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new Error(`Cannot read hub settings ${path}: ${(e as Error).message}`);
		}
	} else if (!process.env.CSUI_STATE_DIR) {
		throw new Error(`Hub settings ${path} not found (or set CSUI_* environment variables)`);
	}
	const s = { ...DEFAULT_HUB_SETTINGS, ...raw, ...hubSettingsFromEnv() };
	s.stateDir = resolve(s.stateDir);
	s.webDir = resolve(s.webDir);
	return s;
}

export function settingsPathFromArgs(argv: string[]): string {
	const i = argv.indexOf("--config");
	if (i >= 0 && argv[i + 1]) return argv[i + 1];
	return process.env.CSUI_HUB_CONFIG ?? "/etc/cross-seed-ui/hub.json";
}
