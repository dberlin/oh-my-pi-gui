import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import {
	IPC_EVENTS,
	type IpcTabStatusPayload,
	type SessionKind,
	type SessionTarget,
	type SshSessionTarget,
} from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, SessionInfoUpdateFrame, SidecarStatus } from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";
import type { PersistedTabLayout } from "./tab-layout";

/** Minimal SidecarManager stand-in: an EventEmitter with lifecycle recording. */
class FakeSidecar extends EventEmitter {
	started = false;
	disposed = false;
	disposeCount = 0;
	disposePromise: Promise<void> = Promise.resolve();
	restartArgs: Array<{ cwd: string | undefined; sessionPath: string | undefined }> = [];
	/** Side-channel frames written via sendSideChannel (F-UI-ORIGIN assertions). */
	sentFrames: object[] = [];
	rpcCommands: RpcCommand[] = [];
	constructor(
		public cwd: string,
		public target: SessionTarget = { type: "local" },
	) {
		super();
	}
	adoptTargetCwd(cwd: string): SessionTarget | null {
		if (cwd === this.cwd) return null;
		this.cwd = cwd;
		this.target =
			this.target.type === "ssh"
				? Object.freeze({ ...this.target, host: Object.freeze({ ...this.target.host }), cwd })
				: Object.freeze({ type: "local" });
		return this.target;
	}
	get status(): SidecarStatus {
		return this.currentStatus;
	}
	currentStatus: SidecarStatus = "starting";
	readonly rpcClient = {
		command: async (command: RpcCommand): Promise<RpcResponse> => {
			this.rpcCommands.push(command);
			return { type: "response", command: command.type, success: true, data: { cancelled: false } };
		},
	};
	start(): void {
		this.started = true;
	}
	restart(cwd?: string, sessionPath?: string): void {
		this.restartArgs.push({ cwd, sessionPath });
	}
	kill(): void {}
	dispose(): Promise<void> {
		this.disposed = true;
		this.disposeCount++;
		this.removeAllListeners();
		return this.disposePromise;
	}
	sendSideChannel(frame: object): void {
		this.sentFrames.push(frame);
	}
	denyRemoteHostTool(frame: unknown): boolean {
		if (this.target.type !== "ssh") return false;
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return true;
		const request = frame as Record<string, unknown>;
		const argumentsPrototype =
			typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments)
				? Object.getPrototypeOf(request.arguments)
				: undefined;
		const valid =
			typeof request.id === "string" &&
			request.id.length > 0 &&
			request.id.length <= 128 &&
			typeof request.toolCallId === "string" &&
			request.toolCallId.length > 0 &&
			request.toolCallId.length <= 128 &&
			typeof request.toolName === "string" &&
			request.toolName.length > 0 &&
			request.toolName.length <= 128 &&
			(argumentsPrototype === Object.prototype || argumentsPrototype === null);
		if (valid) {
			this.sendSideChannel({
				type: "host_tool_result",
				id: request.id,
				error: "Host tools are unavailable for remote SSH sessions",
			});
		}
		return true;
	}
	emitStatus(status: SidecarStatus): void {
		this.currentStatus = status;
		this.emit("status", { status, cwd: this.cwd });
	}
	emitSessionInfo(frame: Omit<SessionInfoUpdateFrame, "type">): void {
		this.emit("sessionInfoUpdate", { type: "session_info_update", ...frame });
	}
	emitAgentEvents(types: string[]): void {
		this.emit(
			"events",
			types.map(type => ({ type })),
		);
	}
	emitExtensionUi(id: string): void {
		this.emit("extensionUi", {
			type: "extension_ui_request",
			id,
			method: "confirm",
			title: "Proceed?",
			message: "ok?",
		});
	}
	emitEditorText(id: string): void {
		this.emit("extensionUi", {
			type: "extension_ui_request",
			id,
			method: "set_editor_text",
			text: "restore me",
			prepend: true,
		});
	}
	emitHostToolCall(id: string): void {
		this.emit("hostToolCall", { type: "host_tool_call", id, name: "gui_tool", args: {} });
	}
	emitHostUriRequest(id: string): void {
		this.emit("hostUriRequest", { type: "host_uri_request", id, operation: "read", uri: "https://example.com" });
	}
}

interface FakeWindow {
	win: BrowserWindow;
	sent: Array<{ channel: string; data: unknown }>;
	close(): void;
	sentTo(channel: string): Array<{ channel: string; data: unknown }>;
}

/** Minimal BrowserWindow stand-in: captured sends + a triggerable "closed". */
function fakeWindow(id: number): FakeWindow {
	const emitter = new EventEmitter();
	const sent: Array<{ channel: string; data: unknown }> = [];
	let destroyed = false;
	const win = {
		webContents: {
			id,
			send: (channel: string, data: unknown) => {
				sent.push({ channel, data });
			},
		},
		isDestroyed: () => destroyed,
		once: (event: string, listener: () => void) => emitter.once(event, listener),
	} as unknown as BrowserWindow;
	return {
		win,
		sent,
		close: () => {
			destroyed = true;
			emitter.emit("closed");
		},
		sentTo: channel => sent.filter(entry => entry.channel === channel),
	};
}

function fakePool(max = 10): { pool: SidecarPool; sidecars: FakeSidecar[] } {
	const sidecars: FakeSidecar[] = [];
	const pool = new SidecarPool(options => {
		const sidecar = new FakeSidecar(options.cwd, options.target);
		sidecars.push(sidecar);
		return sidecar as unknown as SidecarManager;
	}, max);
	return { pool, sidecars };
}

interface ObservedFactoryOptions {
	cwd: string;
	kind: SessionKind;
	fresh: boolean;
	target: SessionTarget;
	resumeSessionId?: string;
}

const SSH_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "build-box",
	host: {
		host: "build.example.test",
		username: "builder",
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
	},
	originCwd: "/work/project",
	cwd: "/work/project",
};

function observingPool(): {
	pool: SidecarPool;
	sidecars: FakeSidecar[];
	factoryOptions: ObservedFactoryOptions[];
} {
	const sidecars: FakeSidecar[] = [];
	const factoryOptions: ObservedFactoryOptions[] = [];
	const pool = new SidecarPool(options => {
		factoryOptions.push(options);
		const sidecar = new FakeSidecar(options.cwd, options.target);
		sidecars.push(sidecar);
		return sidecar as unknown as SidecarManager;
	});
	return { pool, sidecars, factoryOptions };
}

describe("SidecarPool session targets", () => {
	it("normalizes an absent target to local once at acquire", () => {
		const { pool, factoryOptions } = observingPool();
		const fw = fakeWindow(1);

		expect(pool.acquire({ cwd: "/local", win: fw.win, tabId: "tab-local" })).not.toBeNull();
		expect(factoryOptions[0]?.target).toEqual({ type: "local" });
		expect(pool.tabsForWindow(fw.win)[0]?.target).toEqual({ type: "local" });
	});

	it("stores and reports an immutable deep copy of the SSH target", () => {
		const { pool, sidecars, factoryOptions } = observingPool();
		const fw = fakeWindow(1);
		const source: SshSessionTarget = { ...SSH_TARGET, host: { ...SSH_TARGET.host } };

		expect(pool.acquire({ cwd: source.cwd, win: fw.win, tabId: "tab-remote", target: source })).not.toBeNull();
		source.cwd = "/mutated";
		source.host.host = "mutated.example.test";
		sidecars[0]?.emitStatus("ready");

		const factoryTarget = factoryOptions[0]?.target;
		expect(factoryTarget).toEqual(SSH_TARGET);
		expect(Object.isFrozen(factoryTarget)).toBe(true);
		if (factoryTarget?.type !== "ssh") throw new Error("Expected immutable SSH target");
		expect(Object.isFrozen(factoryTarget.host)).toBe(true);
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{
				tabId: "tab-remote",
				cwd: SSH_TARGET.cwd,
				target: SSH_TARGET,
				kind: "agent",
				status: "ready",
				active: true,
				placeholder: false,
				sessionPath: null,
			},
		]);
		const pushed = fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data as IpcTabStatusPayload;
		expect(pushed.target).toEqual(SSH_TARGET);
	});

	it("uses remote resume ids without registering local session ownership", () => {
		const { pool, sidecars, factoryOptions } = observingPool();
		const fw = fakeWindow(1);
		const localPath = "/sessions/local-only.jsonl";

		expect(
			pool.acquire({
				cwd: SSH_TARGET.cwd,
				win: fw.win,
				tabId: "tab-remote",
				sessionPath: localPath,
				resumeSessionId: "remote-session-7",
				target: SSH_TARGET,
			}),
		).not.toBeNull();

		expect(factoryOptions[0]?.resumeSessionId).toBe("remote-session-7");
		expect(sidecars[0]?.started).toBe(true);
		expect(sidecars[0]?.restartArgs).toEqual([]);
		expect(pool.sessionOwner(localPath)).toBeNull();
	});

	it("ignores local session-file updates for remote entries", () => {
		const { pool } = observingPool();
		const fw = fakeWindow(1);
		const localPath = "/sessions/misrouted-remote.jsonl";
		expect(
			pool.acquire({
				cwd: SSH_TARGET.cwd,
				win: fw.win,
				tabId: "tab-remote",
				target: SSH_TARGET,
			}),
		).not.toBeNull();

		pool.noteSessionFile("tab-remote", localPath);

		expect(pool.sessionOwner(localPath)).toBeNull();
	});

	it("awaits remote sidecar disposal before disposeAll settles", async () => {
		const { pool, sidecars } = observingPool();
		const fw = fakeWindow(1);
		const disposal = Promise.withResolvers<void>();
		expect(
			pool.acquire({
				cwd: SSH_TARGET.cwd,
				win: fw.win,
				tabId: "tab-remote",
				target: SSH_TARGET,
			}),
		).not.toBeNull();
		if (!sidecars[0]) throw new Error("Expected remote sidecar");
		sidecars[0].disposePromise = disposal.promise;

		let settled = false;
		const disposing = Promise.resolve(pool.disposeAll());
		void disposing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		disposal.resolve();
		await disposing;
		expect(settled).toBe(true);
	});

	it("tracks remote tab-close termination until app shutdown confirms no SSH child remains", async () => {
		const { pool, sidecars } = observingPool();
		const fw = fakeWindow(1);
		const termination = Promise.withResolvers<void>();
		expect(
			pool.acquire({
				cwd: SSH_TARGET.cwd,
				win: fw.win,
				tabId: "tab-remote",
				target: SSH_TARGET,
			}),
		).not.toBeNull();
		const remote = sidecars[0];
		if (!remote) throw new Error("Expected remote sidecar");
		remote.disposePromise = termination.promise;

		expect(pool.releaseTab("tab-remote")).toBe(true);
		expect(remote.disposeCount).toBe(1);
		expect(pool.size).toBe(0);

		const shutdown = pool.disposeAll();
		const earlyResult = await Promise.race([
			shutdown.then(() => "settled" as const),
			Promise.resolve()
				.then(() => Promise.resolve())
				.then(() => "pending" as const),
		]);
		expect(earlyResult).toBe("pending");

		termination.resolve();
		await shutdown;
		expect(remote.disposed).toBe(true);
		expect(remote.disposeCount).toBe(1);
	});
});
describe("SidecarPool session kind", () => {
	it("threads the spawn kind through the factory into TAB_STATUS payloads", () => {
		const kinds: SessionKind[] = [];
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool(options => {
			kinds.push(options.kind);
			const sidecar = new FakeSidecar(options.cwd, options.target);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarManager;
		});
		const fw = fakeWindow(1);

		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-agent" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-chat", sessionPath: undefined, kind: "chat" });
		// acquire defaults the kind to "agent" — the factory always sees a defined value.
		expect(kinds).toEqual(["agent", "chat"]);

		const [, chatSidecar] = sidecars;
		chatSidecar?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "chat",
				tabId: "tab-chat",
				cwd: "/b",
				target: { type: "local" },
				status: "ready",
				placeholder: false,
				sessionPath: null,
			},
		]);

		// GET_TABS exposes the immutable kind for every tab.
		expect(pool.tabsForWindow(fw.win).map(tab => tab.kind)).toEqual(["agent", "chat"]);
	});
});

describe("SidecarPool tabs", () => {
	it("binds two tabs to one window; the first is active", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const a = pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		const b = pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });

		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(pool.size).toBe(2);
		expect(sidecars.map(s => s.started)).toEqual([true, true]);
		expect(pool.sidecarForWindow(fw.win)).toBe(a);
		expect(pool.sidecarForTab(fw.win, "tab-b")).toBe(b);
		expect(pool.sidecarForTab(fw.win, "nope")).toBeNull();
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-a");
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{
				kind: "agent",
				tabId: "tab-a",
				cwd: "/a",
				target: { type: "local" },
				status: "starting",
				active: true,
				placeholder: false,
				sessionPath: null,
			},
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "starting",
				placeholder: false,
				sessionPath: null,
			},
		]);
	});

	it("mints a snowflake tabId when none is given", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win });
		const tabs = pool.tabsForWindow(fw.win);
		expect(tabs[0]?.tabId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("resumes a session on first start when sessionPath is given", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const sidecar = pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		expect(sidecar).not.toBeNull();
		expect(sidecars[0]?.started).toBe(false);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/s.jsonl" }]);
		expect(pool.tabsForWindow(fw.win)[0]?.sessionPath).toBe("/sessions/s.jsonl");
	});

	it("forwards full channels only from the active tab, TAB_STATUS from every tab", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;

		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		// Only the active tab's batch reaches the full channel…
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: [{ type: "agent_start" }] },
		]);
		// …but both tabs pushed TAB_STATUS for their running transition.
		const statuses = fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data as IpcTabStatusPayload);
		expect(statuses).toEqual([
			{
				kind: "agent",
				tabId: "tab-a",
				cwd: "/a",
				target: { type: "local" },
				status: "starting",
				placeholder: false,
				sessionPath: null,
			},
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "starting",
				placeholder: false,
				sessionPath: null,
			},
		]);

		// Connection status is forwarded on the full channel for the active tab only.
		a?.emitStatus("ready");
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.SIDECAR_STATUS)).toHaveLength(1);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(4);

		// Background sidecar emits nothing on the remaining full channels.
		b?.emit("subagentFrame", { type: "subagent_lifecycle" });
		b?.emit("promptResult", { type: "prompt_result" });
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAME)).toHaveLength(0);
		expect(fw.sentTo(IPC_EVENTS.PROMPT_RESULT)).toHaveLength(0);
		a?.emit("promptResult", { type: "prompt_result" });
		expect(fw.sentTo(IPC_EVENTS.PROMPT_RESULT).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: { type: "prompt_result" } },
		]);
	});

	it("synthesizes running/ready per tab from the agent event stream", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;
		a?.emitStatus("ready");
		b?.emitStatus("ready");
		fw.sent.length = 0;

		// Background tab starts a run: TAB_STATUS reports running without any
		// full-channel leak.
		b?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(0);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "running",
				placeholder: false,
				sessionPath: null,
			},
		]);
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{
				kind: "agent",
				tabId: "tab-a",
				cwd: "/a",
				target: { type: "local" },
				status: "ready",
				active: true,
				placeholder: false,
				sessionPath: null,
			},
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "running",
				placeholder: false,
				sessionPath: null,
			},
		]);

		// Run settles → ready (the renderer's unreadDone signal for background tabs).
		fw.sent.length = 0;
		b?.emitAgentEvents(["agent_end"]);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "ready",
				placeholder: false,
				sessionPath: null,
			},
		]);

		// A restart mid-run clears the flag: no stale "running" after recovery.
		fw.sent.length = 0;
		b?.emitAgentEvents(["agent_start"]);
		b?.emitStatus("restarting");
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => (s.data as IpcTabStatusPayload).status)).toEqual([
			"running",
			"restarting",
			"ready",
		]);
		expect(pool.tabsForWindow(fw.win)[1]?.status).toBe("ready");
	});

	it("re-wires forwarding on switch without duplicating listeners", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;
		// Light wiring ("events" run-tracking) is always on; full wiring adds one more.
		expect(a?.listenerCount("events")).toBe(2);
		expect(b?.listenerCount("events")).toBe(1);

		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		expect(a?.listenerCount("events")).toBe(1);
		expect(b?.listenerCount("events")).toBe(2);

		fw.sent.length = 0;
		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(2);

		// Switching back re-arms A exactly once (one batch per emit, not two).
		expect(pool.setActiveTab(fw.win, "tab-a")).toBe(true);
		expect(a?.listenerCount("events")).toBe(2);
		expect(b?.listenerCount("events")).toBe(1);
		fw.sent.length = 0;
		a?.emitAgentEvents(["agent_end"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);

		// Re-setting the already-active tab is a no-op.
		expect(pool.setActiveTab(fw.win, "tab-a")).toBe(true);
		expect(a?.listenerCount("events")).toBe(2);
		// Foreign/unknown tabs are refused.
		expect(pool.setActiveTab(fakeWindow(2).win, "tab-a")).toBe(false);
		expect(pool.setActiveTab(fw.win, "nope")).toBe(false);
	});

	it("caches session meta per tab and includes it in TAB_STATUS and GET_TABS", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [, b] = sidecars;

		b?.emitSessionInfo({ title: "Fix flaky test", sessionId: "sess-1" });
		// Background session-info pushes a light snapshot and caches for later.
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "starting",
				placeholder: false,
				sessionPath: null,
				sessionId: "sess-1",
				title: "Fix flaky test",
			},
		]);
		// No full-channel forward from a background tab.
		expect(fw.sentTo(IPC_EVENTS.SESSION_INFO_UPDATE)).toHaveLength(0);
		expect(pool.tabsForWindow(fw.win)[1]).toEqual({
			kind: "agent",
			tabId: "tab-b",
			cwd: "/b",
			target: { type: "local" },
			status: "starting",
			placeholder: false,
			sessionPath: null,
			sessionId: "sess-1",
			title: "Fix flaky test",
		});

		// Subsequent status pushes keep carrying the cached meta.
		fw.sent.length = 0;
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				target: { type: "local" },
				status: "ready",
				placeholder: false,
				sessionPath: null,
				sessionId: "sess-1",
				title: "Fix flaky test",
			},
		]);
	});

	it("restores tab order, sessions, kinds, and the persisted active tab", () => {
		const factoryCalls: Array<{ cwd: string; kind: "agent" | "chat"; fresh: boolean }> = [];
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool(options => {
			factoryCalls.push({ cwd: options.cwd, kind: options.kind, fresh: options.fresh });
			const sidecar = new FakeSidecar(options.cwd, options.target);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarManager;
		});
		const fw = fakeWindow(1);

		const restored = pool.restoreLayout(fw.win, {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/agent", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/chat", kind: "chat" },
			],
		});

		expect(restored).toBe(2);
		expect(factoryCalls).toEqual([
			{ cwd: "/agent", kind: "agent", fresh: false },
			{ cwd: "/chat", kind: "chat", fresh: true },
		]);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/a.jsonl" }]);
		expect(sidecars[1]?.started).toBe(true);
		expect(pool.tabsForWindow(fw.win).map(tab => tab.active ?? false)).toEqual([false, true]);
		expect(pool.tabLayoutForWindow(fw.win)).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/agent", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/chat", kind: "chat" },
			],
		});
	});

	it("publishes durable layout changes after tab, session, cwd, and active mutations", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		const snapshots: Array<PersistedTabLayout | null> = [];
		pool.onWindowTabsChanged = (_win, layout) => snapshots.push(layout);

		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/a.jsonl" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b", sessionPath: undefined, kind: "chat" });
		pool.setActiveTab(fw.win, "tab-b");
		pool.noteSessionFile("tab-b", "/sessions/b.jsonl");
		pool.adoptSessionCwd("tab-b", "/moved");

		expect(snapshots.at(-1)).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/moved", kind: "chat", sessionPath: "/sessions/b.jsonl" },
			],
		});

		pool.releaseTab("tab-b");
		expect(snapshots.at(-1)).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" }],
		});
	});

	it("marks only the untargeted startup tab as disposable and clears it on first run", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const snapshots: Array<PersistedTabLayout | null> = [];
		pool.onWindowTabsChanged = (_win, layout) => snapshots.push(layout);

		pool.acquire({ cwd: "/neutral", win: fw.win, tabId: "tab-idle", sessionPath: undefined, kind: "chat", worktree: undefined, fresh: true, placeholder: true });
		expect(pool.tabsForWindow(fw.win)[0]).toMatchObject({ tabId: "tab-idle", placeholder: true });
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]).toMatchObject({ placeholder: true });

		sidecars[0]?.emitAgentEvents(["agent_start"]);

		expect(pool.tabsForWindow(fw.win)[0]).toMatchObject({ tabId: "tab-idle", placeholder: false });
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]).not.toHaveProperty("placeholder");
		expect(snapshots.at(-1)?.tabs[0]).not.toHaveProperty("placeholder");
	});

	it("releases a tab: disposed, pool shrinks, active falls back to a sibling", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;

		// Closing the ACTIVE tab releases it and activates the remaining one.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(a?.disposed).toBe(true);
		expect(pool.size).toBe(1);
		expect(pool.sidecarForWindow(fw.win)).toBe(b);
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-b");
		expect(b?.listenerCount("events")).toBe(2);

		// Unknown tab is a no-op; closing the last tab leaves the window tab-less.
		expect(pool.releaseTab("tab-a")).toBe(false);
		expect(pool.releaseTab("tab-b")).toBe(true);
		expect(b?.disposed).toBe(true);
		expect(pool.size).toBe(0);
		expect(pool.sidecarForWindow(fw.win)).toBeNull();
		expect(pool.activeTabForWindow(fw.win)).toBeNull();
		expect(pool.tabsForWindow(fw.win)).toEqual([]);
	});

	it("counts tabs across windows against the cap", () => {
		const { pool } = fakePool(2);
		const fw1 = fakeWindow(1);
		const fw2 = fakeWindow(2);
		expect(pool.acquire({ cwd: "/a", win: fw1.win, tabId: "tab-a" })).not.toBeNull();
		expect(pool.acquire({ cwd: "/b", win: fw1.win, tabId: "tab-b" })).not.toBeNull();
		expect(pool.atCap).toBe(true);
		// A second window gets no slot either — the cap is pool-wide over tabs.
		expect(pool.acquire({ cwd: "/c", win: fw2.win, tabId: "tab-c" })).toBeNull();
		expect(pool.size).toBe(2);

		pool.releaseTab("tab-b");
		expect(pool.atCap).toBe(false);
		expect(pool.acquire({ cwd: "/c", win: fw2.win, tabId: "tab-c" })).not.toBeNull();
	});

	it("releases every tab of a closed window", () => {
		const { pool, sidecars } = fakePool();
		const fw1 = fakeWindow(1);
		const fw2 = fakeWindow(2);
		pool.acquire({ cwd: "/a", win: fw1.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw1.win, tabId: "tab-b" });
		pool.acquire({ cwd: "/c", win: fw2.win, tabId: "tab-c" });

		fw1.close();
		expect(sidecars[0]?.disposed).toBe(true);
		expect(sidecars[1]?.disposed).toBe(true);
		expect(sidecars[2]?.disposed).toBe(false);
		expect(pool.size).toBe(1);
		expect(pool.activeTabForWindow(fw2.win)).toBe("tab-c");
		expect(pool.sidecarForWindow(fw2.win)).toBe(sidecars[2]);

		// Late events from the surviving window still forward normally.
		sidecars[2]?.emitStatus("ready");
		expect(fw2.sentTo(IPC_EVENTS.SIDECAR_STATUS)).toHaveLength(1);
	});
});

describe("SidecarPool session ownership (F-OWN)", () => {
	it("routes session mutations only to an idle attached tab", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		const [sidecar] = sidecars;
		sidecar?.emitStatus("ready");

		const response = await pool.commandForIdleSession("/sessions/s.jsonl", {
			type: "set_session_name",
			name: "Renamed",
			sessionPath: "/sessions/s.jsonl",
		});
		expect(response?.success).toBe(true);
		expect(sidecar?.rpcCommands).toEqual([
			{ type: "set_session_name", name: "Renamed", sessionPath: "/sessions/s.jsonl" },
		]);

		sidecar?.emitAgentEvents(["agent_start"]);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toBeNull();
	});

	it("blocks session mutations while automatic compaction is in flight", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		const [sidecar] = sidecars;
		sidecar?.emitStatus("ready");
		sidecar?.emitAgentEvents(["auto_compaction_start"]);

		expect(pool.tabsForWindow(fw.win)[0]?.compacting).toBe(true);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toBeNull();

		sidecar?.emitAgentEvents(["auto_compaction_end"]);
		expect(pool.tabsForWindow(fw.win)[0]?.compacting).toBe(false);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toMatchObject({
			success: true,
		});
	});

	it("registers the owner at acquire-with-sessionPath and unregisters on release", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });

		// A duplicate attach consults this: SPAWN_TAB maps it to
		// { tabId: null, ownerTabId, ownerWinId } instead of acquiring.
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		expect(pool.sessionOwner("/sessions/other.jsonl")).toBeNull();

		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
	});

	it("learns the file from noteSessionFile (get_state / switch_session reports)", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();

		pool.noteSessionFile("tab-a", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
			tabId: "tab-a",
			sessionPath: "/sessions/s.jsonl",
		});

		// A switch moves the entry: the old file is freed, the new one owned.
		pool.noteSessionFile("tab-a", "/sessions/s2.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
		expect(pool.sessionOwner("/sessions/s2.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });

		// get_state with sessionFile null (fresh unsaved session) unregisters.
		pool.noteSessionFile("tab-a", null);
		expect(pool.sessionOwner("/sessions/s2.jsonl")).toBeNull();
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-a", sessionPath: null });

		// Unknown tabs are a no-op.
		pool.noteSessionFile("nope", "/sessions/x.jsonl");
		expect(pool.sessionOwner("/sessions/x.jsonl")).toBeNull();
	});

	it("keeps the acquire-time registration through first attach but drops it on a sessionId change", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		const [a] = sidecars;

		// First attach: the resumed session reports its id — registration kept
		// (this is what lets a background --session tab stay guarded).
		a?.emitSessionInfo({ sessionId: "sess-1", title: "Resumed" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });

		// Title-only updates don't touch ownership either.
		a?.emitSessionInfo({ title: "Renamed" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).not.toBeNull();

		// The session under the tab changed (crash-restart into a fresh
		// session, an unobserved switch): the cached file mapping is stale.
		a?.emitSessionInfo({ sessionId: "sess-2" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
		// …and the renderer's hydrate re-registers the file now attached.
		pool.noteSessionFile("tab-a", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
	});

	it("only the current owner clears a mapping", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });

		// Last writer wins if two tabs ever report the same file…
		pool.noteSessionFile("tab-b", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-b", winId: 1 });

		// …so releasing the FORMER owner must not drop the new registration.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-b", winId: 1 });
	});

	it("foreignSessionOwner blocks only foreign attaches", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });

		// A different tab's switch_session is blocked — with the owner info the
		// refusal carries for routing.
		expect(pool.foreignSessionOwner("tab-b", "/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		// The owner itself re-attaches freely (switch_session onto its own file).
		expect(pool.foreignSessionOwner("tab-a", "/sessions/s.jsonl")).toBeNull();
		// Unowned files are free (first attach).
		expect(pool.foreignSessionOwner("tab-b", "/sessions/other.jsonl")).toBeNull();
		// An untracked issuer is blocked by any owner — the safe direction.
		expect(pool.foreignSessionOwner(null, "/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		// Re-attach after release: the mapping is gone, the path is free.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.foreignSessionOwner("tab-b", "/sessions/s.jsonl")).toBeNull();
	});

	it("unregisters owners when a window closes", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a", sessionPath: "/sessions/s.jsonl" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).not.toBeNull();
		fw.close();
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
	});
});

describe("SidecarPool session cwd tracking", () => {
	it("adoptSessionCwd re-roots the tab and pushes the live cwd over TAB_STATUS", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/spawn-a", win: fw.win, tabId: "tab-a" });

		// switch_session re-roots the agent silently; the get_state report moves
		// the tab off its spawn cwd…
		expect(pool.adoptSessionCwd("tab-a", "/live-b")).toBe(true);
		expect(sidecars[0]?.cwd).toBe("/live-b");

		// …and the pushed TAB_STATUS carries the NEW cwd so the renderer's chip
		// stops showing the spawn workspace.
		const pushes = fw.sentTo(IPC_EVENTS.TAB_STATUS);
		expect(pushes).toHaveLength(1);
		expect((pushes[0]!.data as IpcTabStatusPayload).cwd).toBe("/live-b");

		// Same cwd / unknown tab / empty cwd are no-ops (no push, no mutation).
		expect(pool.adoptSessionCwd("tab-a", "/live-b")).toBe(false);
		expect(pool.adoptSessionCwd("nope", "/elsewhere")).toBe(false);
		expect(pool.adoptSessionCwd("tab-a", "")).toBe(false);
		expect(sidecars[0]?.cwd).toBe("/live-b");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(1);
	});

	it("replaces an SSH tab target cwd while preserving its connection snapshot", () => {
		const { pool, sidecars } = observingPool();
		const fw = fakeWindow(1);
		const original = { ...SSH_TARGET, host: { ...SSH_TARGET.host }, executableOverride: "/opt/omp" };
		pool.acquire({ cwd: original.cwd, win: fw.win, tabId: "tab-remote", target: original });

		expect(pool.adoptSessionCwd("tab-remote", "/work/moved")).toBe(true);

		const exposed = pool.tabsForWindow(fw.win)[0]?.target;
		expect(exposed).toEqual({
			...original,
			host: { ...original.host },
			cwd: "/work/moved",
		});
		expect(exposed).not.toBe(original);
		expect(exposed).not.toBe(sidecars[0]?.target);
		expect(Object.isFrozen(exposed)).toBe(true);
		expect(original.cwd).toBe("/work/project");
		const pushed = fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data as IpcTabStatusPayload;
		expect(pushed.target).toEqual(exposed);
	});
});

describe("SidecarPool request-origin routing (F-UI-ORIGIN)", () => {
	it("does not retain fire-and-forget extension UI updates", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");

		sidecars[0]?.emitEditorText("update-1");
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);
		expect(pool.routeSideChannel("update-1", { type: "extension_ui_response", id: "update-1" }, true)).toBe(false);
	});

	it("routes an extension-ui response to the raising sidecar even after a tab switch", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;

		// Tab A raises the request while active; the dialog is forwarded…
		a?.emitExtensionUi("req-1");
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI).map(item => item.data)).toEqual([
			{
				tabId: "tab-a",
				request: {
					type: "extension_ui_request",
					id: "req-1",
					method: "confirm",
					title: "Proceed?",
					message: "ok?",
				},
			},
		]);

		// …the user switches to tab B, THEN the response arrives. It must go to
		// A's sidecar — B never saw the request and would drop/misroute it.
		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		const response = { type: "extension_ui_response", id: "req-1", confirmed: true };
		expect(pool.routeSideChannel(fw.win, "req-1", response, true)).toBe("routed");
		expect(a?.sentFrames).toEqual([response]);
		expect(b?.sentFrames).toEqual([]);

		// Final responses consume the route — a repeat id falls back to the caller.
		expect(pool.routeSideChannel(fw.win, "req-1", response, true)).toBe("unknown");
	});

	it("routes host-uri results to the origin sidecar", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;

		a?.emitHostUriRequest("uri-1");
		expect(fw.sentTo(IPC_EVENTS.HOST_URI_REQUEST)).toHaveLength(1);
		pool.setActiveTab(fw.win, "tab-b");

		const result = { type: "host_uri_result", id: "uri-1", content: "data" };
		expect(pool.routeSideChannel(fw.win, "uri-1", result, true)).toBe("routed");
		expect(a?.sentFrames).toEqual([result]);
		expect(b?.sentFrames).toEqual([]);
	});

	it("keeps the route across non-final host-tool updates and consumes it on the result", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;
		// Unknown tool → forwarded to the renderer (executor returns false).
		pool.hostToolExecutor = () => false;

		a?.emitHostToolCall("tool-1");
		expect(fw.sentTo(IPC_EVENTS.HOST_TOOL_CALL)).toHaveLength(0); // fake executor sends nothing
		pool.setActiveTab(fw.win, "tab-b");

		const update = { type: "host_tool_update", id: "tool-1", update: "working…" };
		expect(pool.routeSideChannel(fw.win, "tool-1", update, false)).toBe("routed");
		// Still registered: the result follows the update stream.
		const result = { type: "host_tool_result", id: "tool-1", result: "done" };
		expect(pool.routeSideChannel(fw.win, "tool-1", result, true)).toBe("routed");
		expect(a?.sentFrames).toEqual([update, result]);
		expect(b?.sentFrames).toEqual([]);
		expect(pool.routeSideChannel(fw.win, "tool-1", result, true)).toBe("unknown");
	});

	it("does not track host tools answered inline", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		const [a] = sidecars;
		// GUI-registered tool: the executor answers on the spot, nothing is
		// forwarded to the renderer, so no response will ever arrive to route.
		pool.hostToolExecutor = (sidecar, request) => {
			sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, result: "inline" });
			return true;
		};

		a?.emitHostToolCall("tool-inline");
		expect(a?.sentFrames).toEqual([{ type: "host_tool_result", id: "tool-inline", result: "inline" }]);
		expect(pool.routeSideChannel(fw.win, "tool-inline", { type: "host_tool_result", id: "tool-inline" }, true)).toBe(
			"unknown",
		);
	});

	it("drops pending routes when the owning tab is released", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		pool.acquire({ cwd: "/b", win: fw.win, tabId: "tab-b" });
		const [a, b] = sidecars;

		a?.emitExtensionUi("req-doomed");
		expect(pool.releaseTab("tab-a")).toBe(true);
		// A late response falls back instead of writing to a disposed sidecar.
		expect(
			pool.routeSideChannel(fw.win, "req-doomed", { type: "extension_ui_response", id: "req-doomed" }, true),
		).toBe("unknown");
		expect(a?.sentFrames).toEqual([]);
		expect(b?.sentFrames).toEqual([]);
	});

	it.each([
		{
			name: "extension UI",
			emit: (sidecar: FakeSidecar, id: string) => sidecar.emitExtensionUi(id),
			frame: { type: "extension_ui_response", id: "shared-id", confirmed: true },
		},
		{
			name: "host tool",
			emit: (sidecar: FakeSidecar, id: string) => sidecar.emitHostToolCall(id),
			frame: { type: "host_tool_result", id: "shared-id", result: "done" },
		},
		{
			name: "host URI",
			emit: (sidecar: FakeSidecar, id: string) => sidecar.emitHostUriRequest(id),
			frame: { type: "host_uri_result", id: "shared-id", content: "data" },
		},
	])("binds a live $name response to the exact originating window", ({ emit, frame }) => {
		const { pool, sidecars } = fakePool();
		const origin = fakeWindow(1);
		const foreign = fakeWindow(2);
		pool.acquire({ cwd: "/origin", win: origin.win, tabId: "tab-origin" });
		pool.acquire({ cwd: "/foreign", win: foreign.win, tabId: "tab-foreign" });
		const [originSidecar, foreignSidecar] = sidecars;
		pool.hostToolExecutor = () => false;

		if (!originSidecar) throw new Error("Missing origin sidecar");
		emit(originSidecar, "shared-id");

		expect(pool.routeSideChannel(foreign.win, "shared-id", frame, true)).toBe("foreign");
		expect(originSidecar.sentFrames).toEqual([]);
		expect(foreignSidecar?.sentFrames).toEqual([]);

		expect(pool.routeSideChannel(origin.win, "shared-id", frame, true)).toBe("routed");
		expect(originSidecar.sentFrames).toEqual([frame]);
		expect(foreignSidecar?.sentFrames).toEqual([]);
	});

	it("never overwrites the first owner of a duplicate live request id", () => {
		const { pool, sidecars } = fakePool();
		const firstWindow = fakeWindow(1);
		const secondWindow = fakeWindow(2);
		pool.acquire({ cwd: "/first", win: firstWindow.win, tabId: "tab-first" });
		pool.acquire({ cwd: "/second", win: secondWindow.win, tabId: "tab-second" });
		const [first, second] = sidecars;

		first?.emitExtensionUi("duplicate-id");
		second?.emitExtensionUi("duplicate-id");
		const frame = { type: "extension_ui_response", id: "duplicate-id", confirmed: true };

		expect(pool.routeSideChannel(secondWindow.win, "duplicate-id", frame, true)).toBe("foreign");
		expect(pool.routeSideChannel(firstWindow.win, "duplicate-id", frame, true)).toBe("routed");
		expect(first?.sentFrames).toEqual([frame]);
		expect(second?.sentFrames).toEqual([]);
	});

	it("rejects malformed or oversized response ids without a lookup or send", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		const [sidecar] = sidecars;
		sidecar?.emitExtensionUi("valid-id");
		const frame = { type: "extension_ui_response", id: "valid-id", confirmed: true };

		expect(pool.routeSideChannel(fw.win, "", frame, true)).toBe("foreign");
		expect(pool.routeSideChannel(fw.win, "x".repeat(129), frame, true)).toBe("foreign");
		expect(pool.routeSideChannel(fw.win, 42, frame, true)).toBe("foreign");
		expect(sidecar?.sentFrames).toEqual([]);
		expect(pool.routeSideChannel(fw.win, "valid-id", frame, true)).toBe("routed");
	});

	it("drops pending routes when the owner window closes", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		const [sidecar] = sidecars;
		sidecar?.emitHostUriRequest("uri-doomed");

		fw.close();

		expect(pool.routeSideChannel(fw.win, "uri-doomed", { type: "host_uri_result", id: "uri-doomed" }, true)).toBe(
			"unknown",
		);
		expect(sidecar?.sentFrames).toEqual([]);
	});

	it("drops pending routes when the pool is disposed", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/a", win: fw.win, tabId: "tab-a" });
		const [sidecar] = sidecars;
		sidecar?.emitExtensionUi("req-disposed");

		await pool.disposeAll();

		expect(
			pool.routeSideChannel(fw.win, "req-disposed", { type: "extension_ui_response", id: "req-disposed" }, true),
		).toBe("unknown");
		expect(sidecar?.sentFrames).toEqual([]);
	});
});

describe("SidecarPool remote host-tool boundary", () => {
	const hostToolNames = ["gui_clipboard_read", "gui_open_url", "gui_notify", "unregistered_host_tool"];

	it.each(hostToolNames)("denies remote %s without executing or forwarding it", toolName => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({
			cwd: SSH_TARGET.cwd,
			win: fw.win,
			tabId: "tab-remote",
			target: SSH_TARGET,
		});
		const [remote] = sidecars;
		let executorCalls = 0;
		pool.hostToolExecutor = () => {
			executorCalls++;
			return false;
		};

		remote?.emit("hostToolCall", {
			type: "host_tool_call",
			id: `remote-${toolName}`,
			toolCallId: `call-${toolName}`,
			toolName,
			arguments: {},
		});

		expect(executorCalls).toBe(0);
		expect(fw.sentTo(IPC_EVENTS.HOST_TOOL_CALL)).toHaveLength(0);
		expect(remote?.sentFrames).toHaveLength(1);
		expect(remote?.sentFrames[0]).toMatchObject({
			type: "host_tool_result",
			id: `remote-${toolName}`,
		});
		const error = (remote?.sentFrames[0] as { error?: unknown } | undefined)?.error;
		expect(typeof error).toBe("string");
		expect((error as string).length).toBeLessThanOrEqual(128);
	});

	it.each(hostToolNames)("preserves local %s executor dispatch", toolName => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire({ cwd: "/local", win: fw.win, tabId: "tab-local" });
		const [local] = sidecars;
		let executorCalls = 0;
		pool.hostToolExecutor = (_sidecar, request, win) => {
			executorCalls++;
			win.webContents.send(IPC_EVENTS.HOST_TOOL_CALL, { request });
			return false;
		};

		local?.emit("hostToolCall", {
			type: "host_tool_call",
			id: `local-${toolName}`,
			toolCallId: `call-${toolName}`,
			toolName,
			arguments: {},
		});

		expect(executorCalls).toBe(1);
		expect(fw.sentTo(IPC_EVENTS.HOST_TOOL_CALL)).toHaveLength(1);
		expect(local?.sentFrames).toEqual([]);
	});

	it("does not reserve a denied remote request id", () => {
		const { pool, sidecars } = fakePool();
		const remoteWindow = fakeWindow(1);
		const localWindow = fakeWindow(2);
		pool.acquire({
			cwd: SSH_TARGET.cwd,
			win: remoteWindow.win,
			tabId: "tab-remote",
			target: SSH_TARGET,
		});
		pool.acquire({ cwd: "/local", win: localWindow.win, tabId: "tab-local" });
		const [remote, local] = sidecars;
		let executorCalls = 0;
		pool.hostToolExecutor = () => {
			executorCalls++;
			return false;
		};
		const request = {
			type: "host_tool_call",
			id: "reused-after-denial",
			toolCallId: "tool-call",
			toolName: "unregistered_host_tool",
			arguments: {},
		};

		remote?.emit("hostToolCall", request);
		local?.emit("hostToolCall", request);
		const result = { type: "host_tool_result", id: request.id, result: "local" };

		expect(executorCalls).toBe(1);
		expect(pool.routeSideChannel(localWindow.win, request.id, result, true)).toBe("routed");
		expect(local?.sentFrames).toEqual([result]);
		expect(remote?.sentFrames).toHaveLength(1);
	});
});
