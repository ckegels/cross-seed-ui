/** Small UI kit: buttons, cards, inputs, modal, toasts, tabs... */
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import {
	type ButtonHTMLAttributes,
	createContext,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

export function cx(...c: (string | false | null | undefined)[]) {
	return c.filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ Button

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
	variant = "secondary",
	size = "md",
	loading,
	icon,
	children,
	className,
	disabled,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: Variant;
	size?: "sm" | "md";
	loading?: boolean;
	icon?: ReactNode;
}) {
	const base =
		"inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
	const sizes = { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5 text-sm" };
	const variants: Record<Variant, string> = {
		primary: "bg-accent text-white hover:brightness-110",
		secondary: "bg-surface-2 text-ink border border-line hover:bg-surface-3",
		ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
		danger: "bg-critical text-white hover:brightness-110",
	};
	return (
		<button
			type="button"
			className={cx(base, sizes[size], variants[variant], className)}
			disabled={disabled || loading}
			{...rest}
		>
			{loading ? <Loader2 size={size === "sm" ? 13 : 15} className="animate-spin" /> : icon}
			{children}
		</button>
	);
}

// ------------------------------------------------------------------ Card

export function Card({
	title,
	subtitle,
	actions,
	children,
	className,
	padded = true,
}: {
	title?: ReactNode;
	subtitle?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
	padded?: boolean;
}) {
	return (
		<section className={cx("card", className)}>
			{(title || actions) && (
				<header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-1">
					<div className="min-w-0">
						{title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
						{subtitle && <p className="text-xs text-ink-3 mt-0.5">{subtitle}</p>}
					</div>
					{actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
				</header>
			)}
			<div className={padded ? "p-4 pt-3" : ""}>{children}</div>
		</section>
	);
}

// ------------------------------------------------------------------ Badge

type Tone = "neutral" | "good" | "warning" | "critical" | "accent";

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
	const tones: Record<Tone, string> = {
		neutral: "bg-surface-2 text-ink-2 border-line",
		good: "bg-good/10 text-good-text border-good/25",
		warning: "bg-warning/15 text-warning-text border-warning/30",
		critical: "bg-critical-soft text-critical border-critical/25",
		accent: "bg-accent-soft text-accent border-accent/25",
	};
	return (
		<span title={title} className={cx("inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium whitespace-nowrap", tones[tone], className)}>
			{children}
		</span>
	);
}

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
	const c: Record<Tone, string> = {
		neutral: "bg-ink-3",
		good: "bg-good",
		warning: "bg-warning",
		critical: "bg-critical",
		accent: "bg-accent",
	};
	return <span className={cx("inline-block size-2 rounded-full shrink-0", c[tone], pulse && "pulse")} />;
}

// ------------------------------------------------------------------ inputs

const inputCls =
	"w-full h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
	return <input className={cx(inputCls, invalid && "border-critical", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={cx(inputCls, "h-auto py-2 font-mono text-xs leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select className={cx(inputCls, "pr-7", className)} {...rest}>
			{children}
		</select>
	);
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cx(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
				checked ? "bg-accent" : "bg-surface-3 border border-line",
			)}
		>
			<span className={cx("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
		</button>
	);
}

export function Field({
	label,
	hint,
	error,
	children,
	right,
}: {
	label: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	children: ReactNode;
	right?: ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-2">
				<label className="text-[13px] font-medium text-ink">{label}</label>
				{right}
			</div>
			{children}
			{error ? <p className="text-xs text-critical">{error}</p> : hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
		</div>
	);
}

// ------------------------------------------------------------------ feedback

export function Spinner({ label }: { label?: string }) {
	return (
		<div className="flex items-center gap-2 text-ink-3 text-sm p-4">
			<Loader2 size={16} className="animate-spin" /> {label ?? "Loading…"}
		</div>
	);
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
	if (!error) return null;
	const msg = error instanceof Error ? error.message : String(error);
	return (
		<div className="flex items-start gap-2 rounded-lg border border-critical/30 bg-critical-soft p-3 text-sm text-ink">
			<XCircle size={16} className="text-critical mt-0.5 shrink-0" />
			<div className="flex-1 whitespace-pre-wrap break-words">{msg}</div>
			{retry && (
				<Button size="sm" onClick={retry}>
					Retry
				</Button>
			)}
		</div>
	);
}

export function Notice({ tone = "accent", title, children }: { tone?: "accent" | "warning" | "critical" | "good"; title?: ReactNode; children?: ReactNode }) {
	const map = {
		accent: { cls: "border-accent/25 bg-accent-soft", icon: <Info size={16} className="text-accent" /> },
		warning: { cls: "border-warning/35 bg-warning/10", icon: <AlertTriangle size={16} className="text-warning-text" /> },
		critical: { cls: "border-critical/30 bg-critical-soft", icon: <XCircle size={16} className="text-critical" /> },
		good: { cls: "border-good/30 bg-good/10", icon: <CheckCircle2 size={16} className="text-good-text" /> },
	}[tone];
	return (
		<div className={cx("flex gap-2.5 rounded-lg border p-3 text-sm", map.cls)}>
			<div className="mt-0.5 shrink-0">{map.icon}</div>
			<div className="min-w-0 flex-1 space-y-1">
				{title && <div className="font-medium text-ink">{title}</div>}
				{children && <div className="text-ink-2">{children}</div>}
			</div>
		</div>
	);
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center text-center py-10 px-4 gap-2">
			{icon && <div className="text-ink-3">{icon}</div>}
			<div className="font-medium text-ink">{title}</div>
			{children && <div className="text-sm text-ink-3 max-w-md">{children}</div>}
		</div>
	);
}

// ------------------------------------------------------------------ modal

export function Modal({
	open,
	onClose,
	title,
	children,
	footer,
	wide,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	wide?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);
	return (
		<dialog
			ref={ref}
			onClose={onClose}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			className={cx(
				"m-auto rounded-xl border border-line bg-surface text-ink p-0 shadow-2xl backdrop:bg-black/50 w-[calc(100%-32px)]",
				wide ? "max-w-3xl" : "max-w-lg",
			)}
		>
			{open && (
				<div className="flex max-h-[85vh] flex-col">
					<div className="flex items-center justify-between border-b border-line px-4 py-3">
						<h3 className="font-semibold">{title}</h3>
						<button type="button" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
							<X size={16} />
						</button>
					</div>
					<div className="overflow-y-auto p-4">{children}</div>
					{footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
				</div>
			)}
		</dialog>
	);
}

// ------------------------------------------------------------------ toasts

interface Toast {
	id: number;
	tone: "good" | "critical" | "accent" | "warning";
	text: string;
}
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const push = useCallback((tone: Toast["tone"], text: string) => {
		const id = Date.now() + Math.random();
		setToasts((t) => [...t, { id, tone, text }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "critical" ? 9000 : 4500);
	}, []);
	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
				{toasts.map((t) => (
					<div key={t.id} className="card flex items-start gap-2 p-3 text-sm">
						{t.tone === "good" && <CheckCircle2 size={16} className="text-good-text mt-0.5 shrink-0" />}
						{t.tone === "critical" && <XCircle size={16} className="text-critical mt-0.5 shrink-0" />}
						{t.tone === "warning" && <AlertTriangle size={16} className="text-warning-text mt-0.5 shrink-0" />}
						{t.tone === "accent" && <Info size={16} className="text-accent mt-0.5 shrink-0" />}
						<div className="flex-1 whitespace-pre-wrap break-words">{t.text}</div>
						<button type="button" className="text-ink-3" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
							<X size={14} />
						</button>
					</div>
				))}
			</div>
		</ToastCtx.Provider>
	);
}

export function useToast() {
	return useContext(ToastCtx);
}

// ------------------------------------------------------------------ tabs

export function Tabs<T extends string>({
	tabs,
	value,
	onChange,
}: {
	tabs: { id: T; label: ReactNode; icon?: ReactNode }[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<div className="flex gap-1 overflow-x-auto border-b border-line -mx-1 px-1" role="tablist">
			{tabs.map((t) => (
				<button
					key={t.id}
					role="tab"
					type="button"
					aria-selected={value === t.id}
					onClick={() => onChange(t.id)}
					className={cx(
						"flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
						value === t.id ? "border-accent text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink",
					)}
				>
					{t.icon}
					{t.label}
				</button>
			))}
		</div>
	);
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
	return (
		<div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					onClick={() => onChange(o.id)}
					className={cx("rounded-md px-2.5 py-1 text-xs font-medium", value === o.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

// ------------------------------------------------------------------ confirm

export function useConfirm() {
	const [state, setState] = useState<{ title: string; body: ReactNode; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void } | null>(null);
	const confirm = useCallback(
		(opts: { title: string; body: ReactNode; danger?: boolean; confirmLabel?: string }) =>
			new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
		[],
	);
	const dialog = (
		<Modal
			open={!!state}
			onClose={() => {
				state?.resolve(false);
				setState(null);
			}}
			title={state?.title ?? ""}
			footer={
				<>
					<Button
						onClick={() => {
							state?.resolve(false);
							setState(null);
						}}
					>
						Cancel
					</Button>
					<Button
						variant={state?.danger ? "danger" : "primary"}
						onClick={() => {
							state?.resolve(true);
							setState(null);
						}}
					>
						{state?.confirmLabel ?? "Confirm"}
					</Button>
				</>
			}
		>
			<div className="text-sm text-ink-2">{state?.body}</div>
		</Modal>
	);
	return { confirm, dialog };
}

export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-3 py-1.5 text-sm border-b border-line last:border-0">
			<span className="text-ink-3 shrink-0">{k}</span>
			<span className="text-ink text-right min-w-0 truncate">{v}</span>
		</div>
	);
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (o: number) => void }) {
	if (total <= limit) return <div className="text-xs text-ink-3">{total} {total === 1 ? "item" : "items"}</div>;
	return (
		<div className="flex items-center gap-2 text-xs text-ink-3">
			<span className="tabular">
				{offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}
			</span>
			<Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
				Previous
			</Button>
			<Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
				Next
			</Button>
		</div>
	);
}
