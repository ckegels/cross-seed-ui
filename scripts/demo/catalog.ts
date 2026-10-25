/**
 * Deterministic demo data: two libraries (LXC A: movies + TV, LXC B: 4K + anime)
 * and what each fictional tracker "has". Used by the mock services and the
 * history seeder so live data and seeded history agree.
 */
import { createHash } from "node:crypto";

export const TRACKERS = [
	{ id: 1, name: "Polaris", host: "polaris.example" },
	{ id: 2, name: "Nimbus", host: "nimbus.example" },
	{ id: 3, name: "Aurora", host: "aurora.example" },
	{ id: 4, name: "Kestrel", host: "kestrel.example" },
	{ id: 5, name: "Harbor", host: "harbor.example" },
	{ id: 6, name: "Lumen", host: "lumen.example" },
] as const;
export type Tracker = (typeof TRACKERS)[number];

export const prowlarrName = (t: Tracker) => `${t.name} (Prowlarr)`;

export interface FileEntry {
	path: string; // relative to save_path, e.g. "Name/Name.mkv"
	size: number;
}

export interface Release {
	key: string; // stable id
	instance: "a" | "b";
	name: string;
	category: string;
	files: FileEntry[];
	size: number;
	hash: string;
	origin: Tracker;
	addedOn: number; // epoch seconds
}

/** Small seeded PRNG so every run builds the same demo. */
export function rng(seed: string) {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const MOVIES: [string, number][] = [
	["Arrival", 2016], ["Blade Runner 2049", 2017], ["Dune Part Two", 2024], ["Oppenheimer", 2023], ["The Matrix", 1999],
	["Heat", 1995], ["Interstellar", 2014], ["Sicario", 2015], ["Mad Max Fury Road", 2015], ["Prisoners", 2013],
	["The Prestige", 2006], ["Inception", 2010], ["Parasite", 2019], ["Whiplash", 2014], ["Drive", 2011],
	["No Country for Old Men", 2007], ["Zodiac", 2007], ["Gravity", 2013], ["Ex Machina", 2014], ["Her", 2013],
	["Moon", 2009], ["Sound of Metal", 2019], ["The Northman", 2022], ["Everything Everywhere All at Once", 2022],
	["Past Lives", 2023], ["Poor Things", 2023], ["Anatomy of a Fall", 2023], ["The Holdovers", 2023], ["Civil War", 2024],
	["Furiosa", 2024], ["The Batman", 2022], ["Top Gun Maverick", 2022], ["Knives Out", 2019], ["1917", 2019],
	["Ford v Ferrari", 2019], ["Edge of Tomorrow", 2014], ["Nightcrawler", 2014], ["Gone Girl", 2014], ["The Social Network", 2010],
	["Children of Men", 2006], ["Collateral", 2004], ["Hereditary", 2018], ["Midsommar", 2019], ["The Lighthouse", 2019],
	["Dunkirk", 2017], ["Tenet", 2020], ["The Revenant", 2015], ["The Martian", 2015], ["Nope", 2022],
];
const SHOWS: [string, number][] = [
	["Severance", 2], ["The Bear", 3], ["Andor", 2], ["Shogun", 1], ["Slow Horses", 4], ["The Expanse", 6],
	["Dark", 3], ["Mr Robot", 4], ["Fargo", 5], ["True Detective", 4], ["Silo", 2], ["Foundation", 2],
];
const ANIME: [string, number][] = [
	["Frieren Beyond Journeys End", 1], ["Vinland Saga", 2], ["Mob Psycho 100", 3], ["Cowboy Bebop", 1],
	["Spy x Family", 2], ["Jujutsu Kaisen", 2], ["Attack on Titan", 4], ["Chainsaw Man", 1],
];
const GROUPS = ["FLUX", "NTb", "SPARKS", "ZQ", "playWEB", "EDITH", "CtrlHD", "HiFi", "DON", "TEPES", "BYNDR", "SiC"];
const ANIME_GROUPS = ["SubsPlease", "Erai-raws", "EMBER", "Judas", "MTBB"];

const GiB = 1024 ** 3;
const dots = (s: string) => s.replace(/[^A-Za-z0-9]+/g, ".").replace(/\.+$/, "");

function build(): Release[] {
	const out: Release[] = [];
	const now = Math.floor(Date.now() / 1000);
	const push = (instance: "a" | "b", name: string, category: string, files: FileEntry[], seedKey: string) => {
		const r = rng(seedKey);
		out.push({
			key: sha1(`${instance}:${name}`).slice(0, 12),
			instance,
			name,
			category,
			files,
			size: files.reduce((a, f) => a + f.size, 0),
			hash: sha1(`demo:${instance}:${name}`),
			origin: TRACKERS[Math.floor(r() * TRACKERS.length)],
			addedOn: now - Math.floor(r() * 400 * 86400),
		});
	};
	// LXC A: 1080p movies + TV season packs
	MOVIES.forEach(([title, year], i) => {
		const r = rng(`a-movie-${title}`);
		const src = r() < 0.7 ? "BluRay" : "WEB-DL";
		const codec = src === "BluRay" ? "x264" : "H.264";
		const audio = r() < 0.5 ? "DTS-HD.MA.5.1" : "DDP5.1";
		const name = `${dots(title)}.${year}.1080p.${src}.${audio}.${codec}-${GROUPS[i % GROUPS.length]}`;
		const size = Math.floor((6 + r() * 18) * GiB);
		push("a", name, "movies", [
			{ path: `${name}/${name}.mkv`, size },
			{ path: `${name}/${name}.nfo`, size: 2000 + Math.floor(r() * 8000) },
		], `a-${name}`);
	});
	SHOWS.forEach(([title, seasons], i) => {
		for (let s = 1; s <= seasons; s++) {
			const r = rng(`a-show-${title}-${s}`);
			const name = `${dots(title)}.S${String(s).padStart(2, "0")}.1080p.WEB-DL.DDP5.1.H.264-${GROUPS[(i + s) % GROUPS.length]}`;
			const eps = 6 + Math.floor(r() * 5);
			const files: FileEntry[] = [];
			for (let e = 1; e <= eps; e++) {
				const ep = `${dots(title)}.S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}.1080p.WEB-DL.DDP5.1.H.264-${GROUPS[(i + s) % GROUPS.length]}`;
				files.push({ path: `${name}/${ep}.mkv`, size: Math.floor((1.2 + r() * 2.5) * GiB) });
			}
			push("a", name, "tv", files, `a-${name}`);
		}
	});
	// LXC B: 2160p movies + anime
	MOVIES.slice(0, 30).forEach(([title, year], i) => {
		const r = rng(`b-movie-${title}`);
		const name = `${dots(title)}.${year}.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.Atmos.7.1-${GROUPS[(i + 5) % GROUPS.length]}`;
		push("b", name, "movies-uhd", [{ path: `${name}/${name}.mkv`, size: Math.floor((40 + r() * 45) * GiB) }], `b-${name}`);
	});
	ANIME.forEach(([title, seasons], i) => {
		for (let s = 1; s <= seasons; s++) {
			const r = rng(`b-anime-${title}-${s}`);
			const g = ANIME_GROUPS[(i + s) % ANIME_GROUPS.length];
			const name = `[${g}] ${title} S${String(s).padStart(2, "0")} (1080p) [Batch]`;
			const eps = 10 + Math.floor(r() * 3);
			const files: FileEntry[] = [];
			for (let e = 1; e <= eps; e++) {
				files.push({ path: `${name}/[${g}] ${title} - S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")} (1080p).mkv`, size: Math.floor((0.9 + r() * 0.8) * GiB) });
			}
			push("b", name, "anime", files, `b-${name}`);
		}
	});
	return out;
}

export const LIBRARY: Release[] = build();

export interface Listing {
	release: Release;
	tracker: Tracker;
	/** exact copy (MATCH) or a differently sized/encoded one (rejected) */
	kind: "exact" | "size" | "group";
	guid: string;
	size: number;
	name: string;
	/** pseudo upload time, seconds */
	pubDate: number;
}

/** Which tracker carries which release. ~40% exact copies, some near-misses. */
function buildListings(): Listing[] {
	const out: Listing[] = [];
	for (const rel of LIBRARY) {
		for (const t of TRACKERS) {
			if (t.id === rel.origin.id) continue;
			const r = rng(`${rel.key}:${t.id}`);
			const roll = r();
			let kind: Listing["kind"] | null = null;
			if (roll < 0.38) kind = "exact";
			else if (roll < 0.5) kind = "size";
			else if (roll < 0.58) kind = "group";
			if (!kind) continue;
			const name = kind === "group" ? rel.name.replace(/-[^-\]]+$/, "-KiNGS").replace(/^\[[^\]]+\]/, "[Other]") : rel.name;
			out.push({
				release: rel,
				tracker: t,
				kind,
				guid: `https://${t.host}/torrents/${parseInt(sha1(rel.key + t.id).slice(0, 7), 16)}`,
				size: kind === "size" ? Math.floor(rel.size * 1.18) : rel.size,
				name,
				pubDate: rel.addedOn + Math.floor(r() * 30 * 86400),
			});
		}
	}
	return out;
}

export const LISTINGS: Listing[] = buildListings();
