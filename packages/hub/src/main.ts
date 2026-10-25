/**
 * cross-seed-ui hub: web UI, login and aggregation for one or more agents.
 *
 *   node hub.mjs --config /etc/cross-seed-ui/hub.json
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { HttpError, Router, sendError, sendJson, serveStatic } from "@csui/shared/src/node/http.ts";
import { csrfCheck, LoginThrottle, Sessions } from "./auth.ts";
import type { HubContext } from "./context.ts";
import { SecretBox } from "./crypto.ts";
import { openHubDb } from "./db.ts";
import { ensureSetupToken, registerAuthRoutes } from "./routes/authRoutes.ts";
import { registerInstanceRoutes } from "./routes/instanceRoutes.ts";
import { registerProwlarrRoutes, startAutoSync } from "./routes/prowlarrRoutes.ts";
import { registerSystemRoutes } from "./routes/systemRoutes.ts";
import { loadHubSettings, settingsPathFromArgs } from "./settings.ts";

declare const __CSUI_VERSION__: string | undefined;
const VERSION = typeof __CSUI_VERSION__ === "string" ? __CSUI_VERSION__ : "dev";

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

function securityHeaders(res: ServerResponse, https: boolean) {
	res.setHeader("content-security-policy", CSP);
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("x-frame-options", "DENY");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("cross-origin-opener-policy", "same-origin");
	res.setHeader("cross-origin-resource-policy", "same-origin");
	res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
	if (https) res.setHeader("strict-transport-security", "max-age=31536000");
}

async function main() {
	if (process.argv.includes("--version")) {
		console.log(VERSION);
		return;
	}
	const settings = loadHubSettings(settingsPathFromArgs(process.argv));
	const db = openHubDb(settings.stateDir);
	const box = new SecretBox(join(settings.stateDir, "secret.key"));
	const ctx: HubContext = {
		settings,
		version: VERSION,
		db,
		box,
		sessions: new Sessions(db, settings),
		throttle: new LoginThrottle(),
	};

	const router = new Router({ bodyLimit: 64 * 1024, trustProxy: settings.trustProxy });
	router.useAlways((req) => {
		req.ctx.session = ctx.sessions.resolve(req) ?? undefined;
		if (req.path.startsWith("/api/")) csrfCheck(req, settings);
	});
	registerAuthRoutes(router, ctx);
	registerInstanceRoutes(router, ctx);
	registerProwlarrRoutes(router, ctx);
	registerSystemRoutes(router, ctx);
	router.get("/api/healthz", () => ({ ok: true }), { public: true });

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		const https = (req.socket as { encrypted?: boolean }).encrypted === true ||
			(settings.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").startsWith("https"));
		securityHeaders(res, https);
		try {
			if (await router.handle(req, res)) return;
			if ((req.url ?? "").startsWith("/api/")) {
				sendJson(res, 404, { error: "not_found", message: "Not found" });
				return;
			}
			if (await serveStatic(settings.webDir, req, res)) return;
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Not found (is the web UI built? check webDir in hub.json)");
		} catch (e) {
			sendError(res, e instanceof Error ? e : new HttpError(500, String(e)));
		}
	};

	const server = settings.tls
		? createHttpsServer({ cert: readFileSync(settings.tls.certFile), key: readFileSync(settings.tls.keyFile) }, handler)
		: createHttpServer(handler);
	server.requestTimeout = 0; // SSE + long config restarts
	server.headersTimeout = 30_000;
	server.listen(settings.port, settings.listen, () => {
		const proto = settings.tls ? "https" : "http";
		console.log(`[hub] cross-seed-ui hub ${VERSION} listening on ${proto}://${settings.listen}:${settings.port}`);
		const token = ensureSetupToken(ctx);
		if (token) {
			console.log("[hub] ------------------------------------------------------------");
			console.log("[hub] No admin account yet. Open the web UI and use this setup token:");
			console.log(`[hub]   ${token}`);
			console.log("[hub] ------------------------------------------------------------");
		}
	});
	startAutoSync(ctx);

	const shutdown = () => {
		console.log("[hub] shutting down");
		server.close();
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((e) => {
	console.error("[hub] fatal:", e instanceof Error ? e.message : e);
	process.exit(1);
});
