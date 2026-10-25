/**
 * Fetch wrapper for the hub API. Adds the anti-CSRF header, parses errors and
 * routes "sudo_required" to the password confirmation dialog.
 */

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
	}
}

type SudoHandler = () => Promise<boolean>;
let sudoHandler: SudoHandler | null = null;
let unauthHandler: (() => void) | null = null;

export function setSudoHandler(h: SudoHandler | null) {
	sudoHandler = h;
}
export function setUnauthenticatedHandler(h: (() => void) | null) {
	unauthHandler = h;
}

async function raw<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: {
			"x-csui": "1",
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		credentials: "same-origin",
	});
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	let json: unknown = undefined;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		/* not json */
	}
	if (!res.ok) {
		const j = (json ?? {}) as { error?: string; message?: string; details?: unknown };
		const err = new ApiError(res.status, j.error ?? "error", j.message ?? `HTTP ${res.status}`, j.details);
		if (err.code === "sudo_required" && sudoHandler && !retried) {
			if (await sudoHandler()) return raw<T>(method, path, body, true);
		}
		if (err.code === "unauthenticated" && unauthHandler) unauthHandler();
		throw err;
	}
	return json as T;
}

export const api = {
	get: <T>(path: string) => raw<T>("GET", path),
	post: <T>(path: string, body: unknown = {}) => raw<T>("POST", path, body),
	put: <T>(path: string, body: unknown) => raw<T>("PUT", path, body),
	del: <T>(path: string) => raw<T>("DELETE", path),
};

export function inst(id: number, path: string) {
	return `/api/instances/${id}/${path}`;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === null || v === "" || v === false) continue;
		p.set(k, v === true ? "1" : String(v));
	}
	const s = p.toString();
	return s ? `?${s}` : "";
}
