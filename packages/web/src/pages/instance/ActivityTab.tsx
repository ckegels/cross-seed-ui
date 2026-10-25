import { ArrowDown, Pause, Play, Radio, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Activity, LogLine } from "@csui/shared";
import { inst, qs } from "../../api.ts";
import { dateTime, time } from "../../format.ts";
import { useApi, useEventSource, useNow } from "../../hooks.ts";
import { Badge, Button, Card, cx, ErrorBox, Input, Notice, Segmented, Select, Spinner, StatusDot } from "../../ui/index.tsx";
import { ActivityLine } from "../Overview.tsx";

const LEVEL_CLS: Record<string, string> = {
	error: "text-critical",
	warn: "text-warning-text",
	info: "text-ink",
	verbose: "text-ink-3",
	debug: "text-ink-3",
	silly: "text-ink-3",
};

function highlight(msg: string): React.ReactNode {
	if (/ - injected$/.test(msg) || /^Found .* by MATCH/.test(msg)) return <span className="text-good-text">{msg}</span>;
	return msg;
}

function LogView({ lines, follow, filter }: { lines: LogLine[]; follow: boolean; filter: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const shown = useMemo(() => {
		const f = filter.toLowerCase();
		return f ? lines.filter((l) => l.message.toLowerCase().includes(f) || l.label?.includes(f)) : lines;
	}, [lines, filter]);
	useEffect(() => {
		if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [shown, follow]);
	return (
		<div ref={ref} className="h-[60vh] overflow-y-auto rounded-lg bg-surface-2 p-3 space-y-0.5">
			{shown.map((l, i) => (
				<div key={i} className="log-line flex gap-2">
					<span className="text-ink-3 shrink-0 tabular">{time(l.ts)}</span>
					<span className={cx("shrink-0 w-12", LEVEL_CLS[l.level] ?? "text-ink-3")}>{l.level}</span>
					{l.label && <span className="text-accent shrink-0">[{l.label}]</span>}
					<span className={cx("min-w-0", LEVEL_CLS[l.level] === "text-ink" ? "text-ink-2" : LEVEL_CLS[l.level])}>{highlight(l.message)}</span>
				</div>
			))}
			{!shown.length && <div className="text-sm text-ink-3 p-2">No log lines{filter ? " match the filter" : " yet"}.</div>}
		</div>
	);
}

function LiveLog({ id }: { id: number }) {
	const [level, setLevel] = useState<"info" | "verbose">("info");
	const [lines, setLines] = useState<LogLine[]>([]);
	const [paused, setPaused] = useState(false);
	const [filter, setFilter] = useState("");
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	const buffer = useRef<LogLine[]>([]);
	const [activity, setActivity] = useState<Activity | null>(null);
	const now = useNow(5000);

	useEffect(() => setLines([]), [level]);
	const connected = useEventSource(inst(id, `logs/stream?level=${level}&backlog=300`), {
		backlog: (d) => setLines(d as LogLine[]),
		line: (d) => {
			if (pausedRef.current) {
				buffer.current.push(d as LogLine);
				return;
			}
			setLines((prev) => {
				const next = [...prev, d as LogLine];
				return next.length > 3000 ? next.slice(-2500) : next;
			});
		},
		activity: (d) => setActivity(d as Activity),
	});

	const resume = () => {
		setLines((prev) => [...prev, ...buffer.current].slice(-2500));
		buffer.current = [];
		setPaused(false);
	};

	return (
		<Card
			title={
				<span className="flex items-center gap-2">
					Live log <StatusDot tone={connected ? "good" : "critical"} pulse={connected} />
				</span>
			}
			subtitle={connected ? "Streaming from cross-seed's log files" : "Connecting…"}
			actions={
				<>
					<Segmented
						value={level}
						onChange={setLevel}
						options={[
							{ id: "info", label: "Info" },
							{ id: "verbose", label: "Verbose" },
						]}
					/>
					{paused ? (
						<Button size="sm" icon={<Play size={12} />} onClick={resume}>
							Resume{buffer.current.length ? ` (${buffer.current.length})` : ""}
						</Button>
					) : (
						<Button size="sm" icon={<Pause size={12} />} onClick={() => setPaused(true)}>
							Pause
						</Button>
					)}
				</>
			}
		>
			<div className="mb-3 space-y-3">
				<ActivityLine activity={activity} now={now} />
				<div className="relative">
					<Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
					<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines…" className="pl-8" />
				</div>
			</div>
			<LogView lines={lines} follow={!paused} filter={filter} />
		</Card>
	);
}

interface LogQueryResult {
	lines: LogLine[];
	files: { date: string; kind: string; size: number }[];
	truncated: boolean;
}

function LogBrowser({ id }: { id: number }) {
	const [kind, setKind] = useState("info");
	const [date, setDate] = useState("");
	const [level, setLevel] = useState("");
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const { data, error, loading, reload } = useApi<LogQueryResult>(inst(id, `logs${qs({ kind, date, level, search: q, limit: 1500 })}`));
	const dates = [...new Set((data?.files ?? []).filter((f) => f.kind === kind).map((f) => f.date))].reverse();
	return (
		<Card title="Log files" subtitle="cross-seed keeps 14 days of logs">
			<div className="mb-3 flex flex-wrap gap-2">
				<Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-32">
					<option value="info">info</option>
					<option value="verbose">verbose</option>
					<option value="error">error</option>
				</Select>
				<Select value={date} onChange={(e) => setDate(e.target.value)} className="w-40">
					<option value="">Today (latest)</option>
					{dates.map((d) => (
						<option key={d} value={d}>
							{d}
						</option>
					))}
				</Select>
				<Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-36">
					<option value="">All levels</option>
					<option value="error">Errors</option>
					<option value="warn">Warnings +</option>
					<option value="info">Info +</option>
				</Select>
				<form
					className="flex flex-1 min-w-48 gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						setQ(search);
					}}
				>
					<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text (Enter)" />
					<Button type="submit" icon={<Search size={14} />} loading={loading}>
						Search
					</Button>
				</form>
			</div>
			{error && <ErrorBox error={error} retry={reload} />}
			{data && !data.files.length && (
				<div className="mb-3">
					<Notice tone="warning" title="cross-seed has not written any log files yet">
						If it refuses its configuration it stops before creating them. The reason is in Maintenance → Service output.
					</Notice>
				</div>
			)}
			{!data ? <Spinner /> : <LogView lines={data.lines} follow filter="" />}
			{data?.truncated && <p className="mt-2 text-xs text-ink-3">Showing the newest {data.lines.length} matching lines.</p>}
		</Card>
	);
}

interface EventRow {
	id: number;
	ts: number;
	type: string;
	via: string | null;
	name: string | null;
	tracker: string | null;
	result: string | null;
	data: unknown;
}

function EventFeed({ id }: { id: number }) {
	const { data } = useApi<EventRow[]>(inst(id, "events?limit=40&types=job-start,search-start,search-complete,rss-complete,server-start,error,indexer-error"), { interval: 15_000 });
	const now = useNow();
	if (!data) return <Spinner />;
	const describe = (e: EventRow): { text: string; tone: "neutral" | "good" | "critical" | "accent" } => {
		const d = (e.data ?? {}) as Record<string, unknown>;
		switch (e.type) {
			case "job-start":
				return { text: `Started ${d.job}`, tone: "accent" };
			case "job-schedule":
				return { text: `${d.job}: next run ${d.nextRun}`, tone: "neutral" };
			case "search-start":
				return { text: `Search: ${d.suitable} of ${d.torrents} torrents eligible, ${d.queries} queries`, tone: "accent" };
			case "search-complete":
				return { text: `Search finished: ${d.found} cross-seeds from ${d.searched} torrents`, tone: "good" };
			case "rss-complete":
				return { text: `RSS scan checked ${d.candidates} new candidates`, tone: "good" };
			case "server-start":
				return { text: `cross-seed started (port ${d.port})`, tone: "good" };
			case "indexer-error":
				return { text: `${e.tracker}: ${String(e.data ?? "")}`, tone: "critical" };
			default:
				return { text: String(e.data ?? e.type), tone: "critical" };
		}
	};
	return (
		<ul className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
			{data.map((e) => {
				const { text, tone } = describe(e);
				return (
					<li key={e.id} className="flex gap-2 text-sm">
						<StatusDot tone={tone} />
						<div className="min-w-0 -mt-1">
							<div className="break-words line-clamp-3">{text}</div>
							<div className="text-[11px] text-ink-3" title={dateTime(e.ts)}>
								{now - e.ts < 86_400_000 ? time(e.ts) : dateTime(e.ts)}
							</div>
						</div>
					</li>
				);
			})}
			{!data.length && <li className="text-sm text-ink-3">No events yet.</li>}
		</ul>
	);
}

export function ActivityTab({ id }: { id: number }) {
	const [view, setView] = useState<"live" | "files">("live");
	return (
		<div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
			<div className="space-y-3 min-w-0">
				<Segmented
					value={view}
					onChange={setView}
					options={[
						{ id: "live", label: <span className="inline-flex items-center gap-1"><Radio size={12} /> Live</span> },
						{ id: "files", label: <span className="inline-flex items-center gap-1"><ArrowDown size={12} /> Log files</span> },
					]}
				/>
				{view === "live" ? <LiveLog id={id} /> : <LogBrowser id={id} />}
			</div>
			<Card title="Timeline" subtitle={<>Jobs, searches and errors <Badge>auto-refresh</Badge></>}>
				<EventFeed id={id} />
			</Card>
		</div>
	);
}
