/**
 * Tiny dependency-free HTTP framework used by the agent and the hub.
 * - route patterns with :params
 * - raw body buffering with a size limit (needed for HMAC verification)
 * - JSON responses, HttpError -> JSON error body
 * - SSE helper and a safe static file server
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public code = "error",
		public details?: unknown,
	) {
		super(message);
	}
}

export interface Req {
	method: string;
	url: URL;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
	raw: IncomingMessage;
	rawBody: Buffer;
	body: unknown;
	ip: string;
	/** per-request data set by middleware (user, session...) */
	ctx: Record<string, unknown>;
}

export type Handler = (req: Req, res: ServerResponse) => unknown | Promise<unknown>;
export type Middleware = (req: Req, res: ServerResponse) => void | Promise<void>;

interface Route {
	method: string;
	parts: string[];
	handler: Handler;
	opts: RouteOptions;
}

export interface RouteOptions {
	bodyLimit?: number;
	/** skip middleware marked as skippable (e.g. auth) */
	public?: boolean;
}

export const NO_RESPONSE = Symbol("no-response");

export class Router {
	private routes: Route[] = [];
	private middleware: Middleware[] = [];
	private publicMiddleware: Middleware[] = [];
	constructor(
		private defaults: { bodyLimit: number; trustProxy?: boolean } = { bodyLimit: 1024 * 1024 },
	) {}

	/** Middleware run for every matched route. */
	useAlways(mw: Middleware) {
		this.publicMiddleware.push(mw);
	}
	/** Middleware run for every non-public route (auth). */
	use(mw: Middleware) {
		this.middleware.push(mw);
	}
	add(method: string, pattern: string, handler: Handler, opts: RouteOptions = {}) {
		this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, opts });
	}
	get(p: string, h: Handler, o?: RouteOptions) {
		this.add("GET", p, h, o);
	}
	post(p: string, h: Handler, o?: RouteOptions) {
		this.add("POST", p, h, o);
	}
	put(p: string, h: Handler, o?: RouteOptions) {
		this.add("PUT", p, h, o);
	}
	patch(p: string, h: Handler, o?: RouteOptions) {
		this.add("PATCH", p, h, o);
	}
	delete(p: string, h: Handler, o?: RouteOptions) {
		this.add("DELETE", p, h, o);
	}

	match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
		const segs = path.split("/").filter(Boolean);
		let methodMismatch = false;
		for (const route of this.routes) {
			if (route.parts.length !== segs.length) {
				// trailing wildcard support: "*" as last part
				if (!(route.parts.at(-1) === "*" && segs.length >= route.parts.length - 1)) continue;
			}
			const params: Record<string, string> = {};
			let ok = true;
			for (let i = 0; i < route.parts.length; i++) {
				const p = route.parts[i];
				if (p === "*") {
					params["*"] = segs.slice(i).map(decodeURIComponent).join("/");
					break;
				}
				const s = segs[i];
				if (s === undefined) {
					ok = false;
					break;
				}
				if (p.startsWith(":")) {
					try {
						params[p.slice(1)] = decodeURIComponent(s);
					} catch {
						ok = false;
						break;
					}
				} else if (p !== s) {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			if (route.method !== method && !(route.method === "GET" && method === "HEAD")) {
				methodMismatch = true;
				continue;
			}
			return { route, params };
		}
		return methodMismatch ? "method" : null;
	}

	/** Returns false when no route matched (caller may fall back to static files). */
	async handle(raw: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const url = new URL(raw.url ?? "/", "http://localhost");
		const method = (raw.method ?? "GET").toUpperCase();
		const m = this.match(method, url.pathname);
		if (m === null) return false;
		if (m === "method") {
			sendJson(res, 405, { error: "method_not_allowed", message: "Method not allowed" });
			return true;
		}
		const { route, params } = m;
		const req: Req = {
			method,
			url,
			path: url.pathname,
			params,
			query: url.searchParams,
			headers: raw.headers,
			raw,
			rawBody: Buffer.alloc(0),
			body: undefined,
			ip: clientIp(raw, this.defaults.trustProxy ?? false),
			ctx: {},
		};
		try {
			if (method !== "GET" && method !== "HEAD") {
				req.rawBody = await readBody(raw, route.opts.bodyLimit ?? this.defaults.bodyLimit);
				if (req.rawBody.length) {
					const ct = String(raw.headers["content-type"] ?? "");
					if (ct.includes("application/json")) {
						try {
							req.body = JSON.parse(req.rawBody.toString("utf8"));
						} catch {
							throw new HttpError(400, "Invalid JSON body", "invalid_json");
						}
					}
				}
			}
			for (const mw of this.publicMiddleware) await mw(req, res);
			if (!route.opts.public) for (const mw of this.middleware) await mw(req, res);
			const result = await route.handler(req, res);
			if (result === NO_RESPONSE || res.writableEnded || res.headersSent) return true;
			if (result === undefined) {
				res.writeHead(204);
				res.end();
			} else {
				sendJson(res, 200, result);
			}
		} catch (e) {
			sendError(res, e);
		}
		return true;
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
	if (res.headersSent) {
		res.end();
		return;
	}
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(data),
	});
	res.end(data);
}

export function sendError(res: ServerResponse, e: unknown) {
	if (e instanceof HttpError) {
		sendJson(res, e.status, { error: e.code, message: e.message, details: e.details });
		return;
	}
	console.error("[http] unhandled error:", e);
	sendJson(res, 500, { error: "internal", message: e instanceof Error ? e.message : "Internal error" });
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on("data", (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				done = true;
				reject(new HttpError(413, `Body larger than ${limit} bytes`, "too_large"));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!done) resolvePromise(Buffer.concat(chunks));
		});
		req.on("error", (e) => {
			if (!done) reject(e);
		});
	});
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const xff = req.headers["x-forwarded-for"];
		const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
		if (first) return first;
	}
	return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

export interface SseStream {
	send(event: string, data: unknown): void;
	comment(text: string): void;
	onClose(cb: () => void): void;
	close(): void;
}

export function startSse(req: Req, res: ServerResponse): SseStream {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write(": connected\n\n");
	const closers: (() => void)[] = [];
	let closed = false;
	const heartbeat = setInterval(() => {
		if (!closed) res.write(": ping\n\n");
	}, 20_000);
	const finish = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		for (const c of closers) c();
	};
	req.raw.on("close", finish);
	res.on("close", finish);
	return {
		send(event, data) {
			if (closed) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		},
		comment(text) {
			if (!closed) res.write(`: ${text}\n\n`);
		},
		onClose(cb) {
			closers.push(cb);
		},
		close() {
			finish();
			res.end();
		},
	};
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

/**
 * Serve a file from `root`. Falls back to index.html for SPA routes.
 * Assets under /assets/ (hashed names) get long-lived caching.
 */
export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const url = new URL(req.url ?? "/", "http://localhost");
	let rel: string;
	try {
		rel = decodeURIComponent(url.pathname);
	} catch {
		return false;
	}
	if (rel.includes("\0")) return false;
	const absRoot = resolve(root);
	let file = normalize(join(absRoot, rel));
	if (file !== absRoot && !file.startsWith(absRoot + sep)) return false;
	let st = await stat(file).catch(() => null);
	if (st?.isDirectory()) {
		file = join(file, "index.html");
		st = await stat(file).catch(() => null);
	}
	let isFallback = false;
	if (!st?.isFile()) {
		// SPA fallback only for "page" paths, never for missing assets or API
		if (extname(rel) || rel.startsWith("/api/")) return false;
		file = join(absRoot, "index.html");
		st = await stat(file).catch(() => null);
		if (!st?.isFile()) return false;
		isFallback = true;
	}
	const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
	const immutable = !isFallback && rel.startsWith("/assets/");
	res.writeHead(200, {
		"content-type": type,
		"content-length": st.size,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	createReadStream(file).pipe(res);
	return true;
}
