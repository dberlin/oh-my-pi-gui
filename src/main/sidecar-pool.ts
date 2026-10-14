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
 * extension ui/error, host tool/uri) forward from at most two VISIBLE tabs.
 * One of them is focused for untargeted commands. Every tab (visible or
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
	type IpcSpawnTabPayload,
	type IpcSetTabViewPayload,
	type IpcTabInfo,
	type IpcTabStatusPayload,
	type IpcTabWorktree,
	type SessionKind,
	type SessionTarget,
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
	type SessionSettledFrame,
	type SidecarStatus,
	type SidecarStatusPayload,
	type SubagentFrame,
} from "../shared/rpc-types";
import { normalizeSessionTarget, sameSessionTarget } from "../shared/session-target";
import type { WindowTabFact } from "./quit-guard";
import { parseBtwFrame } from "./btw-transport";
import type { SidecarManager } from "./sidecar";
import { nextSnowflake } from "./snowflake";
import { type PersistedTabDescriptor, type PersistedTabLayout, TAB_LAYOUT_VERSION } from "./tab-layout";

export type SidecarFactory = (options: {
	cwd: string;
	kind: SessionKind;
	fresh: boolean;
	target: SessionTarget;
	resumeSessionId?: string;
	model?: IpcSpawnTabPayload["model"];
}) => SidecarManager;

function immutableTarget(target: SessionTarget): SessionTarget {
	if (target.type === "local") return Object.freeze({ type: "local" });
	const host = Object.freeze({ ...target.host });
	return Object.freeze({ ...target, host });
}
function forwardToWindow(win: BrowserWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}

interface PoolEntry {
	sidecar: SidecarManager;
	tabId: string;
	win: BrowserWindow;
	/** win.webContents.id, cached at acquire — safe to read after the window is destroyed. */
	winId: number;
	/** Session kind: "agent" (default) or "chat" (tool-free). Immutable; set at acquire. */
	kind: "agent" | "chat";
	/** Untargeted startup tab; disposed when the user opens an explicit tab. */
	placeholder: boolean;
	/** Hidden, ownership-reserved background restore; never focusable until commit. */
	restoringSession?: boolean;
	restoreSettled?: { promise: Promise<void>; resolve: () => void };
	modelOrigin?: IpcSpawnTabPayload["modelOrigin"];
	restoreRequestId?: string;
	resumeSessionId?: string;
	retainedRestore?: { sessionId?: string; title?: string | null };
	restoreFailurePending?: boolean;
	/**
	 * Git-worktree binding (plan/20). Immutable, set at acquire from the spawn
	 * payload; surfaced via tabStatusPayload so the chip and close flow know
	 * this tab owns a ~/.omp/wt checkout.
	 */
	worktree?: IpcTabWorktree;
	/** Last status this tab's sidecar reported (TAB_STATUS / GET_TABS). */
	status: SidecarStatus;
	/** Agent run in flight (agent_start seen, no agent_end yet) — synthesized "running". */
	running: boolean;
	/** Prompt yielded while background work can still wake the session. */
	awaitingSessionSettled: boolean;
	/** Automatic transcript compaction state once observed — true blocks session mutation. */
	compacting?: boolean;
	/** Agent outcome is independent of connection readiness. */
	runState?: IpcTabInfo["runState"];
	retryInfo?: IpcTabInfo["retryInfo"];
	pendingOutcome?: "completed" | "failed" | "idle";
	/** Session meta cached from session_info_update (TAB_STATUS / GET_TABS). */
	sessionId?: string;
	/**
	 * Session meta cached from session_info_update — or, for a tab restored from
	 * the layout that has not been spawned yet, seeded from the persisted title
	 * so its chip has something better than a folder name to show.
	 */
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

type WindowSplitView = NonNullable<IpcSetTabViewPayload["split"]>;

export class SidecarPool {
	#entries = new Set<PoolEntry>();

	#byTabId = new Map<string, PoolEntry>();

	/** Window (webContents.id) → active tab. The first acquired tab defaults active. */
	#activeByWindow = new Map<number, string>();
	/** Window → the one or two tabs whose full event streams are rendered. */
	#visibleByWindow = new Map<number, Set<string>>();
	/** Window → persisted order, axis, and ratio for its optional two-pane view. */
	#splitByWindow = new Map<number, WindowSplitView>();
	/** Session file → owning tab/window (F-OWN double-attach guard). */
	#sessionOwners = new Map<string, IpcSessionOwner>();

	/**
	 * Pending renderer-facing request id → entry that raised it (F-UI-ORIGIN).
	 * Registration is first-writer-wins while an id is live: a duplicate can
	 * neither replace its owner nor gain response authority. Entries drop on a
	 * final response or when the owning entry/window is released.
	 */
	#requestOwners = new Map<string, PoolEntry>();
	#restoreRequests = new Map<
		BrowserWindow,
		Map<
			string,
			{
				controller: AbortController;
				origin?: IpcSpawnTabPayload["modelOrigin"];
				onClosed: () => void;
			}
		>
	>();

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
	 *
	 * `deferStart` creates the tab WITHOUT spawning its process and without
	 * claiming the window's active slot: a sidecar holds ~200 MB of private
	 * memory, so a restored layout must not pay for tabs nobody has looked at.
	 * The spawn happens in `#wireFull`, i.e. the first time the tab is
	 * rendered — `#syncFullWiring` is the single point that knows a tab became
	 * visible.
	 */
	acquire(options: SidecarAcquireOptions): SidecarManager | null {
		if (this.atCap) return null;
		if (
			options.restoreRequestId &&
			this.#restoreRequests.get(options.win)?.get(options.restoreRequestId)?.controller.signal.aborted
		)
			return null;
		const reservedPath =
			options.target?.type === "ssh" ? undefined : (options.restoreSessionPath ?? options.sessionPath);
		if (reservedPath && this.#sessionOwners.has(reservedPath)) return null;
		this.#reserved++;
		let hiddenEntry: PoolEntry | undefined;
		try {
			const {
				cwd,
				win,
				tabId = nextSnowflake(),
				resumeSessionId,
				kind = "agent",
				worktree,
				fresh = false,
				placeholder = false,
				deferStart = false,
				title,
			} = options;
			const target = immutableTarget(normalizeSessionTarget(options.target));
			const remoteResumeSessionId = target.type === "ssh" ? resumeSessionId : undefined;
			const sidecar = this.#factory({
				cwd,
				kind,
				fresh,
				target,
				resumeSessionId: remoteResumeSessionId,
				...(options.model ? { model: options.model } : {}),
			});
			const entry: PoolEntry = {
				sidecar,
				tabId,
				win,
				winId: win.webContents.id,
				kind,
				placeholder,
				restoringSession: options.restoringSession,
				modelOrigin: options.modelOrigin,
				restoreRequestId: options.restoreRequestId,
				resumeSessionId: remoteResumeSessionId,
				sessionId: remoteResumeSessionId,
				target,
				worktree,
				status: sidecar.status,
				running: false,
				awaitingSessionSettled: false,
				detachFull: null,
			};
			if (title) entry.title = title;
			if (entry.restoringSession) {
				const settled = Promise.withResolvers<void>();
				entry.restoreSettled = { promise: settled.promise, resolve: settled.resolve };
			}
			this.#wireLight(entry);
			this.#entries.add(entry);
			this.#byTabId.set(tabId, entry);
			if (entry.restoringSession) hiddenEntry = entry;
			// F-OWN: a local spawn-with-sessionPath owns that file immediately,
			// including a deferred restore. Remote identity is a host/session id
			// and must never enter the local path-owner map.
			if (target.type === "local" && reservedPath) this.#registerSessionFile(entry, reservedPath);
			if (!deferStart && !entry.restoringSession && !this.#activeByWindow.has(entry.winId)) {
				this.#activeByWindow.set(entry.winId, entry.tabId);
				this.#visibleByWindow.set(entry.winId, new Set([entry.tabId]));
				this.#syncFullWiring(entry.winId);
			}

			win.once("closed", () => {
				this.#releaseEntry(entry);
			});

			if (!deferStart) this.#ensureStarted(entry);
			this.#notifyWindowTabsChanged(win);
			return sidecar;
		} catch {
			if (hiddenEntry) this.#releaseEntry(hiddenEntry);
			return null;
		} finally {
			// Release the synchronous reservation exactly once: on success the
			// slot is now the live entry; on failure the pool never held it.
			this.#reserved--;
		}
	}

	/**
	 * Spawn a tab's sidecar unless one is already under way or it has already
	 * run. A fresh sidecar with a session to resume goes through restart():
	 * kill() is a no-op on a not-yet-spawned manager, so this is a plain
	 * start() carrying --session. Safe to call on every visibility change —
	 * `status` leaves "asleep" synchronously inside start(), so a second call
	 * can never double-spawn.
	 */
	#ensureStarted(entry: PoolEntry): void {
		if (entry.sidecar.status !== "asleep") return;
		const sessionPath = entry.restoringSession ? undefined : entry.sessionFile;
		if (sessionPath) entry.sidecar.restart(undefined, sessionPath);
		else entry.sidecar.start();
	}

	/** Per-tab light wiring, attached for the entry's whole life: TAB_STATUS pushes. */
	#wireLight(entry: PoolEntry): void {
		const { sidecar, win } = entry;
		const publish = (payload: IpcTabStatusPayload): void => {
			if (!entry.restoringSession || entry.retainedRestore) forwardToWindow(win, IPC_EVENTS.TAB_STATUS, payload);
		};
		const retireQuestions = () => {
			for (const [id, owner] of this.#requestOwners) {
				if (owner !== entry) continue;
				this.#requestOwners.delete(id);
				forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, {
					tabId: entry.tabId,
					restoringSession: true,
					modelOrigin: entry.modelOrigin,
					restoreRequestId: entry.restoreRequestId,
					request: { type: "extension_ui_request", id: `cancel-${id}`, method: "cancel", targetId: id },
				});
			}
		};
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			entry.status = payload.status;
			if (
				entry.restoringSession &&
				(payload.status === "restarting" || payload.status === "error" || payload.status === "exited")
			)
				retireQuestions();
			// A restart/exit kills any in-flight run along with the process.
			if (payload.status !== "ready") {
				entry.running = false;
				entry.awaitingSessionSettled = false;
				entry.compacting = undefined;
				entry.runState = undefined;
				entry.retryInfo = entry.retryInfo === undefined ? undefined : null;
				entry.pendingOutcome = undefined;
			}
			publish(tabStatusPayload(entry));
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
				if (previousId !== undefined && previousId !== frame.sessionId) {
					if (!entry.restoringSession) this.#unregisterSessionFile(entry);
					entry.runState = undefined;
					entry.retryInfo = entry.retryInfo === undefined ? undefined : null;
					entry.pendingOutcome = undefined;
				}
			}
			// Session meta changes ride the light channel too, so a background
			// tab's title/id updates without waiting for a status flip.
			publish(tabStatusPayload(entry));
		});
		const setRunning = (running: boolean): void => {
			const wasBusy = entry.running || entry.compacting === true;
			const wasOutcome = entry.runState;
			entry.running = running;
			if (!running && entry.pendingOutcome) {
				entry.runState = entry.pendingOutcome;
				entry.pendingOutcome = undefined;
			}
			const busy = entry.running || entry.compacting === true;
			if (busy !== wasBusy || entry.runState !== wasOutcome) {
				publish(tabStatusPayload(entry));
			}
		};
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			if (typeof frame.sessionSettled !== "boolean") return;
			entry.awaitingSessionSettled = !frame.sessionSettled;
			if (frame.agentInvoked || frame.status === "error") {
				entry.pendingOutcome =
					frame.status === "error" ? "failed" : frame.status === "aborted" ? "idle" : "completed";
			}
			setRunning(!frame.sessionSettled);
		});
		sidecar.on("sessionSettled", (_frame: SessionSettledFrame) => {
			entry.awaitingSessionSettled = false;
			if (entry.running && !entry.pendingOutcome) entry.pendingOutcome = "completed";
			setRunning(false);
		});
		// Nonterminal yields and retry attempts do not complete the logical turn.
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			const wasBusy = entry.running || entry.compacting === true;
			const wasPlaceholder = entry.placeholder;
			const wasOutcome = entry.runState;
			const wasRetry = entry.retryInfo;
			let startedInBatch = false;
			for (const event of events) {
				if (event.type === "agent_start") {
					startedInBatch = true;
					entry.running = true;
					entry.placeholder = false;
					if (!entry.retryInfo) {
						entry.runState = undefined;
						entry.pendingOutcome = undefined;
					}
				} else if (event.type === "auto_retry_start") {
					entry.running = true;
					entry.runState = "retrying";
					entry.pendingOutcome = undefined;
					entry.retryInfo = {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage,
						startedAt: Date.now(),
					};
				} else if (event.type === "auto_retry_end") {
					entry.retryInfo = null;
					entry.runState = undefined;
					entry.pendingOutcome = event.success ? undefined : "failed";
				} else if (event.type === "agent_end") {
					if (event.isTerminal === false || entry.retryInfo) continue;
					const last = event.messages?.findLast(message => message.role === "assistant");
					const outcome =
						last?.stopReason === "aborted"
							? "idle"
							: last?.stopReason === "error" || entry.pendingOutcome === "failed" || entry.runState === "failed"
								? "failed"
								: "completed";
					if (entry.awaitingSessionSettled) {
						entry.pendingOutcome = outcome;
					} else {
						entry.running = false;
						entry.runState = outcome;
						entry.pendingOutcome = undefined;
					}
				} else if (event.type === "auto_compaction_start") entry.compacting = true;
				else if (event.type === "auto_compaction_end") entry.compacting = false;
			}
			const busy = entry.running || entry.compacting === true;
			const shortTurn = startedInBatch && !wasBusy && !busy && entry.status === "ready";
			if (shortTurn) {
				// Preserve a real start that batching would otherwise hide from
				// completion badges and the once-per-turn notification gate.
				const started = tabStatusPayload(entry);
				started.status = "running";
				delete started.runState;
				publish(started);
			}
			if (
				shortTurn ||
				busy !== wasBusy ||
				entry.placeholder !== wasPlaceholder ||
				entry.runState !== wasOutcome ||
				entry.retryInfo !== wasRetry
			) {
				publish(tabStatusPayload(entry));
			}
			if (entry.placeholder !== wasPlaceholder) this.#notifyWindowTabsChanged(win);
		});
		sidecar.on("extensionUi", (request: ExtensionUIRequest) => {
			if (!entry.restoringSession) return;
			if (request.method === "cancel") {
				if (this.#requestOwners.get(request.targetId) !== entry) return;
				this.#requestOwners.delete(request.targetId);
			} else {
				if (!BLOCKING_UI_METHODS[request.method]) return;
				if (!sidecar.extensionUiTransportReady) {
					const message =
						"This omp runtime cannot answer blocking extension UI during RPC bootstrap. " +
						"Move interactive startup prompts to session_before_switch, or use a runtime whose input reader starts before session_start.";
					// Never show a question the native runtime cannot yet consume.
					// Existing origin-bound cancellation owns target cleanup.
					sidecar.markUnhealthy(message);
					if (entry.restoreRequestId) {
						this.#restoreRequests.get(win)?.get(entry.restoreRequestId)?.controller.abort(new Error(message));
					}
					return;
				}
				if (!this.#registerRequestOwner(request.id, entry)) return;
			}
			forwardToWindow(win, IPC_EVENTS.EXTENSION_UI, {
				tabId: entry.tabId,
				request,
				restoringSession: true,
				modelOrigin: entry.modelOrigin,
				restoreRequestId: entry.restoreRequestId,
			});
		});
		sidecar.on("hostToolCall", (request: HostToolCallRequest) => {
			if (!entry.restoringSession || sidecar.denyRemoteHostTool(request) || !this.#requestIdAvailable(request.id))
				return;
			if (this.hostToolExecutor?.(sidecar, request, win)) return;
			sidecar.sendSideChannel({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: "This host tool is not available while restoring a saved session" }],
				},
				isError: true,
			});
		});
		sidecar.on("hostUriRequest", (request: HostUriRequest) => {
			if (!entry.restoringSession || !this.#requestIdAvailable(request.id)) return;
			sidecar.sendSideChannel({
				type: "host_uri_result",
				id: request.id,
				error: "This host URI is not available while restoring a saved session",
			});
		});
	}

	/**
	 * Full-channel wiring, attached only while the tab is visible in its window
	 * tab. Idempotent: an already-wired entry is left untouched, so a repeated
	 * setActiveTab cannot stack duplicate listeners.
	 *
	 * Being wired IS being shown, so this is where a deferred tab's process
	 * gets spawned — the one moment the pool knows the user can see it.
	 */
	#wireFull(entry: PoolEntry): void {
		if (entry.restoringSession || entry.detachFull) return;
		this.#ensureStarted(entry);
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
		wire("frame", (value: unknown) => {
			const frame = parseBtwFrame(value);
			if (frame) forwardActive(IPC_EVENTS.BTW_FRAME, frame);
		});
		wire("status", (payload: SidecarStatusPayload) => {
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

	#syncFullWiring(winId: number): void {
		const visible = this.#visibleByWindow.get(winId) ?? new Set<string>();
		for (const entry of this.#entries) {
			if (entry.winId !== winId) continue;
			if (visible.has(entry.tabId) && !entry.restoringSession) this.#wireFull(entry);
			else entry.detachFull?.();
		}
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
		for (const [win, requests] of this.#restoreRequests) {
			for (const [id, request] of requests) {
				if (
					(request.origin?.tabId === entry.tabId && win === entry.win) ||
					(entry.restoreRequestId === id && win === entry.win)
				) {
					request.controller.abort(new Error("The restore origin or target retired"));
				}
			}
		}
		this.#byTabId.delete(entry.tabId);
		this.#unregisterSessionFile(entry);
		entry.restoreSettled?.resolve();
		entry.restoreSettled = undefined;
		// Drop pending routes pointing at the released entry. A late response is
		// genuinely unknown; a still-live route owned by another entry is kept.
		for (const [id, owner] of this.#requestOwners) {
			if (owner === entry) this.#requestOwners.delete(id);
		}
		entry.sidecar.removeAllListeners();
		this.#trackDisposal(entry.sidecar.dispose());
		const visible = this.#visibleByWindow.get(entry.winId);
		visible?.delete(entry.tabId);
		const split = this.#splitByWindow.get(entry.winId);
		if (split?.firstTabId === entry.tabId || split?.secondTabId === entry.tabId)
			this.#splitByWindow.delete(entry.winId);
		if (![...this.#entries].some(candidate => candidate.winId === entry.winId)) {
			this.#activeByWindow.delete(entry.winId);
			this.#visibleByWindow.delete(entry.winId);
			this.#splitByWindow.delete(entry.winId);
			return;
		}
		if (this.#activeByWindow.get(entry.winId) !== entry.tabId) {
			this.#syncFullWiring(entry.winId);
			return;
		}
		this.#activeByWindow.delete(entry.winId);
		// During window teardown every entry self-releases; activating a sibling
		// whose window is already gone would wire forwarders for nothing.
		if (entry.win.isDestroyed()) return;
		const candidates = [...this.#entries].filter(
			candidate => candidate.winId === entry.winId && !candidate.restoringSession,
		);
		const candidate = candidates.find(item => visible?.has(item.tabId)) ?? candidates[0];
		if (!candidate) {
			this.#visibleByWindow.delete(entry.winId);
			return;
		}
		if (!visible || visible.size === 0) this.#visibleByWindow.set(entry.winId, new Set([candidate.tabId]));
		this.#activeByWindow.set(entry.winId, candidate.tabId);
		this.#syncFullWiring(entry.winId);
	}

	/** The window's active entry (first entry as a fallback, e.g. mid-teardown). */
	entryForWindow(win: BrowserWindow): PoolEntry | undefined {
		const active = this.#byTabId.get(this.#activeByWindow.get(win.webContents.id) ?? "");
		if (active && active.win === win) return active;
		for (const entry of this.#entries) {
			if (entry.win === win && !entry.restoringSession) return entry;
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
		if (!entry || entry.restoringSession || entry.running || entry.compacting === true || entry.status !== "ready")
			return null;
		const client = entry.sidecar.rpcClient;
		return client ? await client.command(command) : null;
	}

	/** Make `tabId` the window's active tab (moves full event forwarding). False when unknown/foreign. */
	setActiveTab(win: BrowserWindow, tabId: string): boolean {
		return this.setTabView(win, tabId, [tabId]);
	}

	/** Atomically focus one tab and wire full streams for one or two visible tabs. */
	setTabView(
		win: BrowserWindow,
		focusedTabId: string,
		visibleTabIds: readonly string[],
		split?: IpcSetTabViewPayload["split"],
	): boolean {
		const ids = [...new Set(visibleTabIds)];
		if (ids.length < 1 || ids.length > 2 || !ids.includes(focusedTabId)) return false;
		if (
			split &&
			(ids.length !== 2 ||
				!ids.includes(split.firstTabId) ||
				!ids.includes(split.secondTabId) ||
				split.firstTabId === split.secondTabId ||
				(split.axis !== "columns" && split.axis !== "rows") ||
				!Number.isFinite(split.ratio))
		)
			return false;
		for (const tabId of ids) {
			const entry = this.#byTabId.get(tabId);
			if (!entry || entry.win !== win || entry.restoringSession) return false;
		}
		const winId = win.webContents.id;
		this.#activeByWindow.set(winId, focusedTabId);
		this.#visibleByWindow.set(winId, new Set(ids));
		if (split) this.#splitByWindow.set(winId, { ...split, ratio: Math.min(0.8, Math.max(0.2, split.ratio)) });
		else this.#splitByWindow.delete(winId);
		this.#syncFullWiring(winId);
		this.#notifyWindowTabsChanged(win);
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

	/** Register before any asynchronous origin read or process startup. */
	beginSessionRestoreRequest(win: BrowserWindow, id: string, origin?: IpcSpawnTabPayload["modelOrigin"]): AbortSignal {
		let requests = this.#restoreRequests.get(win);
		if (!requests) {
			requests = new Map();
			this.#restoreRequests.set(win, requests);
		}
		if (requests.has(id)) throw new Error("Saved-session restore request is already active");
		const controller = new AbortController();
		controller.signal.addEventListener(
			"abort",
			() => {
				for (const entry of this.#entries) {
					if (entry.win !== win || entry.restoreRequestId !== id || !entry.restoringSession) continue;
					if (entry.retainedRestore) {
						void this.failSessionRestore(entry.tabId).catch(error =>
							console.error("Stopping saved-session restore failed", error),
						);
					} else this.#releaseEntry(entry);
				}
			},
			{ once: true },
		);
		const onClosed = () => controller.abort(new Error("The restore window closed"));
		requests.set(id, { controller, origin, onClosed });
		win.once("closed", onClosed);
		if (win.isDestroyed()) onClosed();
		return controller.signal;
	}

	cancelSessionRestoreRequest(win: BrowserWindow, id: string): boolean {
		const request = this.#restoreRequests.get(win)?.get(id);
		if (!request) return false;
		request.controller.abort(new Error("Saved-session restore was cancelled"));
		return true;
	}

	finishSessionRestoreRequest(win: BrowserWindow, id: string): void {
		const requests = this.#restoreRequests.get(win);
		const request = requests?.get(id);
		if (!request) return;
		win.removeListener("closed", request.onClosed);
		requests?.delete(id);
		if (requests?.size === 0) this.#restoreRequests.delete(win);
	}

	/** Owner-routing waits for a hidden restore to commit or release its reservation. */
	waitForSessionRestore(sessionPath: string): Promise<void> {
		const owner = this.#sessionOwners.get(sessionPath);
		return (owner && this.#byTabId.get(owner.tabId)?.restoreSettled?.promise) || Promise.resolve();
	}

	/** A cold owner keeps its slot/file reservation and never launches a second manager. */
	async beginSessionRestore(
		win: BrowserWindow,
		tabId: string,
		payload: IpcSpawnTabPayload,
	): Promise<SidecarManager | null> {
		const entry = this.#byTabId.get(tabId);
		if (
			!entry ||
			entry.win !== win ||
			entry.restoringSession ||
			!["asleep", "error", "exited"].includes(entry.status) ||
			entry.running ||
			entry.compacting
		)
			return null;
		if (payload.kind && payload.kind !== entry.kind) return null;
		if (payload.cwd && payload.cwd !== entry.sidecar.cwd) return null;
		if (entry.target.type === "local") {
			if (
				!payload.sessionPath ||
				payload.sessionPath !== entry.sessionFile ||
				payload.resumeSessionId ||
				(payload.target && payload.target.type !== "local")
			)
				return null;
		} else {
			if (
				!payload.target ||
				!sameSessionTarget(payload.target, entry.target) ||
				payload.sessionPath ||
				!payload.resumeSessionId ||
				payload.resumeSessionId !== (entry.sessionId ?? entry.resumeSessionId)
			)
				return null;
		}
		const signal = payload.restoreRequestId
			? this.#restoreRequests.get(win)?.get(payload.restoreRequestId)?.controller.signal
			: undefined;
		if (signal?.aborted) return null;
		entry.retainedRestore = { sessionId: entry.sessionId, title: entry.title };
		entry.restoringSession = true;
		entry.modelOrigin = payload.modelOrigin;
		entry.restoreRequestId = payload.restoreRequestId;
		const settled = Promise.withResolvers<void>();
		entry.restoreSettled = { promise: settled.promise, resolve: settled.resolve };
		entry.detachFull?.();
		// Expose the logical busy slot, not scratch process metadata/history.
		forwardToWindow(win, IPC_EVENTS.TAB_STATUS, { ...tabStatusPayload(entry), status: "starting" });
		try {
			await entry.sidecar.startFreshForRestore(payload.model, signal);
			if (this.#byTabId.get(tabId) !== entry) return null;
			if (signal?.aborted) {
				await this.failSessionRestore(tabId);
				return null;
			}
			return entry.sidecar;
		} catch {
			await this.failSessionRestore(tabId);
			return null;
		}
	}

	async failSessionRestore(tabId: string): Promise<boolean> {
		const entry = this.#byTabId.get(tabId);
		if (!entry?.retainedRestore || !entry.restoringSession || entry.restoreFailurePending) return false;
		const snapshot = entry.retainedRestore;
		entry.restoreFailurePending = true;
		// Claim cleanup synchronously so an abort and the transaction catch do
		// not stop/rewrite the same retained owner twice.
		try {
			await entry.sidecar.stopFailedSessionRestore();
		} finally {
			if (this.#byTabId.get(tabId) === entry) {
				entry.sessionId = snapshot.sessionId;
				entry.title = snapshot.title;
				entry.restoringSession = false;
				entry.retainedRestore = undefined;
				entry.restoreFailurePending = false;
				entry.status = "error";
				entry.restoreSettled?.resolve();
				entry.restoreSettled = undefined;
				forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
				this.#notifyWindowTabsChanged(entry.win);
			}
		}
		return true;
	}

	/** Publish only a fully restored, verified background tab. */
	finishSessionRestore(tabId: string): boolean {
		const entry = this.#byTabId.get(tabId);
		if (!entry || !entry.restoringSession || entry.status !== "ready") return false;
		entry.restoringSession = false;
		entry.restoreSettled?.resolve();
		entry.restoreSettled = undefined;
		entry.retainedRestore = undefined;
		forwardToWindow(entry.win, IPC_EVENTS.TAB_STATUS, tabStatusPayload(entry));
		this.#notifyWindowTabsChanged(entry.win);
		return true;
	}

	/**
	 * Whether the owner tab of `sessionPath` has a process holding that session
	 * in memory. `asleep` (restored but never shown), `exited` and `error` have
	 * no process at all, so the file on disk is the entire session: a delete or
	 * rename must go to the filesystem instead of a `drop_session` /
	 * `set_session_name` with nobody to answer it — which `commandForIdleSession`
	 * would refuse as if a run were in flight. `starting` counts as live: that
	 * spawn is about to read the file.
	 */
	sessionOwnerIsLive(sessionPath: string): boolean {
		const owner = this.#sessionOwners.get(sessionPath);
		const entry = owner ? this.#byTabId.get(owner.tabId) : undefined;
		if (!entry) return false;
		return entry.status !== "asleep" && entry.status !== "exited" && entry.status !== "error";
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
		let visibleTabIds: Set<string> | undefined;
		let split: WindowSplitView | undefined;
		for (const entry of this.#entries) {
			if (entry.win !== win || (entry.restoringSession && !entry.retainedRestore)) continue;
			activeTabId ??= this.#activeByWindow.get(entry.winId);
			visibleTabIds ??= this.#visibleByWindow.get(entry.winId);
			split ??= this.#splitByWindow.get(entry.winId);
			const tab = tabStatusPayload(entry);
			if (entry.tabId === activeTabId) tab.active = true;
			if (visibleTabIds?.has(entry.tabId)) tab.visible = true;
			if (split?.firstTabId === entry.tabId) tab.split = { axis: split.axis, index: 0, ratio: split.ratio };
			else if (split?.secondTabId === entry.tabId) tab.split = { axis: split.axis, index: 1, ratio: split.ratio };
			tabs.push(tab);
		}
		return tabs;
	}

	/** What every live tab is doing right now — the ⌘Q guard's inventory. */
	tabInventory(): WindowTabFact[] {
		return [...this.#entries].map(entry => ({
			windowId: entry.winId,
			tabId: entry.tabId,
			inFlight: entry.running || entry.compacting === true,
		}));
	}

	/** Serializable layout for the window, excluding transient run/status data. */
	tabLayoutForWindow(win: BrowserWindow): PersistedTabLayout | null {
		const entries = [...this.#entries].filter(
			entry => entry.win === win && (!entry.restoringSession || entry.retainedRestore !== undefined),
		);
		if (entries.length === 0) return null;
		const activeTabId = this.#activeByWindow.get(win.webContents.id);
		const activeIndex = Math.max(
			0,
			entries.findIndex(entry => entry.tabId === activeTabId),
		);
		const split = this.#splitByWindow.get(win.webContents.id);
		const firstIndex = split ? entries.findIndex(entry => entry.tabId === split.firstTabId) : -1;
		const secondIndex = split ? entries.findIndex(entry => entry.tabId === split.secondTabId) : -1;
		return {
			version: TAB_LAYOUT_VERSION,
			activeIndex,
			tabs: entries.map(entry => {
				const descriptor: PersistedTabDescriptor = { cwd: entry.sidecar.cwd, kind: entry.kind };
				if (entry.sessionFile) descriptor.sessionPath = entry.sessionFile;
				if (entry.worktree) descriptor.worktree = entry.worktree;
				if (entry.placeholder) descriptor.placeholder = true;
				// Written even when the live title is null, so a cleared title
				// cannot survive as a stale one until the tab is spawned again.
				const title = entry.retainedRestore ? entry.retainedRestore.title : entry.title;
				if (title !== undefined) descriptor.title = title ?? undefined;
				return descriptor;
			}),
			...(split && firstIndex >= 0 && secondIndex >= 0
				? { split: { axis: split.axis, firstIndex, secondIndex, ratio: split.ratio } }
				: {}),
		};
	}

	/**
	 * Recreate saved tabs with fresh runtime ids, then restore their active
	 * index. Every tab is acquired with `deferStart`: only the panes the view
	 * ends up showing get a process, so a restored ten-tab session costs one
	 * sidecar instead of ten.
	 */
	restoreLayout(win: BrowserWindow, layout: PersistedTabLayout): number {
		const winId = win.webContents.id;
		this.#restoringWindows.add(winId);
		let restoredCount = 0;
		let firstRestoredTabId: string | undefined;
		let activeRestoredTabId: string | undefined;
		const restoredTabIds: string[] = [];
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
					deferStart: true,
					title: tab.title,
				});
				if (!sidecar) continue;
				restoredCount++;
				restoredTabIds[index] = tabId;
				firstRestoredTabId ??= tabId;
				if (index === layout.activeIndex) activeRestoredTabId = tabId;
			}
			const activeTabId = activeRestoredTabId ?? firstRestoredTabId;
			if (activeTabId) {
				const firstTabId = layout.split ? restoredTabIds[layout.split.firstIndex] : undefined;
				const secondTabId = layout.split ? restoredTabIds[layout.split.secondIndex] : undefined;
				// Routing the view is what spawns the shown tabs, so a split whose
				// panes were both dropped still falls back to one visible tab.
				if (layout.split && firstTabId && secondTabId) {
					this.setTabView(win, activeTabId, [firstTabId, secondTabId], {
						axis: layout.split.axis,
						firstTabId,
						secondTabId,
						ratio: layout.split.ratio,
					});
				} else this.setTabView(win, activeTabId, [activeTabId]);
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
		for (const requests of this.#restoreRequests.values()) {
			for (const request of requests.values()) request.controller.abort(new Error("The sidecar pool closed"));
		}
		for (const entry of this.#entries) {
			entry.sidecar.removeAllListeners();
			this.#trackDisposal(entry.sidecar.dispose());
		}
		this.#entries.clear();
		this.#byTabId.clear();
		this.#activeByWindow.clear();
		this.#visibleByWindow.clear();
		this.#splitByWindow.clear();
		this.#sessionOwners.clear();
		this.#requestOwners.clear();
		for (const [win, requests] of this.#restoreRequests) {
			for (const request of requests.values()) win.removeListener("closed", request.onClosed);
		}
		this.#restoreRequests.clear();
		this.#restoringWindows.clear();
		await Promise.all(this.#pendingDisposals);
		if (this.#disposalFailures.length > 0) {
			const errors = this.#disposalFailures.splice(0);
			throw new AggregateError(errors, "One or more sidecars could not be disposed");
		}
	}

	/** In-flight async sidecar disposals plus retained failures for shutdown aggregation. */
	#pendingDisposals = new Set<Promise<void>>();

	#disposalFailures: unknown[] = [];

	#trackDisposal(disposal: Promise<void>): void {
		const tracked: Promise<void> = disposal
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
	if (entry.restoringSession) payload.restoringSession = true;
	if (entry.compacting !== undefined) payload.compacting = entry.compacting;
	if (entry.runState !== undefined) payload.runState = entry.runState;
	if (entry.retryInfo !== undefined) payload.retryInfo = entry.retryInfo;
	if (entry.sessionId !== undefined) payload.sessionId = entry.sessionId;
	if (entry.title !== undefined) payload.title = entry.title;
	if (entry.worktree !== undefined) payload.worktree = entry.worktree;
	if (entry.retainedRestore) {
		payload.sessionId = entry.retainedRestore.sessionId;
		payload.title = entry.retainedRestore.title;
		payload.status = "starting";
	}
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
	model?: IpcSpawnTabPayload["model"];
	/** Reserve a local target without launching --session; native RPC restores it. */
	restoreSessionPath?: string;
	/** Hide local/SSH saved-session startup until native restore is verified. */
	restoringSession?: boolean;
	modelOrigin?: IpcSpawnTabPayload["modelOrigin"];
	restoreRequestId?: string;
	kind?: SessionKind;
	worktree?: IpcTabWorktree;
	fresh?: boolean;
	placeholder?: boolean;
	target?: SessionTarget;
	deferStart?: boolean;
	title?: string;
}
