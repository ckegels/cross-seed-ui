import { Search } from "lucide-react";
import { useState } from "react";
import type { DecisionRow, MatchEvent, Paged } from "@csui/shared";
import { inst, qs } from "../../api.ts";
import { ago, DECISION_LABELS, dateTime, MATCH_DECISIONS, RESULT_LABELS, VIA_LABELS } from "../../format.ts";
import { useApi, useNow } from "../../hooks.ts";
import { Badge, Card, ErrorBox, Input, Pager, Segmented, Select, Spinner } from "../../ui/index.tsx";

const LIMIT = 50;

function SearchBox({ onSearch, placeholder }: { onSearch: (s: string) => void; placeholder: string }) {
	const [v, setV] = useState("");
	return (
		<form
			className="relative flex-1 min-w-52"
			onSubmit={(e) => {
				e.preventDefault();
				onSearch(v.trim());
			}}
		>
			<Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
			<Input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="pl-8" onBlur={() => onSearch(v.trim())} />
		</form>
	);
}

export function resultTone(r: string) {
	return r === "injected" ? "good" : r === "failed" ? "critical" : r === "exists" ? "neutral" : "accent";
}

function Matches({ id }: { id: number }) {
	const [search, setSearch] = useState("");
	const [result, setResult] = useState("");
	const [via, setVia] = useState("");
	const [offset, setOffset] = useState(0);
	const now = useNow();
	const { data, error, reload } = useApi<Paged<MatchEvent>>(inst(id, `matches${qs({ search, result, via, limit: LIMIT, offset })}`), { interval: 30_000 });
	return (
		<Card title="Cross-seeds" subtitle="Every match cross-seed acted on, parsed from its logs" padded={false}>
			<div className="flex flex-wrap gap-2 p-4 pt-2">
				<SearchBox onSearch={(s) => (setSearch(s), setOffset(0))} placeholder="Search name…" />
				<Select value={result} onChange={(e) => (setResult(e.target.value), setOffset(0))} className="w-48">
					<option value="">All results</option>
					{Object.entries(RESULT_LABELS).map(([k, v]) => (
						<option key={k} value={k}>
							{v}
						</option>
					))}
				</Select>
				<Select value={via} onChange={(e) => (setVia(e.target.value), setOffset(0))} className="w-40">
					<option value="">All sources</option>
					{Object.entries(VIA_LABELS)
						.filter(([k]) => k !== "inject")
						.map(([k, v]) => (
							<option key={k} value={k}>
								{v}
							</option>
						))}
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
									<th className="px-3 py-2 font-medium">Tracker</th>
									<th className="px-3 py-2 font-medium">Match</th>
									<th className="px-3 py-2 font-medium">Result</th>
									<th className="px-4 py-2 font-medium text-right">When</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{data.rows.map((r) => (
									<tr key={r.id}>
										<td className="px-4 py-2 max-w-[28rem]">
											<div className="truncate" title={r.name}>
												{r.name}
											</div>
											<div className="truncate text-[11px] text-ink-3" title={r.searchee}>
												from {r.searchee} · {r.source}
											</div>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">{r.tracker}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="text-xs">{DECISION_LABELS[r.decision] ?? r.decision}</span>
											<div className="text-[11px] text-ink-3">{VIA_LABELS[r.via] ?? r.via}</div>
										</td>
										<td className="px-3 py-2">
											<Badge tone={resultTone(r.result)}>{RESULT_LABELS[r.result] ?? r.result}</Badge>
										</td>
										<td className="px-4 py-2 text-right whitespace-nowrap text-xs text-ink-3" title={dateTime(r.ts)}>
											{ago(r.ts, now)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{!data.rows.length && <div className="p-6 text-center text-sm text-ink-3">No cross-seeds found.</div>}
					</div>
					<div className="flex justify-end p-3">
						<Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} />
					</div>
				</>
			)}
		</Card>
	);
}

function Decisions({ id }: { id: number }) {
	const [search, setSearch] = useState("");
	const [decision, setDecision] = useState("");
	const [matchesOnly, setMatchesOnly] = useState(false);
	const [offset, setOffset] = useState(0);
	const now = useNow();
	const { data, error, reload } = useApi<Paged<DecisionRow>>(inst(id, `decisions${qs({ search, decision, matchesOnly, limit: LIMIT, offset })}`));
	return (
		<Card title="Decisions" subtitle="cross-seed's verdict for every candidate it compared (from its database)" padded={false}>
			<div className="flex flex-wrap gap-2 p-4 pt-2">
				<SearchBox onSearch={(s) => (setSearch(s), setOffset(0))} placeholder="Search your torrent's name or info hash…" />
				<Select
					value={matchesOnly ? "__matches" : decision}
					onChange={(e) => {
						setOffset(0);
						if (e.target.value === "__matches") {
							setMatchesOnly(true);
							setDecision("");
						} else {
							setMatchesOnly(false);
							setDecision(e.target.value);
						}
					}}
					className="w-56"
				>
					<option value="">All decisions</option>
					<option value="__matches">Matches only</option>
					{Object.entries(DECISION_LABELS).map(([k, v]) => (
						<option key={k} value={k}>
							{v}
						</option>
					))}
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
									<th className="px-4 py-2 font-medium">Your torrent</th>
									<th className="px-3 py-2 font-medium">Tracker</th>
									<th className="px-3 py-2 font-medium">Decision</th>
									<th className="px-4 py-2 font-medium text-right">Last seen</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{data.rows.map((r) => (
									<tr key={r.id}>
										<td className="px-4 py-2 max-w-[30rem]">
											<div className="truncate" title={r.searchee}>
												{r.searchee}
											</div>
											<div className="truncate text-[11px] text-ink-3 font-mono" title={r.guid}>
												{r.guid}
											</div>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">{r.tracker ?? "–"}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<Badge tone={MATCH_DECISIONS.has(r.decision) ? "good" : "neutral"}>{DECISION_LABELS[r.decision] ?? r.decision}</Badge>
										</td>
										<td className="px-4 py-2 text-right whitespace-nowrap text-xs text-ink-3" title={dateTime(r.lastSeen)}>
											{ago(r.lastSeen ?? r.firstSeen, now)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{!data.rows.length && <div className="p-6 text-center text-sm text-ink-3">No decisions found.</div>}
					</div>
					<div className="flex justify-end p-3">
						<Pager offset={offset} limit={LIMIT} total={data.total} onChange={setOffset} />
					</div>
				</>
			)}
		</Card>
	);
}

export function HistoryTab({ id }: { id: number }) {
	const [view, setView] = useState<"matches" | "decisions">("matches");
	return (
		<div className="space-y-3">
			<Segmented
				value={view}
				onChange={setView}
				options={[
					{ id: "matches", label: "Cross-seeds" },
					{ id: "decisions", label: "All decisions" },
				]}
			/>
			{view === "matches" ? <Matches id={id} /> : <Decisions id={id} />}
		</div>
	);
}
