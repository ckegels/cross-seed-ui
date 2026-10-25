/**
 * Hub <-> agent request signing.
 *
 * signature = HMAC-SHA256(secret, METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA256(body))
 * Headers: x-csui-timestamp (ms), x-csui-nonce (hex), x-csui-signature (hex).
 * The secret never travels over the network; timestamps (±60 s) + a nonce
 * cache prevent replays.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_MS = 60_000;

export function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function canonical(method: string, pathAndQuery: string, ts: string, nonce: string, body: Buffer | string) {
	return `${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${nonce}\n${sha256Hex(body)}`;
}

export function signRequest(
	secret: string,
	method: string,
	pathAndQuery: string,
	body: Buffer | string = "",
): Record<string, string> {
	const ts = String(Date.now());
	const nonce = randomBytes(16).toString("hex");
	const sig = createHmac("sha256", secret).update(canonical(method, pathAndQuery, ts, nonce, body)).digest("hex");
	return {
		"x-csui-timestamp": ts,
		"x-csui-nonce": nonce,
		"x-csui-signature": sig,
	};
}

export class NonceCache {
	private seen = new Map<string, number>();
	has(nonce: string): boolean {
		this.prune();
		return this.seen.has(nonce);
	}
	add(nonce: string) {
		this.seen.set(nonce, Date.now());
	}
	private prune() {
		const cutoff = Date.now() - 2 * MAX_SKEW_MS;
		for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
	}
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyRequest(
	secret: string,
	method: string,
	pathAndQuery: string,
	headers: Record<string, string | string[] | undefined>,
	body: Buffer,
	nonces: NonceCache,
): VerifyResult {
	const ts = headers["x-csui-timestamp"];
	const nonce = headers["x-csui-nonce"];
	const sig = headers["x-csui-signature"];
	if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") {
		return { ok: false, reason: "missing signature headers" };
	}
	if (!/^\d{10,16}$/.test(ts) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) {
		return { ok: false, reason: "malformed signature headers" };
	}
	if (Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) {
		return { ok: false, reason: "timestamp outside allowed window (check the clocks of hub and agent)" };
	}
	const expected = createHmac("sha256", secret).update(canonical(method, pathAndQuery, ts, nonce, body)).digest();
	const given = Buffer.from(sig, "hex");
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return { ok: false, reason: "bad signature" };
	}
	if (nonces.has(nonce)) return { ok: false, reason: "replayed request" };
	nonces.add(nonce);
	return { ok: true };
}

export function randomSecret(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}
