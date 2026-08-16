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
 *
 * F-OWN (double-attach guard): `#sessionOwners` maps a session file to the
 * tab/window attached to it, registered at acquire (spawn-with-sessionPath),
 * from the RPC passthrough (switch_session success / get_state — the only
 * main-observable carriers of the file path), and dropped on release or when
 * session_info_update reports a sessionId change (the cached file is stale;
 * the renderer's hydrate re-registers the current one).
 *
 * F-UI-ORIGIN (response routing): extension_ui / host_tool / host_uri
 * requests raised by a tab are recorded by request id → owning entry, so a
 * renderer response routes back to the sidecar that RAISED the request even
 * after the user switched to another tab (sidecarForWindow would misroute
 * it to the newly active sidecar, which never saw the request).
 */
import type { BrowserWindow } from "electron";
import {
	IPC_EVENTS,
	type IpcSessionOwner,
	type IpcTabInfo,
	type IpcTabStatusPayload,
	type IpcTabWorktree,
	type SessionTarget,
	type SessionKind,
} from "../shared/ipc-types";
import {
	type AgentSessionEvent,
	type AvailableCommand,
	BLOCKING_UI_METHODS,
	type CommandOutputFrame,
	type ConfigUpdateFrame,
	type ExtensionErrorFrame,
	type ExtensionUIRequest,
	type HostToolCallRequest,
	type HostUriRequest,
	type ModelCatalogUpdateFrame,
	type PromptResultFrame,
	type RpcCommand,
	type RpcLiveUpdateFrame,
	type RpcResponse,
	type SessionInfoUpdateFrame,
	type SidecarStatus,
	type SubagentFrame,
} from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";
import { nextSnowflake } from "./snowflake";
import { type PersistedTabDescriptor, type PersistedTabLayout, TAB_LAYOUT_VERSION } from "./tab-layout";

import { normalizeSessionTarget } from "../shared/session-target";

export type SidecarFactory = (options: {
	cwd: string;
	kind: SessionKind;
	fresh: boolean;
	target: SessionTarget;
	resumeSessionId?: string;
}) => SidecarManager;

function immutableTarget(target: SessionTarget): SessionTarget {
	if (target.type === "local") return Object.freeze({ type: "local" });
	const host = Object.freeze({ ...target.host });
	return Object.freeze({ ...target, host });
}
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
	/** Session kind: "agent" (default) or "chat" (tool-free). Immutable; set at acquire. */
	kind: "agent" | "chat";
	/** Untargeted startup tab; disposed when the user opens an explicit tab. */
	placeholder: boolean;
	/**
	 * Git-worktree binding (plan/20). Immutable, set at acquire from the spawn
	 * payload; surfaced via tabStatusPayload so the chip and close flow know
	 * this tab owns a ~/.omp/wt checkout.
	 */
	worktree?: IpcTabWorktree;
	status: SidecarStatus;
	/** Agent run in flight (agent_start seen, no agent_end yet) — synthesized "running". */
	running: boolean;
	/** Automatic transcript compaction state once observed — true blocks session mutation. */
	compacting?: boolean;
	/** Session meta cached from session_info_update (TAB_STATUS / GET_TABS). */
	sessionId?: string;
	title?: string | null;
	/**
	 * Session file this tab is attached to (F-OWN). Set at acquire when
	 * spawned with --session and maintained from the RPC passthrough via
	 * noteSessionFile; the reverse key of #sessionOwners.
	 */
	sessionFile?: string;
	/**
	 * Detaches the full-channel forwarders. Null while the tab is background
	 * (nothing wired); set exactly once per active stint so switches move
	 * listeners without duplicating them.
	 */
	detachFull: (() => void) | null;
	/** Immutable target snapshot; SSH cwd is replaced atomically when the live session moves. */
	target: SessionTarget;
}

export class SidecarPool {
	#entries = new Set<PoolEntry>();

	#byTabId = new Map<string, PoolEntry>();

	/** Window (webContents.id) → active tab. The first acquired tab defaults active. */
	#activeByWindow = new Map<number, string>();

	/** Session file → owning tab/window (F-OWN double-attach guard). */
	#sessionOwners = new Map<string, IpcSessionOwner>();

	/**
	 * Pending renderer-facing request id → entry that raised it (F-UI-ORIGIN).
	 * Registration is first-writer-wins while an id is live: a duplicate can
	 * neither replace its owner nor gain response authority. Entries drop on a
	 * final response or when the owning entry/window is released.
	 */
	#requestOwners = new Map<string, PoolEntry>();

	/**
	 * Synchronously-reserved spawn slots. An acquire claims one before the
	 * (synchronous-but-fragile) SidecarManager.start(), and releases it if the
	 * start throws. This is what makes the cap atomic: a concurrent acquire
	 * sees the reservation and is refused even before the child exists.
	 */
	#reserved = 0;

	readonly #max: number;

	readonly #factory: SidecarFactory;

	/** Suppress partial snapshots while a saved layout is being reconstructed. */
	#restoringWindows = new Set<number>();

	/**
	 * Host-tool dispatch needs the main-process executor (ipc.ts), which the
	 * pool cannot import without a cycle. Set once at startup; the pool routes
	 * each sidecar's hostToolCall through it with the owning window. Returns
	 * true when the tool was answered inline (GUI-registered) — the pool only
	 * tracks request ids for renderer-forwarded calls (F-UI-ORIGIN).
	 */
	hostToolExecutor: ((sidecar: SidecarManager, request: HostToolCallRequest, win: BrowserWindow) => boolean) | null =
		null;

	/** Main-process persistence hook. The primary window installs this at startup. */
	onWindowTabsChanged: ((win: BrowserWindow, layout: PersistedTabLayout | null) => void) | null = null;

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
	 * `kind` defaults to "agent"; "chat" spawns a tool-free conversation.
	 * The first tab of a window becomes its active tab; later tabs start in
	 * the background (light TAB_STATUS wiring only). Removes the entry when
	 * the window closes.
	 */
	acquire(options: SidecarAcquireOptions): SidecarManager | null {
		if (this.atCap) return null;
		this.#reserved++;
		try {
			const {
				cwd,
				win,
				tabId = nextSnowflake(),
				sessionPath,
				resumeSessionId,
				kind = "agent",
				worktree,
				fresh = false,
				placeholder = false,
			} = options;
			const target = immutableTarget(normalizeSessionTarget(options.target));
			const remoteResumeSessionId = target.type === "ssh" ? resumeSessionId : undefined;
			const sidecar = this.#factory({ cwd, kind, fresh, target, resumeSessionId: remoteResumeSessionId });
			const entry: PoolEntry = {
				sidecar,
				tabId,
				win,
				winId: win.webContents.id,
				kind,
				placeholder,
				target,
				worktree,
				status: sidecar.status,
				running: false,
				detachFull: null,
			};
			this.#wireLight(entry);
			this.#entries.add(entry);
			this.#byTabId.set(tabId, entry);
			// Local file ownership never receives remote session ids or paths.
			if (target.type === "local" && sessionPath) this.#registerSessionFile(entry, sessionPath);
			if (!this.#activeByWindow.has(entry.winId)) this.#setActive(entry);

			win.once("closed", () => {
				this.#releaseEntry(entry);
			});

			// Local file resumes keep the existing --session/restart path.
			if (target.type === "local" && sessionPath) sidecar.restart(undefined, sessionPath);
			else sidecar.start();
			this.#notifyWindowTabsChanged(win);
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
			if (payload.status !== "ready") {
				entry.running = false;
				entry.compacting = undefined;
			}
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		});
		sidecar.on("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			if (frame.title !== undefined) entry.title = frame.title;
			if (typeof frame.sessionId === "string") {
				const previousId = entry.sessionId;
				entry.sessionId = frame.sessionId;
				// F-OWN: the session under this tab changed (switch / new session
				// / crash-restart) — the cached file→owner mapping is stale. The
				// first attach (previousId undefined) keeps the acquire-time
				// registration; the renderer's hydrate (get_state) re-registers
				// the current file after a real change.
				if (previousId !== undefined && previousId !== frame.sessionId) this.#unregisterSessionFile(entry);
			}
			// Session meta changes ride the light channel too, so a background
			// tab's title/id updates without waiting for a status flip.
			forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		});
		// Run-state tracking works off the event stream (connection status never
		// re-fires at run end), so background tabs report running → ready too.
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			const wasBusy = entry.running || entry.compacting === true;
			const wasPlaceholder = entry.placeholder;
			for (const event of events) {
				if (event.type === "agent_start") {
					entry.running = true;
					entry.placeholder = false;
				} else if (event.type === "agent_end") entry.running = false;
				else if (event.type === "auto_compaction_start") entry.compacting = true;
				else if (event.type === "auto_compaction_end") entry.compacting = false;
			}
			const busy = entry.running || entry.compacting === true;
			if (busy !== wasBusy || entry.placeholder !== wasPlaceholder) {
				forwardToWindow(win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			}
			if (entry.placeholder !== wasPlaceholder) this.#notifyWindowTabsChanged(win);
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
		const forwardActive = <T>(channel: string, payload: T): void => {
			forwardToWindow(win, channel, { tabId: entry.tabId, payload });
		};
		const wire = <T>(event: string, listener: (payload: T) => void): void => {
			sidecar.on(event, listener);
			removers.push(() => {
				sidecar.off(event, listener);
			});
		};
		wire("events", (events: AgentSessionEvent[]) => {
			forwardActive(IPC_EVENTS.EVENTS_BATCH, events);
		});
		wire("status", (payload: StatusPayload) => {
			forwardActive(IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
		});
		wire("extensionUi", (request: ExtensionUIRequest) => {
			// F-UI-ORIGIN: a response must reach THIS sidecar even if the user
			// switches tabs while the dialog is open, so blocking requests take an
			// origin route and invalid or duplicate ids are not forwarded because
			// they cannot acquire response ownership. Fire-and-forget UI updates
			// never reply, so retaining them here would leak the owning tab.
			if (BLOCKING_UI_METHODS[request.method] && !this.#registerRequestOwner(request.id, entry)) return;
			forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, { tabId: entry.tabId, request });
		});
		wire("hostToolCall", (request: HostToolCallRequest) => {
			if (sidecar.denyRemoteHostTool(request)) return;
			// Answered-inline tools never reach the renderer. Reserve eligibility
			// before dispatch so a live duplicate cannot execute or be forwarded,
			// then register only calls the executor actually forwarded.
			if (!this.#requestIdAvailable(request.id)) return;
			const answeredInline = this.hostToolExecutor ? this.hostToolExecutor(sidecar, request, win) : true;
			if (!answeredInline) this.#registerRequestOwner(request.id, entry);
		});
		wire("hostUriRequest", (request: HostUriRequest) => {
			if (!this.#registerRequestOwner(request.id, entry)) return;
			forwardToWindow(win, IPC_EVENTS.HOST_URI_REQUEST, { request });
		});
		wire("subagentFrame", (frame: SubagentFrame) => {
			forwardActive(IPC_EVENTS.SUBAGENT_FRAME, frame);
		});
		wire("liveUpdate", (frame: RpcLiveUpdateFrame) => {
			forwardActive(IPC_EVENTS.LIVE_UPDATE, frame);
		});
		wire("modelCatalogUpdate", (frame: ModelCatalogUpdateFrame) => {
			forwardActive(IPC_EVENTS.MODEL_CATALOG_UPDATE, frame);
		});
		wire("commandsUpdate", (commands: AvailableCommand[]) => {
			forwardActive(IPC_EVENTS.COMMANDS_UPDATE, commands);
		});
		wire("configUpdate", (payload: ConfigUpdateFrame) => {
			forwardActive(IPC_EVENTS.CONFIG_UPDATE, payload);
		});
		wire("promptResult", (frame: PromptResultFrame) => {
			forwardActive(IPC_EVENTS.PROMPT_RESULT, frame);
		});
		wire("commandOutput", (frame: CommandOutputFrame) => {
			forwardActive(IPC_EVENTS.COMMAND_OUTPUT, frame);
		});
		wire("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			forwardActive(IPC_EVENTS.SESSION_INFO_UPDATE, frame);
		});
		wire("extensionError", (frame: ExtensionErrorFrame) => {
			forwardActive(IPC_EVENTS.EXTENSION_ERROR, frame);
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
		this.#unregisterSessionFile(entry);
		// Drop pending routes pointing at the released entry. A late response is
		// genuinely unknown; a still-live route owned by another entry is kept.
		for (const [id, owner] of this.#requestOwners) {
			if (owner === entry) this.#requestOwners.delete(id);
		}
		entry.sidecar.removeAllListeners();
		this.#trackDisposal(entry.sidecar.dispose());
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

	/** Send a command to the idle tab attached to `sessionPath`. */
	async commandForIdleSession(sessionPath: string, command: RpcCommand): Promise<RpcResponse | null> {
		const owner = this.#sessionOwners.get(sessionPath);
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (!entry || entry.running || entry.compacting === true || entry.status !== "ready") return null;
		const client = entry.sidecar.rpcClient;
		return client ? await client.command(command) : null;
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: BrowserWindow, tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry || entry.win !== win) return false;
		const changed = this.#activeByWindow.get(entry.winId) !== entry.tabId;
		this.#setActive(entry);
		if (changed) this.#notifyWindowTabsChanged(win);
		return true;
	}

	/** Release one tab's sidecar. False when the tab is unknown. */
	releaseTab(tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry) return false;
		this.#releaseEntry(entry);
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/**
	 * The tab/window currently attached to `sessionPath`, null when free
	 * (F-OWN). SPAWN_TAB and SESSION_OPEN_NEW_WINDOW consult this before
	 * spawning a second sidecar for the same file.
	 */
	sessionOwner(sessionPath: string): IpcSessionOwner | null {
		return this.#sessionOwners.get(sessionPath) ?? null;
	}

	/**
	 * The owner BLOCKING `tabId`'s attach to `sessionPath` — the file's current
	 * owner when it is a different tab, else null (unowned, or owned by the
	 * issuer itself, which re-attaches freely). An untracked issuer (null
	 * tabId) is blocked by any owner: refusing is the safe direction there.
	 * F-OWN's refuse-or-focus decision point for the switch_session passthrough.
	 */
	foreignSessionOwner(tabId: string | null, sessionPath: string): IpcSessionOwner | null {
		const owner = this.#sessionOwners.get(sessionPath);
		if (!owner || owner.tabId === tabId) return null;
		return owner;
	}

	/**
	 * Record the local session file a local tab's sidecar is attached to.
	 * ipc.ts reports this from the RPC passthrough (switch_session success,
	 * get_state). Remote identity is hostAlias + sessionId and must never enter
	 * the local file-owner map. Null unregisters a fresh unsaved local session.
	 */
	noteSessionFile(tabId: string, sessionFile: string | null): void {
		const entry = this.#byTabId.get(tabId);
		if (entry?.target.type !== "local") return;
		const previous = entry.sessionFile;
		if (sessionFile) this.#registerSessionFile(entry, sessionFile);
		else this.#unregisterSessionFile(entry);
		if (entry.sessionFile !== previous) {
			forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
			this.#notifyWindowTabsChanged(entry.win);
		}
	}

	/**
	 * Re-root a tab to its live session's cwd. `switch_session` re-roots the
	 * agent with no main-observable event, so the chip and every `sidecar.cwd`
	 * consumer stay frozen at the spawn cwd until this is called — the RPC
	 * passthrough reports the post-switch cwd (get_state) here. Pushes
	 * TAB_STATUS when the cwd changed so the renderer's chip tracks the move.
	 * Returns true when the cwd changed (ipc.ts gates the window-record sync).
	 */
	adoptSessionCwd(tabId: string, cwd: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry || !cwd) return false;
		const target = entry.sidecar.adoptTargetCwd(cwd);
		if (!target) return false;
		entry.target = immutableTarget(target);
		forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/**
	 * Route a renderer response only when both its bounded request id and exact
	 * caller window match the live owner. A foreign/invalid caller is rejected
	 * without consuming the route; only genuinely absent ids are `unknown` and
	 * therefore eligible for the IPC compatibility fallback.
	 */
	routeSideChannel(win: BrowserWindow, id: unknown, frame: object, final: boolean): SideChannelRoute {
		if (!validSideChannelRequestId(id)) return "foreign";
		const entry = this.#requestOwners.get(id);
		if (!entry) return "unknown";
		if (win.isDestroyed()) return "foreign";
		if (entry.win !== win || entry.winId !== win.webContents.id) return "foreign";
		if (final) this.#requestOwners.delete(id);
		entry.sidecar.sendSideChannel(frame);
		return "routed";
	}

	/** Register sessionFile → owner, moving the entry off any previous file. */
	#registerSessionFile(entry: PoolEntry, sessionFile: string): void {
		if (entry.sessionFile !== sessionFile) this.#unregisterSessionFile(entry);
		entry.sessionFile = sessionFile;
		this.#sessionOwners.set(sessionFile, { tabId: entry.tabId, winId: entry.winId });
	}

	/** Drop the entry's file→owner mapping when it still points at this entry. */
	#unregisterSessionFile(entry: PoolEntry): void {
		if (entry.sessionFile === undefined) return;
		// Another tab may have re-registered the same file since — only the
		// current owner may clear the mapping.
		if (this.#sessionOwners.get(entry.sessionFile)?.tabId === entry.tabId) {
			this.#sessionOwners.delete(entry.sessionFile);
		}
		entry.sessionFile = undefined;
	}

	/** The window's active tab id (null when the window has no tabs). */
	activeTabForWindow(win: BrowserWindow): string | null {
		return this.#activeByWindow.get(win.webContents.id) ?? null;
	}

	/** The window's tabs in acquisition order (GET_TABS boot reconciliation). */
	tabsForWindow(win: BrowserWindow): IpcTabInfo[] {
		const tabs: IpcTabInfo[] = [];
		let activeTabId: string | undefined;
		for (const entry of this.#entries) {
			if (entry.win !== win) continue;
			activeTabId ??= this.#activeByWindow.get(entry.winId);
			const tab = tabStatusPayload(entry);
			if (entry.tabId === activeTabId) tab.active = true;
			tabs.push(tab);
		}
		return tabs;
	}

	/** Serializable layout for the window, excluding transient run/status data. */
	tabLayoutForWindow(win: BrowserWindow): PersistedTabLayout | null {
		const entries = [...this.#entries].filter(entry => entry.win === win);
		if (entries.length === 0) return null;
		const activeTabId = this.#activeByWindow.get(win.webContents.id);
		const activeIndex = Math.max(
			0,
			entries.findIndex(entry => entry.tabId === activeTabId),
		);
		return {
			version: TAB_LAYOUT_VERSION,
			activeIndex,
			tabs: entries.map(entry => {
				const descriptor: PersistedTabDescriptor = { cwd: entry.sidecar.cwd, kind: entry.kind };
				if (entry.sessionFile) descriptor.sessionPath = entry.sessionFile;
				if (entry.worktree) descriptor.worktree = entry.worktree;
				if (entry.placeholder) descriptor.placeholder = true;
				return descriptor;
			}),
		};
	}

	/** Recreate saved tabs with fresh runtime ids, then restore their active index. */
	restoreLayout(win: BrowserWindow, layout: PersistedTabLayout): number {
		const winId = win.webContents.id;
		this.#restoringWindows.add(winId);
		let restoredCount = 0;
		let firstRestoredTabId: string | undefined;
		let activeRestoredTabId: string | undefined;
		try {
			for (const [index, tab] of layout.tabs.entries()) {
				const tabId = nextSnowflake();
				const sidecar = this.acquire({
					cwd: tab.cwd,
					win,
					tabId,
					sessionPath: tab.sessionPath,
					kind: tab.kind,
					worktree: tab.worktree,
					fresh: !tab.sessionPath,
					placeholder: tab.placeholder === true,
				});
				if (!sidecar) continue;
				restoredCount++;
				firstRestoredTabId ??= tabId;
				if (index === layout.activeIndex) activeRestoredTabId = tabId;
			}
			const activeTabId = activeRestoredTabId ?? firstRestoredTabId;
			if (activeTabId) {
				const active = this.#byTabId.get(activeTabId);
				if (active) this.#setActive(active);
			}
		} finally {
			this.#restoringWindows.delete(winId);
		}
		this.#notifyWindowTabsChanged(win);
		return restoredCount;
	}

	#notifyWindowTabsChanged(win: BrowserWindow): void {
		if (!this.onWindowTabsChanged || this.#restoringWindows.has(win.webContents.id)) return;
		this.onWindowTabsChanged(win, this.tabLayoutForWindow(win));
	}

	async disposeAll(): Promise<void> {
		for (const entry of this.#entries) {
			entry.sidecar.removeAllListeners();
			this.#trackDisposal(entry.sidecar.dispose());
		}
		this.#entries.clear();
		this.#byTabId.clear();
		this.#activeByWindow.clear();
		this.#sessionOwners.clear();
		this.#requestOwners.clear();
		this.#restoringWindows.clear();
		await Promise.all([...this.#pendingDisposals]);
		if (this.#disposalFailures.length > 0) {
			const errors = this.#disposalFailures.splice(0);
			throw new AggregateError(errors, "One or more sidecars could not be disposed");
		}
	}

	/** In-flight async sidecar disposals plus retained failures for shutdown aggregation. */
	#pendingDisposals = new Set<Promise<void>>();

	#disposalFailures: unknown[] = [];

	#trackDisposal(disposal: Promise<void>): void {
		let tracked: Promise<void>;
		tracked = disposal
			.catch(error => {
				this.#disposalFailures.push(error);
			})
			.finally(() => {
				this.#pendingDisposals.delete(tracked);
			});
		this.#pendingDisposals.add(tracked);
	}

	/**
	 * Register a renderer-facing request without replacing a live owner.
	 * Malformed ids are never admitted as routing authority.
	 */
	#registerRequestOwner(id: unknown, entry: PoolEntry): boolean {
		if (!this.#requestIdAvailable(id)) return false;
		this.#requestOwners.set(id, entry);
		return true;
	}

	#requestIdAvailable(id: unknown): id is string {
		return validSideChannelRequestId(id) && !this.#requestOwners.has(id);
	}
}

/** TAB_STATUS push / GET_TABS item: full tab snapshot incl. cached session meta. */
function tabStatusPayload(entry: PoolEntry): IpcTabStatusPayload {
	const payload: IpcTabStatusPayload = {
		tabId: entry.tabId,
		cwd: entry.sidecar.cwd,
		target: entry.target,
		kind: entry.kind,
		placeholder: entry.placeholder,
		sessionPath: entry.sessionFile ?? null,
		// "running" only makes sense on a live connection — a restarting sidecar
		// reports its connection state even with a dead in-flight run.
		status: entry.running && entry.status === "ready" ? "running" : entry.status,
	};
	if (entry.compacting !== undefined) payload.compacting = entry.compacting;
	if (entry.sessionId !== undefined) payload.sessionId = entry.sessionId;
	if (entry.title !== undefined) payload.title = entry.title;
	if (entry.worktree !== undefined) payload.worktree = entry.worktree;
	return payload;
}
const MAX_SIDE_CHANNEL_REQUEST_ID_LENGTH = 128;
export type SideChannelRoute = "routed" | "foreign" | "unknown";

function validSideChannelRequestId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_SIDE_CHANNEL_REQUEST_ID_LENGTH;
}

export interface SidecarAcquireOptions {
	cwd: string;
	win: BrowserWindow;
	tabId?: string;
	sessionPath?: string;
	resumeSessionId?: string;
	kind?: SessionKind;
	worktree?: IpcTabWorktree;
	fresh?: boolean;
	placeholder?: boolean;
	target?: SessionTarget;
}
