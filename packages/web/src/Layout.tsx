import { Activity as ActivityIcon, LayoutDashboard, ListTree, LogOut, Menu, Moon, Plus, Settings, Sun, SunMoon, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Activity } from "@csui/shared";
import { api, inst } from "./api.ts";
import { useLocalStorage } from "./hooks.ts";
import { Link, usePath } from "./router.tsx";
import { instanceColor, useApp } from "./state.tsx";
import { cx } from "./ui/index.tsx";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
	const [theme, setTheme] = useLocalStorage<Theme>("csui.theme", "system");
	useEffect(() => {
		if (theme === "system") document.documentElement.removeAttribute("data-theme");
		else document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);
	return [theme, setTheme];
}

export const STATE_LABEL: Record<string, string> = {
	idle: "Idle",
	searching: "Searching",
	rss: "RSS scan",
	injecting: "Injecting",
	cleanup: "Cleanup",
	caps: "Updating caps",
	stopped: "Stopped",
	offline: "Agent offline",
};

export function stateTone(state: string): "good" | "accent" | "warning" | "critical" | "neutral" {
	if (state === "stopped" || state === "offline") return "critical";
	if (state === "idle") return "good";
	return "accent";
}

function useActivities(ids: number[]) {
	const [map, setMap] = useState<Record<number, string>>({});
	const key = ids.join(",");
	useEffect(() => {
		let alive = true;
		const tick = async () => {
			const entries = await Promise.all(
				ids.map(async (id) => {
					try {
						const a = await api.get<Activity>(inst(id, "activity"));
						return [id, a.state] as const;
					} catch {
						return [id, "offline"] as const;
					}
				}),
			);
			if (alive) setMap(Object.fromEntries(entries));
		};
		void tick();
		const t = setInterval(() => document.visibilityState === "visible" && void tick(), 10_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return map;
}

function NavItem({ to, icon, children, active, onNavigate }: { to: string; icon: ReactNode; children: ReactNode; active: boolean; onNavigate: () => void }) {
	return (
		<Link
			to={to}
			onClick={onNavigate}
			className={cx(
				"flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
				active ? "bg-surface-2 text-ink font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
			)}
		>
			{icon}
			<span className="truncate flex-1">{children}</span>
		</Link>
	);
}

export function Layout({ children }: { children: ReactNode }) {
	const { auth, instances, refreshAuth, isAdmin } = useApp();
	const { path } = usePath();
	const [theme, setTheme] = useTheme();
	const [open, setOpen] = useState(false);
	const states = useActivities(instances.map((i) => i.id));
	const close = () => setOpen(false);

	const logout = async () => {
		await api.post("/api/auth/logout").catch(() => {});
		await refreshAuth();
	};

	const sidebar = (
		<nav className="flex h-full flex-col gap-4 p-3">
			<Link to="/" onClick={close} className="flex items-center gap-2.5 px-1.5 py-1">
				<img src="/favicon.svg" alt="" className="size-7" />
				<div className="leading-tight">
					<div className="font-semibold text-[15px]">cross-seed UI</div>
					<div className="text-[11px] text-ink-3">v{auth?.version}</div>
				</div>
			</Link>
			<div className="space-y-0.5">
				<NavItem to="/" icon={<LayoutDashboard size={16} />} active={path === "/"} onNavigate={close}>
					Overview
				</NavItem>
				<NavItem to="/indexers" icon={<ListTree size={16} />} active={path.startsWith("/indexers")} onNavigate={close}>
					Indexers
				</NavItem>
			</div>
			<div>
				<div className="flex items-center justify-between px-2.5 pb-1">
					<span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Instances</span>
					{isAdmin && (
						<Link to="/settings/instances" onClick={close} className="text-ink-3 hover:text-ink" title="Add instance">
							<Plus size={14} />
						</Link>
					)}
				</div>
				<div className="space-y-0.5">
					{instances.map((i) => {
						const st = states[i.id];
						return (
							<NavItem key={i.id} to={`/i/${i.id}`} active={path.startsWith(`/i/${i.id}/`) || path === `/i/${i.id}`} onNavigate={close} icon={<span className="inline-block size-2.5 rounded-[3px]" style={{ background: instanceColor(i.id) }} />}>
								<span className="flex items-center justify-between gap-2">
									<span className="truncate">{i.name}</span>
									{st && (
										<span className={cx("text-[11px] flex items-center gap-1", st === "idle" ? "text-ink-3" : stateTone(st) === "critical" ? "text-critical" : "text-accent")}>
											{st !== "idle" && st !== "offline" && st !== "stopped" && <ActivityIcon size={11} className="pulse" />}
											{STATE_LABEL[st] ?? st}
										</span>
									)}
								</span>
							</NavItem>
						);
					})}
					{!instances.length && <div className="px-2.5 py-1 text-xs text-ink-3">No instances yet</div>}
				</div>
			</div>
			<div className="mt-auto space-y-0.5">
				<NavItem to="/settings" icon={<Settings size={16} />} active={path.startsWith("/settings")} onNavigate={close}>
					Settings
				</NavItem>
				<div className="flex items-center gap-1 px-1 pt-2 border-t border-line">
					<div className="flex-1 min-w-0 px-1.5">
						<div className="text-sm truncate">{auth?.user?.username}</div>
						<div className="text-[11px] text-ink-3">{auth?.user?.role}</div>
					</div>
					<button
						type="button"
						className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
						title={`Theme: ${theme}`}
						onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}
					>
						{theme === "system" ? <SunMoon size={16} /> : theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
					</button>
					<button type="button" className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" title="Sign out" onClick={logout}>
						<LogOut size={16} />
					</button>
				</div>
			</div>
		</nav>
	);

	return (
		<div className="flex min-h-full">
			<aside className="hidden lg:block w-60 shrink-0 border-r border-line bg-surface sticky top-0 h-screen">{sidebar}</aside>
			{open && (
				<div className="fixed inset-0 z-40 lg:hidden">
					<div className="absolute inset-0 bg-black/40" onClick={close} />
					<aside className="absolute left-0 top-0 h-full w-64 bg-surface border-r border-line">{sidebar}</aside>
				</div>
			)}
			<div className="flex-1 min-w-0">
				<div className="lg:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/90 backdrop-blur px-4 h-12">
					<button type="button" onClick={() => setOpen(!open)} className="p-1 -ml-1 text-ink-2" aria-label="Menu">
						{open ? <X size={20} /> : <Menu size={20} />}
					</button>
					<img src="/favicon.svg" alt="" className="size-6" />
					<span className="font-semibold">cross-seed UI</span>
				</div>
				<main className="mx-auto max-w-[1400px] px-4 py-5 lg:px-8 lg:py-7">{children}</main>
			</div>
		</div>
	);
}

export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
	return (
		<div className="mb-5 flex flex-wrap items-end justify-between gap-3">
			<div className="min-w-0">
				<h1 className="flex items-center gap-2 text-xl font-semibold">
					{icon}
					{title}
				</h1>
				{subtitle && <div className="mt-0.5 text-sm text-ink-3">{subtitle}</div>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
