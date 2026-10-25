/**
 * Hub database (node:sqlite): users, sessions, instances, settings, audit log.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type HubDb = DatabaseSync;

const MIGRATIONS: string[] = [
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'admin',
		totp_secret TEXT,
		totp_last_counter INTEGER,
		created_at INTEGER NOT NULL,
		last_login_at INTEGER,
		password_changed_at INTEGER NOT NULL
	);
	CREATE TABLE sessions (
		id_hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		sudo_until INTEGER NOT NULL DEFAULT 0,
		ip TEXT,
		user_agent TEXT,
		pending_totp TEXT
	);
	CREATE INDEX idx_sessions_user ON sessions(user_id);
	CREATE TABLE instances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		url TEXT NOT NULL,
		secret TEXT NOT NULL,
		color TEXT NOT NULL DEFAULT '#6366f1',
		sort INTEGER NOT NULL DEFAULT 0,
		prowlarr_sync TEXT,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		username TEXT,
		ip TEXT,
		action TEXT NOT NULL,
		instance_id INTEGER,
		detail TEXT,
		ok INTEGER NOT NULL DEFAULT 1
	);
	CREATE INDEX idx_audit_ts ON audit(ts);`,
];

export function openHubDb(stateDir: string): HubDb {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(join(stateDir, "hub.db"));
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
	const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
	let v = row?.v ?? 0;
	if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
	while (v < MIGRATIONS.length) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[v]);
			v++;
			db.prepare("UPDATE schema_version SET v = ?").run(v);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}
	return db;
}

export function getSetting(db: HubDb, key: string): string | null {
	const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
	return r?.value ?? null;
}

export function setSetting(db: HubDb, key: string, value: string | null) {
	if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
	else
		db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
			key,
			value,
		);
}

export interface AuditEntry {
	username: string | null;
	ip: string | null;
	action: string;
	instanceId?: number | null;
	detail?: string | null;
	ok?: boolean;
}

export function audit(db: HubDb, e: AuditEntry) {
	db.prepare("INSERT INTO audit (ts, username, ip, action, instance_id, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		Date.now(),
		e.username,
		e.ip,
		e.action,
		e.instanceId ?? null,
		e.detail ? e.detail.slice(0, 2000) : null,
		e.ok === false ? 0 : 1,
	);
}

export interface UserRow {
	id: number;
	username: string;
	password_hash: string;
	role: "admin" | "viewer";
	totp_secret: string | null;
	totp_last_counter: number | null;
	created_at: number;
	last_login_at: number | null;
	password_changed_at: number;
}

export interface InstanceRow {
	id: number;
	name: string;
	url: string;
	secret: string;
	color: string;
	sort: number;
	prowlarr_sync: string | null;
	created_at: number;
}
