import { CircleAlert, Cpu, Database, HardDrive, Play, Server, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Activity, AgentInfo, InstanceStats, JobInfo } from "@csui/shared";
import { api, inst } from "../../api.ts";
import { BarList, ColumnChart, Meter, SERIES, ShareBar, StatTile } from "../../charts/index.tsx";
import { ago, bytes, compact, DECISION_LABELS, duration, JOB_LABELS, MATCH_DECISIONS, num, pct, until } from "../../format.ts";
import { useApi, useNow } from "../../hooks.ts";
import { STATE_LABEL, stateTone } from "../../Layout.tsx";
import { useApp } from "../../state.tsx";
import { Badge, Button, Card, ErrorBox, Kv, Modal, Segmented, Spinner, StatusDot, Switch, useToast } from "../../ui/index.tsx";
import { ActivityLine } from "../Overview.tsx";

function RunJobDialog({ id, job, onClose }: { id: number; job: string; onClose: () => void }) {
	const toast = useToast();
	const [ignoreRecent, setIgnoreRecent] = useState(false);
	const [ignoreOlder, setIgnoreOlder] = useState(false);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const r = await api.post<{ ok: boolean; message: string }>(inst(id, `jobs/${job}`), {
				ignoreExcludeRecentSearch: ignoreRecent,
				ignoreExcludeOlder: ignoreOlder,
			});
			toast(r.ok ? "good" : "warning", r.message);
			onClose();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const searchLike = job === "search" || job === "rss";
	return (
		<Modal
			open
			onClose={onClose}
			title={`Run ${JOB_LABELS[job] ?? job} now`}
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" loading={busy} onClick={run} icon={<Play size={14} />}>
						Run now
					</Button>
				</>
			}
		>
			<div className="space-y-3 text-sm">
				<p className="text-ink-2">
					Runs the job ahead of schedule.
					{searchLike && " cross-seed then waits a full extra cadence before the next scheduled run."}
				</p>
				{job === "search" && (
					<>
						<label className="flex items-center justify-between gap-3">
							<span>
								Ignore excludeRecentSearch
								<span className="block text-xs text-ink-3">Also search torrents that were searched recently.</span>
							</span>
							<Switch checked={ignoreRecent} onChange={setIgnoreRecent} />
						</label>
						<label className="flex items-center justify-between gap-3">
							<span>
								Ignore excludeOlder
								<span className="block text-xs text-ink-3">Also search old torrents. Can mean many searches, be kind to your trackers.</span>
							</span>
							<Switch checked={ignoreOlder} onChange={setIgnoreOlder} />
						</label>
					</>
				)}
			</div>
		</Modal>
	);
}

function JobsCard({ id, jobs, now, reload }: { id: number; jobs: JobInfo[] | undefined; now: number; reload: () => void }) {
	const { isAdmin } = useApp();
	const [run, setRun] = useState<string | null>(null);
	return (
		<Card title="Scheduled jobs" subtitle="cross-seed checks its schedule every minute">
			{!jobs ? (
				<Spinner />
			) : (
				<div className="divide-y divide-line -my-2">
					{jobs.map((j) => (
						<div key={j.name} className="flex items-center gap-3 py-2.5">
							<StatusDot tone={j.running ? "accent" : j.enabled ? "good" : "neutral"} pulse={j.running} />
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium">{JOB_LABELS[j.name] ?? j.name}</div>
								<div className="text-xs text-ink-3">
									{!j.enabled
										? "Disabled in config"
										: j.running
											? `Running for ${duration(now - (j.runningSince ?? now), 2)}`
											: `Every ${duration(j.cadenceMs, 2)} · last ${ago(j.lastRun, now)} · next ${until(j.nextRun, now)}`}
								</div>
							</div>
							{isAdmin && j.enabled && (
								<Button size="sm" disabled={j.running} icon={<Play size={12} />} onClick={() => setRun(j.name)}>
									Run
								</Button>
							)}
						</div>
					))}
				</div>
			)}
			{run && (
				<RunJobDialog
					id={id}
					job={run}
					onClose={() => {
						setRun(null);
						setTimeout(reload, 1500);
					}}
				/>
			)}
		</Card>
	);
}

export function DashboardTab({ id }: { id: number }) {
	const [days, setDays] = useState<"7" | "30" | "90">("30");
	const info = useApi<AgentInfo>(inst(id, "info"), { interval: 30_000 });
	const activity = useApi<Activity>(inst(id, "activity"), { interval: 4000 });
	const stats = useApi<InstanceStats>(inst(id, `stats?days=${days}`), { interval: 60_000 });
	const jobs = useApi<JobInfo[]>(inst(id, "jobs"), { interval: 15_000 });
	const now = useNow(5000);

	if (info.error && !info.data) return <ErrorBox error={info.error} retry={info.reload} />;
	const s = stats.data;
	const i = info.data;
	const state = activity.data?.state ?? "idle";
	const timeline = (s?.timeline ?? []).map((d) => ({ x: d.day, values: { injected: d.injected, saved: d.saved, failed: d.failed } }));
	const resultSeries = [
		{ key: "injected", label: "Injected", color: SERIES[0] },
		{ key: "saved", label: "Saved", color: SERIES[1] },
		{ key: "failed", label: "Failed", color: "var(--critical)" },
	];
	const decisions = Object.entries(s?.decisions.byDecision ?? {}).sort((a, b) => b[1] - a[1]);
	const sum = (k: "injected" | "saved" | "matches" | "searches") => (s?.timeline ?? []).reduce((a, d) => a + d[k], 0);

	return (
		<div className="space-y-5">
			<div className="grid gap-3 lg:grid-cols-3">
				<Card
					title="Right now"
					className="lg:col-span-2"
					actions={
						<Badge tone={stateTone(state)}>
							<StatusDot tone={stateTone(state)} pulse={state !== "idle" && state !== "stopped"} />
							{STATE_LABEL[state] ?? state}
						</Badge>
					}
				>
					<div className="space-y-3">
						<ActivityLine activity={activity.data ?? null} now={now} />
						{activity.data?.runningJobs.length ? (
							<div className="flex flex-wrap gap-1.5">
								{activity.data.runningJobs.map((j) => (
									<Badge key={j.name} tone="accent">
										{JOB_LABELS[j.name] ?? j.name} · {duration(now - j.since, 1)}
									</Badge>
								))}
							</div>
						) : null}
						{activity.data?.lastMatch && (
							<div className="flex items-start gap-2 rounded-lg bg-surface-2 p-2.5 text-sm">
								<Sparkles size={15} className="text-accent mt-0.5 shrink-0" />
								<div className="min-w-0">
									<div className="truncate" title={activity.data.lastMatch.name}>
										Last match: <span className="font-medium">{activity.data.lastMatch.name}</span>
									</div>
									<div className="text-xs text-ink-3">
										{activity.data.lastMatch.tracker} · {activity.data.lastMatch.result} · {ago(activity.data.lastMatch.ts, now)}
									</div>
								</div>
							</div>
						)}
						{activity.data?.lastError && (
							<div className="flex items-start gap-2 rounded-lg bg-critical-soft p-2.5 text-sm">
								<CircleAlert size={15} className="text-critical mt-0.5 shrink-0" />
								<div className="min-w-0">
									<div className="break-words">{activity.data.lastError.text}</div>
									<div className="text-xs text-ink-3">{ago(activity.data.lastError.ts, now)}</div>
								</div>
							</div>
						)}
					</div>
				</Card>
				<Card title="Instance">
					{!i ? (
						<Spinner />
					) : (
						<div>
							<Kv k="cross-seed" v={i.crossSeed.version ?? "unknown"} />
							<Kv
								k="Service"
								v={
									<span className="inline-flex items-center gap-1.5">
										<StatusDot tone={i.service.state === "active" ? "good" : "critical"} />
										{i.service.state}
										{i.service.since && i.service.state === "active" ? ` · ${duration(now - i.service.since, 2)}` : ""}
									</span>
								}
							/>
							<Kv k="Daemon API" v={i.daemon.reachable ? `port ${i.daemon.port} · ${i.daemon.latencyMs} ms` : <span className="text-critical">{i.daemon.error ?? "unreachable"}</span>} />
							{i.service.memoryBytes ? <Kv k="Memory" v={bytes(i.service.memoryBytes)} /> : null}
							{i.service.restarts ? <Kv k="Restarts" v={num(i.service.restarts)} /> : null}
							<Kv k="Host" v={`${i.hostname} · load ${i.loadavg[0].toFixed(2)}`} />
							<Kv k="Agent" v={`${i.agentVersion} · Node ${i.nodeVersion}`} />
						</div>
					)}
				</Card>
			</div>

			<div className="flex items-center justify-between gap-2">
				<h2 className="text-[15px] font-semibold">Statistics</h2>
				<Segmented
					value={days}
					onChange={setDays}
					options={[
						{ id: "7", label: "7 days" },
						{ id: "30", label: "30 days" },
						{ id: "90", label: "90 days" },
					]}
				/>
			</div>

			{!s ? (
				stats.error ? <ErrorBox error={stats.error} retry={stats.reload} /> : <Spinner />
			) : (
				<>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						<StatTile label={`Injected (${days}d)`} value={compact(sum("injected"))} sub={`${num(s.results.injected)} all time`} trend={s.timeline.map((d) => d.injected).slice(-14)} />
						<StatTile label={`Saved (${days}d)`} value={compact(sum("saved"))} sub="incl. source incomplete" />
						<StatTile label={`Matches (${days}d)`} value={compact(sum("matches"))} sub={`${num(s.decisions.matches)} all time`} trend={s.timeline.map((d) => d.matches).slice(-14)} />
						<StatTile label={`Searches (${days}d)`} value={compact(sum("searches"))} sub={`last ${ago(s.searches.lastSearchAt, now)}`} trend={s.timeline.map((d) => d.searches).slice(-14)} />
					</div>

					<div className="grid gap-3 xl:grid-cols-3">
						<Card title="Results per day" subtitle="What happened to each match" className="xl:col-span-2">
							<ColumnChart data={timeline} series={resultSeries} emptyText="No cross-seeds in this period" />
						</Card>
						<JobsCard id={id} jobs={jobs.data} now={now} reload={jobs.reload} />
					</div>

					<div className="grid gap-3 lg:grid-cols-3">
						<Card title="Library" subtitle="What cross-seed searches with">
							<Kv k="Client torrents" v={num(s.library.clientTorrents)} />
							{s.library.byClient.map((c) => (
								<Kv key={c.host} k={<span className="pl-3">{c.host}</span>} v={num(c.count)} />
							))}
							<Kv k="Total size" v={bytes(s.library.totalBytes)} />
							{s.library.dataEntries > 0 && <Kv k="dataDirs entries" v={num(s.library.dataEntries)} />}
							{s.library.ensembleEntries > 0 && <Kv k="Episodes for season packs" v={num(s.library.ensembleEntries)} />}
							<Kv k="Searched at least once" v={`${num(s.searches.searched)} (${pct(s.searches.searched, s.searches.searched + s.searches.neverSearched)})`} />
							<Kv k="Searched in 24 h / 7 d" v={`${num(s.searches.searched24h)} / ${num(s.searches.searched7d)}`} />
							<Kv k="Torrent cache" v={`${num(s.torrentCache.files)} files · ${bytes(s.torrentCache.bytes)}`} />
						</Card>
						<Card title="Decisions" subtitle="Why candidates matched or not (all time)">
							{decisions.length ? (
								<>
									<ShareBar
										parts={[
											{ key: "m", label: "Matches", value: s.decisions.matches, color: SERIES[0] },
											{ key: "o", label: "Rejected", value: s.decisions.total - s.decisions.matches, color: "var(--surface-3)" },
										]}
									/>
									<div className="mt-4">
										<BarList
											limit={8}
											items={decisions.map(([d, n]) => ({
												key: d,
												label: (
													<span className="inline-flex items-center gap-1.5">
														{DECISION_LABELS[d] ?? d}
														{MATCH_DECISIONS.has(d) && <Badge tone="good">match</Badge>}
													</span>
												),
												value: n,
											}))}
										/>
									</div>
								</>
							) : (
								<p className="text-sm text-ink-3">No decisions yet.</p>
							)}
						</Card>
						<Card title="Trackers" subtitle="Cross-seeds added per tracker">
							<BarList
								items={s.byTracker.map((t) => ({
									key: t.tracker,
									label: t.tracker,
									value: t.injected + t.saved + t.incomplete,
									sub: [t.exists && `${num(t.exists)} already existed`, t.failed && `${num(t.failed)} failed`].filter(Boolean).join(" · ") || undefined,
								}))}
								empty="Nothing added yet"
							/>
						</Card>
					</div>

					{i && i.disks.length > 0 && (
						<Card title="Disk space" subtitle="Config, link and data directories as seen from the LXC">
							<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
								{i.disks.map((d) => {
									const used = d.totalBytes - d.freeBytes;
									const p = used / Math.max(1, d.totalBytes);
									return (
										<div key={d.path} className="space-y-1.5">
											<div className="flex items-center justify-between gap-2 text-sm">
												<span className="flex items-center gap-1.5 min-w-0">
													{d.label === "config" ? <Database size={13} className="text-ink-3" /> : d.label === "linkDir" ? <Cpu size={13} className="text-ink-3" /> : <HardDrive size={13} className="text-ink-3" />}
													<span className="truncate font-mono text-xs" title={d.path}>
														{d.path}
													</span>
												</span>
												<span className="text-xs text-ink-3 shrink-0">{bytes(d.freeBytes)} free</span>
											</div>
											<Meter value={used} max={d.totalBytes} tone={p > 0.95 ? "critical" : p > 0.85 ? "warning" : "accent"} />
										</div>
									);
								})}
							</div>
						</Card>
					)}
				</>
			)}
			{!i?.daemon.reachable && i && (
				<Card>
					<div className="flex items-center gap-2 text-sm text-ink-2">
						<Server size={15} /> The cross-seed API is not reachable, so jobs can't be triggered. Check the Maintenance tab.
					</div>
				</Card>
			)}
		</div>
	);
}
