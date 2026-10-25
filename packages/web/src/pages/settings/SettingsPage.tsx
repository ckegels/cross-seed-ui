import { Info, KeyRound, ListTree, ScrollText, Server, Shield, Users } from "lucide-react";
import { Link, navigate } from "../../router.tsx";
import { instanceColor, useApp } from "../../state.tsx";
import { Notice, Tabs } from "../../ui/index.tsx";
import { PageHeader } from "../../Layout.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { AuditSection } from "./AuditSection.tsx";
import { InstancesSection } from "./InstancesSection.tsx";
import { ProwlarrSection } from "./ProwlarrSection.tsx";
import { UsersSection } from "./UsersSection.tsx";

export function SettingsPage({ tab }: { tab?: string }) {
	const { isAdmin, instances } = useApp();
	const tabs = [
		{ id: "account", label: "Account & security", icon: <Shield size={15} /> },
		...(isAdmin
			? [
					{ id: "instances", label: "Instances", icon: <Server size={15} /> },
					{ id: "prowlarr", label: "Prowlarr", icon: <ListTree size={15} /> },
					{ id: "users", label: "Users", icon: <Users size={15} /> },
					{ id: "audit", label: "Audit log", icon: <ScrollText size={15} /> },
				]
			: []),
		{ id: "about", label: "About & updates", icon: <Info size={15} /> },
	];
	const current = tabs.find((t) => t.id === tab)?.id ?? "account";
	return (
		<>
			<PageHeader title="UI settings" icon={<KeyRound size={20} />} subtitle="Settings of this web UI: your account, users, connected instances and Prowlarr." />
			{instances.length > 0 && (
				<div className="mb-5 max-w-4xl">
					<Notice tone="accent" title="Looking for cross-seed's own settings (Sonarr, Radarr, torrent clients, indexers, matching...)?">
						Every cross-seed instance has its own config.js, so they are set per instance:
						<div className="mt-2 flex flex-col gap-1.5">
							{instances.map((i) => (
								<div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span className="inline-flex items-center gap-1.5 font-medium text-ink">
										<span className="inline-block size-2.5 rounded-[3px]" style={{ background: instanceColor(i.id) }} />
										{i.name}
									</span>
									<Link to={`/i/${i.id}/connections`} className="text-accent hover:underline">Connections (clients, Sonarr, Radarr, notifications)</Link>
									<Link to={`/i/${i.id}/indexers`} className="text-accent hover:underline">Indexers</Link>
									<Link to={`/i/${i.id}/settings`} className="text-accent hover:underline">cross-seed settings</Link>
								</div>
							))}
						</div>
					</Notice>
				</div>
			)}
			<div className="mb-5">
				<Tabs tabs={tabs} value={current} onChange={(t) => navigate(`/settings/${t}`)} />
			</div>
			<div className="max-w-4xl">
				{current === "account" && <AccountSection />}
				{current === "instances" && <InstancesSection />}
				{current === "prowlarr" && <ProwlarrSection />}
				{current === "users" && <UsersSection />}
				{current === "audit" && <AuditSection />}
				{current === "about" && <AboutSection />}
			</div>
		</>
	);
}
