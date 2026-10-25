import { CheckCircle2, CircleAlert, Clock, FlaskConical, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import type { IndexerInfo, TestResult } from "@csui/shared";
import { api, inst } from "../../api.ts";
import { ago, num, until } from "../../format.ts";
import { useApi, useNow } from "../../hooks.ts";
import { Link } from "../../router.tsx";
import { Badge, Button, Card, ErrorBox, Modal, Notice, Segmented, Spinner, Switch, useConfirm, useToast } from "../../ui/index.tsx";
import { RestartingModal } from "../../ui/RestartProgress.tsx";
import { RestartResultView, useDraft } from "./configDraft.tsx";
import { ListEditor, OptionRow } from "./fields.tsx";
import { maskSecret, OPTION_BY_KEY, sameIndexerUrl, type SaveConfigResponse, unmaskSecret } from "@csui/shared";

export function TestButton({ kind, value, size = "sm" }: { kind: string; value: string; size?: "sm" | "md" }) {
	const { instanceId } = useDraft();
	const [res, setRes] = useState<TestResult | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		setRes(null);
		try {
			setRes(await api.post<TestResult>(inst(instanceId, "test"), { kind, value }));
		} catch (e) {
			setRes({ ok: false, message: (e as Error).message, latencyMs: null });
		} finally {
			setBusy(false);
		}
	};
	return (
		<span className="inline-flex items-center gap-2 min-w-0">
			<Button size={size} loading={busy} icon={<FlaskConical size={12} />} onClick={run} disabled={!value}>
				Test
			</Button>
			{res && (
				<span className={res.ok ? "text-xs text-good-text truncate" : "text-xs text-critical truncate"} title={res.message}>
					{res.ok ? <CheckCircle2 size={12} className="inline mr-1" /> : <CircleAlert size={12} className="inline mr-1" />}
					{res.message}
					{res.latencyMs !== null && res.ok ? ` · ${res.latencyMs} ms` : ""}
				</span>
			)}
		</span>
	);
}

function statusBadge(i: IndexerInfo, now: number) {
	if (i.status === "PENDING_RESTART") return <Badge tone="accent">added, restart pending</Badge>;
	if (!i.inConfig) return <Badge>not in config</Badge>;
	if (i.status === "RATE_LIMITED" && (i.retryAfter ?? 0) > now) return <Badge tone="warning"><Clock size={11} /> rate limited, retry {until(i.retryAfter, now)}</Badge>;
	if (i.status === "UNKNOWN_ERROR" && (i.retryAfter ?? 0) > now) return <Badge tone="critical"><CircleAlert size={11} /> failing, retry {until(i.retryAfter, now)}</Badge>;
	if (i.caps.search === false) return <Badge tone="warning">no search support</Badge>;
	if (i.caps.search === null) return <Badge>caps unknown</Badge>;
	return <Badge tone="good">OK</Badge>;
}

function Caps({ i }: { i: IndexerInfo }) {
	const list: [string, boolean | null][] = [
		["TV", i.caps.tv],
		["Movie", i.caps.movie],
		["Music", i.caps.music],
		["Book", i.caps.book],
	];
	const ids = [...Object.entries(i.movieIdCaps ?? {}), ...Object.entries(i.tvIdCaps ?? {})].filter(([, v]) => v).map(([k]) => k.replace("Id", "").toUpperCase());
	return (
		<div className="flex flex-wrap gap-1">
			{list.filter(([, v]) => v).map(([l]) => (
				<Badge key={l}>{l}</Badge>
			))}
			{[...new Set(ids)].slice(0, 4).map((x) => (
				<Badge key={x} tone="accent" title="ID search supported">
					{x}
				</Badge>
			))}
		</div>
	);
}

function HealthTable() {
	const { instanceId, draft, set, canEdit } = useDraft();
	const { data, error, reload, loading } = useApi<IndexerInfo[]>(inst(instanceId, "indexers"), { interval: 60_000 });
	const now = useNow();
	const toast = useToast();
	const [clearing, setClearing] = useState(false);
	const [showRemoved, setShowRemoved] = useState(false);
	const torznab = (draft.torznab as string[]) ?? [];
	const removeUrl = (dbUrl: string) => set("torznab", torznab.filter((u) => !sameIndexerUrl(u, dbUrl)));
	// cross-seed's indexer table stores the URL without the apikey: test the config entry instead
	const configUrlFor = (dbUrl: string) => torznab.find((u) => sameIndexerUrl(u, dbUrl));
	// cross-seed only learns a name from its first search results; Prowlarr already knows it
	const prowlarr = useApi<{ configured: boolean; url?: string; torznabBaseUrl?: string | null }>("/api/prowlarr");
	const prowlarrList = useApi<{ indexers: { id: number; name: string }[] }>(prowlarr.data?.configured ? "/api/prowlarr/indexers" : null);
	const prowlarrNameFor = (url: string): string | null => {
		const bases = [prowlarr.data?.url, prowlarr.data?.torznabBaseUrl].filter(Boolean) as string[];
		for (const b of bases) {
			const m = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/+$/, "")}/(\\d+)/api`).exec(url);
			if (m) return prowlarrList.data?.indexers.find((x) => x.id === Number(m[1]))?.name ?? null;
		}
		return null;
	};
	const clearFailures = async () => {
		setClearing(true);
		try {
			const r = await api.post<{ ok: boolean; message: string }>(inst(instanceId, "maintenance/clear-indexer-failures"), {});
			toast(r.ok ? "good" : "critical", r.message);
			void reload();
		} finally {
			setClearing(false);
		}
	};
	return (
		<Card
			title="Indexer health"
			subtitle="From cross-seed's database: status, capabilities and how much each one is used"
			actions={
				<>
					{canEdit && (
						<Button size="sm" loading={clearing} onClick={clearFailures} title="Clear rate limits and failures so every indexer is retried now">
							Clear failures
						</Button>
					)}
					<Button size="sm" variant="ghost" loading={loading} icon={<RefreshCw size={12} />} onClick={reload}>
						Refresh
					</Button>
				</>
			}
			padded={false}
		>
			{error && <div className="p-4"><ErrorBox error={error} /></div>}
			{!data ? (
				<Spinner />
			) : !data.length ? (
				<div className="p-4 text-sm text-ink-3">No indexers yet. Add some with Prowlarr below or as Torznab URLs.</div>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs text-ink-3 border-b border-line">
								<th className="px-4 py-2 font-medium">Indexer</th>
								<th className="px-3 py-2 font-medium">Status</th>
								<th className="px-3 py-2 font-medium">Supports</th>
								<th className="px-3 py-2 font-medium text-right">Searched</th>
								<th className="px-3 py-2 font-medium text-right">Added</th>
								<th className="px-4 py-2" />
							</tr>
						</thead>
						<tbody className="divide-y divide-line">
							{data.filter((i) => i.inConfig || showRemoved).map((i) => (
								<tr key={`${i.id}-${i.url}`} className={i.inConfig ? "" : "opacity-60"}>
									<td className="px-4 py-2.5 min-w-56">
										<div className="font-medium">
											{i.name ??
												(prowlarrNameFor(i.url) ? (
													<span title="Name from Prowlarr. cross-seed shows its own name for this indexer after the first search with results.">{prowlarrNameFor(i.url)}</span>
												) : (
													<span className="text-ink-3" title="cross-seed learns the name from the first search results">Name not known yet</span>
												))}
										</div>
										<div className="text-[11px] text-ink-3 font-mono truncate max-w-80" title={i.url}>
											{i.url}
										</div>
									</td>
									<td className="px-3 py-2.5">{statusBadge(i, now)}</td>
									<td className="px-3 py-2.5">
										<Caps i={i} />
									</td>
									<td className="px-3 py-2.5 text-right tabular">
										{num(i.searchees)}
										<div className="text-[11px] text-ink-3">{i.lastSearched ? ago(i.lastSearched, now) : "never"}</div>
									</td>
									<td className="px-3 py-2.5 text-right tabular">
										{num(i.injected)}
										<div className="text-[11px] text-ink-3">{num(i.matches)} matches</div>
									</td>
									<td className="px-4 py-2.5">
										<div className="flex justify-end gap-1.5">
											{i.inConfig && configUrlFor(i.url) && <TestButton kind="torznab" value={configUrlFor(i.url)!} />}
											{canEdit && i.inConfig && torznab.some((u) => sameIndexerUrl(u, i.url)) && (
												<Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => removeUrl(i.url)} title="Remove from config (save to apply)">
													Remove
												</Button>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{data.some((i) => !i.inConfig) && (
						<div className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
							<button type="button" className="text-accent hover:underline" onClick={() => setShowRemoved(!showRemoved)}>
								{showRemoved ? "Hide" : "Show"} {data.filter((i) => !i.inConfig).length} removed indexer{data.filter((i) => !i.inConfig).length === 1 ? "" : "s"}
							</button>
							{" "}· no longer in config.js; cross-seed keeps their history in its database.
						</div>
					)}
				</div>
			)}
		</Card>
	);
}

interface ProwlarrIndexerRow {
	id: number;
	name: string;
	privacy: string;
	enable: boolean;
	tags: number[];
	usedBy: number[];
}
interface Policy {
	mode: "selected" | "tag" | "all";
	indexerIds: number[];
	tagIds: number[];
	privateOnly: boolean;
	auto: boolean;
	saved?: boolean;
}

function ProwlarrPanel() {
	const { instanceId, dirtyKeys, reload: reloadConfig, canEdit } = useDraft();
	const toast = useToast();
	const status = useApi<{ configured: boolean; url?: string }>("/api/prowlarr");
	const list = useApi<{ indexers: ProwlarrIndexerRow[]; tags: { id: number; label: string }[] }>(status.data?.configured ? "/api/prowlarr/indexers" : null);
	const policyApi = useApi<Policy>(`/api/instances/${instanceId}/prowlarr`);
	const [policy, setPolicy] = useState<Policy | null>(null);
	const [preview, setPreview] = useState<{ changed: boolean; added: string[]; removed: string[] } | null>(null);
	const [applyResult, setApplyResult] = useState<SaveConfigResponse["restart"] | null>(null);
	const [applyingSince, setApplyingSince] = useState<number | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const { confirm, dialog } = useConfirm();
	// A policy that was never saved starts from the Prowlarr indexers already in config.js,
	// so ticking one more adds it instead of replacing everything.
	const inConfigIds = (list.data?.indexers ?? []).filter((i) => i.usedBy.includes(instanceId)).map((i) => i.id);
	const p: Policy | null =
		policy ??
		(policyApi.data
			? policyApi.data.saved
				? policyApi.data
				: list.data
					? { ...policyApi.data, mode: "selected", indexerIds: inConfigIds }
					: null
			: null);

	if (!status.data) return <Card title="Prowlarr"><Spinner /></Card>;
	if (!status.data.configured)
		return (
			<Card title="Prowlarr">
				<Notice tone="accent" title="Connect Prowlarr to pick indexers from a list">
					<Link to="/settings/prowlarr" className="text-accent hover:underline">Settings → Prowlarr</Link>. You can still add Torznab URLs by hand below.
				</Notice>
			</Card>
		);

	const savePolicy = async (next: Policy) => {
		setPolicy(next);
		setPreview(null);
		await api.put(`/api/instances/${instanceId}/prowlarr`, next);
	};
	const toggle = (id: number) => {
		if (!p) return;
		const ids = p.indexerIds.includes(id) ? p.indexerIds.filter((x) => x !== id) : [...p.indexerIds, id];
		void savePolicy({ ...p, mode: "selected", indexerIds: ids });
	};
	const dryRun = async () => {
		setBusy("preview");
		try {
			setPreview(await api.post(`/api/instances/${instanceId}/prowlarr/sync`, { dryRun: true }));
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(null);
		}
	};
	const apply = async () => {
		setBusy("apply");
		try {
			// show what would be removed before touching anything
			const plan = await api.post<{ changed: boolean; added: string[]; removed: string[] }>(`/api/instances/${instanceId}/prowlarr/sync`, { dryRun: true });
			if (!plan.changed) {
				toast("accent", "Already in sync, nothing to change");
				return;
			}
			if (plan.removed.length) {
				const ok = await confirm({
					title: `Remove ${plan.removed.length} indexer${plan.removed.length === 1 ? "" : "s"} from this instance?`,
					body: (
						<div className="space-y-2">
							<p>Applying this selection removes: <b>{plan.removed.join(", ")}</b>.</p>
							{plan.added.length > 0 && <p>And adds: {plan.added.join(", ")}.</p>}
							<p>Only continue if you want cross-seed to stop using {plan.removed.length === 1 ? "it" : "them"}.</p>
						</div>
					),
					danger: true,
					confirmLabel: "Remove and restart",
				});
				if (!ok) return;
			}
			setApplyingSince(Date.now());
			const r = await api.post<{ changed: boolean; result: SaveConfigResponse | null }>(`/api/instances/${instanceId}/prowlarr/sync`, { restart: true });
			setPreview(null);
			if (!r.changed) toast("accent", "Already in sync, nothing to change");
			else setApplyResult(r.result?.restart ?? null);
			await reloadConfig();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(null);
			setApplyingSince(null);
		}
	};

	const indexers = list.data?.indexers ?? [];
	const tags = list.data?.tags ?? [];
	return (
		<Card
			title="Prowlarr indexers"
			subtitle={`Synced from ${status.data.url}. Only Prowlarr entries are managed here; other Torznab URLs stay untouched.`}
			actions={
				canEdit && (
					<>
						<Button size="sm" loading={busy === "preview"} onClick={dryRun} disabled={!p}>
							Preview
						</Button>
						<Button size="sm" variant="primary" loading={busy === "apply"} icon={<Wand2 size={12} />} onClick={apply} disabled={!p || dirtyKeys.length > 0} title={dirtyKeys.length ? "Save or discard your other changes first" : undefined}>
							Apply & restart
						</Button>
					</>
				)
			}
		>
			{list.error && <ErrorBox error={list.error} retry={list.reload} />}
			{!p || !list.data ? (
				<Spinner />
			) : (
				<div className="space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<Segmented
							value={p.mode}
							onChange={(mode) => canEdit && void savePolicy({ ...p, mode })}
							options={[
								{ id: "selected", label: "Pick indexers" },
								{ id: "tag", label: "By Prowlarr tag" },
								{ id: "all", label: "All enabled" },
							]}
						/>
						{p.mode !== "selected" && (
							<label className="flex items-center gap-2 text-sm">
								<Switch checked={p.privateOnly} onChange={(v) => canEdit && void savePolicy({ ...p, privateOnly: v })} /> Private trackers only
							</label>
						)}
						<label className="flex items-center gap-2 text-sm" title="Re-sync every 6 hours and restart when the list changed">
							<Switch checked={p.auto} onChange={(v) => canEdit && void savePolicy({ ...p, auto: v })} /> Auto-sync every 6 h
						</label>
					</div>
					{p.mode === "tag" && (
						<div className="flex flex-wrap gap-2">
							{tags.map((t) => (
								<label key={t.id} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-sm">
									<input
										type="checkbox"
										checked={p.tagIds.includes(t.id)}
										disabled={!canEdit}
										onChange={() => void savePolicy({ ...p, tagIds: p.tagIds.includes(t.id) ? p.tagIds.filter((x) => x !== t.id) : [...p.tagIds, t.id] })}
									/>
									{t.label}
								</label>
							))}
							{!tags.length && <p className="text-sm text-ink-3">No tags in Prowlarr yet.</p>}
						</div>
					)}
					<div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
						{indexers.map((i) => {
							const picked =
								p.mode === "selected"
									? p.indexerIds.includes(i.id)
									: p.mode === "tag"
										? i.enable && i.tags.some((t) => p.tagIds.includes(t)) && (!p.privateOnly || i.privacy !== "public")
										: i.enable && (!p.privateOnly || i.privacy !== "public");
							const inUse = i.usedBy.includes(instanceId);
							return (
								<label key={i.id} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${picked ? "border-accent/50 bg-accent-soft" : "border-line"} ${p.mode !== "selected" ? "cursor-default" : "cursor-pointer"}`}>
									<input type="checkbox" checked={picked} disabled={p.mode !== "selected" || !canEdit} onChange={() => toggle(i.id)} />
									<span className="flex-1 min-w-0">
										<span className="block truncate font-medium">{i.name}</span>
										<span className="text-[11px] text-ink-3">
											{i.privacy}
											{!i.enable && " · disabled in Prowlarr"}
											{inUse ? " · in config" : ""}
										</span>
									</span>
								</label>
							);
						})}
					</div>
					{preview && (
						<Notice tone={preview.changed ? "accent" : "good"} title={preview.changed ? "Applying will change the config" : "Already in sync"}>
							{preview.added.length > 0 && <div>Add: {preview.added.join(", ")}</div>}
							{preview.removed.length > 0 && <div>Remove: {preview.removed.join(", ")}</div>}
						</Notice>
					)}
				</div>
			)}
			{dialog}
			<RestartingModal instanceId={instanceId} startedAt={applyingSince} saving />
			<Modal open={!!applyResult} onClose={() => setApplyResult(null)} title="Prowlarr sync applied" footer={<Button variant="primary" onClick={() => setApplyResult(null)}>Done</Button>}>
				<RestartResultView result={applyResult} />
			</Modal>
		</Card>
	);
}

export function IndexersTab() {
	const d = useDraft();
	const meta = OPTION_BY_KEY.torznab;
	return (
		<div className="space-y-5">
			<HealthTable />
			<ProwlarrPanel />
			<Card title="Torznab URLs" subtitle="Exactly what is in config.js. API keys are hidden but kept when you save.">
				<OptionRow meta={meta} dirty={d.dirtyKeys.includes("torznab")}>
					<ListEditor
						values={(d.draft.torznab as string[]) ?? []}
						onChange={(v) => d.set("torznab", v)}
						disabled={!d.canEdit}
						placeholder={meta.placeholder}
						render={(v, i) => (
							<div className="flex items-center gap-2 min-w-0">
								<input
									className="w-full h-9 rounded-lg border border-line bg-surface px-2.5 font-mono text-xs"
									value={maskSecret(v)}
									disabled={!d.canEdit}
									onChange={(e) => d.set("torznab", ((d.draft.torznab as string[]) ?? []).map((x, j) => (j === i ? unmaskSecret(e.target.value) : x)))}
								/>
								<TestButton kind="torznab" value={v} />
							</div>
						)}
					/>
				</OptionRow>
			</Card>
		</div>
	);
}
