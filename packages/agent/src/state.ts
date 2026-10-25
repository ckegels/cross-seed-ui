/**
 * Agent's own SQLite database (never cross-seed's): parsed log events and
 * log-reader cursors. Uses the built-in node:sqlite module.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StateDb = DatabaseSync;

const MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
	 CREATE TABLE IF NOT EXISTS log_cursor (
		file TEXT PRIMARY KEY,
		inode INTEGER,
		offset INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	 );
	 CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		type TEXT NOT NULL,
		via TEXT,
		name TEXT,
		tracker TEXT,
		decision TEXT,
		result TEXT,
		source TEXT,
		searchee TEXT,
		data TEXT,
		fingerprint TEXT UNIQUE
	 );
	 CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
	 CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
	 CREATE INDEX IF NOT EXISTS idx_events_tracker ON events(tracker);
	 CREATE TABLE IF NOT EXISTS daily_counts (
		day TEXT NOT NULL,
		kind TEXT NOT NULL,
		key TEXT NOT NULL DEFAULT '',
		n INTEGER NOT NULL,
		PRIMARY KEY (day, kind, key)
	 );`,
];

export function openState(stateDir: string): StateDb {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(join(stateDir, "agent.db"));
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
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

export function getMeta(db: StateDb, key: string): string | null {
	const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
	return r?.value ?? null;
}

export function setMeta(db: StateDb, key: string, value: string) {
	db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		key,
		value,
	);
}
