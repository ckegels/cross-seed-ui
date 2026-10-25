import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, type Req, type Router } from "@csui/shared/src/node/http.ts";
import { requireAdmin, requireSession, requireSudo, type SessionInfo } from "../auth.ts";
import {
	dummyVerify,
	hashPassword,
	newTotpSecret,
	passwordProblems,
	randomToken,
	totpUri,
	verifyPassword,
	verifyTotp,
} from "../crypto.ts";
import { audit, type UserRow } from "../db.ts";
import type { HubContext } from "../context.ts";

const USERNAME = /^[A-Za-z0-9_.@-]{2,64}$/;

function str(body: unknown, key: string, max = 256): string {
	const v = (body as Record<string, unknown> | undefined)?.[key];
	if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${key} is required`, "bad_request");
	return v;
}

export function userCount(ctx: HubContext): number {
	return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

/** One-time setup token so nobody else on the LAN can claim the fresh install. */
export function ensureSetupToken(ctx: HubContext): string | null {
	const file = join(ctx.settings.stateDir, "setup-token");
	if (userCount(ctx) > 0) {
		if (existsSync(file)) rmSync(file, { force: true });
		return null;
	}
	if (!existsSync(file)) writeFileSync(file, randomToken(12), { mode: 0o600 });
	return readFileSync(file, "utf8").trim();
}

function publicUser(u: UserRow) {
	return { id: u.id, username: u.username, role: u.role, totpEnabled: !!u.totp_secret, lastLoginAt: u.last_login_at };
}

/** Verify password (+ TOTP when enabled). Applies throttling. */
async function checkCredentials(ctx: HubContext, req: Req, user: UserRow | undefined, username: string, password: string, code?: string) {
	const wait = ctx.throttle.blockedFor(req.ip, username);
	if (wait > 0) {
		throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60_000)} minute(s).`, "throttled");
	}
	if (!user) {
		await dummyVerify(password);
		ctx.throttle.recordFailure(req.ip, username);
		audit(ctx.db, { username, ip: req.ip, action: "login.failed", detail: "unknown user", ok: false });
		throw new HttpError(401, "Wrong username or password", "bad_credentials");
	}
	if (!(await verifyPassword(password, user.password_hash))) {
		ctx.throttle.recordFailure(req.ip, username);
		audit(ctx.db, { username: user.username, ip: req.ip, action: "login.failed", detail: "bad password", ok: false });
		throw new HttpError(401, "Wrong username or password", "bad_credentials");
	}
	if (user.totp_secret) {
		const secret = ctx.box.decrypt(user.totp_secret);
		if (!code) throw new HttpError(401, "Enter the 6-digit code from your authenticator app", "totp_required");
		const counter = verifyTotp(secret, code.replace(/\s/g, ""));
		if (counter === null || (user.totp_last_counter !== null && counter <= user.totp_last_counter)) {
			ctx.throttle.recordFailure(req.ip, username);
			audit(ctx.db, { username: user.username, ip: req.ip, action: "login.failed", detail: "bad 2FA code", ok: false });
			throw new HttpError(401, "Invalid or already used 2FA code", "totp_invalid");
		}
		ctx.db.prepare("UPDATE users SET totp_last_counter = ? WHERE id = ?").run(counter, user.id);
	}
	ctx.throttle.recordSuccess(req.ip, username);
}

export function registerAuthRoutes(r: Router, ctx: HubContext) {
	const { db, sessions } = ctx;

	r.get(
		"/api/auth/state",
		(req) => {
			const s = req.ctx.session as SessionInfo | undefined;
			return {
				setupRequired: userCount(ctx) === 0,
				user: s ? publicUser(s.user) : null,
				sudoUntil: s?.sudoUntil ?? 0,
				version: ctx.version,
			};
		},
		{ public: true },
	);

	r.post(
		"/api/auth/setup",
		async (req, res) => {
			if (userCount(ctx) > 0) throw new HttpError(409, "Setup was already completed", "setup_done");
			if (ctx.throttle.blockedFor(req.ip, "__setup__") > 0) throw new HttpError(429, "Too many attempts, wait 15 minutes", "throttled");
			const expected = ensureSetupToken(ctx);
			const token = str(req.body, "token", 100).trim();
			if (!expected || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
				ctx.throttle.recordFailure(req.ip, "__setup__");
				throw new HttpError(403, "Wrong setup token. It is printed by the installer and in the hub log (journalctl -u cross-seed-ui-hub).", "bad_token");
			}
			const username = str(req.body, "username", 64).trim();
			const password = str(req.body, "password");
			if (!USERNAME.test(username)) throw new HttpError(400, "Username: 2-64 letters, digits or . _ @ -", "bad_request");
			const problem = passwordProblems(password, username);
			if (problem) throw new HttpError(400, problem, "weak_password");
			const now = Date.now();
			db.prepare(
				"INSERT INTO users (username, password_hash, role, created_at, password_changed_at, last_login_at) VALUES (?, ?, 'admin', ?, ?, ?)",
			).run(username, await hashPassword(password), now, now - 1, now);
			ensureSetupToken(ctx); // deletes the token file
			const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as unknown as UserRow;
			sessions.create(req, res, user);
			audit(db, { username, ip: req.ip, action: "setup.admin_created" });
			return { user: publicUser(user) };
		},
		{ public: true, bodyLimit: 16 * 1024 },
	);

	r.post(
		"/api/auth/login",
		async (req, res) => {
			if (userCount(ctx) === 0) throw new HttpError(409, "Complete the setup first", "setup_required");
			const username = str(req.body, "username", 64).trim();
			const password = str(req.body, "password");
			const code = (req.body as Record<string, unknown>)?.code;
			const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as unknown as UserRow | undefined;
			await checkCredentials(ctx, req, user, username, password, typeof code === "string" ? code : undefined);
			db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user!.id);
			sessions.create(req, res, user!);
			audit(db, { username: user!.username, ip: req.ip, action: "login" });
			return { user: publicUser(user!) };
		},
		{ public: true, bodyLimit: 16 * 1024 },
	);

	r.post("/api/auth/logout", (req, res) => {
		const s = requireSession(req);
		sessions.destroy(req, res);
		audit(db, { username: s.user.username, ip: req.ip, action: "logout" });
		return { ok: true };
	});

	r.post("/api/auth/sudo", async (req) => {
		const s = requireSession(req);
		const password = str(req.body, "password");
		const code = (req.body as Record<string, unknown>)?.code;
		await checkCredentials(ctx, req, s.user, s.user.username, password, typeof code === "string" ? code : undefined);
		sessions.grantSudo(s);
		audit(db, { username: s.user.username, ip: req.ip, action: "sudo" });
		return { sudoUntil: s.sudoUntil };
	});

	r.post("/api/auth/password", async (req, res) => {
		const s = requireSession(req);
		const current = str(req.body, "current");
		const next = str(req.body, "next");
		await checkCredentials(ctx, req, s.user, s.user.username, current, (req.body as Record<string, string>)?.code);
		const problem = passwordProblems(next, s.user.username);
		if (problem) throw new HttpError(400, problem, "weak_password");
		const now = Date.now();
		db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(await hashPassword(next), now, s.user.id);
		// every existing session (including this one) is now invalid; issue a fresh one
		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(s.user.id) as unknown as UserRow;
		sessions.revokeAllOther(user.id, null);
		await new Promise((r) => setTimeout(r, 2));
		sessions.create(req, res, user);
		audit(db, { username: user.username, ip: req.ip, action: "password.changed" });
		return { ok: true };
	});

	r.post("/api/auth/totp/begin", (req) => {
		const s = requireSudo(req);
		const secret = newTotpSecret();
		sessions.setPendingTotp(s, ctx.box.encrypt(secret));
		return { secret, uri: totpUri(secret, s.user.username) };
	});

	r.post("/api/auth/totp/enable", (req) => {
		const s = requireSudo(req);
		if (!s.pendingTotp) throw new HttpError(400, "Start the 2FA setup first", "bad_request");
		const secret = ctx.box.decrypt(s.pendingTotp);
		const counter = verifyTotp(secret, str(req.body, "code", 10).replace(/\s/g, ""));
		if (counter === null) throw new HttpError(400, "That code is not valid. Check the time on your phone and try again.", "totp_invalid");
		db.prepare("UPDATE users SET totp_secret = ?, totp_last_counter = ? WHERE id = ?").run(ctx.box.encrypt(secret), counter, s.user.id);
		sessions.setPendingTotp(s, null);
		audit(db, { username: s.user.username, ip: req.ip, action: "2fa.enabled" });
		return { ok: true };
	});

	r.post("/api/auth/totp/disable", (req) => {
		const s = requireSudo(req);
		db.prepare("UPDATE users SET totp_secret = NULL, totp_last_counter = NULL WHERE id = ?").run(s.user.id);
		audit(db, { username: s.user.username, ip: req.ip, action: "2fa.disabled" });
		return { ok: true };
	});

	r.get("/api/auth/sessions", (req) => {
		const s = requireSession(req);
		return sessions.list(s.user.id).map((x) => ({
			id: x.id_hash.slice(0, 16),
			current: x.id_hash === s.idHash,
			createdAt: x.created_at,
			lastSeenAt: x.last_seen_at,
			ip: x.ip,
			userAgent: x.user_agent,
		}));
	});

	r.delete("/api/auth/sessions/:id", (req) => {
		const s = requireSession(req);
		sessions.revoke(s.user.id, req.params.id);
		audit(db, { username: s.user.username, ip: req.ip, action: "session.revoked" });
		return { ok: true };
	});

	r.post("/api/auth/sessions/revoke-others", (req) => {
		const s = requireSession(req);
		sessions.revokeAllOther(s.user.id, s.idHash);
		audit(db, { username: s.user.username, ip: req.ip, action: "session.revoked_others" });
		return { ok: true };
	});

	// ---------------------------------------------------------------- users
	r.get("/api/users", (req) => {
		requireAdmin(req);
		return (db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[]).map(publicUser);
	});

	r.post("/api/users", async (req) => {
		const s = requireSudo(req);
		const username = str(req.body, "username", 64).trim();
		const password = str(req.body, "password");
		const role = (req.body as Record<string, unknown>)?.role === "viewer" ? "viewer" : "admin";
		if (!USERNAME.test(username)) throw new HttpError(400, "Username: 2-64 letters, digits or . _ @ -", "bad_request");
		const problem = passwordProblems(password, username);
		if (problem) throw new HttpError(400, problem, "weak_password");
		if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new HttpError(409, "That username exists", "exists");
		const now = Date.now();
		db.prepare("INSERT INTO users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)").run(
			username,
			await hashPassword(password),
			role,
			now,
			now - 1,
		);
		audit(db, { username: s.user.username, ip: req.ip, action: "user.created", detail: `${username} (${role})` });
		return { ok: true };
	});

	r.delete("/api/users/:id", (req) => {
		const s = requireSudo(req);
		const id = Number(req.params.id);
		if (id === s.user.id) throw new HttpError(400, "You can't delete yourself", "bad_request");
		const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow | undefined;
		if (!target) throw new HttpError(404, "User not found", "not_found");
		const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
		if (target.role === "admin" && admins <= 1) throw new HttpError(400, "Can't delete the last admin", "bad_request");
		db.prepare("DELETE FROM users WHERE id = ?").run(id);
		audit(db, { username: s.user.username, ip: req.ip, action: "user.deleted", detail: target.username });
		return { ok: true };
	});
}
