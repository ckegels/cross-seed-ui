/**
 * Connection tests, run from the agent so they test reachability exactly
 * like cross-seed sees it (same LXC, same network, same DNS).
 * Mirrors how cross-seed v6 talks to each service (src/arr.ts, src/clients/*).
 */
import type { TestKind, TestResult } from "@csui/shared";
import { parseClientEntry, redactText } from "@csui/shared";

const UA = "cross-seed-ui";
const MAX_BODY = 2 * 1024 * 1024;

function credentials(url: string, basePath?: string) {
	const u = new URL(url);
	const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
	return {
		username: decodeURIComponent(u.username),
		password: decodeURIComponent(u.password),
		href: u.origin + (basePath ? `${pathname}${basePath}` : pathname),
	};
}

async function readText(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_BODY) {
			await reader.cancel();
			break;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function fail(message: string, start: number): TestResult {
	return { ok: false, message: redactText(message), latencyMs: Date.now() - start };
}

function errMsg(e: unknown): string {
	const err = e as Error & { cause?: { code?: string; message?: string } };
	if (err.name === "TimeoutError") return "Timed out";
	return err.cause?.code ? `${err.cause.code}: ${err.cause.message ?? ""}` : err.message;
}

function checkScheme(url: string) {
	const u = new URL(url);
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https URLs are supported");
	return u;
}

async function testTorznab(url: string): Promise<TestResult> {
	const start = Date.now();
	const u = checkScheme(url);
	u.searchParams.set("t", "caps");
	try {
		const res = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
		const text = await readText(res);
		const err = /<error[^>]*code="(\d+)"[^>]*description="([^"]*)"/i.exec(text);
		if (err) return fail(`Indexer error ${err[1]}: ${err[2]}`, start);
		if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`, start);
		if (!/<caps[\s>]/i.test(text)) return fail("Response is not a Torznab caps document. Is this a Torznab URL?", start);
		const title = /<server[^>]*title="([^"]*)"/i.exec(text)?.[1] ?? null;
		const modes = [...text.matchAll(/<(search|tv-search|movie-search|music-search|audio-search|book-search)\b[^>]*available="yes"/gi)].map(
			(m) => m[1],
		);
		const cats = [...text.matchAll(/<category\b[^>]*name="([^"]*)"/gi)].map((m) => m[1]);
		return {
			ok: true,
			message: `Torznab OK${title ? ` (${title})` : ""}: ${modes.length ? modes.join(", ") : "no search modes advertised"}`,
			latencyMs: Date.now() - start,
			details: { title, modes, categories: cats.slice(0, 30) },
		};
	} catch (e) {
		return fail(errMsg(e), start);
	}
}

async function testArr(url: string, kind: "sonarr" | "radarr"): Promise<TestResult> {
	const start = Date.now();
	const u = checkScheme(url);
	const apikey = u.searchParams.get("apikey");
	if (!apikey) return fail(`${kind} URL must contain ?apikey=YOUR_KEY (cross-seed requires it)`, start);
	const base = u.origin + u.pathname.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}/api/v3/system/status`, {
			headers: { "X-Api-Key": apikey, "user-agent": UA },
			signal: AbortSignal.timeout(15_000),
		});
		if (res.status === 401) return fail("401 Unauthorized: check the API key", start);
		if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`, start);
		const body = JSON.parse(await readText(res)) as { appName?: string; version?: string; instanceName?: string };
		const app = (body.appName ?? "").toLowerCase();
		if (app && app !== kind) return fail(`This looks like ${body.appName}, not ${kind}`, start);
		return {
			ok: true,
			message: `${body.instanceName ?? body.appName ?? kind} ${body.version ?? ""} reachable`.trim(),
			latencyMs: Date.now() - start,
			details: { appName: body.appName, version: body.version, instanceName: body.instanceName },
		};
	} catch (e) {
		return fail(errMsg(e), start);
	}
}

async function testQbittorrent(url: string, start: number): Promise<TestResult> {
	const { href, username, password } = credentials(url, "/api/v2");
	const login = await fetch(`${href}/auth/login`, {
		method: "POST",
		body: new URLSearchParams({ username, password }),
		headers: { "user-agent": UA, referer: new URL(href).origin },
		signal: AbortSignal.timeout(10_000),
	});
	if (!login.ok) return fail(`qBittorrent login failed with HTTP ${login.status}`, start);
	const cookie = login.headers.getSetCookie()[0];
	if (!cookie) return fail("qBittorrent login failed: invalid username or password", start);
	const v = await fetch(`${href}/app/version`, {
		headers: { cookie: cookie.split(";")[0], "user-agent": UA },
		signal: AbortSignal.timeout(10_000),
	});
	const version = (await readText(v)).trim();
	if (!v.ok || !version) return fail("Logged in but could not read the qBittorrent version", start);
	return { ok: true, message: `qBittorrent ${version}`, latencyMs: Date.now() - start, details: { version } };
}

async function testTransmission(url: string, start: number): Promise<TestResult> {
	const { href, username, password } = credentials(url);
	const headers: Record<string, string> = { "content-type": "application/json", "user-agent": UA };
	if (username || password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	const body = JSON.stringify({ method: "session-get", arguments: { fields: ["version"] } });
	let res = await fetch(href, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
	if (res.status === 409) {
		headers["X-Transmission-Session-Id"] = res.headers.get("X-Transmission-Session-Id") ?? "";
		res = await fetch(href, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
	}
	if (res.status === 401) return fail("Transmission: invalid username or password", start);
	if (!res.ok) return fail(`Transmission HTTP ${res.status}`, start);
	const json = JSON.parse(await readText(res)) as { result?: string; arguments?: { version?: string } };
	if (json.result !== "success") return fail(`Transmission: ${json.result ?? "unexpected response"}`, start);
	return { ok: true, message: `Transmission ${json.arguments?.version ?? ""}`.trim(), latencyMs: Date.now() - start };
}

async function testDeluge(url: string, start: number): Promise<TestResult> {
	const { href, password } = credentials(url);
	const call = async (method: string, params: unknown[], cookie?: string) => {
		const res = await fetch(href, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": UA, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ method, params, id: Date.now() }),
			signal: AbortSignal.timeout(10_000),
		});
		const json = JSON.parse(await readText(res)) as { result: unknown; error: { message: string } | null };
		return { json, cookie: res.headers.getSetCookie()[0]?.split(";")[0] ?? cookie };
	};
	const login = await call("auth.login", [password]);
	if (login.json.error) return fail(`Deluge: ${login.json.error.message}`, start);
	if (login.json.result !== true) return fail("Deluge: wrong password", start);
	const connected = await call("web.connected", [], login.cookie);
	if (connected.json.result !== true) {
		return { ok: false, message: "Logged in to Deluge WebUI, but the WebUI is not connected to a Deluge daemon", latencyMs: Date.now() - start };
	}
	return { ok: true, message: "Deluge WebUI connected to its daemon", latencyMs: Date.now() - start };
}

async function testRtorrent(url: string, start: number): Promise<TestResult> {
	const { href, username, password } = credentials(url);
	const headers: Record<string, string> = { "content-type": "text/xml", "user-agent": UA };
	if (username || password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	const res = await fetch(href, {
		method: "POST",
		headers,
		body: '<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName><params></params></methodCall>',
		signal: AbortSignal.timeout(10_000),
	});
	if (res.status === 401) return fail("rTorrent: invalid username or password", start);
	if (!res.ok) return fail(`rTorrent HTTP ${res.status}`, start);
	const text = await readText(res);
	if (/<fault>/i.test(text)) return fail("rTorrent returned an XML-RPC fault", start);
	const version = /<string>([^<]*)<\/string>/.exec(text)?.[1];
	return { ok: true, message: `rTorrent ${version ?? ""}`.trim(), latencyMs: Date.now() - start };
}

async function testClient(entry: string): Promise<TestResult> {
	const start = Date.now();
	const parsed = parseClientEntry(entry);
	if (!parsed) return fail("Entry must look like qbittorrent:http://user:pass@host:8080", start);
	checkScheme(parsed.url);
	try {
		let r: TestResult;
		switch (parsed.clientType) {
			case "qbittorrent":
				r = await testQbittorrent(parsed.url, start);
				break;
			case "transmission":
				r = await testTransmission(parsed.url, start);
				break;
			case "deluge":
				r = await testDeluge(parsed.url, start);
				break;
			case "rtorrent":
				r = await testRtorrent(parsed.url, start);
				break;
			default:
				return fail(`Unknown client type "${parsed.clientType}"`, start);
		}
		if (r.ok && parsed.readonly) r.message += " (read-only: used as a source only)";
		return r;
	} catch (e) {
		return fail(errMsg(e), start);
	}
}

async function testNotification(url: string): Promise<TestResult> {
	const start = Date.now();
	checkScheme(url);
	try {
		// same payload shape as cross-seed's test notification
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": UA },
			body: JSON.stringify({ title: "cross-seed", body: "Test from cross-seed-ui", extra: { event: "TEST" } }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return fail(`Webhook rejected the test: HTTP ${res.status} ${res.statusText}`, start);
		return { ok: true, message: `Delivered (HTTP ${res.status})`, latencyMs: Date.now() - start };
	} catch (e) {
		return fail(errMsg(e), start);
	}
}

export async function runTest(kind: TestKind, value: string): Promise<TestResult> {
	try {
		switch (kind) {
			case "torznab":
				return await testTorznab(value);
			case "sonarr":
				return await testArr(value, "sonarr");
			case "radarr":
				return await testArr(value, "radarr");
			case "client":
				return await testClient(value);
			case "notification":
				return await testNotification(value);
			default:
				return { ok: false, message: `Unsupported test ${kind}`, latencyMs: null };
		}
	} catch (e) {
		return { ok: false, message: redactText(errMsg(e)), latencyMs: null };
	}
}
