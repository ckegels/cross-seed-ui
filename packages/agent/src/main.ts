/**
 * cross-seed-ui agent: runs next to a cross-seed v6 daemon (same LXC, as the
 * same user as cross-seed, root for the Proxmox community script).
 *
 *   node agent.mjs --config /etc/cross-seed-ui/agent.json
 */
import { createServer } from "node:http";
import { HttpError, sendError, sendJson } from "@csui/shared/src/node/http.ts";
import { ConfigManager } from "./crossSeedConfig.ts";
import { CrossSeedDb } from "./crossSeedDb.ts";
import { CrossSeedDaemon } from "./daemon.ts";
import { LogTailer } from "./logs.ts";
import { buildRouter } from "./routes.ts";
import { createServiceController } from "./service.ts";
import { loadSettings, settingsPathFromArgs } from "./settings.ts";
import { openState } from "./state.ts";

declare const __CSUI_VERSION__: string | undefined;
const VERSION = typeof __CSUI_VERSION__ === "string" ? __CSUI_VERSION__ : "dev";

async function main() {
	if (process.argv.includes("--version")) {
		console.log(VERSION);
		return;
	}
	const settings = loadSettings(settingsPathFromArgs(process.argv));
	const state = openState(settings.stateDir);
	const csdb = new CrossSeedDb(settings.crossSeedDir);
	const config = new ConfigManager(settings.crossSeedDir, settings.stateDir, settings.maxBackups);
	const service = createServiceController(settings);
	const daemon = new CrossSeedDaemon(settings.crossSeedBin, settings.crossSeedDir, csdb, {
		url: settings.crossSeedUrl,
		exec: service.exec?.bind(service),
	});
	const tailer = new LogTailer(settings.crossSeedDir, state, {
		backfill: settings.backfillLogs,
		retentionDays: settings.eventRetentionDays,
	});

	if (settings.service.manager === "process") await service.start();
	await tailer.start();

	const router = buildRouter({ settings, version: VERSION, config, csdb, daemon, service, tailer, state });
	const server = createServer(async (req, res) => {
		res.setHeader("x-content-type-options", "nosniff");
		try {
			const handled = await router.handle(req, res);
			if (!handled) sendJson(res, 404, { error: "not_found", message: "Not found" });
		} catch (e) {
			sendError(res, e instanceof Error ? e : new HttpError(500, String(e)));
		}
	});
	server.requestTimeout = 0; // SSE streams
	server.headersTimeout = 30_000;
	server.listen(settings.port, settings.listen, () => {
		console.log(`[agent] cross-seed-ui agent ${VERSION} listening on ${settings.listen}:${settings.port}`);
		console.log(`[agent] cross-seed dir: ${settings.crossSeedDir}, service: ${settings.service.manager}:${settings.service.name}`);
	});

	const shutdown = async () => {
		console.log("[agent] shutting down");
		tailer.stop();
		server.close();
		if (settings.service.manager === "process") await service.stop();
		csdb.close();
		state.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((e) => {
	console.error("[agent] fatal:", e instanceof Error ? e.message : e);
	process.exit(1);
});
