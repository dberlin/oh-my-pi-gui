/**
 * Pool of per-window sidecar processes, bounded at a hard cap.
 *
 * Each window owns one SidecarManager (1:1). The pool enforces the concurrency
 * cap atomically (a slot is reserved synchronously before the async spawn, so
 * N concurrent acquires cannot overshoot), wires each sidecar's events to its
 * owning window, and releases the sidecar (listeners first, then dispose) when
 * its window closes.
 */
import type { BrowserWindow } from "electron";
import { IPC_EVENTS } from "../shared/ipc-types";
import type { HostToolCallRequest } from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";

export type SidecarFactory = (cwd: string) => SidecarManager;

function forwardToWindow(win: BrowserWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

interface PoolEntry {
	sidecar: SidecarManager;
	win: BrowserWindow;
}

export class SidecarPool {
	#entries = new Set<PoolEntry>();
	/**
	 * Synchronously-reserved spawn slots. An acquire claims one before the
	 * (synchronous-but-fragile) SidecarManager.start(), and releases it if the
	 * start throws. This is what makes the cap atomic: a concurrent acquire
	 * sees the reservation and is refused even before the child exists.
	 */
	#reserved = 0;
	readonly #max: number;
	readonly #factory: SidecarFactory;
	/**
	 * Host-tool dispatch needs the main-process executor (ipc.ts), which the
	 * pool cannot import without a cycle. Set once at startup; the pool routes
	 * each sidecar's hostToolCall through it with the owning window.
	 */
	hostToolExecutor: ((sidecar: SidecarManager, request: HostToolCallRequest, win: BrowserWindow) => void) | null =
		null;

	constructor(factory: SidecarFactory, max = 10) {
		this.#factory = factory;
		this.#max = max;
	}

	get size(): number {
		return this.#entries.size + this.#reserved;
	}

	/** True when the pool is full — single source of truth for the cap. */
	get atCap(): boolean {
		return this.size >= this.#max;
	}

	/**
	 * Spawn + bind a sidecar for `cwd` to `win`. Returns null at the cap.
	 * Wires the sidecar's 8 event channels to the window, and removes it from
	 * the pool when the window closes.
	 */
	acquire(cwd: string, win: BrowserWindow): SidecarManager | null {
		if (this.atCap) return null;
		this.#reserved++;
		try {
			const sidecar = this.#factory(cwd);
			const entry: PoolEntry = { sidecar, win };
			this.#wireEvents(entry);
			this.#entries.add(entry);

			win.once("closed", () => {
				this.#entries.delete(entry);
				// Listeners first, then dispose — a stale forwarder surviving into a
				// sidecar.restart() would push events at a destroyed window.
				sidecar.removeAllListeners();
				sidecar.dispose();
			});

			sidecar.start();
			return sidecar;
		} catch {
			return null;
		} finally {
			// Release the synchronous reservation exactly once: on success the
			// slot is now the live entry; on failure the pool never held it.
			this.#reserved--;
		}
	}

	/** Per-sidecar → owning-window event forwarding. */
	#wireEvents({ sidecar, win }: PoolEntry): void {
		sidecar.on("events", events => {
			forwardToWindow(win, IPC_EVENTS.EVENTS_BATCH, { events });
		});
		sidecar.on("status", payload => {
			forwardToWindow(win, IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
		});
		sidecar.on("extensionUi", request => {
			forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, { request });
		});
		sidecar.on("hostToolCall", request => {
			this.hostToolExecutor?.(sidecar, request, win);
		});
		sidecar.on("hostUriRequest", request => {
			forwardToWindow(win, IPC_EVENTS.HOST_URI_REQUEST, { request });
		});
		sidecar.on("subagentFrame", frame => {
			forwardToWindow(win, IPC_EVENTS.SUBAGENT_FRAME, { frame });
		});
		sidecar.on("liveUpdate", frame => {
			forwardToWindow(win, IPC_EVENTS.LIVE_UPDATE, frame);
		});
		sidecar.on("commandsUpdate", commands => {
			forwardToWindow(win, IPC_EVENTS.COMMANDS_UPDATE, { commands });
		});
		sidecar.on("configUpdate", payload => {
			forwardToWindow(win, IPC_EVENTS.CONFIG_UPDATE, payload);
		});
		sidecar.on("promptResult", frame => {
			forwardToWindow(win, IPC_EVENTS.PROMPT_RESULT, frame);
		});
		sidecar.on("commandOutput", frame => {
			forwardToWindow(win, IPC_EVENTS.COMMAND_OUTPUT, frame);
		});
		sidecar.on("sessionInfoUpdate", frame => {
			forwardToWindow(win, IPC_EVENTS.SESSION_INFO_UPDATE, frame);
		});
		sidecar.on("extensionError", frame => {
			forwardToWindow(win, IPC_EVENTS.EXTENSION_ERROR, frame);
		});
	}

	/** Look up the entry owning a window (undefined if that window has no sidecar yet). */
	entryForWindow(win: BrowserWindow): PoolEntry | undefined {
		for (const entry of this.#entries) {
			if (entry.win === win) return entry;
		}
		return undefined;
	}

	sidecarForWindow(win: BrowserWindow): SidecarManager | null {
		return this.entryForWindow(win)?.sidecar ?? null;
	}

	disposeAll(): void {
		for (const entry of this.#entries) {
			entry.sidecar.removeAllListeners();
			entry.sidecar.dispose();
		}
		this.#entries.clear();
	}
}
