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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PORT = 3847;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];
export function statsServerArgs(port: number): string[] {
	return ["stats", "--port", String(port)];
}

/**
 * Create commands that shadow only the URL openers used by the bundled stats
 * runtime. The rest of PATH remains available for stats port-conflict checks.
 */
export function createStatsOpenerShim(
	directory: string = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-stats-opener-")),
	platform: NodeJS.Platform = process.platform,
): string {
	fs.mkdirSync(directory, { recursive: true });
	if (platform === "win32") {
		// The runtime resolves this absolute path from SystemRoot. Keep the PATH
		// root free of powershell.exe so stats port recovery can find the real
		// PowerShell executable later in the inherited PATH.
		const opener = path.join(directory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		fs.mkdirSync(path.dirname(opener), { recursive: true });
		// A non-PE file makes CreateProcess fail fast; the runtime's opener is
		// best-effort and handles that launch error.
		fs.writeFileSync(opener, "OMP_GUI_NO_BROWSER\n");
		return directory;
	}

	const script = "#!/bin/sh\nprintf '%s\\n' OMP_GUI_NO_BROWSER\n";
	const openers = platform === "darwin" ? ["open"] : ["xdg-open", "wslview"];
	for (const opener of openers) fs.writeFileSync(path.join(directory, opener), script, { mode: 0o755 });
	return directory;
}

export function statsServerEnv(
	baseEnv: NodeJS.ProcessEnv,
	openerShim: string,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const delimiter = platform === "win32" ? ";" : path.delimiter;
	return {
		...baseEnv,
		...(platform === "win32" ? { SystemRoot: openerShim, SYSTEMROOT: openerShim } : {}),
		PATH: [openerShim, baseEnv.PATH].filter((entry): entry is string => Boolean(entry)).join(delimiter),
		PI_NOTIFICATIONS: "off",
	};
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
	#openerShimDir: string | null = null;

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
			this.#openerShimDir ??= createStatsOpenerShim();
			child = spawn(this.#binaryPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: statsServerEnv(process.env, this.#openerShimDir),
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
		if (this.#openerShimDir) {
			fs.rmSync(this.#openerShimDir, { recursive: true, force: true });
			this.#openerShimDir = null;
		}
	}
}
