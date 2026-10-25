import { useEffect } from "react";
import { setUnauthenticatedHandler } from "./api.ts";
import { Layout } from "./Layout.tsx";
import { LoginPage, SetupPage } from "./pages/Auth.tsx";
import { IndexersPage } from "./pages/IndexersPage.tsx";
import { InstancePage } from "./pages/instance/InstancePage.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";
import { match, usePath } from "./router.tsx";
import { AppProvider, useApp } from "./state.tsx";
import { Empty, Spinner, ToastProvider } from "./ui/index.tsx";
import { SudoDialog } from "./ui/SudoDialog.tsx";

function Routes() {
	const { path } = usePath();
	let m: Record<string, string> | null;
	if (path === "/") return <OverviewPage />;
	if ((m = match("/i/:id/:tab?", path))) return <InstancePage key={m.id} id={Number(m.id)} tab={m.tab} />;
	if (match("/indexers", path)) return <IndexersPage />;
	if ((m = match("/settings/:tab?", path))) return <SettingsPage tab={m.tab} />;
	return <Empty title="Page not found" />;
}

function Gate() {
	const { auth, refreshAuth } = useApp();
	useEffect(() => {
		setUnauthenticatedHandler(() => void refreshAuth());
		return () => setUnauthenticatedHandler(null);
	}, [refreshAuth]);
	if (!auth) return <Spinner />;
	if (auth.setupRequired) return <SetupPage />;
	if (!auth.user) return <LoginPage />;
	return (
		<Layout>
			<Routes />
			<SudoDialog />
		</Layout>
	);
}

export function App() {
	return (
		<ToastProvider>
			<AppProvider>
				<Gate />
			</AppProvider>
		</ToastProvider>
	);
}
