/**
 * Demo-only fake services for a real cross-seed daemon:
 *   /qbit/<a|b>/api/v2/...        qBittorrent WebUI API (library + accepts injections)
 *   /<trackerId>/api               Prowlarr-style Torznab per fictional tracker
 *   /<trackerId>/download/<key>    generated .torrent files
 *   /api/v1/...                    Prowlarr API (indexers, tags, status)
 *   /sonarr|/radarr/api/v3/...     minimal Sonarr/Radarr
 *   /notify                        notification webhook sink
 *
 *   node --import tsx scripts/demo/mock-services.ts <dataRoot> [port]
 * <dataRoot>/<a|b>/data holds sparse copies of the library so linking works.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { LIBRARY, LISTINGS, type Listing, prowlarrName, type Release, TRACKERS, sha1 } from "./catalog.ts";

const dataRoot = process.argv[2];
const port = Number(process.argv[3] ?? 9696);
const PROWLARR_KEY = "demo0prowlarr0key0123456789abcdef";
if (!dataRoot) throw new Error("usage: mock-services.ts <dataRoot> [port]");

// ---------------------------------------------------------------- bencode
function bencode(v: unknown): Buffer {
	if (typeof v === "number") return Buffer.from(`i${Math.floor(v)}e`);
	if (typeof v === "string") return Buffer.concat([Buffer.from(`${Buffer.byteLength(v)}:`), Buffer.from(v)]);
	if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
	if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(bencode), Buffer.from("e")]);
	const obj = v as Record<string, unknown>;
	return Buffer.concat([Buffer.from("d"), ...Object.keys(obj).sort().flatMap((k) => [bencode(k), bencode(obj[k])]), Buffer.from("e")]);
}

/** Minimal bdecode that also returns the raw byte range of the "info" dict. */
function bdecode(buf: Buffer) {
	let i = 0;
	let infoRange: [number, number] | null = null;
	const read = (): unknown => {
		const c = String.fromCharCode(buf[i]);
		if (c === "i") {
			const end = buf.indexOf(0x65, i);
			const n = Number(buf.subarray(i + 1, end).toString());
			i = end + 1;
			return n;
		}
		if (c === "l") {
			i++;
			const arr: unknown[] = [];
			while (buf[i] !== 0x65) arr.push(read());
			i++;
			return arr;
		}
		if (c === "d") {
			i++;
			const obj: Record<string, unknown> = {};
			while (buf[i] !== 0x65) {
				const k = (read() as Buffer).toString();
				const start = i;
				obj[k] = read();
				if (k === "info") infoRange = [start, i];
			}
			i++;
			return obj;
		}
		const colon = buf.indexOf(0x3a, i);
		const len = Number(buf.subarray(i, colon).toString());
		const s = buf.subarray(colon + 1, colon + 1 + len);
		i = colon + 1 + len;
		return s;
	};
	const value = read() as Record<string, unknown>;
	return { value, infoHash: infoRange ? createHash("sha1").update(buf.subarray(infoRange[0], infoRange[1])).digest("hex") : null };
}

function torrentFor(l: Listing): Buffer {
	const rel = l.release;
	const pieceLength = 16 * 1024 * 1024;
	const pieces = Math.max(1, Math.ceil(l.size / pieceLength));
	const hashes = Buffer.concat(Array.from({ length: Math.min(pieces, 4000) }, (_, i) => createHash("sha1").update(`${l.guid}:${i}`).digest()));
	const root = l.name;
	const scale = l.size / rel.size;
	const files = rel.files.map((f) => ({
		length: Math.floor(f.size * scale),
		path: f.path.split("/").slice(1),
	}));
	return bencode({
		announce: `https://${l.tracker.host}/announce/${sha1(l.tracker.host).slice(0, 32)}`,
		info: { name: root, files, "piece length": pieceLength, pieces: hashes, private: 1, source: l.tracker.name.toUpperCase() },
	});
}

// ---------------------------------------------------------------- qBittorrent state
interface QTorrent {
	hash: string;
	name: string;
	save_path: string;
	category: string;
	tags: string;
	files: { name: string; size: number }[];
	tracker: string;
	added_on: number;
	state: string;
}

const clients: Record<string, QTorrent[]> = { a: [], b: [] };
for (const r of LIBRARY) {
	clients[r.instance].push({
		hash: r.hash,
		name: r.name,
		save_path: join(dataRoot, r.instance, "data", r.category),
		category: r.category,
		tags: "",
		files: r.files.map((f) => ({ name: f.path, size: f.size })),
		tracker: `https://${r.origin.host}/announce/${sha1(r.origin.host).slice(0, 32)}`,
		added_on: r.addedOn,
		state: "stalledUP",
	});
}

function torrentInfo(t: QTorrent, withTrackers: boolean, withFiles: boolean) {
	const size = t.files.reduce((a, f) => a + f.size, 0);
	return {
		hash: t.hash,
		infohash_v1: t.hash,
		infohash_v2: "",
		name: t.name,
		size,
		total_size: size,
		progress: 1,
		amount_left: 0,
		completed: size,
		state: t.state,
		save_path: t.save_path,
		download_path: "",
		content_path: join(t.save_path, t.name),
		root_path: join(t.save_path, t.name),
		category: t.category,
		tags: t.tags,
		tracker: t.tracker,
		auto_tmm: false,
		added_on: t.added_on,
		completion_on: t.added_on + 3600,
		ratio: 1.2,
		num_seeds: 3,
		num_leechs: 0,
		...(withTrackers ? { trackers: [{ url: t.tracker, tier: 0, status: 2, msg: "" }] } : {}),
		...(withFiles ? { files: t.files.map((f, index) => ({ index, name: f.name, size: f.size, progress: 1, priority: 1 })) } : {}),
	};
}

async function body(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return Buffer.concat(chunks);
}

async function params(req: IncomingMessage, url: URL): Promise<URLSearchParams> {
	const p = new URLSearchParams(url.search);
	if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("multipart/")) {
		for (const [k, v] of new URLSearchParams((await body(req)).toString())) p.set(k, v);
	}
	return p;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const norm = (s: string) => s.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

function rssItem(l: Listing, guidSuffix = "") {
	const link = `http://127.0.0.1:${port}/${l.tracker.id}/download/${l.release.key}-${l.kind}.torrent?apikey=${PROWLARR_KEY}`;
	return `<item><title>${esc(l.name)}</title><guid>${esc(l.guid + guidSuffix)}</guid><prowlarrindexer id="${l.tracker.id}" type="private">${esc(prowlarrName(l.tracker))}</prowlarrindexer><link>${esc(link)}</link><size>${l.size}</size><pubDate>${new Date(l.pubDate * 1000).toUTCString()}</pubDate><enclosure url="${esc(link)}" length="${l.size}" type="application/x-bittorrent"/><torznab:attr name="category" value="${l.release.category.startsWith("tv") || l.release.category === "anime" ? 5000 : 2000}"/></item>`;
}

/** Every 7 minutes one listing "gets uploaded" so RSS finds new matches over time. */
function freshUploads(t: (typeof TRACKERS)[number]): Listing[] {
	const window = Math.floor(Date.now() / (7 * 60_000));
	const mine = LISTINGS.filter((l) => l.tracker.id === t.id && l.kind === "exact");
	const out: Listing[] = [];
	for (let w = window; w > window - 30; w--) {
		const l = mine[(w * 7 + t.id * 13) % mine.length];
		if (l) out.push({ ...l, pubDate: Math.floor((w * 7 * 60_000) / 1000), guid: `${l.guid}?u=${w}` });
	}
	return out;
}

// a tracker that is rate limited half of the time, to show indexer health
const flaky = (id: number) => id === 6 && Math.floor(Date.now() / 3_600_000) % 2 === 0;

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const p = url.pathname;
	const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
	const text = (v: string, status = 200, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "text/plain", ...headers }).end(v);
	try {
		// ---------------- qBittorrent
		const q = /^\/qbit\/(a|b)\/api\/v2\/(.+)$/.exec(p);
		if (q) {
			const list = clients[q[1]];
			const ep = q[2];
			switch (ep) {
				case "auth/login":
					await body(req);
					return text("Ok.", 200, { "set-cookie": "SID=demo; HttpOnly; path=/" });
				case "app/version":
					return text("v5.0.4");
				case "app/webapiVersion":
					return text("2.11.4");
				case "app/preferences":
					return json({ save_path: join(dataRoot, q[1], "data"), resume_data_storage_type: "Legacy" });
				case "torrents/categories":
					return json(Object.fromEntries([...new Set(list.map((t) => t.category))].map((c) => [c, { name: c, savePath: "" }])));
				case "torrents/info": {
					const prm = await params(req, url);
					const hashes = prm.get("hashes")?.split("|");
					const rows = hashes ? list.filter((t) => hashes.includes(t.hash)) : list;
					return json(rows.map((t) => torrentInfo(t, prm.get("includeTrackers") === "true", prm.get("includeFiles") === "true")));
				}
				case "torrents/files": {
					const prm = await params(req, url);
					const t = list.find((x) => x.hash === prm.get("hash"));
					return t ? json(torrentInfo(t, false, true).files) : text("Not Found", 404);
				}
				case "torrents/trackers": {
					const prm = await params(req, url);
					const t = list.find((x) => x.hash === prm.get("hash"));
					return t ? json([{ url: t.tracker, tier: 0, status: 2, msg: "" }]) : text("Not Found", 404);
				}
				case "torrents/add": {
					const raw = await body(req);
					const form = await new Request("http://x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: raw }).formData();
					const file = form.get("torrents") as File;
					const { value, infoHash } = bdecode(Buffer.from(await file.arrayBuffer()));
					const info = value.info as Record<string, unknown>;
					const name = (info.name as Buffer).toString();
					const files = ((info.files as Record<string, unknown>[]) ?? [{ length: info.length, path: [] }]).map((f) => ({
						name: [name, ...((f.path as Buffer[]) ?? []).map((x) => x.toString())].join("/"),
						size: f.length as number,
					}));
					const stopped = form.get("stopped") === "true" || form.get("paused") === "true";
					list.push({
						hash: infoHash!,
						name,
						save_path: String(form.get("savepath") ?? ""),
						category: String(form.get("category") ?? ""),
						tags: String(form.get("tags") ?? ""),
						files,
						tracker: (value.announce as Buffer).toString(),
						added_on: Math.floor(Date.now() / 1000),
						state: stopped ? "stoppedUP" : "stalledUP",
					});
					console.log(`[qbit ${q[1]}] injected ${name}`);
					return text("Ok.");
				}
				case "torrents/recheck":
				case "torrents/start":
				case "torrents/resume": {
					const prm = await params(req, url);
					for (const h of (prm.get("hashes") ?? "").split("|")) {
						const t = list.find((x) => x.hash === h);
						if (t) t.state = "stalledUP";
					}
					return text("");
				}
				default:
					await body(req);
					return text("");
			}
		}

		// ---------------- Prowlarr API
		if (p.startsWith("/api/v1/")) {
			if (req.headers["x-api-key"] !== PROWLARR_KEY) return json({ error: "Unauthorized" }, 401);
			if (p === "/api/v1/system/status") return json({ appName: "Prowlarr", instanceName: "Prowlarr", version: "1.30.2.4939" });
			if (p === "/api/v1/tag") return json([{ id: 1, label: "cross-seed" }, { id: 2, label: "uhd" }]);
			if (p === "/api/v1/indexer") {
				return json([
					...TRACKERS.map((t) => ({ id: t.id, name: t.name, protocol: "torrent", privacy: "private", enable: true, tags: t.id <= 4 ? [1] : t.id === 5 ? [1, 2] : [2], implementation: "Cardigann" })),
					{ id: 7, name: "OpenTracker", protocol: "torrent", privacy: "public", enable: true, tags: [], implementation: "Cardigann" },
					{ id: 8, name: "Usenet Example", protocol: "usenet", privacy: "private", enable: true, tags: [], implementation: "Newznab" },
				]);
			}
			return json([]);
		}

		// ---------------- Sonarr / Radarr
		const ping = /^\/(sonarr|radarr)\/api\/?$/.exec(p);
		if (ping) return json({ current: "v3", deprecated: [] });
		const arr = /^\/(sonarr|radarr)\/api\/v3\/(.+)$/.exec(p);
		if (arr) {
			if (arr[2] === "system/status") return json({ appName: arr[1] === "sonarr" ? "Sonarr" : "Radarr", instanceName: arr[1] === "sonarr" ? "Sonarr" : "Radarr", version: arr[1] === "sonarr" ? "4.0.14.2939" : "5.21.1.9799" });
			if (arr[2] === "parse") return json({ title: url.searchParams.get("title") });
			return json([]);
		}

		if (p === "/notify" || p.startsWith("/notify/")) {
			await body(req);
			return json({ ok: true });
		}

		// ---------------- Torznab
		const tz = /^\/(\d+)\/(api|download\/([\w-]+)\.torrent)$/.exec(p);
		const tracker = TRACKERS.find((t) => t.id === Number(tz?.[1]));
		if (tz && tracker) {
			if (tz[3]) {
				const [key, kind] = tz[3].split("-");
				const l = LISTINGS.find((x) => x.tracker.id === tracker.id && x.release.key === key && x.kind === kind);
				return l ? res.writeHead(200, { "content-type": "application/x-bittorrent" }).end(torrentFor(l)) : text("Not Found", 404);
			}
			if (url.searchParams.get("apikey") !== PROWLARR_KEY) return res.writeHead(401, { "content-type": "application/xml" }).end('<error code="100" description="Invalid API Key"/>');
			const t = url.searchParams.get("t");
			if (t === "caps") {
				return res.writeHead(200, { "content-type": "application/xml" }).end(
					`<?xml version="1.0" encoding="UTF-8"?><caps><server title="${tracker.name}"/><limits default="100" max="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep,imdbid,tvdbid"/><movie-search available="yes" supportedParams="q,imdbid,tmdbid"/><music-search available="no"/><audio-search available="no"/><book-search available="no"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/><category id="5070" name="TV/Anime"/></categories></caps>`,
				);
			}
			if (flaky(tracker.id)) {
				return res.writeHead(429, { "retry-after": "1800", "content-type": "text/plain" }).end("Too Many Requests");
			}
			const query = norm(url.searchParams.get("q") ?? "");
			let items: Listing[];
			if (!query) {
				items = freshUploads(tracker);
			} else {
				const words = query.split(" ").filter((w) => w.length > 1 && !/^(1080p|2160p|s\d\d)$/.test(w)).slice(0, 3);
				items = LISTINGS.filter((l) => l.tracker.id === tracker.id && words.every((w) => norm(l.name).includes(w)));
			}
			return res
				.writeHead(200, { "content-type": "application/rss+xml" })
				.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>${tracker.name}</title>${items.map((l) => rssItem(l)).join("")}</channel></rss>`);
		}
		return text("Not Found", 404);
	} catch (e) {
		console.error(e);
		return text(String(e), 500);
	}
}).listen(port, "127.0.0.1", () => console.log(`[demo] mock services on http://127.0.0.1:${port}`));

export type { Release };
