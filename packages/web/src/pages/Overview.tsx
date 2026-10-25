import { CheckCircle2, CircleAlert, Clock, Download, HardDrive, Library, Radio, RefreshCw, Search, Server, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Activity, AgentInfo, InstanceStats, JobInfo, MatchEvent, Paged } from "@csui/shared";
import { api, inst } from "../api.ts";
import { BarList, ColumnChart, Meter, StatTile } from "../charts/index.tsx";
import { ago, compact, JOB_LABELS, num, RESULT_LABELS, until, VIA_LABELS } from "../format.ts";
import { useApi, useNow } from "../hooks.ts";
import { PageHeader, STATE_LABEL, stateTone } from "../Layout.tsx";
import { Link } from "../router.tsx";
import { type Instance, instanceColor, useApp } from "../state.tsx";
import { Badge, Button, Card, Empty, ErrorBox, Notice, Segmented, Spinner, StatusDot, useToast } from "../ui/index.tsx";

export interface OverviewEntry {
	instance: Instance;
	online: boolean;
	error: string | null;
	info: AgentInfo | null;
	activity: Activity | null;
	stats: InstanceStats | null;
	jobs: JobInfo[] | null;
}

export function ActivityLine({ activity, now }: { activity: Activity | null; now: number }) {
	if (!activity) return <span className="text-ink-3">No activity data</span>;
	const p = activity.progress;
	if (p) {
		return (
			<div className="space-y-1.5 min-w-0">
				<div className="flex items-center justify-between gap-2 text-xs">
					<span className="text-ink-2 truncate">
						{VIA_LABELS[p.via] ?? p.via}: <span className="text-ink">{p.name}</span>
					</span>
					<span className="tabular text-ink-3 shrink-0">
						{num(p.index)} / {num(p.total)}
						{p.etaMs ? ` · ~${until(now + p.etaMs, now).replace("in ", "")} left` : ""}
					</span>
				</div>
				<Meter value={p.index} max={p.total} />
			</div>
		);
	}
	if (activity.lastEvent) {
		return (
			<div className="text-xs text-ink-3 truncate" title={activity.lastEvent.text}>
				{ago(activity.lastEvent.ts, now)} · {activity.lastEvent.text}
			</div>
		);
	}
	return <span className="text-xs text-ink-3">Waiting for log output…</span>;
}

function InstanceCard({ e, now, onAction }: { e: OverviewEntry; now: number; onAction: () => void }) {
	const { isAdmin } = useApp();
	const toast = useToast();
	const [busy, setBusy] = useState<string | null>(null);
	const state = !e.online ? "offline" : (e.activity?.state ?? "idle");
	const svc = e.info?.service;
	const run = async (job: string) => {
		setBusy(job);
		try {
			const r = await api.post<{ ok: boolean; message: string }>(inst(e.instance.id, `jobs/${job}`), {});
			toast(r.ok ? "good" : "warning", r.message);
			onAction();
		} catch (err) {
			toast("critical", (err as Error).message);
		} finally {
			setBusy(null);
		}
	};
	const nextJobs = (e.jobs ?? []).filter((j) => j.enabled && (j.name === "rss" || j.name === "search"));
	return (
		<div className="card p-4 space-y-3 min-w-0">
			<div className="flex items-start justify-between gap-2">
				<Link to={`/i/${e.instance.id}`} className="flex items-center gap-2 min-w-0 group">
					<span className="inline-block size-3 rounded-[4px] shrink-0" style={{ background: instanceColor(e.instance.id) }} />
					<span className="font-semibold truncate group-hover:underline">{e.instance.name}</span>
				</Link>
				<Badge tone={stateTone(state)}>
					<StatusDot tone={stateTone(state)} pulse={state !== "idle" && state !== "offline" && state !== "stopped"} />
					{STATE_LABEL[state] ?? state}
				</Badge>
			</div>
			{!e.online ? (
				<ErrorBox error={e.error} />
			) : (
				<>
					<ActivityLine activity={e.activity} now={now} />
					<div className="grid grid-cols-3 gap-2 text-center">
						<div className="rounded-lg bg-surface-2 py-2">
							<div className="text-lg font-semibold tabular">{compact(e.stats?.results.injected24h ?? 0)}</div>
							<div className="text-[11px] text-ink-3">injected 24h</div>
						</div>
						<div className="rounded-lg bg-surface-2 py-2">
							<div className="text-lg font-semibold tabular">{compact(e.stats?.library.clientTorrents || e.stats?.library.searchees || 0)}</div>
							<div className="text-[11px] text-ink-3">torrents</div>
						</div>
						<div className="rounded-lg bg-surface-2 py-2">
							<div className="text-lg font-semibold tabular">
								{e.stats ? `${e.stats.indexers.ok}/${e.stats.indexers.inConfig}` : "–"}
							</div>
							<div className="text-[11px] text-ink-3">indexers OK</div>
						</div>
					</div>
					<div className="space-y-1 text-xs">
						{nextJobs.map((j) => (
							<div key={j.name} className="flex items-center justify-between gap-2">
								<span className="text-ink-2 flex items-center gap-1.5">
									<Clock size={12} className="text-ink-3" />
									{JOB_LABELS[j.name]}
								</span>
								<span className="text-ink-3 tabular">
									{j.running ? <span className="text-accent">running since {ago(j.runningSince, now).replace(" ago", "")}</span> : `last ${ago(j.lastRun, now)} · next ${until(j.nextRun, now)}`}
								</span>
							</div>
						))}
						{e.activity?.lastMatch && (
							<div className="flex items-center justify-between gap-2" title={e.activity.lastMatch.name}>
								<span className="text-ink-2 flex items-center gap-1.5 min-w-0">
									<Sparkles size={12} className="text-ink-3 shrink-0" />
									<span className="truncate">{e.activity.lastMatch.name}</span>
								</span>
								<span className="text-ink-3 shrink-0">{ago(e.activity.lastMatch.ts, now)}</span>
							</div>
						)}
						{e.activity?.lastError && now - e.activity.lastError.ts < 6 * 3600_000 && (
							<div className="flex items-center gap-1.5 text-critical min-w-0" title={e.activity.lastError.text}>
								<CircleAlert size={12} className="shrink-0" />
								<span className="truncate">{e.activity.lastError.text}</span>
							</div>
						)}
					</div>
					<div className="flex items-center justify-between gap-2 pt-1 border-t border-line">
						<span className="text-[11px] text-ink-3 truncate">
							cross-seed {e.info?.crossSeed.version ?? "?"} · {svc?.state === "active" ? `up ${ago(svc.since, now).replace(" ago", "")}` : (svc?.state ?? "")}
						</span>
						{isAdmin && (
							<div className="flex gap-1.5">
								<Button size="sm" variant="ghost" loading={busy === "rss"} icon={<Radio size={13} />} onClick={() => run("rss")}>
									RSS
								</Button>
								<Button size="sm" variant="ghost" loading={busy === "search"} icon={<Search size={13} />} onClick={() => run("search")}>
									Search
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function RecentMatches({ instances, refreshKey }: { instances: Instance[]; refreshKey: number }) {
	const [rows, setRows] = useState<(MatchEvent & { instanceId: number })[] | null>(null);
	const now = useNow();
	useEffect(() => {
		let alive = true;
		Promise.all(
			instances.map((i) =>
				api
					.get<Paged<MatchEvent>>(inst(i.id, "matches?limit=15"))
					.then((p) => p.rows.map((r) => ({ ...r, instanceId: i.id })))
					.catch(() => []),
			),
		).then((lists) => alive && setRows(lists.flat().sort((a, b) => b.ts - a.ts).slice(0, 15)));
		return () => {
			alive = false;
		};
	}, [instances, refreshKey]);
	if (!rows) return <Spinner />;
	if (!rows.length) return <Empty title="No matches yet">Injected and saved cross-seeds show up here as soon as cross-seed logs them.</Empty>;
	const byId = new Map(instances.map((i) => [i.id, i]));
	return (
		<ul className="divide-y divide-line -my-1">
			{rows.map((r) => (
				<li key={`${r.instanceId}-${r.id}`} className="flex items-center gap-3 py-2 min-w-0">
					<span className="inline-block size-2.5 rounded-[3px] shrink-0" style={{ background: instanceColor(r.instanceId) }} title={byId.get(r.instanceId)?.name} />
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm" title={r.name}>
							{r.name}
						</div>
						<div className="text-[11px] text-ink-3 truncate">
							{r.tracker} · {VIA_LABELS[r.via] ?? r.via} · {r.decision.replace("MATCH_", "").replace("MATCH", "exact").toLowerCase()}
						</div>
					</div>
					<Badge tone={r.result === "injected" ? "good" : r.result === "failed" ? "critical" : r.result === "exists" ? "neutral" : "accent"}>
						{RESULT_LABELS[r.result] ?? r.result}
					</Badge>
					<span className="text-[11px] text-ink-3 w-16 text-right shrink-0">{ago(r.ts, now)}</span>
				</li>
			))}
		</ul>
	);
}

export function OverviewPage() {
	const { instances, isAdmin } = useApp();
	const [days, setDays] = useState<"7" | "30" | "90">("30");
	const { data, error, reload } = useApi<OverviewEntry[]>(`/api/overview?days=${days}`, { interval: 20_000 });
	const now = useNow(10_000);
	const [refreshKey, setRefreshKey] = useState(0);

	const totals = useMemo(() => {
		const t = { injected: 0, saved: 0, failed: 0, matches: 0, searches: 0, torrents: 0, bytes: 0, idxOk: 0, idxTotal: 0, limited: 0 };
		for (const e of data ?? []) {
			const s = e.stats;
			if (!s) continue;
			for (const d of s.timeline) {
				t.injected += d.injected;
				t.saved += d.saved;
				t.failed += d.failed;
				t.matches += d.matches;
				t.searches += d.searches;
			}
			t.torrents += s.library.clientTorrents || s.library.searchees;
			t.bytes += s.library.totalBytes;
			t.idxOk += s.indexers.ok;
			t.idxTotal += s.indexers.inConfig;
			t.limited += s.indexers.rateLimited + s.indexers.failing;
		}
		return t;
	}, [data]);

	const series = (data ?? []).map((e) => ({ key: String(e.instance.id), label: e.instance.name, color: instanceColor(e.instance.id) }));
	const chartData = (metric: "injected" | "searches" | "matches") => {
		const daysMap = new Map<string, Record<string, number>>();
		for (const e of data ?? []) {
			for (const d of e.stats?.timeline ?? []) {
				const row = daysMap.get(d.day) ?? {};
				row[String(e.instance.id)] = metric === "injected" ? d.injected + d.saved : d[metric];
				daysMap.set(d.day, row);
			}
		}
		return [...daysMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([x, values]) => ({ x, values }));
	};
	const trend = (metric: "injected" | "matches" | "searches") => chartData(metric).map((d) => Object.values(d.values).reduce((a, b) => a + b, 0)).slice(-14);

	const trackers = useMemo(() => {
		const m = new Map<string, { injected: number; saved: number; failed: number }>();
		for (const e of data ?? []) {
			for (const t of e.stats?.byTracker ?? []) {
				const x = m.get(t.tracker) ?? { injected: 0, saved: 0, failed: 0 };
				x.injected += t.injected;
				x.saved += t.saved + t.incomplete;
				x.failed += t.failed;
				m.set(t.tracker, x);
			}
		}
		return [...m.entries()].map(([tracker, v]) => ({ tracker, ...v })).sort((a, b) => b.injected + b.saved - (a.injected + a.saved));
	}, [data]);

	if (!instances.length) {
		return (
			<>
				<PageHeader title="Overview" />
				<Card>
					<Empty icon={<Server size={28} />} title="Connect your first cross-seed instance">
						Install the agent in each cross-seed LXC (<code>install.sh --role agent</code>), then add it here with its URL and secret.
						{isAdmin && (
							<div className="mt-4">
								<Link to="/settings/instances" className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white">
									Add instance
								</Link>
							</div>
						)}
					</Empty>
				</Card>
			</>
		);
	}

	const range = `last ${days} days`;
	return (
		<>
			<PageHeader
				title="Overview"
				subtitle={`${instances.length} instance${instances.length === 1 ? "" : "s"} · ${range}`}
				actions={
					<Segmented
						value={days}
						onChange={setDays}
						options={[
							{ id: "7", label: "7 days" },
							{ id: "30", label: "30 days" },
							{ id: "90", label: "90 days" },
						]}
					/>
				}
			/>
			{error && !data && <ErrorBox error={error} retry={reload} />}
			{!data ? (
				<Spinner />
			) : (
				<div className="space-y-5">
					<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
						<StatTile label={`Cross-seeds added (${days}d)`} icon={<Download size={13} />} value={compact(totals.injected + totals.saved)} sub={`${num(totals.injected)} injected · ${num(totals.saved)} saved`} trend={trend("injected")} />
						<StatTile label={`Matches found (${days}d)`} icon={<Sparkles size={13} />} value={compact(totals.matches)} sub="new MATCH decisions" trend={trend("matches")} />
						<StatTile label={`Searches (${days}d)`} icon={<Search size={13} />} value={compact(totals.searches)} sub="torrents searched on indexers" trend={trend("searches")} />
						<StatTile label="Library" icon={<Library size={13} />} value={compact(totals.torrents)} sub={<span className="inline-flex items-center gap-1"><HardDrive size={11} />{(totals.bytes / 1024 ** 4).toFixed(1)} TiB seeded</span>} />
						<StatTile
							label="Indexers healthy"
							icon={totals.limited ? <CircleAlert size={13} className="text-warning-text" /> : <CheckCircle2 size={13} className="text-good-text" />}
							value={`${totals.idxOk}/${totals.idxTotal}`}
							sub={totals.limited ? `${totals.limited} rate limited or failing` : "all reachable"}
						/>
					</div>

					{totals.failed > 0 && (
						<Notice tone="warning" title={`${num(totals.failed)} injection${totals.failed === 1 ? "" : "s"} failed in the ${range}`}>
							cross-seed saved them to its output directory and retries every hour. Check the instance's activity log for the reason.
						</Notice>
					)}

					<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
						{data.map((e) => (
							<InstanceCard key={e.instance.id} e={e} now={now} onAction={() => setTimeout(() => void reload(), 1500)} />
						))}
					</div>

					<div className="grid gap-3 xl:grid-cols-2">
						<Card title="Cross-seeds added per day" subtitle="Injected + saved, by instance">
							<ColumnChart data={chartData("injected")} series={series} emptyText="No cross-seeds in this period" />
						</Card>
						<Card title="Searches per day" subtitle="Torrents searched on your indexers, by instance">
							<ColumnChart data={chartData("searches")} series={series} emptyText="No searches logged in this period" />
						</Card>
					</div>

					<div className="grid gap-3 xl:grid-cols-5">
						<Card title="Top trackers" subtitle="Cross-seeds added per tracker, all time" className="xl:col-span-2">
							<BarList
								items={trackers.map((t) => ({
									key: t.tracker,
									label: t.tracker,
									value: t.injected + t.saved,
									sub: t.failed ? `${num(t.failed)} failed` : undefined,
								}))}
								empty="No cross-seeds recorded yet"
							/>
						</Card>
						<Card
							title="Recent matches"
							subtitle="Newest across all instances"
							className="xl:col-span-3"
							actions={
								<Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => setRefreshKey((k) => k + 1)}>
									Refresh
								</Button>
							}
						>
							<RecentMatches instances={instances} refreshKey={refreshKey} />
						</Card>
					</div>
				</div>
			)}
		</>
	);
}
