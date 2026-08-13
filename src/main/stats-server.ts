/**
 * The GUI's built-in stats dashboard server, spawned from the SAME bundled
 * omp binary as the agent sidecar (`omp stats --port <port>`).
 *
 * Internal to the GUI's closed loop: spawned on app start, killed on quit,
 * localhost-only. No external `omp stats` process is required and none is
 * consulted — if an external process already owns the port, this reports the
 * conflict rather than silently using it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_PORT = 3847;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];
export function statsServerArgs(port: number): string[] {
	return ["stats", "--port", String(port), "--no-open"];
}

export function statsServerPort(output: string): number | null {
	const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(output);
	return match ? Number(match[1]) : null;
}

export class StatsServerManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#restartCount = 0;
	#restartTimer: NodeJS.Timeout | null = null;
	#disposed = false;
	#port = DEFAULT_PORT;
	readonly #binaryPath: string;

	constructor(binaryPath: string) {
		super();
		this.#binaryPath = binaryPath;
	}

	get port(): number {
		return this.#port;
	}

	start(): void {
		if (this.#disposed) return;
		this.#spawn();
	}

	#spawn(): void {
		const args = statsServerArgs(DEFAULT_PORT);
		console.log(`[stats-server] spawning: ${this.#binaryPath} ${args.join(" ")}`);
		let child: ChildProcess;
		try {
			child = spawn(this.#binaryPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_NOTIFICATIONS: "off" },
			});
		} catch (err) {
			// spawn() throws synchronously (e.g. EBADF/ENOENT) — treat like a
			// failed child so it retries gracefully instead of crashing the main
			// process with an uncaught-exception dialog.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}
		this.#child = child;

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			const port = statsServerPort(text);
			if (port !== null) {
				this.#port = port;
				this.#restartCount = 0;
				console.log(`[stats-server] ready on port ${this.#port}`);
				this.emit("ready", this.#port);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) console.error(`[stats-server stderr] ${text}`);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			if (code === 0) {
				this.emit("exit", code);
				return;
			}
			this.#attemptRestart(`exit code ${code}${signal ? ` (${signal})` : ""}`);
		});
		child.on("error", err => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	#attemptRestart(reason: string): void {
		if (this.#restartCount >= MAX_RESTART_ATTEMPTS) {
			console.error(`[stats-server] failed after ${MAX_RESTART_ATTEMPTS} attempts: ${reason}`);
			this.emit("exit", null);
			return;
		}
		const delay = RESTART_DELAYS[this.#restartCount] ?? 4000;
		this.#restartCount++;
		console.warn(`[stats-server] restart ${this.#restartCount}/${MAX_RESTART_ATTEMPTS} in ${delay}ms: ${reason}`);
		this.#restartTimer = setTimeout(() => {
			if (!this.#disposed) this.#spawn();
		}, delay);
	}

	kill(): void {
		this.#disposed = true;
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#child = null;
		child?.kill("SIGTERM");
	}
}
