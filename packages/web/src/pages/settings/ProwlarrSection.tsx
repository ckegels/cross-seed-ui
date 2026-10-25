import { CheckCircle2, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useApi } from "../../hooks.ts";
import { Button, Card, ErrorBox, Field, Input, Notice, useConfirm, useToast } from "../../ui/index.tsx";

export function ProwlarrSection() {
	const { data, reload } = useApi<{ configured: boolean; url?: string; torznabBaseUrl?: string | null }>("/api/prowlarr");
	const toast = useToast();
	const { confirm, dialog } = useConfirm();
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [base, setBase] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [testMsg, setTestMsg] = useState<string | null>(null);

	useEffect(() => {
		if (data?.configured) {
			setUrl(data.url ?? "");
			setBase(data.torznabBaseUrl ?? "");
		}
	}, [data]);

	const test = async () => {
		setBusy("test");
		setError(null);
		setTestMsg(null);
		try {
			const r = await api.post<{ message: string }>("/api/prowlarr/test", { url, apiKey: apiKey || undefined });
			setTestMsg(r.message);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(null);
		}
	};
	const save = async (e: FormEvent) => {
		e.preventDefault();
		setBusy("save");
		setError(null);
		try {
			const r = await api.put<{ version: string }>("/api/prowlarr", { url, apiKey: apiKey || undefined, torznabBaseUrl: base || undefined });
			toast("good", `Prowlarr ${r.version} connected`);
			setApiKey("");
			void reload();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(null);
		}
	};
	const remove = async () => {
		if (!(await confirm({ title: "Disconnect Prowlarr?", body: "Existing Torznab URLs in your cross-seed configs stay as they are.", danger: true }))) return;
		await api.del("/api/prowlarr");
		setUrl("");
		void reload();
	};
	return (
		<Card
			title="Prowlarr"
			subtitle="Lets you pick indexers from a list per instance and keep them in sync"
			actions={
				data?.configured && (
					<Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={remove}>
						Disconnect
					</Button>
				)
			}
		>
			<form onSubmit={save} className="space-y-3">
				<Field label="Prowlarr URL" hint="How the hub reaches Prowlarr, e.g. http://192.168.1.10:9696">
					<Input value={url} onChange={(e) => setUrl(e.target.value)} required className="font-mono text-xs" placeholder="http://prowlarr:9696" />
				</Field>
				<Field label="API key" hint={data?.configured ? "Stored encrypted. Leave empty to keep the current key." : "Prowlarr → Settings → General → API Key"}>
					<Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={!data?.configured} type="password" autoComplete="off" />
				</Field>
				<Field label="Torznab base URL for cross-seed (optional)" hint="Only if cross-seed must reach Prowlarr at a different address than the hub, e.g. http://prowlarr:9696">
					<Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono text-xs" placeholder="same as above" />
				</Field>
				{testMsg && <Notice tone="good" title={`Connected: ${testMsg}`} />}
				<ErrorBox error={error} />
				<div className="flex justify-end gap-2">
					<Button onClick={test} loading={busy === "test"} icon={<CheckCircle2 size={14} />} disabled={!url || (!apiKey && !data?.configured)}>
						Test
					</Button>
					<Button type="submit" variant="primary" loading={busy === "save"}>
						Save
					</Button>
				</div>
			</form>
			{dialog}
		</Card>
	);
}
