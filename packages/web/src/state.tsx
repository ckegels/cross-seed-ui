/** App-wide state: auth session, instances list. */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.ts";
import { SERIES } from "./charts/index.tsx";

export interface User {
	id: number;
	username: string;
	role: "admin" | "viewer";
	totpEnabled: boolean;
	lastLoginAt: number | null;
}

export interface AuthState {
	setupRequired: boolean;
	user: User | null;
	sudoUntil: number;
	version: string;
}

export interface Instance {
	id: number;
	name: string;
	url: string;
	color: string;
	sort: number;
	createdAt: number;
}

interface Ctx {
	auth: AuthState | null;
	refreshAuth: () => Promise<void>;
	instances: Instance[];
	refreshInstances: () => Promise<void>;
	isAdmin: boolean;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
	const [auth, setAuth] = useState<AuthState | null>(null);
	const [instances, setInstances] = useState<Instance[]>([]);

	const refreshAuth = useCallback(async () => {
		setAuth(await api.get<AuthState>("/api/auth/state"));
	}, []);
	const refreshInstances = useCallback(async () => {
		try {
			setInstances(await api.get<Instance[]>("/api/instances"));
		} catch {
			setInstances([]);
		}
	}, []);

	useEffect(() => {
		void refreshAuth();
	}, [refreshAuth]);
	useEffect(() => {
		if (auth?.user) void refreshInstances();
	}, [auth?.user, refreshInstances]);

	return (
		<AppCtx.Provider value={{ auth, refreshAuth, instances, refreshInstances, isAdmin: auth?.user?.role === "admin" }}>
			{children}
		</AppCtx.Provider>
	);
}

export function useApp() {
	return useContext(AppCtx);
}

/** Color follows the entity (instance id), never its position in a filtered list. */
export function instanceColor(id: number): string {
	return SERIES[(id - 1) % SERIES.length];
}
