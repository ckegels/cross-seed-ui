import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { templateConfig } from "../../shared/src/options.ts";
import { ConfigManager, detectDynamicCode } from "../src/crossSeedConfig.ts";
import { ActivityTracker } from "../src/logs.ts";
import { extractEvent, parseLogLine } from "../../shared/src/logParse.ts";

const valid = () => ({
	...templateConfig(),
	torznab: ["http://prowlarr:9696/1/api?apikey=abc"],
	torrentClients: ["qbittorrent:http://u:p@qbit:8080"],
	linkDirs: ["/data/links"],
});

describe("ConfigManager", () => {
	it("writes, backs up, detects conflicts and restores", async () => {
		const dir = mkdtempSync(join(tmpdir(), "csui-cs-"));
		const state = mkdtempSync(join(tmpdir(), "csui-st-"));
		writeFileSync(join(dir, "config.js"), `module.exports = { delay: 45, torznab: [process.env.HOME ? "http://x/1/api?apikey=k" : ""] };`);
		const m = new ConfigManager(dir, state, 5);
		const first = await m.load();
		assert.equal(first.config.delay, 45);
		assert.equal(first.usesDynamicCode, true);

		const r = await m.write(valid(), { baseHash: first.hash, note: "test" });
		assert.ok(r.backupId);
		const again = await m.load();
		assert.deepEqual(again.config.linkDirs, ["/data/links"]);
		assert.equal(again.usesDynamicCode, false);

		await assert.rejects(m.write(valid(), { baseHash: first.hash }), /changed since you loaded it/);
		await assert.rejects(m.write({ ...valid(), delay: 1 }, { baseHash: again.hash }), /errors/);

		const backups = await m.listBackups();
		assert.equal(backups.length, 1);
		assert.equal(backups[0].note, "before: test");
		await m.restoreBackup(backups[0].id);
		assert.match(readFileSync(join(dir, "config.js"), "utf8"), /delay: 45/);
		await assert.rejects(m.readBackup("../etc"), /Invalid backup id|not found/);
	});

	it("refuses to write a file that does not load", async () => {
		const dir = mkdtempSync(join(tmpdir(), "csui-cs-"));
		const m = new ConfigManager(dir, mkdtempSync(join(tmpdir(), "csui-st-")), 5);
		writeFileSync(join(dir, "config.js"), "module.exports = { delay: 30 };");
		await assert.rejects(m.writeText("module.exports = {", undefined), /could not be loaded/);
		assert.match(readFileSync(join(dir, "config.js"), "utf8"), /delay: 30/);
	});

	it("detects dynamic code but ignores comments", () => {
		assert.equal(detectDynamicCode("// uses process.env in a comment\nmodule.exports = { a: 1 };"), false);
		assert.equal(detectDynamicCode("module.exports = { a: process.env.A };"), true);
	});
});

describe("ActivityTracker", () => {
	const feed = (t: ActivityTracker, line: string) => {
		const e = parseLogLine(line)!;
		t.feed(e, extractEvent(e));
	};
	it("tracks running jobs and progress", () => {
		const t = new ActivityTracker();
		const now = new Date();
		const ts = (s: number) => {
			const d = new Date(now.getTime() - 60_000 + s * 1000);
			const p = (n: number, l = 2) => String(n).padStart(l, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
		};
		feed(t, `${ts(0)} info: [scheduler] starting job: search`);
		feed(t, `${ts(1)} info: [search] (1/10) Searching for A | MediaType: movie | IDs: NONE`);
		feed(t, `${ts(31)} info: [search] (2/10) Searching for B | MediaType: movie | IDs: NONE`);
		let a = t.snapshot(true);
		assert.equal(a.state, "searching");
		assert.equal(a.progress?.index, 2);
		assert.equal(a.progress?.etaMs, 30_000 * 8);
		feed(t, `${ts(40)} info: [scheduler] search: last run 40s ago, next run in 24h`);
		a = t.snapshot(true);
		assert.equal(a.state, "idle");
		assert.equal(t.snapshot(false).state, "stopped");
	});
	it("reports starting while cross-seed validates and loads torrents after a restart", () => {
		const t = new ActivityTracker();
		const p = (n: number) => String(n).padStart(2, "0");
		const d = new Date();
		const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
		feed(t, `${ts} info: cross-seed v6.13.9`);
		feed(t, `${ts} info: Validating your configuration...`);
		assert.equal(t.snapshot(true).state, "starting");
		feed(t, `${ts} info: Your configuration is valid!`);
		assert.equal(t.snapshot(true).state, "starting");
		feed(t, `${ts} info: [server] Server is running on port 2468, ^C to stop.`);
		assert.equal(t.snapshot(true).state, "idle");
		feed(t, `${ts} info: Validating your configuration...`);
		feed(t, `${ts} error: Your configuration is invalid, please see the error above for details.`);
		assert.equal(t.snapshot(false).state, "stopped");
		assert.equal(t.snapshot(false, true).state, "starting");
	});
	it("forgets errors from before the last (re)start", () => {
		const t = new ActivityTracker();
		const p = (n: number) => String(n).padStart(2, "0");
		const d = new Date();
		const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
		feed(t, `${ts} error: [torznab] Failed to reach Torr9 (Prowlarr): request failed`);
		assert.match(t.snapshot(true).lastError?.text ?? "", /Torr9/);
		feed(t, `${ts} info: [server] Server is running on port 2468, ^C to stop.`);
		assert.equal(t.snapshot(true).lastError, null);
	});
});
