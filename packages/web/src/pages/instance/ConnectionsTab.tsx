import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CLIENT_URL_HINTS, maskSecret, OPTION_BY_KEY, parseClientEntry, REDACTED, TORRENT_CLIENT_TYPES, unmaskSecret } from "@csui/shared";
import { Button, Card, Input, Select, Switch } from "../../ui/index.tsx";
import { useDraft } from "./configDraft.tsx";
import { Issues, ListEditor, OptionField, OptionRow } from "./fields.tsx";
import { TestButton } from "./IndexersTab.tsx";

interface ClientParts {
	type: string;
	readonly: boolean;
	scheme: string;
	hostPath: string;
	username: string;
	password: string;
}

function splitClient(entry: string): ClientParts {
	const parsed = parseClientEntry(entry) ?? { clientType: "qbittorrent", readonly: false, url: entry };
	const m = /^(https?:)\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(.*)$/i.exec(parsed.url);
	const dec = (s?: string) => {
		if (!s) return "";
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	return {
		type: parsed.clientType,
		readonly: parsed.readonly,
		scheme: m?.[1] ?? "http:",
		username: dec(m?.[2]),
		password: m?.[3] === REDACTED ? REDACTED : dec(m?.[3]),
		hostPath: m?.[4] ?? parsed.url,
	};
}

function joinClient(p: ClientParts): string {
	const enc = (s: string) => (s === REDACTED ? s : encodeURIComponent(s));
	const auth = p.username || p.password ? `${enc(p.username)}${p.password ? `:${enc(p.password)}` : ""}@` : "";
	return `${p.type}:${p.readonly ? "readonly:" : ""}${p.scheme}//${auth}${p.hostPath}`;
}

function ClientRow({ entry, onChange, onRemove, disabled }: { entry: string; onChange: (v: string) => void; onRemove: () => void; disabled: boolean }) {
	const p = splitClient(entry);
	const set = (patch: Partial<ClientParts>) => onChange(joinClient({ ...p, ...patch }));
	const [editPw, setEditPw] = useState(false);
	return (
		<div className="rounded-lg border border-line p-3 space-y-3">
			<div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
				<Select value={p.type} disabled={disabled} onChange={(e) => set({ type: e.target.value })}>
					{TORRENT_CLIENT_TYPES.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</Select>
				<div className="flex gap-2">
					<Select value={p.scheme} disabled={disabled} className="w-24" onChange={(e) => set({ scheme: e.target.value })}>
						<option value="http:">http</option>
						<option value="https:">https</option>
					</Select>
					<Input
						value={p.hostPath}
						disabled={disabled}
						placeholder={CLIENT_URL_HINTS[p.type as keyof typeof CLIENT_URL_HINTS]?.replace(/^https?:\/\/[^@]*@/, "") ?? "host:port"}
						onChange={(e) => set({ hostPath: e.target.value })}
						className="font-mono text-xs"
					/>
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<Input value={p.username} disabled={disabled} placeholder={p.type === "deluge" ? "(not used by Deluge)" : "username"} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
				{p.password === REDACTED && !editPw ? (
					<div className="flex items-center gap-2">
						<Input value="••••••••" disabled readOnly />
						{!disabled && (
							<Button
								size="sm"
								onClick={() => {
									setEditPw(true);
									set({ password: "" });
								}}
							>
								Change
							</Button>
						)}
					</div>
				) : (
					<Input type="password" value={p.password === REDACTED ? "" : p.password} disabled={disabled} placeholder="password" onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
				)}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<label className="flex items-center gap-2 text-sm text-ink-2" title="Use as a source for matching only, never inject into it">
					<Switch checked={p.readonly} disabled={disabled} onChange={(v) => set({ readonly: v })} /> Read-only
				</label>
				<div className="flex items-center gap-2 min-w-0">
					<TestButton kind="client" value={entry} />
					{!disabled && (
						<Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={onRemove}>
							Remove
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function ClientsEditor() {
	const d = useDraft();
	const list = (d.draft.torrentClients as string[]) ?? [];
	const set = (v: string[]) => d.set("torrentClients", v);
	return (
		<OptionRow meta={OPTION_BY_KEY.torrentClients} dirty={d.dirtyKeys.includes("torrentClients")}>
			<div className="space-y-2">
				{list.map((e, i) => (
					<ClientRow key={i} entry={e} disabled={!d.canEdit} onChange={(v) => set(list.map((x, j) => (j === i ? v : x)))} onRemove={() => set(list.filter((_, j) => j !== i))} />
				))}
				{d.canEdit && (
					<Button icon={<Plus size={14} />} onClick={() => set([...list, "qbittorrent:http://localhost:8080"])}>
						Add torrent client
					</Button>
				)}
			</div>
		</OptionRow>
	);
}

/** Sonarr/Radarr entries are "http://host:port/?apikey=KEY" */
function ArrEditor({ k }: { k: "sonarr" | "radarr" }) {
	const d = useDraft();
	const list = (d.draft[k] as string[]) ?? [];
	const set = (v: string[]) => d.set(k, v);
	const split = (u: string) => {
		const m = /^(.*?)\/?\?apikey=([^&]*)/.exec(u);
		return m ? { base: m[1], key: m[2] } : { base: u, key: "" };
	};
	const join = (base: string, key: string) => `${base.replace(/\/+$/, "")}/?apikey=${key}`;
	const [newBase, setNewBase] = useState("");
	const [newKey, setNewKey] = useState("");
	return (
		<OptionRow meta={OPTION_BY_KEY[k]} dirty={d.dirtyKeys.includes(k)}>
			<div className="space-y-2">
				{list.map((u, i) => {
					const { base, key } = split(u);
					return (
						<div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto] items-center">
							<Input value={base} disabled={!d.canEdit} className="font-mono text-xs" onChange={(e) => set(list.map((x, j) => (j === i ? join(e.target.value, key) : x)))} />
							<Input
								type="password"
								value={key === REDACTED ? "••••••••" : key}
								disabled={!d.canEdit}
								onFocus={(e) => key === REDACTED && e.target.select()}
								onChange={(e) => set(list.map((x, j) => (j === i ? join(base, e.target.value.replace(/•/g, "")) : x)))}
								placeholder="API key"
							/>
							<div className="flex items-center gap-1">
								<TestButton kind={k} value={u} />
								{d.canEdit && (
									<button type="button" className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical" onClick={() => set(list.filter((_, j) => j !== i))} title="Remove">
										<Trash2 size={14} />
									</button>
								)}
							</div>
						</div>
					);
				})}
				{d.canEdit && (
					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto]">
						<Input value={newBase} onChange={(e) => setNewBase(e.target.value)} placeholder={k === "sonarr" ? "http://sonarr:8989" : "http://radarr:7878"} className="font-mono text-xs" />
						<Input type="password" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="API key" autoComplete="new-password" />
						<Button
							icon={<Plus size={14} />}
							disabled={!newBase.trim() || !newKey.trim()}
							onClick={() => {
								set([...list, join(newBase.trim(), newKey.trim())]);
								setNewBase("");
								setNewKey("");
							}}
						>
							Add
						</Button>
					</div>
				)}
				<Issues k={k} />
			</div>
		</OptionRow>
	);
}

export function ConnectionsTab() {
	const d = useDraft();
	return (
		<div className="space-y-5">
			<Card title="Torrent clients" subtitle="Where cross-seed reads your torrents from and injects matches into">
				<ClientsEditor />
				<OptionField k="useClientTorrents" />
			</Card>
			<Card title="Sonarr & Radarr" subtitle="Optional. cross-seed asks them for IMDB/TVDB/TMDB ids so indexers can search by id instead of by name.">
				<ArrEditor k="sonarr" />
				<ArrEditor k="radarr" />
			</Card>
			<Card title="Notifications" subtitle="Get told when cross-seed injects something or an injection fails">
				<OptionRow meta={OPTION_BY_KEY.notificationWebhookUrls} dirty={d.dirtyKeys.includes("notificationWebhookUrls")}>
					<ListEditor
						values={(d.draft.notificationWebhookUrls as string[]) ?? []}
						onChange={(v) => d.set("notificationWebhookUrls", v)}
						disabled={!d.canEdit}
						placeholder={OPTION_BY_KEY.notificationWebhookUrls.placeholder}
						render={(v, i) => (
							<div className="flex items-center gap-2 min-w-0">
								<Input
									value={maskSecret(v)}
									disabled={!d.canEdit}
									className="font-mono text-xs"
									onChange={(e) =>
										d.set(
											"notificationWebhookUrls",
											((d.draft.notificationWebhookUrls as string[]) ?? []).map((x, j) => (j === i ? unmaskSecret(e.target.value) : x)),
										)
									}
								/>
								<TestButton kind="notification" value={v} />
							</div>
						)}
					/>
				</OptionRow>
			</Card>
			<Card title="cross-seed API" subtitle="Used by autobrr (announce), *arr download-complete webhooks and this UI">
				<OptionField k="port" />
				<OptionField k="host" />
				<OptionField k="apiKey" />
			</Card>
		</div>
	);
}
