import { Activity as ActivityIcon, Cable, Gauge, History, Library, ListTree, SlidersHorizontal, Wrench } from "lucide-react";
import { navigate, usePath } from "../../router.tsx";
import { instanceColor, useApp } from "../../state.tsx";
import type { Activity, AgentInfo } from "@csui/shared";
import { Loader2 } from "lucide-react";
import { inst } from "../../api.ts";
import { useApi } from "../../hooks.ts";
import { Link } from "../../router.tsx";
import { Empty, ErrorBox, Notice, Spinner, Tabs } from "../../ui/index.tsx";
import { PageHeader } from "../../Layout.tsx";
import { ActivityTab } from "./ActivityTab.tsx";
import { ConfigDraftProvider, SaveBar, useDraft } from "./configDraft.tsx";
import { ConnectionsTab } from "./ConnectionsTab.tsx";
import { DashboardTab } from "./DashboardTab.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { IndexersTab } from "./IndexersTab.tsx";
import { LibraryTab } from "./LibraryTab.tsx";
import { MaintenanceTab } from "./MaintenanceTab.tsx";
import { SettingsTab } from "./SettingsTab.tsx";

const TABS = [
	{ id: "dashboard", label: "Dashboard", icon: <Gauge size={15} /> },
	{ id: "activity", label: "Activity", icon: <ActivityIcon size={15} /> },
	{ id: "indexers", label: "Indexers", icon: <ListTree size={15} /> },
	{ id: "connections", label: "Connections", icon: <Cable size={15} /> },
	{ id: "settings", label: "cross-seed settings", icon: <SlidersHorizontal size={15} /> },
	{ id: "history", label: "History", icon: <History size={15} /> },
	{ id: "library", label: "Library", icon: <Library size={15} /> },
	{ id: "maintenance", label: "Maintenance", icon: <Wrench size={15} /> },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Tells the user when cross-seed is (re)starting or not running, on every tab. */
function StatusBanner({ id }: { id: number }) {
	const activity = useApi<Activity>(inst(id, "activity"), { interval: 4000 });
	const info = useApi<AgentInfo>(inst(id, "info"), { interval: 15_000 });
	const state = activity.data?.state;
	if (activity.error && !activity.data) {
		return <div className="mb-4"><Notice tone="critical" title="The agent of this instance is not reachable">{activity.error.message}</Notice></div>;
	}
	if (state === "starting") {
		return (
			<div className="mb-4 flex items-start gap-2.5 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm">
				<Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-warning-text" />
				<div className="min-w-0">
					<div className="font-medium">cross-seed is starting…</div>
					<div className="text-ink-2">
						It checks its configuration and loads your torrents; with a large library this can take a few minutes. Statistics and jobs
						may be incomplete until it is back.
					</div>
					{activity.data?.lastEvent && <div className="log-line mt-1 truncate text-ink-3">{activity.data.lastEvent.text}</div>}
				</div>
			</div>
		);
	}
	if (state === "stopped") {
		const svc = info.data?.service;
		return (
			<div className="mb-4">
				<Notice tone="critical" title={`cross-seed is not running${svc ? ` (${svc.state}${svc.subState ? `, ${svc.subState}` : ""})` : ""}`}>
					{info.data?.crossSeed.manualRuns?.length ? (
						<span className="block mb-1">
							A manual <code>{info.data.crossSeed.manualRuns[0].command}</code> is running (pid {info.data.crossSeed.manualRuns[0].pid}), started by hand
							in a terminal. That is not the daemon: no scheduled searches, RSS or announces happen until the daemon runs.
						</span>
					) : null}
					Start it on the <Link to={`/i/${id}/maintenance`} className="text-accent hover:underline">Maintenance</Link> tab. If it stops again right away,
					the <Link to={`/i/${id}/settings`} className="text-accent hover:underline">cross-seed settings</Link> tab shows which option it refuses, and
					Maintenance → Service output shows its message.
				</Notice>
			</div>
		);
	}
	return null;
}

function ConfigGate({ children }: { children: React.ReactNode }) {
	const d = useDraft();
	if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
	if (!d.loaded) return <Spinner label="Loading config.js…" />;
	return (
		<>
			{!d.canEdit && <div className="mb-3"><Notice tone="accent">You have a viewer account: settings are read-only.</Notice></div>}
			{children}
			<SaveBar />
		</>
	);
}

export function InstancePage({ id, tab }: { id: number; tab?: string }) {
	const { instances } = useApp();
	usePath();
	const instance = instances.find((i) => i.id === id);
	if (!instance) return <Empty title="Instance not found">It may have been removed.</Empty>;
	const current = (TABS.find((t) => t.id === tab)?.id ?? "dashboard") as TabId;
	const configTabs: TabId[] = ["indexers", "connections", "settings"];

	return (
		<ConfigDraftProvider instanceId={id}>
			<PageHeader
				title={instance.name}
				icon={<span className="inline-block size-3.5 rounded-[4px]" style={{ background: instanceColor(id) }} />}
				subtitle={
					<span>
						Everything on these tabs applies only to this instance (its own cross-seed and config.js).{" "}
						<span className="font-mono text-xs">{instance.url}</span>
					</span>
				}
			/>
			<StatusBanner id={id} />
			<div className="mb-5">
				<Tabs tabs={[...TABS]} value={current} onChange={(t) => navigate(`/i/${id}/${t}`)} />
			</div>
			{configTabs.includes(current) ? (
				<ConfigGate>
					{current === "indexers" && <IndexersTab />}
					{current === "connections" && <ConnectionsTab />}
					{current === "settings" && <SettingsTab />}
				</ConfigGate>
			) : (
				<>
					{current === "dashboard" && <DashboardTab id={id} />}
					{current === "activity" && <ActivityTab id={id} />}
					{current === "history" && <HistoryTab id={id} />}
					{current === "library" && <LibraryTab id={id} />}
					{current === "maintenance" && <MaintenanceTab id={id} />}
				</>
			)}
		</ConfigDraftProvider>
	);
}
