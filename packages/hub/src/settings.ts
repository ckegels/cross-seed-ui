/**
 * Hub settings, read from JSON (default /etc/cross-seed-ui/hub.json).
 */
import { readFileSync } from "node:fs";
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

export function loadHubSettings(path: string): HubSettings {
	let raw: Partial<HubSettings> = {};
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`Cannot read hub settings ${path}: ${(e as Error).message}`);
	}
	const s = { ...DEFAULT_HUB_SETTINGS, ...raw };
	s.stateDir = resolve(s.stateDir);
	s.webDir = resolve(s.webDir);
	return s;
}

export function settingsPathFromArgs(argv: string[]): string {
	const i = argv.indexOf("--config");
	if (i >= 0 && argv[i + 1]) return argv[i + 1];
	return process.env.CSUI_HUB_CONFIG ?? "/etc/cross-seed-ui/hub.json";
}
