/**
 * Dev-only mock Torznab indexer so a real cross-seed daemon produces real
 * searches, decisions and matches locally.
 *
 *   node --import tsx scripts/mock-torznab.ts <dataDir> [port]
 *
 * Serves /<n>/api?t=caps|search|movie|tvsearch for a few fake trackers. Each
 * search for a release that exists in <dataDir> returns a candidate with the
 * same name/size (=> MATCH) on some trackers, a size mismatch on others.
 * /<n>/download/<file>.torrent returns a generated .torrent for that data.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const dataDir = process.argv[2];
const port = Number(process.argv[3] ?? 9797);
if (!dataDir) {
	console.error("usage: mock-torznab.ts <dataDir> [port]");
	process.exit(1);
}

const TRACKERS = [
	{ id: 1, name: "MockBHD", host: "mockbhd.example", matchEvery: 1 },
	{ id: 2, name: "MockAither", host: "mockaither.example", matchEvery: 2 },
	{ id: 3, name: "MockBLU", host: "mockblu.example", matchEvery: 3 },
];

interface Release {
	name: string;
	files: { path: string[]; length: number }[];
	size: number;
}

function releases(): Release[] {
	const out: Release[] = [];
	for (const entry of readdirSync(dataDir)) {
		const p = join(dataDir, entry);
		const st = statSync(p);
		if (st.isDirectory()) {
			const files = readdirSync(p)
				.filter((f) => statSync(join(p, f)).isFile())
				.map((f) => ({ path: [f], length: statSync(join(p, f)).size }));
			out.push({ name: entry, files, size: files.reduce((a, f) => a + f.length, 0) });
		} else {
			out.push({ name: entry.replace(/\.\w+$/, ""), files: [{ path: [entry], length: st.size }], size: st.size });
		}
	}
	return out;
}

function bencode(v: unknown): Buffer {
	if (typeof v === "number") return Buffer.from(`i${Math.floor(v)}e`);
	if (typeof v === "string") return Buffer.concat([Buffer.from(`${Buffer.byteLength(v)}:`), Buffer.from(v)]);
	if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
	if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(bencode), Buffer.from("e")]);
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return Buffer.concat([Buffer.from("d"), ...keys.flatMap((k) => [bencode(k), bencode(obj[k])]), Buffer.from("e")]);
}

function torrentFor(r: Release, tracker: (typeof TRACKERS)[number]): Buffer {
	const pieceLength = 4 * 1024 * 1024;
	const pieces = Math.max(1, Math.ceil(r.size / pieceLength));
	// fake but well-formed piece hashes (unique per tracker so info hashes differ)
	const hashes = Buffer.concat(Array.from({ length: pieces }, (_, i) => createHash("sha1").update(`${tracker.id}:${r.name}:${i}`).digest()));
	const isSingle = r.files.length === 1 && r.files[0].path[0].startsWith(r.name);
	const info: Record<string, unknown> = isSingle
		? { name: r.files[0].path[0], length: r.files[0].length, "piece length": pieceLength, pieces: hashes, private: 1, source: tracker.name }
		: { name: r.name, files: r.files, "piece length": pieceLength, pieces: hashes, private: 1, source: tracker.name };
	return bencode({ announce: `https://${tracker.host}/announce/PASSKEY123`, info });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function item(r: Release, t: (typeof TRACKERS)[number], idx: number, sizeOverride?: number) {
	const guid = `https://${t.host}/torrents/${idx}`;
	const link = `http://127.0.0.1:${port}/${t.id}/download/${encodeURIComponent(r.name)}.torrent?apikey=mockkey`;
	return `<item><title>${esc(r.name)}</title><guid>${esc(guid)}</guid><link>${esc(link)}</link><size>${sizeOverride ?? r.size}</size><pubDate>${new Date(Date.now() - idx * 3600_000).toUTCString()}</pubDate><torznab:attr name="category" value="2000"/><enclosure url="${esc(link)}" length="${sizeOverride ?? r.size}" type="application/x-bittorrent"/></item>`;
}

createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const m = /^\/(\d+)\/(api|download\/(.+)\.torrent)$/.exec(url.pathname);
	const tracker = TRACKERS.find((t) => t.id === Number(m?.[1]));
	if (!m || !tracker) {
		res.writeHead(404).end();
		return;
	}
	if (m[3]) {
		const name = decodeURIComponent(m[3]);
		const r = releases().find((x) => x.name === name);
		if (!r) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": "application/x-bittorrent" }).end(torrentFor(r, tracker));
		return;
	}
	const t = url.searchParams.get("t");
	if (t === "caps") {
		res.writeHead(200, { "content-type": "application/xml" }).end(
			`<?xml version="1.0" encoding="UTF-8"?><caps><server title="${tracker.name}"/><limits default="100" max="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep,imdbid,tvdbid"/><movie-search available="yes" supportedParams="q,imdbid,tmdbid"/><music-search available="no"/><audio-search available="no"/><book-search available="no"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`,
		);
		return;
	}
	const q = (url.searchParams.get("q") ?? "").toLowerCase();
	const all = releases();
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	const hits = q ? all.filter((r) => norm(r.name).includes(norm(q)) || norm(q).includes(norm(r.name).split(" ").slice(0, 2).join(" "))) : all;
	const items = hits.map((r, i) => {
		const idx = all.indexOf(r);
		// some trackers have the same release with a different size => SIZE_MISMATCH
		const mismatch = idx % tracker.matchEvery !== 0;
		return item(r, tracker, idx * 10 + tracker.id, mismatch ? Math.round(r.size * 1.3) : undefined);
	});
	console.log(`[mock] ${tracker.name} t=${t} q="${q}" -> ${items.length} results`);
	res.writeHead(200, { "content-type": "application/rss+xml" }).end(
		`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>${tracker.name}</title>${items.join("")}</channel></rss>`,
	);
}).listen(port, "127.0.0.1", () => console.log(`[mock] torznab on http://127.0.0.1:${port}/{1,2,3}/api`));

export { basename };
