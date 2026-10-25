import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../../api.ts";
import { ago } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { type User, useApp } from "../../state.tsx";
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, Select, useConfirm } from "../../ui/index.tsx";

export function UsersSection() {
	const { auth } = useApp();
	const { data, reload } = useApi<User[]>("/api/users");
	const { confirm, dialog } = useConfirm();
	const [adding, setAdding] = useState(false);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState("viewer");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const add = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post("/api/users", { username, password, role });
			setAdding(false);
			setUsername("");
			setPassword("");
			void reload();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};
	const remove = async (u: User) => {
		if (!(await confirm({ title: `Delete ${u.username}?`, body: "Their sessions end immediately.", danger: true, confirmLabel: "Delete" }))) return;
		await api.del(`/api/users/${u.id}`);
		void reload();
	};
	return (
		<Card
			title="Users"
			subtitle="Admins can change everything. Viewers can only look."
			actions={
				<Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
					Add user
				</Button>
			}
		>
			<div className="divide-y divide-line -my-2">
				{(data ?? []).map((u) => (
					<div key={u.id} className="flex items-center gap-3 py-2.5 text-sm">
						<div className="flex-1 min-w-0">
							<div className="font-medium">{u.username}</div>
							<div className="text-xs text-ink-3">last sign-in {ago(u.lastLoginAt)}</div>
						</div>
						<Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge>
						{u.totpEnabled && <Badge tone="good">2FA</Badge>}
						{u.id !== auth?.user?.id && (
							<Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => remove(u)}>
								Delete
							</Button>
						)}
					</div>
				))}
			</div>
			<Modal open={adding} onClose={() => setAdding(false)} title="Add user">
				<form onSubmit={add} className="space-y-3">
					<Field label="Username">
						<Input value={username} onChange={(e) => setUsername(e.target.value)} required />
					</Field>
					<Field label="Password" hint="At least 10 characters. They can change it after signing in.">
						<Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
					</Field>
					<Field label="Role">
						<Select value={role} onChange={(e) => setRole(e.target.value)}>
							<option value="viewer">Viewer (read-only)</option>
							<option value="admin">Admin</option>
						</Select>
					</Field>
					<ErrorBox error={error} />
					<div className="flex justify-end gap-2">
						<Button onClick={() => setAdding(false)}>Cancel</Button>
						<Button type="submit" variant="primary" loading={busy}>
							Add
						</Button>
					</div>
				</form>
			</Modal>
			{dialog}
		</Card>
	);
}
