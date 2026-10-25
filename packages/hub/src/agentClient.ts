/**
 * Signed HTTP client for agents.
 */
import type { ServerResponse } from "node:http";
import { HttpError } from "@csui/shared/src/node/http.ts";
import { signRequest } from "@csui/shared/src/node/hmac.ts";
import type { SecretBox } from "./crypto.ts";
import type { InstanceRow } from "./db.ts";

export interface AgentTarget {
	id: number;
	url: string;
	secret: string;
}

export function targetOf(row: InstanceRow, box: SecretBox): AgentTarget {
	return { id: row.id, url: row.url.replace(/\/+$/, ""), secret: box.decrypt(row.secret) };
}

export async function agentFetch(
	t: AgentTarget,
	method: string,
	pathAndQuery: string,
	body?: unknown,
	timeoutMs = 30_000,
): Promise<Response> {
	const payload = body === undefined ? "" : JSON.stringify(body);
	const headers: Record<string, string> = signRequest(t.secret, method, pathAndQuery, payload);
	if (payload) headers["content-type"] = "application/json";
	try {
		return await fetch(`${t.url}${pathAndQuery}`, {
			method,
			headers,
			body: payload || undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		const err = e as Error & { cause?: { code?: string } };
		const why = err.name === "TimeoutError" ? "timed out" : (err.cause?.code ?? err.message);
		throw new HttpError(502, `Agent ${t.url} is not reachable (${why})`, "agent_unreachable");
	}
}

/** Call an agent and return its JSON, turning agent errors into HttpErrors. */
export async function agentJson<T = unknown>(
	t: AgentTarget,
	method: string,
	pathAndQuery: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<T> {
	const res = await agentFetch(t, method, pathAndQuery, body, timeoutMs);
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		throw new HttpError(502, `Agent returned invalid JSON (HTTP ${res.status})`, "agent_bad_response");
	}
	if (!res.ok) {
		const j = (json ?? {}) as { error?: string; message?: string; details?: unknown };
		// 401 from an agent is a configuration problem (secret/clock), not the user's session
		const status = res.status === 401 ? 502 : res.status;
		throw new HttpError(status, j.message ?? `Agent error ${res.status}`, j.error ?? "agent_error", j.details);
	}
	return json as T;
}

/** Pipe an agent SSE stream to the browser. */
export async function pipeAgentSse(t: AgentTarget, pathAndQuery: string, res: ServerResponse, onClose: (cb: () => void) => void) {
	const controller = new AbortController();
	const headers = signRequest(t.secret, "GET", pathAndQuery, "");
	let upstream: Response;
	try {
		upstream = await fetch(`${t.url}${pathAndQuery}`, { headers, signal: controller.signal });
	} catch (e) {
		throw new HttpError(502, `Agent not reachable: ${(e as Error).message}`, "agent_unreachable");
	}
	if (!upstream.ok || !upstream.body) {
		throw new HttpError(502, `Agent stream failed (HTTP ${upstream.status})`, "agent_error");
	}
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	onClose(() => controller.abort());
	const reader = upstream.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(value)) await new Promise((r) => res.once("drain", r));
		}
	} catch {
		/* client or agent went away */
	} finally {
		res.end();
	}
}
