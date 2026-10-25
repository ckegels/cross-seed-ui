import { Eye, FileCode2, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import {
	BLOCKLIST_TYPES,
	GROUPS,
	migrateLegacy,
	OPTION_BY_KEY,
	OPTIONS,
	parseBlocklistEntry,
	renderConfigFile,
	type SaveConfigResponse,
} from "@csui/shared";
import { api, inst } from "../../api.ts";
import { Button, Card, Input, Modal, Notice, Select, Switch, Textarea, useToast } from "../../ui/index.tsx";
import { RestartResultView, useDraft } from "./configDraft.tsx";
import { OptionField, OptionRow } from "./fields.tsx";

const HANDLED_ELSEWHERE = new Set(["torznab", "sonarr", "radarr", "torrentClients", "notificationWebhookUrls", "useClientTorrents", "port", "host", "apiKey", "blockList"]);

function BlocklistEditor() {
	const d = useDraft();
	const list = (d.draft.blockList as string[]) ?? [];
	const set = (v: string[]) => d.set("blockList", v);
	const [type, setType] = useState("name");
	const [value, setValue] = useState("");
	const hint = BLOCKLIST_TYPES.find((t) => t.value === type)?.hint;
	return (
		<OptionRow meta={OPTION_BY_KEY.blockList} dirty={d.dirtyKeys.includes("blockList")}>
			<div className="space-y-2">
				{list.map((entry, i) => {
					const p = parseBlocklistEntry(entry);
					const known = BLOCKLIST_TYPES.find((t) => t.value === p.type);
					return (
						<div key={i} className="flex items-center gap-2">
							<span className="w-32 shrink-0 text-xs text-ink-3">{known?.label ?? p.type}</span>
							<Input
								value={p.value}
								disabled={!d.canEdit}
								className="font-mono text-xs"
								onChange={(e) => set(list.map((x, j) => (j === i ? `${p.type === "legacy" ? "" : `${p.type}:`}${e.target.value}` : x)))}
							/>
							{d.canEdit && (
								<button type="button" className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical" onClick={() => set(list.filter((_, j) => j !== i))} title="Remove">
									<Trash2 size={14} />
								</button>
							)}
						</div>
					);
				})}
				{!list.length && <p className="text-sm text-ink-3">Nothing blocked.</p>}
				{d.canEdit && (
					<div className="space-y-1 pt-1">
						<div className="flex flex-wrap gap-2">
							<Select value={type} onChange={(e) => setType(e.target.value)} className="w-44">
								{BLOCKLIST_TYPES.map((t) => (
									<option key={t.value} value={t.value}>
										{t.label}
									</option>
								))}
							</Select>
							<Input
								value={value}
								onChange={(e) => setValue(e.target.value)}
								className="flex-1 min-w-40 font-mono text-xs"
								placeholder="value"
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										set([...list, `${type}:${value}`]);
										setValue("");
									}
								}}
							/>
							<Button
								icon={<Plus size={14} />}
								onClick={() => {
									set([...list, `${type}:${value}`]);
									setValue("");
								}}
							>
								Add
							</Button>
						</div>
						<p className="text-xs text-ink-3">{hint}</p>
					</div>
				)}
			</div>
		</OptionRow>
	);
}

function RawEditor() {
	const d = useDraft();
	const toast = useToast();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [hash, setHash] = useState("");
	const [restart, setRestart] = useState(true);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<SaveConfigResponse | null>(null);
	const load = async () => {
		try {
			const r = await api.get<{ text: string; hash: string }>(inst(d.instanceId, "config/raw?reveal=1"));
			setText(r.text);
			setHash(r.hash);
			setResult(null);
			setOpen(true);
		} catch (e) {
			toast("critical", (e as Error).message);
		}
	};
	const save = async () => {
		setBusy(true);
		try {
			const r = await api.put<SaveConfigResponse>(inst(d.instanceId, "config/raw"), { text, baseHash: hash, restart, autoRollback: true });
			setResult(r);
			await d.reload();
		} catch (e) {
			toast("critical", (e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button icon={<FileCode2 size={14} />} onClick={load} disabled={!d.canEdit}>
				Edit raw config.js
			</Button>
			<Modal
				open={open}
				onClose={() => setOpen(false)}
				title="config.js (raw)"
				wide
				footer={
					result ? (
						<Button variant="primary" onClick={() => setOpen(false)}>
							Done
						</Button>
					) : (
						<>
							<label className="mr-auto flex items-center gap-2 text-sm">
								<Switch checked={restart} onChange={setRestart} /> Restart (with automatic undo)
							</label>
							<Button onClick={() => setOpen(false)}>Cancel</Button>
							<Button variant="primary" loading={busy} onClick={save}>
								Save
							</Button>
						</>
					)
				}
			>
				{result ? (
					result.restart ? <RestartResultView result={result.restart} /> : <Notice tone="good" title="Saved">Restart cross-seed to apply.</Notice>
				) : (
					<div className="space-y-2">
						<Notice tone="warning" title="Advanced">
							This file is JavaScript that runs as the cross-seed user (root in the community-script LXC). It is checked by loading it before it is saved, and the previous version is backed up.
						</Notice>
						<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={24} spellCheck={false} />
					</div>
				)}
			</Modal>
		</>
	);
}

export function SettingsTab() {
	const d = useDraft();
	const [advanced, setAdvanced] = useState(false);
	const [preview, setPreview] = useState(false);
	const loaded = d.loaded!;
	const groups = GROUPS.filter((g) => g.id !== "connections" && g.id !== "daemon");
	const hasLegacy = loaded.legacyKeys.length > 0;

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-sm text-ink-2">
					<Switch checked={advanced} onChange={setAdvanced} /> Show advanced options
				</label>
				<div className="ml-auto flex gap-2">
					<Button icon={<Eye size={14} />} onClick={() => setPreview(true)}>
						Preview file
					</Button>
					<RawEditor />
				</div>
			</div>
			{loaded.usesDynamicCode && (
				<Notice tone="warning" title="config.js contains code">
					It uses process.env, require or functions. The form shows the evaluated values; saving from the form writes plain values.
				</Notice>
			)}
			{loaded.unknownKeys.length > 0 && (
				<Notice tone="accent" title="Unknown keys">
					{loaded.unknownKeys.join(", ")}: cross-seed v6 ignores these. They are kept when saving.
				</Notice>
			)}
			{hasLegacy && (
				<Notice tone="warning" title="Deprecated options in use">
					{loaded.legacyKeys.join(", ")}. cross-seed still understands them but they should be migrated.
					{d.canEdit && (
						<div className="mt-2">
							<Button
								size="sm"
								icon={<Wand2 size={12} />}
								onClick={() => {
									const { config } = migrateLegacy(d.draft);
									for (const k of loaded.legacyKeys) config[k] = undefined;
									d.setMany(config);
								}}
							>
								Migrate to the new options
							</Button>
						</div>
					)}
				</Notice>
			)}
			{groups.map((g) => {
				const keys = OPTIONS.filter((o) => o.group === g.id && !HANDLED_ELSEWHERE.has(o.key))
					.filter((o) => advanced || !o.advanced || d.dirtyKeys.includes(o.key))
					.filter((o) => g.id !== "legacy" || (d.draft[o.key] !== undefined && d.draft[o.key] !== null))
					.map((o) => o.key);
				if (g.id === "blocklist") {
					return (
						<Card key={g.id} title={g.label} subtitle={g.description}>
							<BlocklistEditor />
						</Card>
					);
				}
				if (!keys.length) return null;
				return (
					<Card key={g.id} title={g.label} subtitle={g.description}>
						{keys.map((k) => (
							<OptionField key={k} k={k} />
						))}
					</Card>
				);
			})}
			<Modal open={preview} onClose={() => setPreview(false)} title="config.js that will be written" wide>
				<p className="mb-2 text-xs text-ink-3">Secrets are shown hidden here; the real values are kept on save.</p>
				<pre className="log-line max-h-[65vh] overflow-auto rounded-lg bg-surface-2 p-3">{renderConfigFile(d.draft)}</pre>
			</Modal>
		</div>
	);
}
