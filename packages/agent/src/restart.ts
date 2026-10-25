/**
 * Restart cross-seed and verify it came up with the configuration.
 *
 * cross-seed v6 logs "Your configuration is valid!" after the full startup
 * validation (schema, paths, clients, indexers) and "Server is running on port"
 * once the API listens. "Your configuration is invalid" (or the process
 * exiting) means it refused the config.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RestartResult } from "@csui/shared";
import { parseLogText, redactText } from "@csui/shared";
import { listLogFiles, readRange } from "./logs.ts";
import type { ServiceController } from "./service.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function infoLogPosition(logsDir: string): Promise<{ name: string | null; size: number }> {
	const files = (await listLogFiles(logsDir)).filter((f) => f.kind === "info");
	const last = files.at(-1);
	return last ? { name: last.name, size: last.size } : { name: null, size: 0 };
}

export async function restartAndVerify(
	service: ServiceController,
	crossSeedDir: string,
	opts: { timeoutMs?: number } = {},
): Promise<RestartResult> {
	const logsDir = join(crossSeedDir, "logs");
	const timeoutMs = opts.timeoutMs ?? 90_000;
	const before = await infoLogPosition(logsDir);
	const t0 = Date.now();
	try {
		await service.restart();
	} catch (e) {
		return { ok: false, rolledBack: false, message: `Restart command failed: ${(e as Error).message}`, logTail: [] };
	}

	let valid = false;
	let collected = "";
	let readFrom = before;
	const readNew = async () => {
		const now = await infoLogPosition(logsDir);
		if (now.name) {
			const start = now.name === readFrom.name ? readFrom.size : 0;
			const st = await stat(join(logsDir, now.name)).catch(() => null);
			if (st && st.size > start) {
				collected += await readRange(join(logsDir, now.name), start, st.size);
				readFrom = { name: now.name, size: st.size };
			}
		}
	};
	const rejection = (entries: ReturnType<typeof parseLogText>, tail: string[]): RestartResult | null => {
		if (!entries.some((e) => e.message.includes("Your configuration is invalid"))) return null;
		const errors = entries.filter((e) => e.level === "error").map((e) => redactText(e.message));
		return {
			ok: false,
			rolledBack: false,
			message: `cross-seed rejected the configuration:\n${errors.join("\n").slice(0, 4000)}`,
			logTail: tail,
		};
	};
	while (Date.now() - t0 < timeoutMs) {
		await sleep(1000);
		await readNew();
		const entries = parseLogText(collected);
		const tail = entries.slice(-40).map((e) => redactText(`${e.level}: ${e.label ? `[${e.label}] ` : ""}${e.message}`));
		const rejected = rejection(entries, tail);
		if (rejected) return rejected;
		if (entries.some((e) => e.message.includes("Your configuration is valid!"))) valid = true;
		if (entries.some((e) => e.label === "server" && e.message.startsWith("Server is running"))) {
			return { ok: true, rolledBack: false, message: "cross-seed restarted and is running.", logTail: tail };
		}
		const st = await service.status();
		const exited = st.state === "failed" || st.subState === "auto-restart" || (st.state === "inactive" && Date.now() - t0 > 5000);
		if (exited && !valid) {
			// give winston a moment to flush, then look for the reason once more
			await sleep(800);
			await readNew();
			const final = parseLogText(collected);
			const finalTail = final.slice(-40).map((e) => redactText(`${e.level}: ${e.label ? `[${e.label}] ` : ""}${e.message}`));
			const rejectedLate = rejection(final, finalTail);
			if (rejectedLate) return rejectedLate;
			// cross-seed exits before winston flushes its files, so the reason
			// usually only reaches stdout (the systemd journal)
			const journal = await service.recentOutput(60, t0);
			const invalidAt = journal.findIndex((l) => l.includes("Your configuration is invalid"));
			if (invalidAt >= 0) {
				const startAt = Math.max(0, journal.findLastIndex((l, i) => i < invalidAt && l.includes("Validating your configuration")));
				const reasons = journal
					.slice(startAt + 1, invalidAt)
					.map((l) => l.replace(/^.*?\b(error|warn|info):\s*/, "").trim())
					.filter((l, i, arr) => l && arr.indexOf(l) === i);
				return {
					ok: false,
					rolledBack: false,
					message: `cross-seed rejected the configuration:\n${redactText(reasons.join("\n")).slice(0, 4000)}`,
					logTail: journal.map(redactText).slice(-40),
				};
			}
			return {
				ok: false,
				rolledBack: false,
				message: "cross-seed stopped right after the restart.",
				logTail: [...finalTail, ...journal.map(redactText)].slice(-60),
			};
		}
	}
	if (valid) {
		return {
			ok: true,
			rolledBack: false,
			message: "cross-seed accepted the configuration and is still starting up (indexing your torrents).",
			logTail: parseLogText(collected).slice(-40).map((e) => redactText(`${e.level}: ${e.message}`)),
		};
	}
	return {
		ok: false,
		rolledBack: false,
		message: `cross-seed did not confirm the configuration within ${Math.round(timeoutMs / 1000)}s.`,
		logTail: [...parseLogText(collected).slice(-30).map((e) => redactText(e.message)), ...(await service.recentOutput(20, t0)).map(redactText)],
	};
}
