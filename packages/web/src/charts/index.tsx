/**
 * Hand-rolled SVG charts following the dataviz rules:
 * thin columns (<= 24px) with 4px rounded data-ends, 2px surface gaps between
 * stacked segments, hairline solid grid, legend for >= 2 series, hover tooltip
 * per column (values lead, line keys), text never in series colors.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { compact, num, shortDay } from "../format.ts";
import { cx } from "../ui/index.tsx";

/** Fixed categorical order (never cycled past 8). */
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [w, setW] = useState(0);
	useEffect(() => {
		if (!ref.current) return;
		const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
		ro.observe(ref.current);
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

function niceMax(v: number): number {
	if (v <= 0) return 4;
	const exp = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [1, 2, 2.5, 5, 10]) {
		if (m * exp >= v) return m * exp;
	}
	return 10 * exp;
}

/** rect with only the top corners rounded (data-end), square at the baseline */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
	const rr = Math.min(r, w / 2, h);
	return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface Series {
	key: string;
	label: string;
	color: string;
}

export function Legend({ series, className }: { series: Series[]; className?: string }) {
	if (series.length < 2) return null;
	return (
		<div className={cx("flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2", className)}>
			{series.map((s) => (
				<span key={s.key} className="inline-flex items-center gap-1.5">
					<span className="inline-block size-2.5 rounded-[3px]" style={{ background: s.color }} />
					{s.label}
				</span>
			))}
		</div>
	);
}

export function ColumnChart({
	data,
	series,
	height = 180,
	emptyText = "No data yet",
	formatX = shortDay,
}: {
	data: { x: string; values: Record<string, number> }[];
	series: Series[];
	height?: number;
	emptyText?: string;
	formatX?: (x: string) => string;
}) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);
	const padL = 36;
	const padB = 22;
	const padT = 8;
	const plotW = Math.max(0, width - padL - 4);
	const plotH = height - padB - padT;
	const totals = data.map((d) => series.reduce((a, s) => a + (d.values[s.key] ?? 0), 0));
	const max = niceMax(Math.max(0, ...totals));
	const band = data.length ? plotW / data.length : 0;
	const barW = Math.max(2, Math.min(24, band * 0.62));
	const ticks = [0, max / 2, max];
	const allZero = totals.every((t) => t === 0);
	const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));

	return (
		<div className="space-y-2">
			<Legend series={series} />
			<div ref={ref} className="relative" style={{ height }} onPointerLeave={() => setHover(null)}>
				{width > 0 && (
					<svg width={width} height={height} role="img" aria-label="Column chart" className="block overflow-visible">
						{ticks.map((t) => {
							const y = padT + plotH - (t / max) * plotH;
							return (
								<g key={t}>
									<line x1={padL} x2={width} y1={y} y2={y} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
									<text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="var(--text-3)" className="tabular">
										{compact(t)}
									</text>
								</g>
							);
						})}
						{data.map((d, i) => {
							const cxm = padL + band * i + band / 2;
							let yCursor = padT + plotH;
							const nonZero = series.filter((s) => (d.values[s.key] ?? 0) > 0);
							return (
								<g key={d.x} opacity={hover === null || hover === i ? 1 : 0.55}>
									{nonZero.map((s, si) => {
										const v = d.values[s.key] ?? 0;
										const h = (v / max) * plotH;
										const isTop = si === nonZero.length - 1;
										const gap = si > 0 ? 2 : 0;
										const y = yCursor - h;
										const segH = Math.max(0, h - gap);
										yCursor = y;
										if (segH <= 0) return null;
										return isTop ? (
											<path key={s.key} d={topRounded(cxm - barW / 2, y, barW, segH, 4)} fill={s.color} />
										) : (
											<rect key={s.key} x={cxm - barW / 2} y={y} width={barW} height={segH} fill={s.color} />
										);
									})}
									{i % labelEvery === 0 && (
										<text x={cxm} y={height - 6} textAnchor="middle" fontSize={10.5} fill="var(--text-3)">
											{formatX(d.x)}
										</text>
									)}
									<rect
										x={padL + band * i}
										y={padT}
										width={band}
										height={plotH}
										fill="transparent"
										onPointerEnter={() => setHover(i)}
										onFocus={() => setHover(i)}
										tabIndex={-1}
									/>
								</g>
							);
						})}
					</svg>
				)}
				{allZero && width > 0 && (
					<div className="absolute inset-0 flex items-center justify-center text-xs text-ink-3 pointer-events-none" style={{ paddingLeft: padL }}>
						{emptyText}
					</div>
				)}
				{hover !== null && data[hover] && !allZero && (
					<Tooltip
						x={Math.min(Math.max(padL + band * hover + band / 2, 80), width - 80)}
						title={formatX(data[hover].x)}
						rows={series.map((s) => ({ color: s.color, label: s.label, value: num(data[hover].values[s.key] ?? 0) }))}
						total={series.length > 1 ? num(totals[hover]) : undefined}
					/>
				)}
			</div>
		</div>
	);
}

function Tooltip({ x, title, rows, total }: { x: number; title: string; rows: { color: string; label: string; value: string }[]; total?: string }) {
	return (
		<div
			className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-lg border border-line bg-surface px-2.5 py-2 text-xs shadow-lg min-w-36"
			style={{ left: x }}
		>
			<div className="mb-1 text-ink-3">{title}</div>
			{rows.map((r) => (
				<div key={r.label} className="flex items-center gap-2 py-0.5">
					<span className="inline-block h-0.5 w-3 rounded" style={{ background: r.color }} />
					<span className="font-semibold text-ink tabular">{r.value}</span>
					<span className="text-ink-2">{r.label}</span>
				</div>
			))}
			{total !== undefined && (
				<div className="mt-1 border-t border-line pt-1 flex items-center gap-2">
					<span className="font-semibold text-ink tabular">{total}</span>
					<span className="text-ink-3">total</span>
				</div>
			)}
		</div>
	);
}

/** Horizontal bars, one series (slot 1), values at the bar end in text ink. */
export function BarList({
	items,
	color = SERIES[0],
	max: maxProp,
	valueFormat = num,
	empty = "Nothing yet",
	limit = 10,
}: {
	items: { label: ReactNode; value: number; sub?: ReactNode; key: string; title?: string }[];
	color?: string;
	max?: number;
	valueFormat?: (n: number) => string;
	empty?: string;
	limit?: number;
}) {
	const [showAll, setShowAll] = useState(false);
	const list = showAll ? items : items.slice(0, limit);
	const max = maxProp ?? Math.max(1, ...items.map((i) => i.value));
	if (!items.length) return <div className="text-sm text-ink-3 py-4">{empty}</div>;
	return (
		<div className="space-y-2">
			{list.map((it) => (
				<div key={it.key} className="group" title={it.title}>
					<div className="flex items-baseline justify-between gap-3 text-[13px]">
						<span className="truncate text-ink">{it.label}</span>
						<span className="tabular font-medium text-ink shrink-0">{valueFormat(it.value)}</span>
					</div>
					<div className="mt-1 h-2 rounded-full bg-surface-2 overflow-hidden">
						<div className="h-full rounded-full" style={{ width: `${Math.max(it.value > 0 ? 1.5 : 0, (it.value / max) * 100)}%`, background: color }} />
					</div>
					{it.sub && <div className="mt-0.5 text-[11px] text-ink-3">{it.sub}</div>}
				</div>
			))}
			{items.length > limit && (
				<button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowAll(!showAll)}>
					{showAll ? "Show less" : `Show all ${items.length}`}
				</button>
			)}
		</div>
	);
}

/** Stacked share bar for part-to-whole with a legend underneath. */
export function ShareBar({ parts }: { parts: { key: string; label: string; value: number; color: string }[] }) {
	const total = parts.reduce((a, p) => a + p.value, 0);
	const visible = parts.filter((p) => p.value > 0);
	return (
		<div className="space-y-2">
			<div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2">
				{visible.map((p) => (
					<div key={p.key} title={`${p.label}: ${num(p.value)}`} style={{ width: `${(p.value / Math.max(1, total)) * 100}%`, background: p.color }} />
				))}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
				{parts.map((p) => (
					<span key={p.key} className="inline-flex items-center gap-1.5">
						<span className="inline-block size-2.5 rounded-[3px]" style={{ background: p.color }} />
						{p.label} <span className="font-medium text-ink tabular">{num(p.value)}</span>
					</span>
				))}
			</div>
		</div>
	);
}

export function Sparkline({ values, color = "var(--text-3)", accent = SERIES[0], height = 28 }: { values: number[]; color?: string; accent?: string; height?: number }) {
	const w = 96;
	const max = Math.max(1, ...values);
	const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * (w - 4) + 2, height - 3 - (v / max) * (height - 6)]);
	const d = useMemo(() => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(""), [pts]);
	if (values.length < 2) return null;
	const last = pts[pts.length - 1];
	return (
		<svg width={w} height={height} aria-hidden className="overflow-visible">
			<path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
			<circle cx={last[0]} cy={last[1]} r={3} fill={accent} stroke="var(--surface)" strokeWidth={2} />
		</svg>
	);
}

export function StatTile({
	label,
	value,
	sub,
	trend,
	icon,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	trend?: number[];
	icon?: ReactNode;
}) {
	return (
		<div className="card p-4 flex flex-col gap-1 min-w-0">
			<div className="flex items-center gap-1.5 text-xs text-ink-3">
				{icon}
				<span className="truncate">{label}</span>
			</div>
			<div className="flex items-end justify-between gap-2">
				<div className="text-2xl font-semibold text-ink leading-tight">{value}</div>
				{trend && <Sparkline values={trend} />}
			</div>
			{sub && <div className="text-xs text-ink-3 truncate">{sub}</div>}
		</div>
	);
}

export function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "warning" | "critical" }) {
	const p = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
	const color = { accent: "var(--accent)", warning: "var(--warning)", critical: "var(--critical)" }[tone];
	return (
		<div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: "var(--accent-soft)" }}>
			<div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
		</div>
	);
}
