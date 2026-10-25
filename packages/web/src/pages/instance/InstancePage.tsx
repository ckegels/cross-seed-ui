import { Activity as ActivityIcon, Cable, Gauge, History, Library, ListTree, SlidersHorizontal, Wrench } from "lucide-react";
import { navigate, usePath } from "../../router.tsx";
import { instanceColor, useApp } from "../../state.tsx";
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
