import { Search, Zap } from "lucide-react";
import { useState } from "react";
import type { LibraryRow, Paged } from "@csui/shared";
import { api, inst, qs } from "../../api.ts";
import { ago, bytes, dateTime, num } from "../../format.ts";
import { useApi, useNow } from "../../hooks.ts";
import { useApp } from "../../state.tsx";
import { Badge, Button, Card, ErrorBox, Input, Modal, Pager, Select, Spinner, Switch, useToast } from "../../ui/index.tsx";

const LIMIT = 50;

export function SearchNowDialog({ id, infoHash, name, onClose }: { id: number; infoHash?: string; name?: string; onClose: () => void }) {
	const toast = useToast();
	const [hash, setHash] = useState(infoHash ?? "");
	const [opts, setOpts] = useState({ ignoreExcludeRecentSearch: true, ignoreExcludeOlder: true, ignoreCrossSeeds: true, includeSingleEpisodes: false, includeNonVideos: false, ignoreBlockList: false });
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const body = hash.startsWith("/") ? { path: hash, ...opts } : { infoHash: hash.trim(), ...opts };
			const r = await api.post<{ ok: boolean; message: string }>(inst(id, "search"), body);
			toast(r.ok ? "good" : "warning", r.message);
			onClose();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const toggle = (k: keyof typeof opts, label: string, hint: string) => (
		<label className="flex items-center justify-between gap-3 text-sm">
			<span>
				{label}
				<span className="block text-xs text-ink-3">{hint}</span>
			</span>
			<Switch checked={opts[k]} onChange={(v) => setOpts({ ...opts, [k]: v })} />
		</label>
	);
	return (
		<Modal
			open
			onClose={onClose}
			title="Search for cross-seeds now"
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" loading={busy} onClick={run} icon={<Zap size={14} />} disabled={!hash.trim()}>
						Search
					</Button>
				</>
			}
		>
			<div className="space-y-3">
				{name ? <p className="text-sm break-words">{name}</p> : null}
				<Input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Info hash, or an absolute data path" className="font-mono text-xs" />
				{toggle("ignoreExcludeRecentSearch", "Ignore excludeRecentSearch", "Search even if it was searched recently")}
				{toggle("ignoreExcludeOlder", "Ignore excludeOlder", "Search even if it is old")}
				{toggle("ignoreCrossSeeds", "Skip if it is itself a cross-seed", "Default behaviour of the webhook")}
				{toggle("includeSingleEpisodes", "Include single episodes", "Override includeSingleEpisodes for this search")}
				{toggle("includeNonVideos", "Include non-videos", "Override includeNonVideos for this search")}
				{toggle("ignoreBlockList", "Ignore the blocklist", "Use with care")}
			</div>
		</Modal>
	);
}

export function LibraryTab({ id }: { id: number }) {
	const { isAdmin } = useApp();
	const [search, setSearch] = useState("");
	const [input, setInput] = useState("");
	const [client, setClient] = useState("");
	const [sort, setSort] = useState("name");
	const [offset, setOffset] = useState(0);
	const [searchFor, setSearchFor] = useState<LibraryRow | null>(null);
	const now = useNow();
	const { data, error, reload } = useApi<Paged<LibraryRow> & { clients: string[] }>(inst(id, `library${qs({ search, client, sort, limit: LIMIT, offset })}`));
	return (
		<Card title="Library" subtitle="Torrents cross-seed knows from your clients (refreshed by cross-seed itself)" padded={false}>
			<div className="flex flex-wrap gap-2 p-4 pt-2">
				<form
					className="relative flex-1 min-w-52"
					onSubmit={(e) => {
						e.preventDefault();
						setSearch(input.trim());
						setOffset(0);
					}}
				>
					<Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
					<Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search name or info hash (Enter)" className="pl-8" />
				</form>
				{(data?.clients.length ?? 0) > 1 && (
					<Select value={client} onChange={(e) => (setClient(e.target.value), setOffset(0))} className="w-48">
						<option value="">All clients</option>
						{data!.clients.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</Select>
				)}
				<Select value={sort} onChange={(e) => (setSort(e.target.value), setOffset(0))} className="w-44">
					<option value="name">Sort: name</option>
					<option value="size">Sort: size</option>
					<option value="lastSearched">Sort: last searched</option>
					<option value="matches">Sort: matches</option>
				</Select>
			</div>
			{error && <div className="px-4"><ErrorBox error={error} retry={reload} /></div>}
			{!data ? (
				<Spinner />
			) : (
				<>
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-y border-line text-left text-xs text-ink-3">
									<th className="px-4 py-2 font-medium">Torrent</th>
									<th className="px-3 py-2 font-medium">Category / tags</th>
									<th className="px-3 py-2 font-medium text-right">Size</th>
									<th className="px-3 py-2 font-medium text-right">Matches</th>
									<th className="px-3 py-2 font-medium text-right">Last searched</th>
									{isAdmin && <th className="px-4 py-2" />}
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{data.rows.map((r) => (
									<tr key={`${r.clientHost}-${r.infoHash}`}>
										<td className="px-4 py-2 max-w-[30rem]">
											<div className="truncate" title={r.name}>
												{r.name}
											</div>
											<div className="truncate text-[11px] text-ink-3" title={r.savePath}>
												{r.trackers.join(", ") || "no trackers"} · {r.clientHost}
											</div>
										</td>
										<td className="px-3 py-2">
											<div className="flex flex-wrap gap-1">
												{r.category && <Badge>{r.category}</Badge>}
												{r.tags.slice(0, 3).map((t) => (
													<Badge key={t} tone="accent">
														{t}
													</Badge>
												))}
											</div>
										</td>
										<td className="px-3 py-2 text-right whitespace-nowrap tabular">{bytes(r.length)}</td>
										<td className="px-3 py-2 text-right tabular">{num(r.matches)}</td>
										<td className="px-3 py-2 text-right whitespace-nowrap text-xs text-ink-3" title={dateTime(r.lastSearched)}>
											{ago(r.lastSearched, now)}
										</td>
										{isAdmin && (
											<td className="px-4 py-2 text-right">
												<Button size="sm" variant="ghost" icon={<Zap size={12} />} onClick={() => setSearchFor(r)}>
													Search
												</Button>
											</td>
										)}
									</tr>
								))}
							</tbody>
						</table>
						{!data.rows.length && (
							<div className="p-6 text-center text-sm text-ink-3">
								{search ? "Nothing matches your search." : "No client torrents in cross-seed's database yet (useClientTorrents must be on)."}
							</div>
						)}
					</div>
					<div className="flex justify-end p-3">
						<Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} />
					</div>
				</>
			)}
			{searchFor && <SearchNowDialog id={id} infoHash={searchFor.infoHash} name={searchFor.name} onClose={() => setSearchFor(null)} />}
		</Card>
	);
}
