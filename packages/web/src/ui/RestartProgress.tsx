/**
 * Live view of a cross-seed restart: shown while a save/restart request is
 * running. Polls the agent and turns what it sees into steps, so the user
 * knows what is happening instead of staring at a spinner.
 */
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Activity, AgentInfo } from "@csui/shared";
import { api, inst } from "../api.ts";
import { cx, Modal } from "./index.tsx";

interface Seen {
	restarted: boolean;
	validated: boolean;
	online: boolean;
	lastLine: string | null;
}

export function RestartProgress({ instanceId, startedAt, saving = true }: { instanceId: number; startedAt: number; saving?: boolean }) {
	const [seen, setSeen] = useState<Seen>({ restarted: false, validated: false, online: false, lastLine: null });
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		let alive = true;
		const tick = async () => {
			setNow(Date.now());
			try {
				const [info, act] = await Promise.all([
					api.get<AgentInfo>(inst(instanceId, "info")).catch(() => null),
					api.get<Activity>(inst(instanceId, "activity")).catch(() => null),
				]);
				if (!alive) return;
				setSeen((prev) => {
					const restarted =
						prev.restarted ||
						(!!info?.service.since && info.service.since > startedAt - 2000) ||
						(!!act?.lastEvent && act.lastEvent.ts > startedAt && /cross-seed v\d|Validating your configuration/.test(act.lastEvent.text));
					const validated = prev.validated || (restarted && (act?.state === "starting" || act?.state === "idle") && !!act?.lastEvent && act.lastEvent.ts > startedAt && !/Validating your configuration/.test(act.lastEvent.text));
					const online = restarted && !!info?.daemon.reachable && act?.state !== "starting";
					return {
						restarted,
						validated: validated || online,
						online,
						lastLine: act?.lastEvent && act.lastEvent.ts > startedAt ? act.lastEvent.text : prev.lastLine,
					};
				});
			} catch {
				/* keep polling */
			}
		};
		void tick();
		const t = setInterval(tick, 1500);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [instanceId, startedAt]);

	const steps = [
		...(saving ? [{ label: "Saving config.js (a backup of the old one is kept)", done: true }] : []),
		{ label: "Restarting cross-seed", done: seen.restarted },
		{ label: "cross-seed checks the configuration and its clients/indexers", done: seen.validated },
		{ label: "Loading your torrents and starting its API", done: seen.online },
	];
	const current = steps.findIndex((s) => !s.done);
	const secs = Math.max(0, Math.round((now - startedAt) / 1000));

	return (
		<div className="space-y-3 rounded-lg border border-line bg-surface-2 p-4">
			<div className="flex items-center justify-between gap-2">
				<div className="font-medium">Restarting cross-seed…</div>
				<div className="text-xs text-ink-3 tabular">{secs}s</div>
			</div>
			<ol className="space-y-2">
				{steps.map((s, i) => (
					<li key={s.label} className={cx("flex items-center gap-2.5 text-sm", !s.done && i !== current && "text-ink-3")}>
						{s.done ? (
							<Check size={15} className="text-good-text shrink-0" />
						) : i === current ? (
							<Loader2 size={15} className="animate-spin text-accent shrink-0" />
						) : (
							<span className="inline-block size-[15px] shrink-0 rounded-full border border-line-strong" />
						)}
						{s.label}
					</li>
				))}
			</ol>
			{seen.lastLine && (
				<div className="log-line truncate rounded bg-surface px-2 py-1.5 text-ink-3" title={seen.lastLine}>
					{seen.lastLine}
				</div>
			)}
			<p className="text-xs text-ink-3">
				Usually a few seconds. With a large torrent library cross-seed can need a few minutes before it is fully back; if it refuses the
				new configuration, the previous one is restored automatically.
			</p>
		</div>
	);
}

/** Blocking dialog shown while a request that restarts cross-seed is running. */
export function RestartingModal({ instanceId, startedAt, saving = false }: { instanceId: number; startedAt: number | null; saving?: boolean }) {
	return (
		<Modal open={startedAt !== null} onClose={() => {}} title="Applying">
			{startedAt !== null && <RestartProgress instanceId={instanceId} startedAt={startedAt} saving={saving} />}
		</Modal>
	);
}
