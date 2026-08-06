import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { IPC_EVENTS, type IpcTabStatusPayload } from "../shared/ipc-types";
import type { SessionInfoUpdateFrame, SidecarStatus } from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";

/** Minimal SidecarManager stand-in: an EventEmitter with lifecycle recording. */
class FakeSidecar extends EventEmitter {
	started = false;
	disposed = false;
	restartArgs: Array<{ cwd: string | undefined; sessionPath: string | undefined }> = [];
	constructor(readonly cwd: string) {
		super();
	}
	get status(): SidecarStatus {
		return "starting";
	}
	start(): void {
		this.started = true;
	}
	restart(cwd?: string, sessionPath?: string): void {
		this.restartArgs.push({ cwd, sessionPath });
	}
	kill(): void {}
	dispose(): void {
		this.disposed = true;
		this.removeAllListeners();
	}
	emitStatus(status: SidecarStatus): void {
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
	const pool = new SidecarPool(cwd => {
		const sidecar = new FakeSidecar(cwd);
		sidecars.push(sidecar);
		return sidecar as unknown as SidecarManager;
	}, max);
	return { pool, sidecars };
}

describe("SidecarPool tabs", () => {
	it("binds two tabs to one window; the first is active", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const a = pool.acquire("/a", fw.win, "tab-a");
		const b = pool.acquire("/b", fw.win, "tab-b");

		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(pool.size).toBe(2);
		expect(sidecars.map(s => s.started)).toEqual([true, true]);
		expect(pool.sidecarForWindow(fw.win)).toBe(a);
		expect(pool.sidecarForTab(fw.win, "tab-b")).toBe(b);
		expect(pool.sidecarForTab(fw.win, "nope")).toBeNull();
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-a");
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{ tabId: "tab-a", cwd: "/a", status: "starting" },
			{ tabId: "tab-b", cwd: "/b", status: "starting" },
		]);
	});

	it("mints a snowflake tabId when none is given", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win);
		const tabs = pool.tabsForWindow(fw.win);
		expect(tabs[0]?.tabId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("resumes a session on first start when sessionPath is given", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const sidecar = pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		expect(sidecar).not.toBeNull();
		expect(sidecars[0]?.started).toBe(false);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/s.jsonl" }]);
	});

	it("forwards full channels only from the active tab, TAB_STATUS from every tab", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		// Only the active tab's batch reaches the full channel…
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		// …but both tabs pushed TAB_STATUS for their running transition.
		const statuses = fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data as IpcTabStatusPayload);
		expect(statuses).toEqual([
			{ tabId: "tab-a", cwd: "/a", status: "starting" },
			{ tabId: "tab-b", cwd: "/b", status: "starting" },
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
		expect(fw.sentTo(IPC_EVENTS.PROMPT_RESULT)).toHaveLength(1);
	});

	it("synthesizes running/ready per tab from the agent event stream", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		a?.emitStatus("ready");
		b?.emitStatus("ready");
		fw.sent.length = 0;

		// Background tab starts a run: TAB_STATUS reports running without any
		// full-channel leak.
		b?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(0);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ tabId: "tab-b", cwd: "/b", status: "running" },
		]);
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{ tabId: "tab-a", cwd: "/a", status: "ready" },
			{ tabId: "tab-b", cwd: "/b", status: "running" },
		]);

		// Run settles → ready (the renderer's unreadDone signal for background tabs).
		fw.sent.length = 0;
		b?.emitAgentEvents(["agent_end"]);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ tabId: "tab-b", cwd: "/b", status: "ready" },
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
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
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
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [, b] = sidecars;

		b?.emitSessionInfo({ title: "Fix flaky test", sessionId: "sess-1" });
		// Background session-info pushes a light snapshot and caches for later.
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ tabId: "tab-b", cwd: "/b", status: "starting", sessionId: "sess-1", title: "Fix flaky test" },
		]);
		// No full-channel forward from a background tab.
		expect(fw.sentTo(IPC_EVENTS.SESSION_INFO_UPDATE)).toHaveLength(0);
		expect(pool.tabsForWindow(fw.win)[1]).toEqual({
			tabId: "tab-b",
			cwd: "/b",
			status: "starting",
			sessionId: "sess-1",
			title: "Fix flaky test",
		});

		// Subsequent status pushes keep carrying the cached meta.
		fw.sent.length = 0;
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ tabId: "tab-b", cwd: "/b", status: "ready", sessionId: "sess-1", title: "Fix flaky test" },
		]);
	});

	it("releases a tab: disposed, pool shrinks, active falls back to a sibling", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
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
		expect(pool.acquire("/a", fw1.win, "tab-a")).not.toBeNull();
		expect(pool.acquire("/b", fw1.win, "tab-b")).not.toBeNull();
		expect(pool.atCap).toBe(true);
		// A second window gets no slot either — the cap is pool-wide over tabs.
		expect(pool.acquire("/c", fw2.win, "tab-c")).toBeNull();
		expect(pool.size).toBe(2);

		pool.releaseTab("tab-b");
		expect(pool.atCap).toBe(false);
		expect(pool.acquire("/c", fw2.win, "tab-c")).not.toBeNull();
	});

	it("releases every tab of a closed window", () => {
		const { pool, sidecars } = fakePool();
		const fw1 = fakeWindow(1);
		const fw2 = fakeWindow(2);
		pool.acquire("/a", fw1.win, "tab-a");
		pool.acquire("/b", fw1.win, "tab-b");
		pool.acquire("/c", fw2.win, "tab-c");

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
