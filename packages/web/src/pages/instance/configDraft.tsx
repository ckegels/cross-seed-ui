/**
 * Shared config editing state for one instance. Tabs edit `draft`; the save
 * bar shows what changed, validates like cross-seed, saves, restarts and shows
 * the restart verdict (with automatic rollback when cross-seed refuses it).
 */
import { RotateCcw, Save } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	type ConfigResponse,
	type CrossSeedConfig,
	OPTION_BY_KEY,
	type SaveConfigResponse,
	type ValidationResult,
	validateConfig,
} from "@csui/shared";
import { api, ApiError, inst } from "../../api.ts";
import { useApp } from "../../state.tsx";
import { Button, ErrorBox, Field, Input, Modal, Notice, Switch, useToast } from "../../ui/index.tsx";

interface DraftCtx {
	loaded: ConfigResponse | null;
	error: unknown;
	draft: CrossSeedConfig;
	set: (key: string, value: unknown) => void;
	setMany: (patch: CrossSeedConfig) => void;
	dirtyKeys: string[];
	validation: ValidationResult;
	reload: () => Promise<void>;
	reset: () => void;
	instanceId: number;
	canEdit: boolean;
}

const Ctx = createContext<DraftCtx>(null as unknown as DraftCtx);

export function useDraft() {
	return useContext(Ctx);
}

function same(a: unknown, b: unknown) {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function ConfigDraftProvider({ instanceId, children }: { instanceId: number; children: ReactNode }) {
	const { isAdmin } = useApp();
	const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
	const [draft, setDraft] = useState<CrossSeedConfig>({});
	const [error, setError] = useState<unknown>(null);

	const reload = useCallback(async () => {
		try {
			const c = await api.get<ConfigResponse>(inst(instanceId, "config"));
			setLoaded(c);
			setDraft(structuredClone(c.config));
			setError(null);
		} catch (e) {
			setError(e);
		}
	}, [instanceId]);

	useEffect(() => {
		setLoaded(null);
		void reload();
	}, [reload]);

	const dirtyKeys = useMemo(() => {
		if (!loaded) return [];
		const keys = new Set([...Object.keys(loaded.config), ...Object.keys(draft)]);
		return [...keys].filter((k) => !same(loaded.config[k], draft[k]));
	}, [loaded, draft]);

	const validation = useMemo(() => validateConfig(draft, { configDir: loaded?.configDir }), [draft, loaded?.configDir]);

	const value: DraftCtx = {
		loaded,
		error,
		draft,
		set: (key, v) => setDraft((d) => ({ ...d, [key]: v })),
		setMany: (patch) => setDraft((d) => ({ ...d, ...patch })),
		dirtyKeys,
		validation,
		reload,
		reset: () => loaded && setDraft(structuredClone(loaded.config)),
		instanceId,
		canEdit: isAdmin,
	};
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function show(v: unknown): string {
	if (v === undefined) return "(not set)";
	if (v === null) return "null";
	if (Array.isArray(v)) return v.length ? `${v.length} item${v.length === 1 ? "" : "s"}` : "empty list";
	if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 57)}…"` : `"${v}"`;
	return String(v);
}

export function RestartResultView({ result }: { result: SaveConfigResponse["restart"] }) {
	if (!result) return null;
	return (
		<div className="space-y-3">
			<Notice tone={result.ok ? "good" : result.rolledBack ? "warning" : "critical"} title={result.ok ? "cross-seed is running with the new config" : result.rolledBack ? "cross-seed refused the change. The previous config was restored." : "cross-seed did not start cleanly"}>
				<div className="whitespace-pre-wrap">{result.message}</div>
			</Notice>
			{result.logTail.length > 0 && (
				<details>
					<summary className="cursor-pointer text-xs text-ink-3">Log output</summary>
					<pre className="log-line mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-ink-2">{result.logTail.join("\n")}</pre>
				</details>
			)}
		</div>
	);
}

export function SaveBar() {
	const d = useDraft();
	const toast = useToast();
	const [open, setOpen] = useState(false);
	const [restart, setRestart] = useState(true);
	const [autoRollback, setAutoRollback] = useState(true);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [result, setResult] = useState<SaveConfigResponse | null>(null);
	const [force, setForce] = useState(false);

	if (!d.loaded || !d.dirtyKeys.length || !d.canEdit) return null;
	const errors = d.validation.errors;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await api.put<SaveConfigResponse>(inst(d.instanceId, "config"), {
				config: d.draft,
				baseHash: d.loaded!.hash,
				restart,
				autoRollback,
				note: note.trim() || undefined,
				force: force || undefined,
			});
			setResult(r);
			await d.reload();
			if (!r.restart || r.restart.ok) {
				toast("good", r.restart ? "Saved, cross-seed restarted" : "Saved. Restart cross-seed to apply.");
				if (!r.restart) setOpen(false);
			}
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	const close = () => {
		setOpen(false);
		setResult(null);
		setError(null);
		setNote("");
		setForce(false);
	};

	return (
		<>
			<div className="sticky bottom-3 z-20 mt-6">
				<div className="card flex flex-wrap items-center gap-3 px-4 py-3 shadow-lg border-accent/40">
					<div className="flex-1 min-w-0 text-sm">
						<span className="font-medium">
							{d.dirtyKeys.length} unsaved change{d.dirtyKeys.length === 1 ? "" : "s"}
						</span>
						<span className="text-ink-3"> · {d.dirtyKeys.map((k) => OPTION_BY_KEY[k]?.label ?? k).join(", ")}</span>
						{errors.length > 0 && <div className="text-xs text-critical mt-0.5">{errors.length} problem{errors.length === 1 ? "" : "s"} cross-seed would reject</div>}
					</div>
					<Button variant="ghost" icon={<RotateCcw size={14} />} onClick={d.reset}>
						Discard
					</Button>
					<Button variant="primary" icon={<Save size={14} />} onClick={() => setOpen(true)}>
						Review & save
					</Button>
				</div>
			</div>
			<Modal
				open={open}
				onClose={close}
				title={result ? "Saved" : "Save configuration"}
				wide
				footer={
					result ? (
						<Button variant="primary" onClick={close}>
							Done
						</Button>
					) : (
						<>
							<Button onClick={close}>Cancel</Button>
							<Button variant="primary" loading={busy} disabled={errors.length > 0 && !force} onClick={save} icon={<Save size={14} />}>
								{restart ? "Save & restart" : "Save"}
							</Button>
						</>
					)
				}
			>
				{result ? (
					<div className="space-y-3">
						{result.backupId && <p className="text-xs text-ink-3">Previous version backed up as {result.backupId}.</p>}
						{result.restart ? <RestartResultView result={result.restart} /> : <Notice tone="accent" title="Saved without restart">cross-seed reads config.js only at startup. Restart it from the Maintenance tab to apply.</Notice>}
					</div>
				) : (
					<div className="space-y-4">
						<div className="rounded-lg border border-line divide-y divide-line">
							{d.dirtyKeys.map((k) => (
								<div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-3 py-2 text-sm">
									<div className="font-medium truncate">{OPTION_BY_KEY[k]?.label ?? k}</div>
									<div className="text-ink-3 min-w-0">
										<span className="line-through decoration-ink-3/60">{show(d.loaded!.config[k])}</span>
										<span className="mx-1.5">→</span>
										<span className="text-ink">{show(d.draft[k])}</span>
									</div>
								</div>
							))}
						</div>
						{errors.length > 0 && (
							<Notice tone="critical" title="cross-seed would refuse this configuration">
								<ul className="list-disc pl-4 space-y-0.5">
									{errors.map((e, i) => (
										<li key={i}>{e.message}</li>
									))}
								</ul>
								<label className="mt-2 flex items-center gap-2 text-xs">
									<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Save anyway (the validator might be stricter than your cross-seed version)
								</label>
							</Notice>
						)}
						{d.validation.warnings.length > 0 && (
							<Notice tone="warning" title="Warnings">
								<ul className="list-disc pl-4 space-y-0.5">
									{d.validation.warnings.map((w, i) => (
										<li key={i}>{w.message}</li>
									))}
								</ul>
							</Notice>
						)}
						{d.loaded!.usesDynamicCode && (
							<Notice tone="warning" title="Your config.js contains code">
								It uses things like process.env or functions. Saving from the UI writes plain values, so that code will be replaced by its current result.
							</Notice>
						)}
						<Field label="Note (optional)" hint="Stored with the backup and in the audit log">
							<Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. added BHD" />
						</Field>
						<div className="flex flex-col gap-2.5">
							<label className="flex items-center justify-between gap-3 text-sm">
								<span>
									Restart cross-seed now
									<span className="block text-xs text-ink-3">cross-seed only reads its config at startup.</span>
								</span>
								<Switch checked={restart} onChange={setRestart} />
							</label>
							<label className="flex items-center justify-between gap-3 text-sm">
								<span>
									Undo automatically if cross-seed refuses it
									<span className="block text-xs text-ink-3">Restores the previous config.js and restarts again.</span>
								</span>
								<Switch checked={autoRollback} onChange={setAutoRollback} disabled={!restart} />
							</label>
						</div>
						<SaveError error={error} onReload={async () => {
							await d.reload();
							close();
						}} />
					</div>
				)}
			</Modal>
		</>
	);
}

function SaveError({ error, onReload }: { error: unknown; onReload: () => void }) {
	if (!error) return null;
	if (error instanceof ApiError && error.code === "config_conflict") {
		return (
			<Notice tone="warning" title="config.js changed on the server">
				Someone edited it by hand or from another tab. Reload to get the latest version; your unsaved changes will be lost.
				<div className="mt-2">
					<Button size="sm" onClick={onReload}>
						Reload config
					</Button>
				</div>
			</Notice>
		);
	}
	if (error instanceof ApiError && error.code === "config_invalid") {
		const v = error.details as ValidationResult | undefined;
		return (
			<Notice tone="critical" title="Rejected by validation">
				<ul className="list-disc pl-4">{v?.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
			</Notice>
		);
	}
	return <ErrorBox error={error} />;
}

/** Issues (errors + warnings) concerning a given key. */
export function useIssuesFor(key: string) {
	const { validation } = useDraft();
	return {
		errors: validation.errors.filter((e) => e.keys.includes(key)),
		warnings: validation.warnings.filter((w) => w.keys.includes(key)),
	};
}
