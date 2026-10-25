/**
 * Password re-confirmation. Any API call answered with "sudo_required" opens
 * this dialog and is retried after a successful confirmation.
 */
import { Lock } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, setSudoHandler } from "../api.ts";
import { useApp } from "../state.tsx";
import { Button, ErrorBox, Field, Input, Modal } from "./index.tsx";

export function SudoDialog() {
	const { auth, refreshAuth } = useApp();
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const resolver = useRef<((ok: boolean) => void) | null>(null);

	useEffect(() => {
		setSudoHandler(
			() =>
				new Promise<boolean>((resolve) => {
					resolver.current = resolve;
					setPassword("");
					setCode("");
					setError(null);
					setOpen(true);
				}),
		);
		return () => setSudoHandler(null);
	}, []);

	const close = (ok: boolean) => {
		setOpen(false);
		resolver.current?.(ok);
		resolver.current = null;
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/auth/sudo", { password, code: auth?.user?.totpEnabled ? code : undefined });
			await refreshAuth();
			close(true);
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open={open} onClose={() => close(false)} title="Confirm it's you">
			<form onSubmit={submit} className="space-y-3">
				<p className="text-sm text-ink-2">
					This action touches secrets or security settings. Enter your password to continue; it stays unlocked for a few minutes.
				</p>
				<Field label="Password">
					<Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
				</Field>
				{auth?.user?.totpEnabled && (
					<Field label="Authenticator code">
						<Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
					</Field>
				)}
				<ErrorBox error={error} />
				<div className="flex justify-end gap-2">
					<Button onClick={() => close(false)}>Cancel</Button>
					<Button type="submit" variant="primary" loading={busy} icon={<Lock size={14} />}>
						Confirm
					</Button>
				</div>
			</form>
		</Modal>
	);
}
