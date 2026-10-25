/**
 * Read / write cross-seed's config.js safely.
 *
 * - Loading evaluates the file in a child `node` process, exactly like
 *   cross-seed (it `import()`s the file), so process.env etc. keep working.
 * - Saving: optimistic concurrency (hash), restore redacted secrets, validate,
 *   render, test-load the new file, backup the old one, atomic rename.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	type BackupInfo,
	type CrossSeedConfig,
	KNOWN_KEYS,
	OPTIONS,
	renderConfigFile,
	validateConfig,
} from "@csui/shared";
import { HttpError } from "@csui/shared/src/node/http.ts";

const execFileP = promisify(execFile);

const UNDEFINED_MARKER = "__csui_undefined__";

const LOADER = `
const p = process.argv[1];
const mod = require(p);
const cfg = mod && mod.__esModule && mod.default ? mod.default : mod;
process.stdout.write(JSON.stringify(cfg, (k, v) => v === undefined ? "${UNDEFINED_MARKER}" : (typeof v === "function" ? "${UNDEFINED_MARKER}" : v)));
`;

export function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Evaluate a config.js and return the plain object. */
export async function evaluateConfigFile(path: string): Promise<CrossSeedConfig> {
	try {
		const { stdout } = await execFileP(process.execPath, ["-e", LOADER, path], {
			timeout: 10_000,
			maxBuffer: 8 * 1024 * 1024,
			cwd: dirname(path),
			env: process.env,
		});
		const parsed = JSON.parse(stdout, (_k, v) => (v === UNDEFINED_MARKER ? undefined : v));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config.js does not export an object");
		}
		// JSON.parse reviver drops keys whose value became undefined; restore them
		const raw = JSON.parse(stdout) as Record<string, unknown>;
		for (const [k, v] of Object.entries(raw)) if (v === UNDEFINED_MARKER) parsed[k] = undefined;
		return parsed as CrossSeedConfig;
	} catch (e) {
		const err = e as { stderr?: string; message: string };
		const detail = (err.stderr || err.message || "").split("\n").slice(0, 8).join("\n");
		throw new HttpError(422, `config.js could not be loaded:\n${detail}`, "config_unparsable");
	}
}

const DYNAMIC_PATTERNS = [/process\.env/, /\brequire\s*\(/, /=>/, /\bfunction\b/, /\$\{/, /\bimport\s*\(/];

export function detectDynamicCode(source: string): boolean {
	// ignore comments
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
	return DYNAMIC_PATTERNS.some((p) => p.test(stripped));
}

export interface LoadedConfig {
	exists: boolean;
	path: string;
	source: string;
	hash: string;
	mtime: number | null;
	config: CrossSeedConfig;
	usesDynamicCode: boolean;
	unknownKeys: string[];
	legacyKeys: string[];
}

export class ConfigManager {
	readonly path: string;
	readonly backupDir: string;

	constructor(
		private crossSeedDir: string,
		stateDir: string,
		private maxBackups: number,
	) {
		this.path = join(crossSeedDir, "config.js");
		this.backupDir = join(stateDir, "backups");
	}

	async load(): Promise<LoadedConfig> {
		const st = await stat(this.path).catch(() => null);
		if (!st) {
			return {
				exists: false,
				path: this.path,
				source: "",
				hash: sha256(""),
				mtime: null,
				config: {},
				usesDynamicCode: false,
				unknownKeys: [],
				legacyKeys: [],
			};
		}
		const source = await readFile(this.path, "utf8");
		const config = await evaluateConfigFile(this.path);
		const legacy = new Set(OPTIONS.filter((o) => o.deprecated).map((o) => o.key));
		return {
			exists: true,
			path: this.path,
			source,
			hash: sha256(source),
			mtime: st.mtimeMs,
			config,
			usesDynamicCode: detectDynamicCode(source),
			unknownKeys: Object.keys(config).filter((k) => !KNOWN_KEYS.has(k)),
			legacyKeys: Object.keys(config).filter((k) => legacy.has(k) && config[k] !== undefined && config[k] !== null),
		};
	}

	/**
	 * Write a new config. `config` must already have real secrets.
	 * Returns the backup id of the previous version (null if there was none).
	 */
	async write(
		config: CrossSeedConfig,
		opts: { baseHash: string; note?: string; force?: boolean; author?: string },
	): Promise<{ hash: string; backupId: string | null }> {
		const current = await this.load();
		if (current.exists && opts.baseHash !== current.hash) {
			throw new HttpError(
				409,
				"config.js was changed since you loaded it (by hand or from another session). Reload and apply your changes again.",
				"config_conflict",
			);
		}
		const validation = validateConfig(config, { configDir: this.crossSeedDir });
		if (!validation.ok && !opts.force) {
			throw new HttpError(422, "The configuration has errors", "config_invalid", validation);
		}
		const text = renderConfigFile(config, {
			note: `Saved ${new Date().toISOString()}${opts.author ? ` by ${opts.author}` : ""}${opts.note ? ` - ${opts.note}` : ""}`,
		});
		return this.writeText(text, current, opts.note ? `before: ${opts.note}` : "before UI save");
	}

	/** Write raw config.js text (advanced editor / restore). */
	async writeText(text: string, current?: LoadedConfig, note = ""): Promise<{ hash: string; backupId: string | null }> {
		current ??= await this.load();
		await mkdir(dirname(this.path), { recursive: true });
		const tmp = join(dirname(this.path), `.config.js.csui-${randomBytes(6).toString("hex")}.tmp`);
		const mode = current.exists ? ((await stat(this.path)).mode & 0o777) : 0o600;
		await writeFile(tmp, text, { mode });
		try {
			// make sure the new file actually loads before replacing anything
			await evaluateConfigFile(tmp);
		} catch (e) {
			await rm(tmp, { force: true });
			throw e;
		}
		let backupId: string | null = null;
		if (current.exists) backupId = await this.backup(current, note);
		await rename(tmp, this.path);
		await chmod(this.path, mode).catch(() => {});
		return { hash: sha256(text), backupId };
	}

	private async backup(current: LoadedConfig, note: string): Promise<string> {
		await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
		const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${current.hash.slice(0, 8)}`;
		await copyFile(this.path, join(this.backupDir, `${id}.js`));
		await chmod(join(this.backupDir, `${id}.js`), 0o600);
		await writeFile(
			join(this.backupDir, `${id}.json`),
			JSON.stringify({ id, createdAt: Date.now(), note, hash: current.hash }),
			{ mode: 0o600 },
		);
		await this.pruneBackups();
		return id;
	}

	private async pruneBackups() {
		const list = await this.listBackups();
		for (const b of list.slice(this.maxBackups)) {
			await rm(join(this.backupDir, `${b.id}.js`), { force: true });
			await rm(join(this.backupDir, `${b.id}.json`), { force: true });
		}
	}

	async listBackups(): Promise<BackupInfo[]> {
		const files = await readdir(this.backupDir).catch(() => [] as string[]);
		const out: BackupInfo[] = [];
		for (const f of files) {
			if (!f.endsWith(".js")) continue;
			const id = basename(f, ".js");
			const st = await stat(join(this.backupDir, f)).catch(() => null);
			if (!st) continue;
			let meta: { createdAt?: number; note?: string; hash?: string } = {};
			try {
				meta = JSON.parse(await readFile(join(this.backupDir, `${id}.json`), "utf8"));
			} catch {
				/* metadata optional */
			}
			out.push({
				id,
				createdAt: meta.createdAt ?? st.mtimeMs,
				size: st.size,
				note: meta.note ?? "",
				hash: meta.hash ?? "",
			});
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	}

	private backupPath(id: string): string {
		if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, "Invalid backup id", "bad_request");
		return join(this.backupDir, `${id}.js`);
	}

	async readBackup(id: string): Promise<string> {
		try {
			return await readFile(this.backupPath(id), "utf8");
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(404, "Backup not found", "not_found");
		}
	}

	async restoreBackup(id: string): Promise<{ hash: string; backupId: string | null }> {
		const text = await this.readBackup(id);
		return this.writeText(text, undefined, `before: restore of ${id}`);
	}
}
