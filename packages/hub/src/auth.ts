/**
 * Sessions, login throttling, CSRF and role checks for the hub.
 *
 * - Session id: 32 random bytes in an HttpOnly, SameSite=Strict cookie; only
 *   its SHA-256 is stored, so a leaked DB can't be used to hijack sessions.
 * - Idle timeout + absolute lifetime, rolling last_seen.
 * - CSRF: SameSite=Strict + every state-changing request must send the custom
 *   header `x-csui: 1` (cross-site forms can't set it, CORS is never enabled)
 *   and, when present, Origin must match Host.
 * - Login throttling per IP and per username.
 * - "sudo": sensitive actions (reveal secrets, raw config, users, instances)
 *   require a password re-confirmation within the last N minutes.
 */
import type { ServerResponse } from "node:http";
import { HttpError, type Req } from "@csui/shared/src/node/http.ts";
import { randomToken, sha256 } from "./crypto.ts";
import type { HubDb, UserRow } from "./db.ts";
import type { HubSettings } from "./settings.ts";

export const COOKIE = "csui_sid";

export interface SessionInfo {
	idHash: string;
	user: UserRow;
	sudoUntil: number;
	createdAt: number;
	pendingTotp: string | null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const k = part.slice(0, i).trim();
		const v = part.slice(i + 1).trim();
		if (k && !(k in out)) {
			try {
				out[k] = decodeURIComponent(v);
			} catch {
				out[k] = v;
			}
		}
	}
	return out;
}

export function isHttps(req: Req, settings: HubSettings): boolean {
	if ((req.raw.socket as { encrypted?: boolean }).encrypted) return true;
	if (settings.trustProxy) return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
	return false;
}

function cookieAttrs(req: Req, settings: HubSettings, maxAgeSec: number): string {
	const secure = settings.secureCookies === "auto" ? isHttps(req, settings) : settings.secureCookies;
	return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export class Sessions {
	constructor(
		private db: HubDb,
		private settings: HubSettings,
	) {
		setInterval(() => this.purge(), 3600_000).unref();
	}

	create(req: Req, res: ServerResponse, user: UserRow): void {
		const token = randomToken(32);
		const now = Date.now();
		const expires = now + this.settings.sessionMaxDays * 86_400_000;
		this.db
			.prepare(
				"INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, sudo_until, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			// a fresh login counts as a password confirmation
			.run(sha256(token), user.id, now, now, expires, now + this.settings.sudoMinutes * 60_000, req.ip, String(req.headers["user-agent"] ?? "").slice(0, 200));
		res.setHeader("set-cookie", `${COOKIE}=${token}; ${cookieAttrs(req, this.settings, this.settings.sessionMaxDays * 86400)}`);
	}

	destroy(req: Req, res: ServerResponse) {
		const s = req.ctx.session as SessionInfo | undefined;
		if (s) this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(s.idHash);
		res.setHeader("set-cookie", `${COOKIE}=; ${cookieAttrs(req, this.settings, 0)}`);
	}

	/** Resolve the session from the cookie, or null. Updates last_seen. */
	resolve(req: Req): SessionInfo | null {
		const token = parseCookies(req.headers.cookie)[COOKIE];
		if (!token || token.length > 100) return null;
		const idHash = sha256(token);
		const row = this.db
			.prepare(
				`SELECT s.*, u.id AS uid FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
			)
			.get(idHash) as Record<string, unknown> | undefined;
		if (!row) return null;
		const now = Date.now();
		const idleLimit = this.settings.sessionIdleHours * 3600_000;
		if ((row.expires_at as number) < now || now - (row.last_seen_at as number) > idleLimit) {
			this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
			return null;
		}
		const user = this.db.prepare("SELECT * FROM users WHERE id = ?").get(row.uid as number) as unknown as UserRow;
		// sessions created before the last password change are invalid
		if ((row.created_at as number) < user.password_changed_at) {
			this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
			return null;
		}
		if (now - (row.last_seen_at as number) > 60_000) {
			this.db.prepare("UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id_hash = ?").run(now, req.ip, idHash);
		}
		return {
			idHash,
			user,
			sudoUntil: row.sudo_until as number,
			createdAt: row.created_at as number,
			pendingTotp: (row.pending_totp as string) ?? null,
		};
	}

	grantSudo(s: SessionInfo) {
		const until = Date.now() + this.settings.sudoMinutes * 60_000;
		this.db.prepare("UPDATE sessions SET sudo_until = ? WHERE id_hash = ?").run(until, s.idHash);
		s.sudoUntil = until;
	}

	setPendingTotp(s: SessionInfo, secret: string | null) {
		this.db.prepare("UPDATE sessions SET pending_totp = ? WHERE id_hash = ?").run(secret, s.idHash);
	}

	list(userId: number) {
		return this.db
			.prepare("SELECT id_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC")
			.all(userId) as { id_hash: string; created_at: number; last_seen_at: number; ip: string; user_agent: string }[];
	}

	revoke(userId: number, idHashPrefix: string) {
		const rows = this.list(userId).filter((r) => r.id_hash.startsWith(idHashPrefix));
		if (rows.length !== 1) throw new HttpError(404, "Session not found", "not_found");
		this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(rows[0].id_hash);
	}

	revokeAllOther(userId: number, keepIdHash: string | null) {
		this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, keepIdHash ?? "");
	}

	purge() {
		const now = Date.now();
		this.db
			.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?")
			.run(now, now - this.settings.sessionIdleHours * 3600_000);
	}
}

// ------------------------------------------------------------ throttling

interface Bucket {
	failures: number[];
	lockedUntil: number;
}

/** Sliding-window failure counter: 5 failures/15 min per user, 20 per IP, then lockout. */
export class LoginThrottle {
	private ip = new Map<string, Bucket>();
	private user = new Map<string, Bucket>();
	private static WINDOW = 15 * 60_000;

	private check(map: Map<string, Bucket>, key: string): number {
		const b = map.get(key);
		if (!b) return 0;
		return b.lockedUntil > Date.now() ? b.lockedUntil - Date.now() : 0;
	}
	private fail(map: Map<string, Bucket>, key: string, max: number) {
		const now = Date.now();
		const b = map.get(key) ?? { failures: [], lockedUntil: 0 };
		b.failures = b.failures.filter((t) => now - t < LoginThrottle.WINDOW);
		b.failures.push(now);
		if (b.failures.length >= max) b.lockedUntil = now + LoginThrottle.WINDOW;
		map.set(key, b);
	}

	/** milliseconds until another attempt is allowed (0 = allowed) */
	blockedFor(ip: string, username: string): number {
		return Math.max(this.check(this.ip, ip), this.check(this.user, username.toLowerCase()));
	}
	recordFailure(ip: string, username: string) {
		this.fail(this.ip, ip, 20);
		this.fail(this.user, username.toLowerCase(), 5);
	}
	recordSuccess(ip: string, username: string) {
		this.ip.delete(ip);
		this.user.delete(username.toLowerCase());
	}
}

// ------------------------------------------------------------ middleware helpers

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfCheck(req: Req, settings: HubSettings) {
	if (SAFE.has(req.method)) return;
	if (req.headers["x-csui"] !== "1") {
		throw new HttpError(403, "Missing anti-CSRF header", "csrf");
	}
	const origin = req.headers.origin;
	if (origin) {
		const host = (settings.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host;
		let originHost: string;
		try {
			originHost = new URL(origin).host;
		} catch {
			throw new HttpError(403, "Bad Origin header", "csrf");
		}
		if (originHost !== host) throw new HttpError(403, "Cross-origin request rejected", "csrf");
	}
}

export function requireSession(req: Req): SessionInfo {
	const s = req.ctx.session as SessionInfo | undefined;
	if (!s) throw new HttpError(401, "Not logged in", "unauthenticated");
	return s;
}

export function requireAdmin(req: Req): SessionInfo {
	const s = requireSession(req);
	if (s.user.role !== "admin") throw new HttpError(403, "This action needs an admin account", "forbidden");
	return s;
}

export function requireSudo(req: Req): SessionInfo {
	const s = requireAdmin(req);
	if (s.sudoUntil < Date.now()) {
		throw new HttpError(403, "Please confirm your password to continue", "sudo_required");
	}
	return s;
}
