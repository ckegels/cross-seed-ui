import { LogOut, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { type FormEvent, useState } from "react";
import { api } from "../../api.ts";
import { ago, dateTime } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { useApp } from "../../state.tsx";
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, useConfirm, useToast } from "../../ui/index.tsx";

function PasswordCard() {
	const { auth } = useApp();
	const toast = useToast();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [next2, setNext2] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (next !== next2) return setError(new Error("The new passwords don't match"));
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/auth/password", { current, next, code: auth?.user?.totpEnabled ? code : undefined });
			toast("good", "Password changed. Other sessions were signed out.");
			setCurrent("");
			setNext("");
			setNext2("");
			setCode("");
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card title="Password" subtitle="Changing it signs out every other session">
			<form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
				<div className="sm:col-span-2">
					<Field label="Current password">
						<Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
					</Field>
				</div>
				<Field label="New password" hint="At least 10 characters">
					<Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
				</Field>
				<Field label="Repeat new password">
					<Input type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} required />
				</Field>
				{auth?.user?.totpEnabled && (
					<Field label="Authenticator code">
						<Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
					</Field>
				)}
				<div className="sm:col-span-2 space-y-2">
					<ErrorBox error={error} />
					<div className="flex justify-end">
						<Button type="submit" variant="primary" loading={busy}>
							Change password
						</Button>
					</div>
				</div>
			</form>
		</Card>
	);
}

function TotpCard() {
	const { auth, refreshAuth } = useApp();
	const toast = useToast();
	const { confirm, dialog } = useConfirm();
	const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const enabled = auth?.user?.totpEnabled;
	const begin = async () => {
		setError(null);
		try {
			const r = await api.post<{ secret: string; uri: string }>("/api/auth/totp/begin");
			setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }) });
		} catch (e) {
			setError(e);
		}
	};
	const enable = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/auth/totp/enable", { code });
			toast("good", "Two-factor authentication is on");
			setSetup(null);
			setCode("");
			await refreshAuth();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};
	const disable = async () => {
		if (!(await confirm({ title: "Turn off two-factor authentication?", body: "Signing in will only need your password.", danger: true, confirmLabel: "Turn off" }))) return;
		try {
			await api.post("/api/auth/totp/disable");
			await refreshAuth();
		} catch (e) {
			setError(e);
		}
	};
	return (
		<Card
			title={
				<span className="flex items-center gap-2">
					Two-factor authentication {enabled ? <Badge tone="good">on</Badge> : <Badge>off</Badge>}
				</span>
			}
			subtitle="A 6-digit code from an authenticator app (Aegis, 1Password, Google Authenticator...) on every sign-in"
		>
			{enabled ? (
				<Button icon={<ShieldOff size={14} />} onClick={disable}>
					Turn off
				</Button>
			) : setup ? (
				<form onSubmit={enable} className="flex flex-wrap gap-5">
					<img src={setup.qr} alt="QR code for your authenticator app" className="size-44 rounded-lg bg-white p-1" />
					<div className="flex-1 min-w-60 space-y-3">
						<p className="text-sm text-ink-2">Scan the code, or enter this key by hand:</p>
						<code className="block break-all rounded-lg bg-surface-2 p-2 text-xs">{setup.secret}</code>
						<Field label="Code from the app">
							<Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
						</Field>
						<ErrorBox error={error} />
						<div className="flex gap-2">
							<Button onClick={() => setSetup(null)}>Cancel</Button>
							<Button type="submit" variant="primary" loading={busy} icon={<ShieldCheck size={14} />}>
								Turn on
							</Button>
						</div>
					</div>
				</form>
			) : (
				<div className="space-y-2">
					<Button variant="primary" icon={<Smartphone size={14} />} onClick={begin}>
						Set up
					</Button>
					<ErrorBox error={error} />
				</div>
			)}
			{dialog}
		</Card>
	);
}

interface SessionRow {
	id: string;
	current: boolean;
	createdAt: number;
	lastSeenAt: number;
	ip: string;
	userAgent: string;
}

function SessionsCard() {
	const { data, reload } = useApi<SessionRow[]>("/api/auth/sessions");
	const toast = useToast();
	const revoke = async (id: string) => {
		await api.del(`/api/auth/sessions/${id}`);
		void reload();
	};
	const others = async () => {
		await api.post("/api/auth/sessions/revoke-others");
		toast("good", "Signed out everywhere else");
		void reload();
	};
	return (
		<Card
			title="Sessions"
			subtitle="Where you are signed in"
			actions={
				<Button size="sm" icon={<LogOut size={12} />} onClick={others}>
					Sign out others
				</Button>
			}
		>
			<div className="divide-y divide-line -my-2">
				{(data ?? []).map((s) => (
					<div key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
						<div className="flex-1 min-w-0">
							<div className="truncate" title={s.userAgent}>
								{s.userAgent || "Unknown browser"}
							</div>
							<div className="text-xs text-ink-3">
								{s.ip} · active {ago(s.lastSeenAt)} · since {dateTime(s.createdAt)}
							</div>
						</div>
						{s.current ? (
							<Badge tone="accent">this browser</Badge>
						) : (
							<Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>
								Sign out
							</Button>
						)}
					</div>
				))}
			</div>
		</Card>
	);
}

export function AccountSection() {
	const { auth } = useApp();
	return (
		<div className="space-y-4">
			<Notice tone="accent">
				Signed in as <b>{auth?.user?.username}</b> ({auth?.user?.role}). Sensitive actions (revealing secrets, raw config, users, instances) ask for your password again.
			</Notice>
			<PasswordCard />
			<TotpCard />
			<SessionsCard />
		</div>
	);
}
