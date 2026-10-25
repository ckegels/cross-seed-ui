/**
 * Docker support: control the official cross-seed container through the
 * Docker Engine API instead of systemd.
 *
 * DOCKER_HOST may be a unix socket (unix:///var/run/docker.sock) or, preferably,
 * a socket proxy (tcp://socket-proxy:2375) that only allows container
 * inspect/logs/start/stop/restart and exec. Only the one configured container
 * is ever touched.
 */
import { request } from "node:http";
import type { ServiceStatus } from "@csui/shared";
import type { ServiceController } from "./service.ts";
import { stripAnsi } from "./service.ts";

interface Target {
	socketPath?: string;
	host?: string;
	port?: number;
}

export function parseDockerHost(dockerHost: string | undefined): Target {
	const h = dockerHost || "unix:///var/run/docker.sock";
	if (h.startsWith("unix://")) return { socketPath: h.slice("unix://".length) };
	const m = /^(?:tcp|http):\/\/([^:/]+)(?::(\d+))?\/?$/.exec(h);
	if (!m) throw new Error(`Unsupported DOCKER_HOST "${h}" (use unix:///path or tcp://host:port)`);
	return { host: m[1], port: Number(m[2] ?? 2375) };
}

export class DockerApi {
	constructor(private target: Target) {}

	call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; data: Buffer }> {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const req = request(
				{
					...this.target,
					method,
					path: `/v1.41${path}`,
					headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
					timeout: timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }));
					res.on("error", reject);
				},
			);
			req.on("timeout", () => req.destroy(new Error("Docker API timed out")));
			req.on("error", (e) => reject(new Error(`Docker API not reachable (${(e as NodeJS.ErrnoException).code ?? e.message}). Check DOCKER_HOST / the socket proxy.`)));
			if (payload) req.write(payload);
			req.end();
		});
	}

	async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
		const r = await this.call(method, path, body, timeoutMs);
		if (r.status >= 400) throw new Error(`Docker API ${method} ${path}: HTTP ${r.status} ${r.data.toString().slice(0, 300)}`);
		return (r.data.length ? JSON.parse(r.data.toString()) : undefined) as T;
	}
}

/** Split Docker's multiplexed stdout/stderr stream (8-byte frame headers) into text. */
export function demux(buf: Buffer): { stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	let i = 0;
	// a TTY container returns a raw stream without headers
	const framed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2 || buf[0] === 0) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
	if (!framed) return { stdout: buf.toString("utf8"), stderr: "" };
	while (i + 8 <= buf.length) {
		const type = buf[i];
		const size = buf.readUInt32BE(i + 4);
		const chunk = buf.subarray(i + 8, i + 8 + size).toString("utf8");
		if (type === 2) stderr += chunk;
		else stdout += chunk;
		i += 8 + size;
	}
	return { stdout, stderr };
}

interface ContainerJson {
	Id: string;
	State: { Status: string; Running: boolean; Restarting: boolean; ExitCode: number; StartedAt: string; Pid: number };
	RestartCount: number;
	Config: { Image: string };
}

export class DockerController implements ServiceController {
	private api: DockerApi;
	constructor(
		private container: string,
		dockerHost: string | undefined,
	) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error(`Invalid container name: ${container}`);
		this.api = new DockerApi(parseDockerHost(dockerHost));
	}

	private path(suffix = "") {
		return `/containers/${encodeURIComponent(this.container)}${suffix}`;
	}

	async status(): Promise<ServiceStatus> {
		try {
			const c = await this.api.json<ContainerJson>("GET", this.path("/json"), undefined, 10_000);
			const s = c.State;
			const started = Date.parse(s.StartedAt);
			return {
				manager: "docker",
				name: this.container,
				state: s.Restarting ? "activating" : s.Running ? "active" : s.ExitCode ? "failed" : "inactive",
				subState: s.Restarting ? "auto-restart" : s.Status,
				since: s.Running && Number.isFinite(started) ? started : null,
				pid: s.Pid || null,
				memoryBytes: null,
				restarts: c.RestartCount ?? null,
			};
		} catch (e) {
			return {
				manager: "docker",
				name: this.container,
				state: "unknown",
				subState: (e as Error).message.slice(0, 200),
				since: null,
				pid: null,
				memoryBytes: null,
				restarts: null,
			};
		}
	}

	private async action(name: "start" | "stop" | "restart") {
		const r = await this.api.call("POST", this.path(`/${name}?t=20`), undefined, 60_000);
		// 304 = already started/stopped
		if (r.status >= 400) throw new Error(`docker ${name} ${this.container}: HTTP ${r.status} ${r.data.toString().slice(0, 300)}`);
	}
	start() {
		return this.action("start");
	}
	stop() {
		return this.action("stop");
	}
	restart() {
		return this.action("restart");
	}

	async recentOutput(lines: number, sinceMs?: number): Promise<string[]> {
		try {
			const q = new URLSearchParams({ stdout: "1", stderr: "1", timestamps: "1", tail: String(Math.min(Math.max(lines, 1), 2000)) });
			if (sinceMs) q.set("since", String(Math.floor(sinceMs / 1000)));
			const r = await this.api.call("GET", this.path(`/logs?${q}`), undefined, 15_000);
			if (r.status >= 400) return [];
			const { stdout, stderr } = demux(r.data);
			return `${stdout}${stderr}`
				.split("\n")
				.filter(Boolean)
				.map(stripAnsi)
				.sort();
		} catch {
			return [];
		}
	}

	/** Run a command inside the cross-seed container (used for the cross-seed CLI). */
	async exec(cmd: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
		const created = await this.api.json<{ Id: string }>("POST", this.path("/exec"), {
			Cmd: cmd,
			AttachStdout: true,
			AttachStderr: true,
			Env: ["FORCE_COLOR=0", "NO_COLOR=1"],
		});
		const r = await this.api.call("POST", `/exec/${created.Id}/start`, { Detach: false, Tty: false }, timeoutMs);
		if (r.status >= 400) throw new Error(`docker exec failed: HTTP ${r.status} ${r.data.toString().slice(0, 300)}`);
		const { stdout, stderr } = demux(r.data);
		const info = await this.api.json<{ ExitCode: number | null }>("GET", `/exec/${created.Id}/json`);
		return { stdout, stderr, code: info.ExitCode ?? 0 };
	}
}
