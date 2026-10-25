import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NonceCache, signRequest, verifyRequest } from "../../shared/src/node/hmac.ts";
import { LoginThrottle, parseCookies } from "../src/auth.ts";
import { base32Decode, base32Encode, hashPassword, passwordProblems, SecretBox, totpCode, verifyPassword, verifyTotp } from "../src/crypto.ts";
import { desiredIds, mergeTorznab, prowlarrIdOf } from "../src/prowlarr.ts";
import { newerVersion } from "../src/routes/systemRoutes.ts";

describe("passwords", () => {
	it("hashes and verifies", async () => {
		const h = await hashPassword("correct horse battery");
		assert.match(h, /^scrypt\$32768\$8\$1\$/);
		assert.equal(await verifyPassword("correct horse battery", h), true);
		assert.equal(await verifyPassword("wrong", h), false);
	});
	it("rejects weak passwords", () => {
		assert.ok(passwordProblems("short"));
		assert.ok(passwordProblems("adminadmin123", "admin"));
		assert.equal(passwordProblems("a long enough passphrase", "bob"), null);
	});
});

describe("TOTP", () => {
	it("matches the RFC 6238 SHA-1 test vector", () => {
		// secret "12345678901234567890", T=59s -> 94287082 (8 digits) -> last 6 = 287082
		const secret = base32Encode(Buffer.from("12345678901234567890"));
		assert.equal(totpCode(secret, Math.floor(59 / 30)), "287082");
		assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
	});
	it("accepts ±1 step and rejects garbage", () => {
		const secret = base32Encode(Buffer.from("abcdefghijabcdefghij"));
		const now = 1_800_000_000_000;
		const c = Math.floor(now / 30_000);
		assert.equal(verifyTotp(secret, totpCode(secret, c - 1), now), c - 1);
		assert.equal(verifyTotp(secret, totpCode(secret, c + 2), now), null);
		assert.equal(verifyTotp(secret, "abc", now), null);
	});
});

describe("SecretBox", () => {
	it("round-trips and detects tampering", () => {
		const box = new SecretBox(join(mkdtempSync(join(tmpdir(), "csui-")), "k"));
		const enc = box.encrypt("hello");
		assert.equal(box.decrypt(enc), "hello");
		const parts = enc.split(":");
		parts[3] = Buffer.from("other").toString("base64");
		assert.throws(() => box.decrypt(parts.join(":")));
	});
});

describe("HMAC signing", () => {
	it("verifies once and rejects replays, tampering and wrong secrets", () => {
		const secret = "s".repeat(40);
		const body = Buffer.from('{"a":1}');
		const h = signRequest(secret, "PUT", "/v1/config?x=1", body);
		const nonces = new NonceCache();
		assert.deepEqual(verifyRequest(secret, "PUT", "/v1/config?x=1", h, body, nonces), { ok: true });
		assert.equal(verifyRequest(secret, "PUT", "/v1/config?x=1", h, body, nonces).ok, false); // replay
		const h2 = signRequest(secret, "PUT", "/v1/config", body);
		assert.equal(verifyRequest(secret, "PUT", "/v1/config", h2, Buffer.from('{"a":2}'), new NonceCache()).ok, false);
		assert.equal(verifyRequest("x".repeat(40), "PUT", "/v1/config", h2, body, new NonceCache()).ok, false);
		assert.equal(verifyRequest(secret, "GET", "/v1/config", h2, body, new NonceCache()).ok, false);
	});
});

describe("Prowlarr torznab merging", () => {
	const s = { url: "http://prowlarr:9696", apiKey: "KEY" };
	it("keeps foreign entries, adds and removes prowlarr ones", () => {
		const current = ["http://jackett:9117/api/v2.0/indexers/x/results/torznab/api?apikey=J", "http://prowlarr:9696/1/api?apikey=__CSUI_REDACTED__", "http://prowlarr:9696/2/api?apikey=__CSUI_REDACTED__"];
		const r = mergeTorznab(s, current, [2, 5]);
		assert.deepEqual(r.next, [current[0], "http://prowlarr:9696/2/api?apikey=KEY", "http://prowlarr:9696/5/api?apikey=KEY"]);
		assert.deepEqual(r.added, [5]);
		assert.deepEqual(r.removed, [1]);
		assert.equal(prowlarrIdOf(s, "http://prowlarr:9696/12/api?apikey=x"), 12);
		assert.equal(prowlarrIdOf(s, "http://prowlarr:96960/12/api"), null);
	});
	it("selects by tag and privacy", () => {
		const idx = [
			{ id: 1, name: "a", protocol: "torrent", privacy: "private", enable: true, tags: [3], implementation: "", torznabUrl: "" },
			{ id: 2, name: "b", protocol: "torrent", privacy: "public", enable: true, tags: [3], implementation: "", torznabUrl: "" },
			{ id: 3, name: "c", protocol: "torrent", privacy: "private", enable: false, tags: [3], implementation: "", torznabUrl: "" },
		];
		assert.deepEqual(desiredIds({ mode: "tag", tagIds: [3], indexerIds: [], privateOnly: true, auto: false }, idx), [1]);
		assert.deepEqual(desiredIds({ mode: "all", tagIds: [], indexerIds: [], privateOnly: false, auto: false }, idx), [1, 2]);
		assert.deepEqual(desiredIds({ mode: "selected", tagIds: [], indexerIds: [3, 99], privateOnly: true, auto: false }, idx), [3]);
	});
});

describe("misc", () => {
	it("throttles per user after 5 failures", () => {
		const t = new LoginThrottle();
		for (let i = 0; i < 5; i++) t.recordFailure("1.2.3.4", "Admin");
		assert.ok(t.blockedFor("9.9.9.9", "admin") > 0);
		assert.equal(t.blockedFor("9.9.9.9", "other"), 0);
	});
	it("parses cookies and compares versions", () => {
		assert.deepEqual(parseCookies("a=1; csui_sid=abc%3D; a=2"), { a: "1", csui_sid: "abc=" });
		assert.equal(newerVersion("0.2.0", "0.1.9"), true);
		assert.equal(newerVersion("0.1.0", "0.1.0"), false);
		assert.equal(newerVersion("1.0.0", "1.0.0-beta"), false);
	});
});

describe("router", () => {
	it("prefers exact routes over wildcard routes", async () => {
		const { Router } = await import("../../shared/src/node/http.ts");
		const r = new Router();
		r.add("PUT", "/api/instances/:id/*", () => "proxy");
		r.add("PUT", "/api/instances/:id/prowlarr", () => "exact");
		const m = r.match("PUT", "/api/instances/3/prowlarr");
		assert.ok(m && typeof m === "object");
		assert.equal(m.route.handler({} as never, {} as never), "exact");
		const w = r.match("PUT", "/api/instances/3/config");
		assert.ok(w && typeof w === "object");
		assert.equal(w.params["*"], "config");
	});
});
