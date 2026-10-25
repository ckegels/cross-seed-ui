import { FileClock, Play, Power, RotateCw, ScrollText, Square, Terminal, Zap } from "lucide-react";
import { useState } from "react";
import type { AgentInfo, BackupInfo, RestartResult } from "@csui/shared";
import { api, inst } from "../../api.ts";
import { ago, bytes, dateTime, duration } from "../../format.ts";
import { useApi, useNow } from "../../hooks.ts";
import { useApp } from "../../state.tsx";
import { Badge, Button, Card, ErrorBox, Kv, Modal, Notice, Spinner, StatusDot, Switch, useConfirm, useToast } from "../../ui/index.tsx";
import { RestartingModal } from "../../ui/RestartProgress.tsx";
import { RestartResultView } from "./configDraft.tsx";
import { SearchNowDialog } from "./LibraryTab.tsx";

function ServiceCard({ id }: { id: number }) {
	const { isAdmin } = useApp();
	const info = useApi<AgentInfo>(inst(id, "info"), { interval: 10_000 });
	const toast = useToast();
	const { confirm, dialog } = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	const [result, setResult] = useState<RestartResult | null>(null);
	const [restartingSince, setRestartingSince] = useState<number | null>(null);
	const now = useNow(5000);
	const act = async (action: "start" | "stop" | "restart") => {
		if (action === "stop" && !(await confirm({ title: "Stop cross-seed?", body: "No searches, RSS or announce matching until you start it again.", danger: true, confirmLabel: "Stop" }))) return;
		setBusy(action);
		if (action !== "stop") setRestartingSince(Date.now());
		try {
			const r = await api.post<RestartResult & { message: string }>(inst(id, `service/${action}`), {});
			if (action === "restart") setResult(r);
			else toast("good", r.message);
			void info.reload();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(null);
			setRestartingSince(null);
		}
	};
	const s = info.data?.service;
	return (
		<Card title="cross-seed service" subtitle={s ? `${s.manager === "systemd" ? "systemd unit" : "process"}: ${s.name}` : undefined}>
			{!info.data ? (
				info.error ? <ErrorBox error={info.error} /> : <Spinner />
			) : (
				<div className="space-y-3">
					<div>
						<Kv
							k="State"
							v={
								<span className="inline-flex items-center gap-1.5">
									<StatusDot tone={s?.state === "active" ? "good" : s?.state === "activating" ? "warning" : "critical"} />
									{s?.state}
									{s?.subState ? ` (${s.subState})` : ""}
								</span>
							}
						/>
						<Kv k="Since" v={s?.since ? `${dateTime(s.since)} (${duration(now - s.since, 2)})` : "–"} />
						<Kv k="PID" v={s?.pid ?? "–"} />
						{s?.memoryBytes ? <Kv k="Memory" v={bytes(s.memoryBytes)} /> : null}
						<Kv k="Version" v={info.data.crossSeed.version ?? "?"} />
						<Kv k="Config dir" v={<code className="text-xs">{info.data.crossSeed.configDir}</code>} />
					</div>
					{isAdmin && s?.manager !== "none" && (
						<div className="flex flex-wrap gap-2">
							<Button variant="primary" icon={<RotateCw size={14} />} loading={busy === "restart"} onClick={() => act("restart")}>
								Restart
							</Button>
							{s?.state === "active" ? (
								<Button icon={<Square size={14} />} loading={busy === "stop"} onClick={() => act("stop")}>
									Stop
								</Button>
							) : (
								<Button icon={<Play size={14} />} loading={busy === "start"} onClick={() => act("start")}>
									Start
								</Button>
							)}
						</div>
					)}
				</div>
			)}
			{dialog}
			<RestartingModal instanceId={id} startedAt={restartingSince} />
			<Modal open={!!result} onClose={() => setResult(null)} title="Restart" footer={<Button variant="primary" onClick={() => setResult(null)}>Done</Button>}>
				<RestartResultView result={result} />
			</Modal>
		</Card>
	);
}

function MaintenanceCard({ id }: { id: number }) {
	const { isAdmin } = useApp();
	const { data } = useApi<{ id: string; label: string; description: string }[]>(inst(id, "maintenance"));
	const { confirm, dialog } = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	const [out, setOut] = useState<{ title: string; ok: boolean; message: string; output?: string } | null>(null);
	const [search, setSearch] = useState(false);
	const run = async (c: { id: string; label: string; description: string }) => {
		if (!(await confirm({ title: c.label, body: c.description, confirmLabel: "Run" }))) return;
		setBusy(c.id);
		try {
			const r = await api.post<{ ok: boolean; message: string; output?: string }>(inst(id, `maintenance/${c.id}`), {});
			setOut({ title: c.label, ...r });
		} catch (e) {
			setOut({ title: c.label, ok: false, message: (e as Error).message });
		} finally {
			setBusy(null);
		}
	};
	return (
		<Card title="Maintenance commands" subtitle="Official cross-seed CLI commands, run on the LXC">
			{!data ? (
				<Spinner />
			) : (
				<div className="divide-y divide-line -my-2">
					{data.map((c) => (
						<div key={c.id} className="flex items-center gap-3 py-2.5">
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium">{c.label}</div>
								<div className="text-xs text-ink-3">{c.description}</div>
							</div>
							{isAdmin && (
								<Button size="sm" icon={<Terminal size={12} />} loading={busy === c.id} onClick={() => run(c)}>
									Run
								</Button>
							)}
						</div>
					))}
					{isAdmin && (
						<div className="flex items-center gap-3 py-2.5">
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium">Search one torrent</div>
								<div className="text-xs text-ink-3">Same as the download-complete webhook: search by info hash or data path right now.</div>
							</div>
							<Button size="sm" icon={<Zap size={12} />} onClick={() => setSearch(true)}>
								Search
							</Button>
						</div>
					)}
				</div>
			)}
			{dialog}
			{search && <SearchNowDialog id={id} onClose={() => setSearch(false)} />}
			<Modal open={!!out} onClose={() => setOut(null)} title={out?.title ?? ""} footer={<Button variant="primary" onClick={() => setOut(null)}>Close</Button>}>
				{out && (
					<div className="space-y-2">
						<Notice tone={out.ok ? "good" : "critical"} title={out.message} />
						{out.output && <pre className="log-line max-h-72 overflow-auto rounded-lg bg-surface-2 p-3">{out.output}</pre>}
					</div>
				)}
			</Modal>
		</Card>
	);
}

function BackupsCard({ id }: { id: number }) {
	const { isAdmin } = useApp();
	const { data, error, reload } = useApi<BackupInfo[]>(isAdmin ? inst(id, "config/backups") : null);
	const now = useNow();
	const toast = useToast();
	const { confirm, dialog } = useConfirm();
	const [view, setView] = useState<{ id: string; text: string } | null>(null);
	const [restart, setRestart] = useState(true);
	const [result, setResult] = useState<RestartResult | null>(null);
	const [restoringSince, setRestoringSince] = useState<number | null>(null);
	if (!isAdmin) return null;
	const restore = async (b: BackupInfo) => {
		if (!(await confirm({ title: "Restore this version?", body: `config.js will be replaced by the version from ${dateTime(b.createdAt)}. The current file is backed up first.`, confirmLabel: "Restore" }))) return;
		if (restart) setRestoringSince(Date.now());
		try {
			const r = await api.post<{ restart: RestartResult | null }>(inst(id, `config/backups/${b.id}/restore`), { restart });
			toast("good", "Restored");
			if (r.restart) setResult(r.restart);
			void reload();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setRestoringSince(null);
		}
	};
	return (
		<Card
			title="config.js history"
			subtitle="A copy is kept before every change (latest 50)"
			actions={
				<label className="flex items-center gap-2 text-xs text-ink-2">
					<Switch checked={restart} onChange={setRestart} /> Restart after restore
				</label>
			}
		>
			{error && <ErrorBox error={error} />}
			{!data ? (
				<Spinner />
			) : !data.length ? (
				<p className="text-sm text-ink-3">No backups yet. They are created the first time you save from the UI.</p>
			) : (
				<div className="divide-y divide-line -my-2 max-h-96 overflow-y-auto">
					{data.map((b) => (
						<div key={b.id} className="flex items-center gap-3 py-2">
							<FileClock size={15} className="text-ink-3 shrink-0" />
							<div className="flex-1 min-w-0">
								<div className="text-sm">
									{dateTime(b.createdAt)} <span className="text-ink-3 text-xs">({ago(b.createdAt, now)})</span>
								</div>
								<div className="text-xs text-ink-3 truncate">{b.note || "no note"}</div>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onClick={async () => {
									const r = await api.get<{ id: string; text: string }>(inst(id, `config/backups/${b.id}`));
									setView(r);
								}}
							>
								View
							</Button>
							<Button size="sm" onClick={() => restore(b)}>
								Restore
							</Button>
						</div>
					))}
				</div>
			)}
			{dialog}
			<Modal open={!!view} onClose={() => setView(null)} title={view?.id ?? ""} wide>
				<p className="mb-2 text-xs text-ink-3">Secrets hidden.</p>
				<pre className="log-line max-h-[65vh] overflow-auto rounded-lg bg-surface-2 p-3">{view?.text}</pre>
			</Modal>
			<RestartingModal instanceId={id} startedAt={restoringSince} saving />
			<Modal open={!!result} onClose={() => setResult(null)} title="Restored" footer={<Button variant="primary" onClick={() => setResult(null)}>Done</Button>}>
				<RestartResultView result={result} />
			</Modal>
		</Card>
	);
}

function JournalCard({ id }: { id: number }) {
	const { isAdmin } = useApp();
	const [open, setOpen] = useState(false);
	const { data, reload, loading } = useApi<{ lines: string[] }>(open ? inst(id, "service/journal?lines=300") : null);
	if (!isAdmin) return null;
	return (
		<Card
			title="Service output"
			subtitle="Console output of the cross-seed process (systemd journal). Useful when it does not start."
			actions={
				open ? (
					<Button size="sm" variant="ghost" icon={<RotateCw size={12} />} loading={loading} onClick={reload}>
						Refresh
					</Button>
				) : (
					<Button size="sm" icon={<ScrollText size={12} />} onClick={() => setOpen(true)}>
						Show
					</Button>
				)
			}
		>
			{open &&
				(!data ? (
					<Spinner />
				) : (
					<pre className="log-line max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 text-ink-2">{data.lines.join("\n") || "No output"}</pre>
				))}
		</Card>
	);
}

export function MaintenanceTab({ id }: { id: number }) {
	return (
		<div className="grid gap-3 xl:grid-cols-2">
			<ServiceCard id={id} />
			<MaintenanceCard id={id} />
			<BackupsCard id={id} />
			<JournalCard id={id} />
			<div className="xl:col-span-2 text-xs text-ink-3 flex items-center gap-1.5">
				<Power size={12} /> Changes made here are recorded in the audit log <Badge>Settings → Audit log</Badge>
			</div>
		</div>
	);
}
