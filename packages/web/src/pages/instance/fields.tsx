/** Form editors generated from the shared option metadata. */
import { ArrowUp, ChevronRight, ExternalLink, Folder, FolderOpen, GripVertical, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { maskSecret, OPTION_BY_KEY, type OptionMeta, parseDuration, REDACTED, unmaskSecret } from "@csui/shared";
import { api, inst, qs } from "../../api.ts";
import { duration, bytes } from "../../format.ts";
import { Badge, Button, cx, Input, Modal, Spinner, Switch, ErrorBox } from "../../ui/index.tsx";
import { useDraft, useIssuesFor } from "./configDraft.tsx";

export function Issues({ k }: { k: string }) {
	const { errors, warnings } = useIssuesFor(k);
	if (!errors.length && !warnings.length) return null;
	return (
		<div className="space-y-1">
			{errors.map((e, i) => (
				<p key={`e${i}`} className="text-xs text-critical whitespace-pre-wrap">
					{e.message}
				</p>
			))}
			{warnings.map((w, i) => (
				<p key={`w${i}`} className="text-xs text-warning-text whitespace-pre-wrap">
					{w.message}
				</p>
			))}
		</div>
	);
}

export function OptionRow({ meta, children, dirty }: { meta: OptionMeta; children: ReactNode; dirty?: boolean }) {
	return (
		<div className="grid gap-2 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-6 border-b border-line last:border-0">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{meta.label}</span>
					{dirty && <Badge tone="accent">changed</Badge>}
					{meta.deprecated && <Badge tone="warning">deprecated</Badge>}
				</div>
				<div className="mt-0.5 text-xs font-mono text-ink-3">{meta.key}</div>
				<p className="mt-1 text-xs leading-relaxed text-ink-2">{meta.description}</p>
				{meta.docs && (
					<a href={meta.docs} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
						Docs <ExternalLink size={11} />
					</a>
				)}
			</div>
			<div className="min-w-0 space-y-1.5 md:pt-0.5">
				{children}
				<Issues k={meta.key} />
			</div>
		</div>
	);
}

/** Generic editor for one option key. */
export function OptionField({ k }: { k: string }) {
	const d = useDraft();
	const meta = OPTION_BY_KEY[k];
	if (!meta) return null;
	const value = d.draft[k];
	const dirty = d.dirtyKeys.includes(k);
	const disabled = !d.canEdit;
	const set = (v: unknown) => d.set(k, v);
	const isNull = value === null || (value === undefined && meta.cliDefault === undefined) || value === false && meta.type !== "boolean";

	let editor: ReactNode;
	switch (meta.type) {
		case "boolean":
			editor = (
				<div className="flex items-center gap-2">
					<Switch checked={value === true || (value === undefined && meta.cliDefault === true)} onChange={set} disabled={disabled} label={meta.label} />
					<span className="text-sm text-ink-2">{value === true || (value === undefined && meta.cliDefault === true) ? "On" : "Off"}</span>
					{value === undefined && <span className="text-xs text-ink-3">(not in file, default)</span>}
				</div>
			);
			break;
		case "enum":
			editor = (
				<div className="grid gap-2 sm:grid-cols-2">
					{meta.choices!.map((c) => {
						const active = (value ?? meta.cliDefault) === c.value;
						return (
							<button
								key={c.value}
								type="button"
								disabled={disabled}
								onClick={() => set(c.value)}
								className={cx(
									"rounded-lg border px-3 py-2 text-left transition-colors",
									active ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
								)}
							>
								<div className="text-sm font-medium">{c.label}</div>
								{c.description && <div className="text-xs text-ink-3 mt-0.5">{c.description}</div>}
							</button>
						);
					})}
				</div>
			);
			break;
		case "number":
		case "integer":
			editor = (
				<Nullable meta={meta} isNull={isNull} disabled={disabled} onNull={(n) => set(n ? null : (meta.templateDefault ?? meta.min ?? 0))}>
					<div className="flex items-center gap-2">
						<Input
							type="number"
							className="max-w-48 tabular"
							value={typeof value === "number" ? value : ""}
							min={meta.min}
							max={meta.max}
							step={meta.step ?? (meta.type === "integer" ? 1 : "any")}
							disabled={disabled}
							onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))}
						/>
						{meta.unit && <span className="text-xs text-ink-3">{meta.unit}</span>}
						{meta.unit === "bytes" && typeof value === "number" && <span className="text-xs text-ink-3">= {bytes(value)}</span>}
					</div>
				</Nullable>
			);
			break;
		case "duration": {
			const parsed = typeof value === "string" ? parseDuration(value) : NaN;
			editor = (
				<Nullable meta={meta} isNull={isNull} disabled={disabled} onNull={(n) => set(n ? null : (meta.templateDefault ?? meta.placeholder ?? "1 day"))}>
					<div className="flex items-center gap-2">
						<Input className="max-w-48" value={typeof value === "string" ? value : ""} placeholder={meta.placeholder} disabled={disabled} onChange={(e) => set(e.target.value)} />
						<span className="text-xs text-ink-3">{Number.isFinite(parsed) ? `= ${duration(parsed, 3)}` : typeof value === "string" && value ? "not a duration" : ""}</span>
					</div>
				</Nullable>
			);
			break;
		}
		case "path":
			editor = (
				<Nullable meta={meta} isNull={isNull} disabled={disabled} onNull={(n) => set(n ? null : "")}>
					<PathInput value={typeof value === "string" ? value : ""} onChange={set} disabled={disabled} />
				</Nullable>
			);
			break;
		case "pathList":
			editor = <ListEditor values={(value as string[]) ?? []} onChange={set} disabled={disabled} placeholder={meta.placeholder} path />;
			break;
		case "stringList":
		case "urlList":
			editor = <ListEditor values={(value as string[]) ?? []} onChange={set} disabled={disabled} placeholder={meta.placeholder} />;
			break;
		default:
			editor = (
				<Nullable meta={meta} isNull={isNull} disabled={disabled} onNull={(n) => set(n ? null : "")}>
					<Input
						value={typeof value === "string" ? value : ""}
						placeholder={meta.placeholder}
						disabled={disabled || value === REDACTED}
						onChange={(e) => set(e.target.value)}
						type={meta.secret ? "password" : "text"}
						autoComplete="off"
					/>
					{value === REDACTED && <p className="text-xs text-ink-3">Hidden. Clear it to type a new value.</p>}
				</Nullable>
			);
	}
	return (
		<OptionRow meta={meta} dirty={dirty}>
			{editor}
		</OptionRow>
	);
}

function Nullable({ meta, isNull, onNull, disabled, children }: { meta: OptionMeta; isNull: boolean; onNull: (n: boolean) => void; disabled?: boolean; children: ReactNode }) {
	if (!meta.nullable) return <>{children}</>;
	return (
		<div className="space-y-2">
			<label className="flex items-center gap-2 text-sm text-ink-2">
				<input type="checkbox" checked={isNull} disabled={disabled} onChange={(e) => onNull(e.target.checked)} />
				{meta.nullLabel ?? "Not set"}
			</label>
			{!isNull && children}
		</div>
	);
}

export function ListEditor({
	values,
	onChange,
	disabled,
	placeholder,
	path,
	render,
}: {
	values: string[];
	onChange: (v: string[]) => void;
	disabled?: boolean;
	placeholder?: string;
	path?: boolean;
	render?: (v: string, i: number) => ReactNode;
}) {
	const [adding, setAdding] = useState("");
	const update = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)));
	const remove = (i: number) => onChange(values.filter((_, j) => j !== i));
	const up = (i: number) => {
		if (i === 0) return;
		const next = [...values];
		[next[i - 1], next[i]] = [next[i], next[i - 1]];
		onChange(next);
	};
	const add = () => {
		const v = adding.trim();
		if (!v) return;
		onChange([...values, v]);
		setAdding("");
	};
	return (
		<div className="space-y-2">
			{values.map((v, i) => (
				<div key={i} className="flex items-center gap-1.5">
					<GripVertical size={14} className="text-ink-3 shrink-0 hidden sm:block" />
					{render ? (
						<div className="flex-1 min-w-0">{render(v, i)}</div>
					) : path ? (
						<div className="flex-1 min-w-0">
							<PathInput value={v} onChange={(nv) => update(i, nv)} disabled={disabled} />
						</div>
					) : (
						<Input value={maskSecret(v)} onChange={(e) => update(i, unmaskSecret(e.target.value))} disabled={disabled} className="font-mono text-xs" />
					)}
					<button type="button" title="Move up" disabled={disabled || i === 0} onClick={() => up(i)} className="rounded p-1.5 text-ink-3 hover:bg-surface-2 disabled:opacity-30">
						<ArrowUp size={14} />
					</button>
					<button type="button" title="Remove" disabled={disabled} onClick={() => remove(i)} className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical">
						<Trash2 size={14} />
					</button>
				</div>
			))}
			{!disabled && (
				<div className="flex items-center gap-1.5">
					{path ? (
						<div className="flex-1">
							<PathInput value={adding} onChange={setAdding} placeholder={placeholder} onEnter={add} />
						</div>
					) : (
						<Input
							value={adding}
							placeholder={placeholder}
							onChange={(e) => setAdding(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
							className="font-mono text-xs"
						/>
					)}
					<Button icon={<Plus size={14} />} onClick={add} disabled={!adding.trim()}>
						Add
					</Button>
				</div>
			)}
			{!values.length && disabled && <p className="text-sm text-ink-3">None</p>}
		</div>
	);
}

export function PathInput({
	value,
	onChange,
	disabled,
	placeholder,
	onEnter,
}: {
	value: string;
	onChange: (v: string) => void;
	disabled?: boolean;
	placeholder?: string;
	onEnter?: () => void;
}) {
	const [browse, setBrowse] = useState(false);
	return (
		<div className="flex items-center gap-1.5">
			<Input
				value={value}
				placeholder={placeholder ?? "/path/on/the/lxc"}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => onEnter && e.key === "Enter" && (e.preventDefault(), onEnter())}
				className="font-mono text-xs"
			/>
			{!disabled && (
				<Button icon={<FolderOpen size={14} />} onClick={() => setBrowse(true)} title="Browse folders on this instance">
					<span className="hidden sm:inline">Browse</span>
				</Button>
			)}
			{browse && <DirBrowser start={value || "/"} onClose={() => setBrowse(false)} onPick={(p) => (onChange(p), setBrowse(false))} />}
		</div>
	);
}

interface DirListing {
	path: string;
	parent: string | null;
	dirs: { name: string; path: string }[];
	freeBytes: number | null;
}

function DirBrowser({ start, onPick, onClose }: { start: string; onPick: (p: string) => void; onClose: () => void }) {
	const { instanceId } = useDraft();
	const [listing, setListing] = useState<DirListing | null>(null);
	const [error, setError] = useState<unknown>(null);
	const load = async (p: string) => {
		setError(null);
		try {
			setListing(await api.get<DirListing>(inst(instanceId, `fs/dirs${qs({ path: p })}`)));
		} catch (e) {
			setError(e);
			if (!listing) setListing(await api.get<DirListing>(inst(instanceId, "fs/dirs?path=/")).catch(() => null));
		}
	};
	useEffect(() => {
		void load(start);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<Modal
			open
			onClose={onClose}
			title="Choose a folder"
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
						Use this folder
					</Button>
				</>
			}
		>
			{error ? <ErrorBox error={error} /> : null}
			{!listing ? (
				<Spinner />
			) : (
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
						<code className="text-xs break-all">{listing.path}</code>
						{listing.freeBytes !== null && <span className="text-xs text-ink-3 shrink-0">{bytes(listing.freeBytes)} free</span>}
					</div>
					<div className="max-h-80 overflow-y-auto rounded-lg border border-line divide-y divide-line">
						{listing.parent && (
							<button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => load(listing.parent!)}>
								<Folder size={14} className="text-ink-3" /> ..
							</button>
						)}
						{listing.dirs.map((dd) => (
							<button key={dd.path} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => load(dd.path)}>
								<Folder size={14} className="text-accent" />
								<span className="flex-1 truncate">{dd.name}</span>
								<ChevronRight size={14} className="text-ink-3" />
							</button>
						))}
						{!listing.dirs.length && <div className="px-3 py-3 text-sm text-ink-3">No sub-folders</div>}
					</div>
				</div>
			)}
		</Modal>
	);
}
