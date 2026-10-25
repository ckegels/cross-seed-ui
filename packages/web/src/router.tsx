/** Minimal history-API router (no dependency). */
import { type AnchorHTMLAttributes, type ReactNode, useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false) {
	if (to === location.pathname + location.search) return;
	if (replace) history.replaceState(null, "", to);
	else history.pushState(null, "", to);
	for (const l of listeners) l();
	window.scrollTo({ top: 0 });
}

export function usePath(): { path: string; query: URLSearchParams } {
	const [, force] = useState(0);
	useEffect(() => {
		const fn = () => force((n) => n + 1);
		listeners.add(fn);
		window.addEventListener("popstate", fn);
		return () => {
			listeners.delete(fn);
			window.removeEventListener("popstate", fn);
		};
	}, []);
	return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Match "/i/:id/:tab?" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
	const p = pattern.split("/").filter(Boolean);
	const s = path.split("/").filter(Boolean);
	const out: Record<string, string> = {};
	for (let i = 0; i < Math.max(p.length, s.length); i++) {
		const part = p[i];
		if (part === undefined) return null;
		const optional = part.endsWith("?");
		const name = part.replace(/\?$/, "");
		if (s[i] === undefined) {
			if (optional) continue;
			return null;
		}
		if (name.startsWith(":")) out[name.slice(1)] = decodeURIComponent(s[i]);
		else if (name !== s[i]) return null;
	}
	return out;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
	return (
		<a
			href={to}
			onClick={(e) => {
				if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				e.preventDefault();
				navigate(to);
			}}
			{...rest}
		>
			{children}
		</a>
	);
}
