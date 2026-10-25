import { CheckCircle2, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { AgentInfo } from "@csui/shared";
import { api } from "../../api.ts";
import { type Instance, instanceColor, useApp } from "../../state.tsx";
import { Button, Card, ErrorBox, Field, Input, Modal, Notice, useConfirm, useToast } from "../../ui/index.tsx";

function InstanceForm({ initial, onDone }: { initial?: Instance; onDone: () => void }) {
	const { refreshInstances } = useApp();
	const toast = useToast();
	const [name, setName] = useState(initial?.name ?? "");
	const [url, setUrl] = useState(initial?.url ?? "http://");
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [tested, setTested] = useState<AgentInfo | null>(null);

	const test = async () => {
		setBusy("test");
		setError(null);
		setTested(null);
		try {
			const r = await api.post<{ info: AgentInfo }>("/api/instances/test", { url, secret });
			setTested(r.info);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(null);
		}
	};
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy("save");
		setError(null);
		try {
			if (initial) await api.put(`/api/instances/${initial.id}`, { name, url, secret: secret || undefined });
			else await api.post("/api/instances", { name, url, secret });
			await refreshInstances();
			toast("good", initial ? "Instance updated" : "Instance added");
			onDone();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(null);
		}
	};
	return (
		<form onSubmit={submit} className="space-y-3">
			<Field label="Name" hint="e.g. the LXC name">
				<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="cross-seed movies" />
			</Field>
			<Field label="Agent URL" hint="Address of the agent in that LXC. Default port 2469.">
				<Input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="http://192.168.1.21:2469" className="font-mono text-xs" />
			</Field>
			<Field label={initial ? "Agent secret (leave empty to keep)" : "Agent secret"} hint="Printed by the installer; also in /etc/cross-seed-ui/agent.json on that LXC.">
				<Input value={secret} onChange={(e) => setSecret(e.target.value)} required={!initial} type="password" autoComplete="off" className="font-mono text-xs" />
			</Field>
			{tested && (
				<Notice tone="good" title={`Connected to ${tested.hostname}`}>
					cross-seed {tested.crossSeed.version ?? "?"} · service {tested.service.state} · agent {tested.agentVersion}
				</Notice>
			)}
			<ErrorBox error={error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onDone}>Cancel</Button>
				<Button onClick={test} loading={busy === "test"} disabled={!secret} icon={<CheckCircle2 size={14} />}>
					Test
				</Button>
				<Button type="submit" variant="primary" loading={busy === "save"}>
					{initial ? "Save" : "Add instance"}
				</Button>
			</div>
		</form>
	);
}

export function InstancesSection() {
	const { instances, refreshInstances } = useApp();
	const { confirm, dialog } = useConfirm();
	const toast = useToast();
	const [editing, setEditing] = useState<Instance | "new" | null>(null);
	const remove = async (i: Instance) => {
		if (!(await confirm({ title: `Remove ${i.name}?`, body: "The UI forgets this agent. Nothing changes on the LXC itself.", danger: true, confirmLabel: "Remove" }))) return;
		try {
			await api.del(`/api/instances/${i.id}`);
			await refreshInstances();
		} catch (e) {
			toast("critical", (e as Error).message);
		}
	};
	return (
		<div className="space-y-4">
			<Card
				title="Instances"
				subtitle="Each instance is a cross-seed LXC running the cross-seed-ui agent"
				actions={
					<Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
						Add instance
					</Button>
				}
			>
				{!instances.length ? (
					<p className="text-sm text-ink-3">No instances yet.</p>
				) : (
					<div className="divide-y divide-line -my-2">
						{instances.map((i) => (
							<div key={i.id} className="flex items-center gap-3 py-2.5">
								<span className="inline-block size-3 rounded-[4px]" style={{ background: instanceColor(i.id) }} />
								<div className="flex-1 min-w-0">
									<div className="font-medium">{i.name}</div>
									<div className="text-xs text-ink-3 font-mono truncate">{i.url}</div>
								</div>
								<Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => setEditing(i)}>
									Edit
								</Button>
								<Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => remove(i)}>
									Remove
								</Button>
							</div>
						))}
					</div>
				)}
			</Card>
			<Card title="Installing the agent" subtitle="Run this inside each cross-seed LXC (as root)">
				<pre className="log-line rounded-lg bg-surface-2 p-3 overflow-x-auto">{`curl -fsSL https://raw.githubusercontent.com/ckegels/cross-seed-ui/main/deploy/install.sh | bash -s -- --role agent --allow-ip <this-web-ui-ip>
# it prints the agent URL and secret to paste here`}</pre>
				<p className="mt-2 text-xs text-ink-3 flex items-center gap-1.5">
					<Server size={12} /> More options and updating: see the README on GitHub.
				</p>
			</Card>
			<Modal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "Add instance" : "Edit instance"}>
				{editing && <InstanceForm initial={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
			</Modal>
			{dialog}
		</div>
	);
}
