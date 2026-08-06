/**
 * Pool of per-tab sidecar processes, bounded at a hard cap.
 *
 * Each TAB owns one SidecarManager; a window holds N tabs. The pool enforces
 * the concurrency cap atomically (a slot is reserved synchronously before the
 * async spawn, so N concurrent acquires cannot overshoot — and the cap now
 * counts tabs across all windows), wires each sidecar's events to its owning
 * window, and releases the sidecar (listeners first, then dispose) when its
 * tab closes or its window closes.
 *
 * Event routing: the full event channels (events batch, status, subagent,
 * live, commands, config, prompt result, command output, session info,
 * extension ui/error, host tool/uri) forward ONLY from the window's ACTIVE
 * tab — listeners move on setActiveTab, never duplicate. Every tab (active or
 * background) additionally pushes the light TAB_STATUS channel, so background
 * tabs report status flips and session title/id changes.
 */
import type { BrowserWindow } from "electron";
import { IPC_EVENTS, type IpcTabInfo, type IpcTabStatusPayload } from "../shared/ipc-types";
import type {
	AgentSessionEvent,
	AvailableCommand,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	HostToolCallRequest,
	HostUriRequest,
	PromptResultFrame,
	RpcLiveUpdateFrame,
	SessionInfoUpdateFrame,
	SidecarStatus,
	SubagentFrame,
} from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";
import { nextSnowflake } from "./snowflake";

export type SidecarFactory = (cwd: string) => SidecarManager;

function forwardToWindow(win: BrowserWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

/** Payload of the sidecar's `status` event (see SidecarEvents). */
interface StatusPayload {
	status: SidecarStatus;
	message?: string;
	cwd: string;
}

interface PoolEntry {
	sidecar: SidecarManager;
	tabId: string;
	win: BrowserWindow;
	/** win.webContents.id, cached at acquire — safe to read after the window is destroyed. */
	winId: number;
	/** Last status this tab's sidecar reported (TAB_STATUS / GET_TABS). */
	status: SidecarStatus;
	/** Agent run in flight (agent_start seen, no agent_end yet) — synthesized "running". */
	running: boolean;
	/** Session meta cached from session_info_update (TAB_STATUS / GET_TABS). */
	sessionId?: string;
	title?: string;
	/**
	 * Detaches the full-channel forwarders. Null while the tab is background
	 * (nothing wired); set exactly once per active stint so switches move
	 * listeners without duplicating them.
	 */
	detachFull: (() => void) | null;
}

export class SidecarPool {
	#entries = new Set<PoolEntry>();
	#byTabId = new Map<string, PoolEntry>();
	/** Window (webContents.id) → active tab. The first acquired tab defaults active. */
	#activeByWindow = new Map<number, string>();
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
	 * Spawn + bind a sidecar for `cwd` to `win` as a tab. Returns null at the
	 * cap. `tabId` defaults to a fresh snowflake (the window's initial sidecar
	 * is minted here too); `sessionPath` resumes that session on first start.
	 * The first tab of a window becomes its active tab; later tabs start in
	 * the background (light TAB_STATUS wiring only). Removes the entry when
	 * the window closes.
	 */
	acquire(
		cwd: string,
		win: BrowserWindow,
		tabId: string = nextSnowflake(),
		sessionPath?: string,
	): SidecarManager | null {
		if (this.atCap) return null;
		this.#reserved++;
		try {
			const sidecar = this.#factory(cwd);
			const entry: PoolEntry = {
				sidecar,
				tabId,
				win,
				winId: win.webContents.id,
				status: sidecar.status,
				running: false,
				detachFull: null,
			};
			this.#wireLight(entry);
			this.#entries.add(entry);
			this.#byTabId.set(tabId, entry);
			if (!this.#activeByWindow.has(entry.winId)) this.#setActive(entry);

			win.once("closed", () => {
				this.#releaseEntry(entry);
			});

			// A fresh sidecar with a session to resume goes through restart():
			// kill() is a no-op on a not-yet-spawned manager, so this is a plain
			// start() carrying --session.
			if (sessionPath) sidecar.restart(undefined, sessionPath);
			else sidecar.start();
			return sidecar;
		} catch {
			return null;
		} finally {
			// Release the synchronous reservation exactly once: on success the
			// slot is now the live entry; on failure the pool never held it.
			this.#reserved--;
		}
	}

	/** Per-tab light wiring, attached for the entry's whole life: TAB_STATUS pushes. */
	#wireLight(entry: PoolEntry): void {
		const { sidecar, win } = entry;
		sidecar.on("status", (payload: StatusPayload) => {
			entry.status = payload.status;
			// A restart/exit kills any in-flight run along with the process.
			if (payload.status !== "ready") entry.running = false;
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		});
		sidecar.on("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			if (typeof frame.title === "string") entry.title = frame.title;
			if (typeof frame.sessionId === "string") entry.sessionId = frame.sessionId;
			// Session meta changes ride the light channel too, so a background
			// tab's title/id updates without waiting for a status flip.
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		});
		// Run-state tracking works off the event stream (connection status never
		// re-fires at run end), so background tabs report running → ready too.
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			const wasRunning = entry.running;
			for (const event of events) {
				if (event.type === "agent_start") entry.running = true;
				else if (event.type === "agent_end") entry.running = false;
			}
			if (entry.running !== wasRunning) {
				forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			}
		});
	}

	/**
	 * Full-channel wiring, attached ONLY while the tab is its window's active
	 * tab. Idempotent: an already-wired entry is left untouched, so a repeated
	 * setActiveTab cannot stack duplicate listeners.
	 */
	#wireFull(entry: PoolEntry): void {
		if (entry.detachFull) return;
		const { sidecar, win } = entry;
		const removers: (() => void)[] = [];
		const wire = <T>(event: string, listener: (payload: T) => void): void => {
			sidecar.on(event, listener);
			removers.push(() => {
				sidecar.off(event, listener);
			});
		};
		wire("events", (events: AgentSessionEvent[]) => {
			forwardToWindow(win, IPC_EVENTS.EVENTS_BATCH, { events });
		});
		wire("status", (payload: StatusPayload) => {
			forwardToWindow(win, IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
		});
		wire("extensionUi", (request: ExtensionUIRequest) => {
			forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, { request });
		});
		wire("hostToolCall", (request: HostToolCallRequest) => {
			this.hostToolExecutor?.(sidecar, request, win);
		});
		wire("hostUriRequest", (request: HostUriRequest) => {
			forwardToWindow(win, IPC_EVENTS.HOST_URI_REQUEST, { request });
		});
		wire("subagentFrame", (frame: SubagentFrame) => {
			forwardToWindow(win, IPC_EVENTS.SUBAGENT_FRAME, { frame });
		});
		wire("liveUpdate", (frame: RpcLiveUpdateFrame) => {
			forwardToWindow(win, IPC_EVENTS.LIVE_UPDATE, frame);
		});
		wire("commandsUpdate", (commands: AvailableCommand[]) => {
			forwardToWindow(win, IPC_EVENTS.COMMANDS_UPDATE, { commands });
		});
		wire("configUpdate", (payload: ConfigUpdateFrame) => {
			forwardToWindow(win, IPC_EVENTS.CONFIG_UPDATE, payload);
		});
		wire("promptResult", (frame: PromptResultFrame) => {
			forwardToWindow(win, IPC_EVENTS.PROMPT_RESULT, frame);
		});
		wire("commandOutput", (frame: CommandOutputFrame) => {
			forwardToWindow(win, IPC_EVENTS.COMMAND_OUTPUT, frame);
		});
		wire("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			forwardToWindow(win, IPC_EVENTS.SESSION_INFO_UPDATE, frame);
		});
		wire("extensionError", (frame: ExtensionErrorFrame) => {
			forwardToWindow(win, IPC_EVENTS.EXTENSION_ERROR, frame);
		});
		entry.detachFull = () => {
			entry.detachFull = null;
			for (const remove of removers) remove();
		};
	}

	/** Move the window's active tab to `entry`, detaching the previous tab's forwarders. */
	#setActive(entry: PoolEntry): void {
		const previous = this.#byTabId.get(this.#activeByWindow.get(entry.winId) ?? "");
		if (previous === entry) return;
		if (previous?.detachFull) previous.detachFull();
		this.#activeByWindow.set(entry.winId, entry.tabId);
		this.#wireFull(entry);
	}

	/**
	 * Release a tab: listeners first, then dispose (a stale forwarder surviving
	 * into a sidecar.restart() would push events at a destroyed window). When
	 * the active tab goes away, the oldest surviving tab of the window takes
	 * over (the renderer may override with SET_ACTIVE_TAB); releasing the last
	 * tab leaves the window tab-less, back to its initial no-sidecar state.
	 */
	#releaseEntry(entry: PoolEntry): void {
		if (!this.#entries.delete(entry)) return;
		this.#byTabId.delete(entry.tabId);
		entry.sidecar.removeAllListeners();
		entry.sidecar.dispose();
		if (this.#activeByWindow.get(entry.winId) !== entry.tabId) return;
		this.#activeByWindow.delete(entry.winId);
		// During window teardown every entry self-releases; activating a sibling
		// whose window is already gone would wire forwarders for nothing.
		if (entry.win.isDestroyed()) return;
		for (const candidate of this.#entries) {
			if (candidate.winId === entry.winId) {
				this.#setActive(candidate);
				return;
			}
		}
	}

	/** The window's active entry (first entry as a fallback, e.g. mid-teardown). */
	entryForWindow(win: BrowserWindow): PoolEntry | undefined {
		const active = this.#byTabId.get(this.#activeByWindow.get(win.webContents.id) ?? "");
		if (active && active.win === win) return active;
		for (const entry of this.#entries) {
			if (entry.win === win) return entry;
		}
		return undefined;
	}

	/** Resolves via the ACTIVE tab, so every existing ipc.ts handler keeps working unchanged. */
	sidecarForWindow(win: BrowserWindow): SidecarManager | null {
		return this.entryForWindow(win)?.sidecar ?? null;
	}

	/** The sidecar of one specific tab, scoped to the window that owns it. */
	sidecarForTab(win: BrowserWindow, tabId: string): SidecarManager | null {
		const entry = this.#byTabId.get(tabId);
		return entry && entry.win === win ? entry.sidecar : null;
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: BrowserWindow, tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry || entry.win !== win) return false;
		this.#setActive(entry);
		return true;
	}

	/** Release one tab's sidecar. False when the tab is unknown. */
	releaseTab(tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return false;
		this.#releaseEntry(entry);
		return true;
	}

	/** The window's active tab id (null when the window has no tabs). */
	activeTabForWindow(win: BrowserWindow): string | null {
		return this.#activeByWindow.get(win.webContents.id) ?? null;
	}

	/** The window's tabs in acquisition order (GET_TABS boot reconciliation). */
	tabsForWindow(win: BrowserWindow): IpcTabInfo[] {
		const tabs: IpcTabInfo[] = [];
		for (const entry of this.#entries) {
			if (entry.win !== win) continue;
			tabs.push(tabStatusPayload(entry));
		}
		return tabs;
	}

	disposeAll(): void {
		for (const entry of this.#entries) {
			entry.sidecar.removeAllListeners();
			entry.sidecar.dispose();
		}
		this.#entries.clear();
		this.#byTabId.clear();
		this.#activeByWindow.clear();
	}
}

/** TAB_STATUS push / GET_TABS item: full tab snapshot incl. cached session meta. */
function tabStatusPayload(entry: PoolEntry): IpcTabStatusPayload {
	const payload: IpcTabStatusPayload = {
		tabId: entry.tabId,
		cwd: entry.sidecar.cwd,
		// "running" only makes sense on a live connection — a restarting sidecar
		// reports its connection state even with a dead in-flight run.
		status: entry.running && entry.status === "ready" ? "running" : entry.status,
	};
	if (entry.sessionId !== undefined) payload.sessionId = entry.sessionId;
	if (entry.title !== undefined) payload.title = entry.title;
	return payload;
}
