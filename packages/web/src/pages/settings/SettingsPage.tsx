import { Info, KeyRound, ListTree, ScrollText, Server, Shield, Users } from "lucide-react";
import { navigate } from "../../router.tsx";
import { useApp } from "../../state.tsx";
import { Tabs } from "../../ui/index.tsx";
import { PageHeader } from "../../Layout.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { AuditSection } from "./AuditSection.tsx";
import { InstancesSection } from "./InstancesSection.tsx";
import { ProwlarrSection } from "./ProwlarrSection.tsx";
import { UsersSection } from "./UsersSection.tsx";

export function SettingsPage({ tab }: { tab?: string }) {
	const { isAdmin } = useApp();
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
			<PageHeader title="Settings" icon={<KeyRound size={20} />} />
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
