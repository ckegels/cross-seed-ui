import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.ts";

export interface ApiState<T> {
	data: T | undefined;
	error: ApiError | Error | null;
	loading: boolean;
	reload: () => Promise<void>;
	setData: (v: T | undefined) => void;
}

/**
 * GET a path; optional polling. Keeps the previous data while refetching so
 * charts don't flash (the dataviz "refetch keeps the frame" rule).
 */
export function useApi<T>(path: string | null, opts: { interval?: number } = {}): ApiState<T> {
	const [data, setData] = useState<T | undefined>(undefined);
	const [error, setError] = useState<ApiError | Error | null>(null);
	const [loading, setLoading] = useState(!!path);
	const seq = useRef(0);

	const reload = useCallback(async () => {
		if (!path) return;
		const my = ++seq.current;
		setLoading(true);
		try {
			const d = await api.get<T>(path);
			if (my === seq.current) {
				setData(d);
				setError(null);
			}
		} catch (e) {
			if (my === seq.current) setError(e as Error);
		} finally {
			if (my === seq.current) setLoading(false);
		}
	}, [path]);

	useEffect(() => {
		setData(undefined);
		setError(null);
		void reload();
	}, [reload]);

	useEffect(() => {
		if (!opts.interval || !path) return;
		const t = setInterval(() => {
			if (document.visibilityState === "visible") void reload();
		}, opts.interval);
		return () => clearInterval(t);
	}, [opts.interval, path, reload]);

	return { data, error, loading, reload, setData };
}

/** Subscribe to a server-sent events stream. */
export function useEventSource(path: string | null, handlers: Record<string, (data: unknown) => void>) {
	const ref = useRef(handlers);
	ref.current = handlers;
	const [connected, setConnected] = useState(false);
	useEffect(() => {
		if (!path) return;
		let es: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		let closed = false;
		const open = () => {
			es = new EventSource(path, { withCredentials: true });
			es.onopen = () => setConnected(true);
			es.onerror = () => {
				setConnected(false);
				es?.close();
				if (!closed) retry = setTimeout(open, 5000);
			};
			for (const name of Object.keys(ref.current)) {
				es.addEventListener(name, (ev) => {
					try {
						ref.current[name]?.(JSON.parse((ev as MessageEvent).data));
					} catch {
						/* ignore malformed */
					}
				});
			}
		};
		open();
		return () => {
			closed = true;
			if (retry) clearTimeout(retry);
			es?.close();
			setConnected(false);
		};
		// handler names are fixed per call site
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path]);
	return connected;
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
	const [v, setV] = useState<T>(() => {
		try {
			const s = localStorage.getItem(key);
			return s ? (JSON.parse(s) as T) : initial;
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(nv: T) => {
			setV(nv);
			try {
				localStorage.setItem(key, JSON.stringify(nv));
			} catch {
				/* storage unavailable */
			}
		},
		[key],
	);
	return [v, set];
}
