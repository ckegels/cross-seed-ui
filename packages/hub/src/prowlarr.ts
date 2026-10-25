/**
 * Prowlarr integration: list indexers and build cross-seed Torznab URLs.
 * Torznab URL format: <base>/<indexerId>/api?apikey=<key>
 */
import { HttpError } from "@csui/shared/src/node/http.ts";

export interface ProwlarrSettings {
	url: string;
	apiKey: string;
	/** base URL cross-seed should use, if it differs from how the hub reaches Prowlarr */
	torznabBaseUrl?: string;
}

export interface ProwlarrIndexer {
	id: number;
	name: string;
	protocol: string;
	privacy: string;
	enable: boolean;
	tags: number[];
	implementation: string;
	torznabUrl: string;
}

export interface ProwlarrTag {
	id: number;
	label: string;
}

async function call<T>(s: ProwlarrSettings, path: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${s.url.replace(/\/+$/, "")}${path}`, {
			headers: { "X-Api-Key": s.apiKey, accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (e) {
		const err = e as Error & { cause?: { code?: string } };
		throw new HttpError(502, `Prowlarr is not reachable: ${err.cause?.code ?? err.message}`, "prowlarr_unreachable");
	}
	if (res.status === 401) throw new HttpError(502, "Prowlarr rejected the API key (401)", "prowlarr_auth");
	if (!res.ok) throw new HttpError(502, `Prowlarr returned HTTP ${res.status}`, "prowlarr_error");
	return (await res.json()) as T;
}

export function torznabUrl(s: ProwlarrSettings, id: number): string {
	const base = (s.torznabBaseUrl || s.url).replace(/\/+$/, "");
	return `${base}/${id}/api?apikey=${s.apiKey}`;
}

/** Does this torznab URL point at this Prowlarr? Returns the indexer id. */
export function prowlarrIdOf(s: ProwlarrSettings, url: string): number | null {
	for (const base of [s.torznabBaseUrl, s.url].filter(Boolean) as string[]) {
		const b = base.replace(/\/+$/, "");
		const m = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d+)/api\\b`).exec(url);
		if (m) return Number(m[1]);
	}
	return null;
}

export async function prowlarrStatus(s: ProwlarrSettings) {
	return call<{ appName: string; version: string; instanceName?: string }>(s, "/api/v1/system/status");
}

export async function listProwlarrIndexers(s: ProwlarrSettings): Promise<{ indexers: ProwlarrIndexer[]; tags: ProwlarrTag[] }> {
	const [raw, tags] = await Promise.all([
		call<{ id: number; name: string; protocol: string; privacy: string; enable: boolean; tags?: number[]; implementation: string }[]>(
			s,
			"/api/v1/indexer",
		),
		call<ProwlarrTag[]>(s, "/api/v1/tag").catch(() => []),
	]);
	return {
		indexers: raw
			.filter((i) => i.protocol === "torrent")
			.map((i) => ({
				id: i.id,
				name: i.name,
				protocol: i.protocol,
				privacy: i.privacy,
				enable: i.enable,
				tags: i.tags ?? [],
				implementation: i.implementation,
				torznabUrl: torznabUrl(s, i.id),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
		tags,
	};
}

export type SyncMode = "selected" | "tag" | "all";

export interface SyncPolicy {
	mode: SyncMode;
	/** indexer ids for "selected" */
	indexerIds: number[];
	/** tag ids for "tag" */
	tagIds: number[];
	/** only private indexers when mode = all/tag */
	privateOnly: boolean;
	/** automatic background sync */
	auto: boolean;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = { mode: "selected", indexerIds: [], tagIds: [], privateOnly: true, auto: false };

export function desiredIds(policy: SyncPolicy, indexers: ProwlarrIndexer[]): number[] {
	const enabled = indexers.filter((i) => i.enable);
	switch (policy.mode) {
		case "all":
			return enabled.filter((i) => !policy.privateOnly || i.privacy !== "public").map((i) => i.id);
		case "tag":
			return enabled
				.filter((i) => i.tags.some((t) => policy.tagIds.includes(t)))
				.filter((i) => !policy.privateOnly || i.privacy !== "public")
				.map((i) => i.id);
		default:
			return policy.indexerIds.filter((id) => indexers.some((i) => i.id === id));
	}
}

/**
 * Compute the new torznab list: keep every non-Prowlarr entry untouched, and
 * replace Prowlarr entries by the desired set (keeping existing order first).
 */
export function mergeTorznab(s: ProwlarrSettings, current: string[], ids: number[]): { next: string[]; added: number[]; removed: number[] } {
	const want = new Set(ids);
	const have = new Map<number, string>();
	const next: string[] = [];
	for (const u of current) {
		const id = prowlarrIdOf(s, u);
		if (id === null) {
			next.push(u);
			continue;
		}
		if (want.has(id) && !have.has(id)) {
			have.set(id, u);
			next.push(torznabUrl(s, id)); // normalise (e.g. new api key)
		}
	}
	const added: number[] = [];
	for (const id of ids) {
		if (!have.has(id)) {
			next.push(torznabUrl(s, id));
			added.push(id);
		}
	}
	const removed = current.map((u) => prowlarrIdOf(s, u)).filter((id): id is number => id !== null && !want.has(id));
	return { next, added, removed: [...new Set(removed)] };
}
