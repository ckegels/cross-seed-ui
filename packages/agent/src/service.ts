/**
 * Control of the cross-seed daemon process.
 * - systemd: `systemctl start|stop|restart <name>` and `systemctl show` for status
 * - process: spawn a command as a child (local development)
 * - docker:  the official cross-seed container, via the Docker API (see docker.ts)
 * - none:    status only from the daemon ping
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceStatus } from "@csui/shared";
import { DockerController } from "./docker.ts";
import type { AgentSettings } from "./settings.ts";

const execFileP = promisify(execFile);

export interface ServiceController {
	status(): Promise<ServiceStatus>;
	start(): Promise<void>;
	stop(): Promise<void>;
	restart(): Promise<void>;
	/** recent stdout/stderr lines (journal for systemd), optionally only since `sinceMs`, ANSI stripped */
	recentOutput(lines: number, sinceMs?: number): Promise<string[]>;
	/** run a command where cross-seed runs (docker: inside its container) */
	exec?(cmd: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number }>;
}

const UNIT_NAME = /^[A-Za-z0-9@._-]+$/;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

class SystemdController implements ServiceController {
	constructor(private name: string) {
		if (!UNIT_NAME.test(name)) throw new Error(`Invalid systemd unit name: ${name}`);
	}
	private async systemctl(...args: string[]) {
		const { stdout } = await execFileP("systemctl", args, { timeout: 60_000 });
		return stdout;
	}
	async status(): Promise<ServiceStatus> {
		try {
			const out = await this.systemctl(
				"show",
				this.name,
				"--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,MemoryCurrent,NRestarts",
			);
			const props = Object.fromEntries(
				out
					.trim()
					.split("\n")
					.map((l) => {
						const i = l.indexOf("=");
						return [l.slice(0, i), l.slice(i + 1)];
					}),
			);
			const since = props.ActiveEnterTimestamp ? Date.parse(props.ActiveEnterTimestamp) : NaN;
			const mem = Number(props.MemoryCurrent);
			return {
				manager: "systemd",
				name: this.name,
				state: props.ActiveState || "unknown",
				subState: props.SubState || null,
				since: Number.isFinite(since) ? since : null,
				pid: Number(props.MainPID) || null,
				memoryBytes: Number.isFinite(mem) && mem < 2 ** 62 ? mem : null,
				restarts: props.NRestarts !== undefined ? Number(props.NRestarts) : null,
			};
		} catch (e) {
			return {
				manager: "systemd",
				name: this.name,
				state: "unknown",
				subState: (e as Error).message.slice(0, 200),
				since: null,
				pid: null,
				memoryBytes: null,
				restarts: null,
			};
		}
	}
	async start() {
		await this.systemctl("start", this.name);
	}
	async stop() {
		await this.systemctl("stop", this.name);
	}
	async restart() {
		// reset-failed so a unit in "failed" state can be restarted cleanly
		await this.systemctl("reset-failed", this.name).catch(() => {});
		await this.systemctl("restart", this.name);
	}
	async recentOutput(lines: number, sinceMs?: number): Promise<string[]> {
		try {
			const args = ["-u", this.name, "-n", String(Math.min(Math.max(lines, 1), 2000)), "--no-pager", "-o", "short-iso"];
			if (sinceMs) args.push("--since", `@${Math.floor(sinceMs / 1000)}`);
			const { stdout } = await execFileP(
				"journalctl",
				args,
				{ timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
			);
			return stdout.split("\n").filter(Boolean).map(stripAnsi);
		} catch {
			return [];
		}
	}
}

class ProcessController implements ServiceController {
	private child: ChildProcess | null = null;
	private startedAt: number | null = null;
	private output: { ts: number; line: string }[] = [];
	private restarts = 0;
	constructor(
		private command: string[],
		private env: Record<string, string>,
	) {}
	async status(): Promise<ServiceStatus> {
		const running = !!this.child && this.child.exitCode === null && !this.child.killed;
		return {
			manager: "process",
			name: this.command.join(" "),
			state: running ? "active" : this.child?.exitCode ? "failed" : "inactive",
			subState: running ? "running" : this.child ? `exited ${this.child.exitCode}` : "dead",
			since: running ? this.startedAt : null,
			pid: running ? (this.child?.pid ?? null) : null,
			memoryBytes: null,
			restarts: this.restarts,
		};
	}
	async start() {
		if (this.child && this.child.exitCode === null) return;
		const [cmd, ...args] = this.command;
		const child = spawn(cmd, args, { env: { ...process.env, ...this.env }, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		this.startedAt = Date.now();
		const push = (d: Buffer) => {
			for (const l of d.toString().split("\n")) if (l) this.output.push({ ts: Date.now(), line: stripAnsi(l) });
			if (this.output.length > 2000) this.output.splice(0, this.output.length - 2000);
		};
		child.stdout?.on("data", push);
		child.stderr?.on("data", push);
	}
	async stop() {
		const c = this.child;
		if (!c || c.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				c.kill("SIGKILL");
			}, 15_000);
			c.once("exit", () => {
				clearTimeout(t);
				resolve();
			});
			c.kill("SIGTERM");
		});
	}
	async restart() {
		await this.stop();
		this.restarts++;
		await this.start();
	}
	async recentOutput(lines: number, sinceMs?: number) {
		return this.output.filter((o) => !sinceMs || o.ts >= sinceMs).slice(-lines).map((o) => o.line);
	}
}

class NoController implements ServiceController {
	async status(): Promise<ServiceStatus> {
		return {
			manager: "none",
			name: "",
			state: "unknown",
			subState: null,
			since: null,
			pid: null,
			memoryBytes: null,
			restarts: null,
		};
	}
	private unsupported(): never {
		throw new Error("Service control is disabled in the agent settings (service.manager = none)");
	}
	async start() {
		this.unsupported();
	}
	async stop() {
		this.unsupported();
	}
	async restart() {
		this.unsupported();
	}
	async recentOutput() {
		return [];
	}
}

export function createServiceController(s: AgentSettings): ServiceController {
	switch (s.service.manager) {
		case "systemd":
			return new SystemdController(s.service.name);
		case "docker":
			return new DockerController(s.service.name, s.service.dockerHost);
		case "process":
			if (!s.service.command?.length) throw new Error("service.command is required for manager=process");
			return new ProcessController(s.service.command, s.service.env ?? {});
		default:
			return new NoController();
	}
}
