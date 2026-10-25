import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuration } from "../src/duration.ts";
import { templateConfig } from "../src/options.ts";
import { validateConfig, isChildPath } from "../src/validate.ts";
import { REDACTED, redactConfig, redactString, restoreSecrets, SecretRestoreError } from "../src/redact.ts";
import { extractEvent, parseLogLine, parseLogText } from "../src/logParse.ts";
import { renderConfigFile } from "../src/configFile.ts";

describe("duration", () => {
	it("parses like vercel/ms", () => {
		assert.equal(parseDuration("2 weeks"), 14 * 86400000);
		assert.equal(parseDuration("30 minutes"), 1800000);
		assert.equal(parseDuration("1h"), 3600000);
		assert.equal(parseDuration("1.5 days"), 1.5 * 86400000);
		assert.equal(parseDuration("100"), 100);
		assert.ok(Number.isNaN(parseDuration("soon")));
		assert.ok(Number.isNaN(parseDuration(" 2 days")));
	});
});

const goodConfig = () => ({
	...templateConfig(),
	torznab: ["http://prowlarr:9696/1/api?apikey=abcdef0123456789"],
	torrentClients: ["qbittorrent:http://admin:s3cret@qbit:8080"],
	linkDirs: ["/data/torrents/links"],
});

describe("validateConfig", () => {
	it("accepts a typical config", () => {
		const r = validateConfig(goodConfig());
		assert.deepEqual(r.errors, []);
		assert.equal(r.ok, true);
	});

	it("template alone fails like cross-seed (inject needs clients, flexible needs linkDirs)", () => {
		const r = validateConfig(templateConfig());
		const msgs = r.errors.map((e) => e.message).join("\n");
		assert.match(msgs, /client configured for useClientTorrents/);
		assert.match(msgs, /torrentClients when using 'inject'/);
		assert.match(msgs, /linkDirs for flexible and partial/);
	});

	it("enforces cadence relationships", () => {
		const c = { ...goodConfig(), searchCadence: "1 day", excludeRecentSearch: "2 days", excludeOlder: "1 week" };
		const r = validateConfig(c);
		assert.ok(r.errors.some((e) => e.keys.includes("excludeRecentSearch") && /3x/.test(e.message)));
	});

	it("rejects out of range values", () => {
		const r = validateConfig({ ...goodConfig(), delay: 5, rssCadence: "5 minutes", autoResumeMaxDownload: 99999999 });
		const keys = r.errors.flatMap((e) => e.keys);
		assert.ok(keys.includes("delay"));
		assert.ok(keys.includes("rssCadence"));
		assert.ok(keys.includes("autoResumeMaxDownload"));
	});

	it("validates blocklist entries", () => {
		const r = validateConfig({
			...goodConfig(),
			blockList: ["name:foo", "tracker:https://x.org/announce", "infoHash:zz", "nameRegex:(", "bogus:1"],
		});
		assert.equal(r.errors.filter((e) => e.keys.includes("blockList")).length, 4);
	});

	it("detects nested directories", () => {
		assert.equal(isChildPath("/data/links", ["/data"]), true);
		assert.equal(isChildPath("/data2", ["/data"]), false);
		const r = validateConfig({ ...goodConfig(), dataDirs: ["/data"], linkDirs: ["/data/links"] });
		assert.ok(r.errors.some((e) => e.keys.includes("linkDirs")));
	});

	it("does not leak credentials in client errors", () => {
		const r = validateConfig({ ...goodConfig(), torrentClients: ["qbit:http://admin:hunter2@qbit:8080"] });
		assert.ok(r.errors.length);
		assert.ok(!JSON.stringify(r.errors).includes("hunter2"));
	});
});

describe("redaction", () => {
	it("redacts passwords, api keys and path tokens without normalising", () => {
		assert.equal(
			redactString("qbittorrent:readonly:http://admin:p%40ss@qbit:8080"),
			`qbittorrent:readonly:http://admin:${REDACTED}@qbit:8080`,
		);
		assert.equal(
			redactString("http://prowlarr:9696/12/api?apikey=0123456789abcdef"),
			`http://prowlarr:9696/12/api?apikey=${REDACTED}`,
		);
		assert.equal(
			redactString("http://apprise:8000/notify/abcDEF0123456789abcdefXYZ"),
			`http://apprise:8000/notify/${REDACTED}`,
		);
		assert.equal(redactString("http://sonarr:8989"), "http://sonarr:8989");
	});

	it("round-trips untouched, edited and reordered entries", () => {
		const current = {
			torznab: ["http://p:9696/1/api?apikey=KEY1aaaaaaaa", "http://p:9696/2/api?apikey=KEY1aaaaaaaa"],
			torrentClients: ["qbittorrent:http://admin:pw@qbit:8080"],
			apiKey: "x".repeat(30),
		};
		const red = redactConfig(current);
		assert.equal(red.apiKey, REDACTED);
		// reorder + add an index via an edited copy of #1 (path change keeps the key)
		const incoming = {
			...red,
			torznab: [(red.torznab as string[])[1], (red.torznab as string[])[0].replace("/1/", "/7/")],
		};
		const restored = restoreSecrets(incoming, current);
		assert.deepEqual(restored.torznab, ["http://p:9696/2/api?apikey=KEY1aaaaaaaa", "http://p:9696/7/api?apikey=KEY1aaaaaaaa"]);
		assert.deepEqual(restored.torrentClients, current.torrentClients);
		assert.equal(restored.apiKey, current.apiKey);
	});

	it("refuses to guess a secret for a new host", () => {
		const current = { torznab: ["http://p:9696/1/api?apikey=KEY"] };
		assert.throws(
			() => restoreSecrets({ torznab: [`http://other:9696/1/api?apikey=${REDACTED}`] }, current),
			SecretRestoreError,
		);
	});
});

describe("log parsing", () => {
	it("parses lines and folds continuations", () => {
		const entries = parseLogText(
			"2026-10-25 10:00:00.123 error: [torznab] boom\n    at stack line\n2026-10-25 10:00:01.000 info: hello",
		);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].label, "torznab");
		assert.match(entries[0].message, /stack line/);
		assert.equal(entries[1].label, null);
	});

	it("extracts match events", () => {
		const e = parseLogLine(
			"2026-10-25 10:00:00.000 info: [search] Found Movie.2024.1080p.BluRay-GRP [Movie.2024.1080p.BluRay-GRP.mkv] on BHD (Prowlarr) by MATCH_PARTIAL from torrentClient (Movie 2024 [abcdef12...@qbit:8080]) - injected",
		)!;
		const ev = extractEvent(e);
		assert.ok(ev && ev.type === "match");
		if (ev.type === "match") {
			assert.equal(ev.name, "Movie.2024.1080p.BluRay-GRP");
			assert.equal(ev.tracker, "BHD (Prowlarr)");
			assert.equal(ev.decision, "MATCH_PARTIAL");
			assert.equal(ev.result, "injected");
			assert.equal(ev.searchee, "Movie 2024");
			assert.equal(ev.via, "search");
		}
	});

	it("extracts search progress and scheduler events", () => {
		const p = extractEvent(
			parseLogLine(
				"2026-10-25 10:00:00.000 info: [search] (12/400) Searching for Show S01 [Show.S01.1080p [12345678...@qbit:8080]] | MediaType: pack | IDs: TVDB: 1234",
			)!,
		);
		assert.deepEqual(p && p.type === "search-progress" && [p.index, p.total, p.name], [12, 400, "Show S01"]);
		const s = extractEvent(parseLogLine("2026-10-25 10:00:00.000 info: [scheduler] starting job: rss")!);
		assert.deepEqual(s, { type: "job-start", job: "rss" });
		const n = extractEvent(parseLogLine("2026-10-25 10:00:00.000 info: [scheduler] rss: last run 1m ago, next run in 29m")!);
		assert.equal(n?.type, "job-schedule");
	});
});

describe("config file", () => {
	it("renders a loadable module that round-trips", async () => {
		const cfg = { ...goodConfig(), blockList: ["name:*/evil"], apiKey: undefined };
		const text = renderConfigFile(cfg, { note: "test" });
		const mod = { exports: {} as Record<string, unknown> };
		new Function("module", text)(mod);
		for (const [k, v] of Object.entries(cfg)) assert.deepEqual(mod.exports[k], v, k);
	});
});
