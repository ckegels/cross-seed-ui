import { KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useApp } from "../state.tsx";
import { Button, ErrorBox, Field, Input } from "../ui/index.tsx";

function Shell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
	return (
		<div className="min-h-full flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="flex items-center gap-2.5 mb-6">
					<img src="/favicon.svg" alt="" className="size-9" />
					<div>
						<div className="font-semibold text-ink">cross-seed UI</div>
						<div className="text-xs text-ink-3">Manage your cross-seed instances</div>
					</div>
				</div>
				<div className="card p-5 space-y-4">
					<div>
						<h1 className="text-lg font-semibold">{title}</h1>
						<p className="text-sm text-ink-3 mt-0.5">{subtitle}</p>
					</div>
					{children}
				</div>
			</div>
		</div>
	);
}

export function LoginPage() {
	const { refreshAuth } = useApp();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [needCode, setNeedCode] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/auth/login", { username, password, code: needCode ? code : undefined });
			await refreshAuth();
		} catch (err) {
			if (err instanceof ApiError && err.code === "totp_required") {
				setNeedCode(true);
			} else {
				setError(err);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Shell title="Sign in" subtitle="Use your cross-seed UI account.">
			<form onSubmit={submit} className="space-y-3">
				<Field label="Username">
					<Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
				</Field>
				<Field label="Password">
					<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
				</Field>
				{needCode && (
					<Field label="Authenticator code" hint="6-digit code from your authenticator app">
						<Input
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9 ]{6,7}"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							required
						/>
					</Field>
				)}
				<ErrorBox error={error} />
				<Button type="submit" variant="primary" className="w-full" loading={busy} icon={<KeyRound size={15} />}>
					Sign in
				</Button>
			</form>
		</Shell>
	);
}

export function SetupPage() {
	const { refreshAuth } = useApp();
	const [token, setToken] = useState("");
	const [username, setUsername] = useState("admin");
	const [password, setPassword] = useState("");
	const [password2, setPassword2] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (password !== password2) {
			setError(new Error("The passwords don't match."));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/auth/setup", { token: token.trim(), username, password });
			await refreshAuth();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Shell
			title="Create the admin account"
			subtitle={
				<>
					First start. The setup token was printed by the installer and is in the hub log:{" "}
					<code className="text-xs">journalctl -u cross-seed-ui-hub | grep -A1 token</code>
				</>
			}
		>
			<form onSubmit={submit} className="space-y-3">
				<Field label="Setup token">
					<Input autoFocus value={token} onChange={(e) => setToken(e.target.value)} required className="font-mono" />
				</Field>
				<Field label="Username">
					<Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
				</Field>
				<Field label="Password" hint="At least 10 characters. A passphrase is easiest.">
					<Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
				</Field>
				<Field label="Repeat password">
					<Input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
				</Field>
				<ErrorBox error={error} />
				<Button type="submit" variant="primary" className="w-full" loading={busy} icon={<ShieldCheck size={15} />}>
					Create account
				</Button>
			</form>
		</Shell>
	);
}
