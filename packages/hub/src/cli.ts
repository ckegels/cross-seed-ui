/**
 * Hub maintenance commands (run as root on the hub LXC via `cross-seed-ui`):
 *   hub.mjs --config <file> reset-password <username>   prints a new random password
 *   hub.mjs --config <file> setup-token                  prints the first-run token
 *   hub.mjs --config <file> add-instance <name> <url> <secretFile>
 *   hub.mjs --config <file> disable-2fa <username>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signRequest } from "@csui/shared/src/node/hmac.ts";
import { hashPassword, randomToken, SecretBox } from "./crypto.ts";
import { audit, openHubDb } from "./db.ts";
import type { HubSettings } from "./settings.ts";

export const CLI_COMMANDS = ["reset-password", "setup-token", "add-instance", "disable-2fa"];

export async function runCli(settings: HubSettings, args: string[]): Promise<number> {
	const db = openHubDb(settings.stateDir);
	const [cmd, ...rest] = args;
	try {
		switch (cmd) {
			case "reset-password": {
				const username = rest[0];
				const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username ?? "") as { id: number } | undefined;
				if (!user) {
					console.error(`No user "${username}"`);
					return 1;
				}
				const pw = randomToken(12);
				db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(await hashPassword(pw), Date.now(), user.id);
				audit(db, { username: "cli", ip: null, action: "password.reset_cli", detail: username });
				console.log(`New password for ${username}: ${pw}\nAll sessions of this user were signed out.`);
				return 0;
			}
			case "disable-2fa": {
				const r = db.prepare("UPDATE users SET totp_secret = NULL, totp_last_counter = NULL WHERE username = ?").run(rest[0] ?? "");
				if (!r.changes) {
					console.error(`No user "${rest[0]}"`);
					return 1;
				}
				audit(db, { username: "cli", ip: null, action: "2fa.disabled_cli", detail: rest[0] });
				console.log(`2FA disabled for ${rest[0]}`);
				return 0;
			}
			case "setup-token": {
				const n = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
				if (n > 0) {
					console.log("Setup is already done (an admin exists). Use reset-password if you are locked out.");
					return 0;
				}
				try {
					console.log(readFileSync(join(settings.stateDir, "setup-token"), "utf8").trim());
				} catch {
					console.log("No token yet: start the hub once, it creates one.");
				}
				return 0;
			}
			case "add-instance": {
				const [name, url, secretFile] = rest;
				if (!name || !url || !secretFile) {
					console.error("usage: add-instance <name> <url> <secretFile>");
					return 1;
				}
				const secret = readFileSync(secretFile, "utf8").trim();
				const clean = url.replace(/\/+$/, "");
				const res = await fetch(`${clean}/v1/info`, { headers: signRequest(secret, "GET", "/v1/info", ""), signal: AbortSignal.timeout(10_000) });
				if (!res.ok) {
					console.error(`Agent check failed: HTTP ${res.status} ${await res.text()}`);
					return 1;
				}
				if (db.prepare("SELECT 1 FROM instances WHERE url = ?").get(clean)) {
					console.log(`An instance with url ${clean} already exists`);
					return 0;
				}
				const box = new SecretBox(join(settings.stateDir, "secret.key"));
				const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM instances").get() as { n: number }).n;
				db.prepare("INSERT INTO instances (name, url, secret, color, sort, created_at) VALUES (?, ?, ?, '#2a78d6', ?, ?)").run(
					name,
					clean,
					box.encrypt(secret),
					sort,
					Date.now(),
				);
				audit(db, { username: "cli", ip: null, action: "instance.added", detail: `${name} ${clean}` });
				console.log(`Added instance "${name}" (${clean})`);
				return 0;
			}
			default:
				console.error(`Unknown command ${cmd}. Commands: ${CLI_COMMANDS.join(", ")}`);
				return 1;
		}
	} finally {
		db.close();
	}
}
