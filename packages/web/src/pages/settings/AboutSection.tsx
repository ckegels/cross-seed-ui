import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useApi } from "../../hooks.ts";
import { Button, Card, Kv, Notice } from "../../ui/index.tsx";

interface SystemInfo {
	version: string;
	node: string;
	latest: string | null;
	releaseUrl: string | null;
	updateAvailable: boolean;
	updateError: string | null;
	updateCommand: string;
}

export function AboutSection() {
	const [check, setCheck] = useState(false);
	const { data, loading, reload } = useApi<SystemInfo>(`/api/system${check ? "?checkUpdates=1" : ""}`);
	return (
		<div className="space-y-4">
			<Card
				title="cross-seed UI"
				actions={
					<Button size="sm" icon={<RefreshCw size={12} />} loading={loading} onClick={() => (check ? reload() : setCheck(true))}>
						Check for updates
					</Button>
				}
			>
				<Kv k="Hub version" v={data?.version ?? "…"} />
				<Kv k="Node.js" v={data?.node ?? "…"} />
				<Kv k="Latest release" v={data?.latest ?? (check ? "unknown" : "not checked")} />
				{data?.updateError && <p className="mt-2 text-xs text-warning-text">{data.updateError}</p>}
			</Card>
			{data?.updateAvailable && (
				<Notice tone="accent" title={`Version ${data.latest} is available`}>
					Run <code>{data.updateCommand}</code> as root in each LXC (hub and agents). It downloads the release, keeps your settings and restarts the services.
				</Notice>
			)}
			<Card title="How it fits together">
				<ul className="list-disc pl-5 text-sm text-ink-2 space-y-1">
					<li>The <b>hub</b> (this web UI) stores users, sessions and the list of agents.</li>
					<li>An <b>agent</b> runs next to each cross-seed daemon. It edits config.js (with backups), reads cross-seed's database read-only, follows its logs and restarts the service.</li>
					<li>Hub and agents talk over HTTP with every request signed (HMAC-SHA256, replay protected). The shared secret never travels over the network.</li>
				</ul>
			</Card>
		</div>
	);
}
