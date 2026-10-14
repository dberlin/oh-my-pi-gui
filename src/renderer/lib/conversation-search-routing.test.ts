import { parseHTML } from "linkedom";
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcSessionOwner, IpcSpawnTabResult, SessionTarget } from "../../shared/ipc-types";
import { confirmModelRestore } from "../hooks/use-session-switch";
import { ModelRestoreDialog } from "../components/dialogs/ModelRestoreDialog";
import { SessionSwitchDialog } from "../components/dialogs/SessionSwitchDialog";
import { I18nProvider, translate } from "./i18n";
import { useAgentViewStore } from "../stores/agent-view";
import { useModelStore } from "../stores/model";
import { useModelRestoreStore } from "../stores/model-restore";
import { type SessionStore, useSessionStore } from "../stores/session";
import { sessionRuntimeStore, setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { useTranscriptFocusStore } from "../stores/transcript-focus";
import { useUiStore } from "../stores/ui";
import { type FlatHit, openConversationHit } from "./conversation-search";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let dialogRoot: Root | null = null;
let dialogContainer: Element | null = null;

async function mountConsent(Dialog: ComponentType): Promise<void> {
	dialogContainer = document.createElement("div") as unknown as Element;
	document.body.appendChild(dialogContainer as never);
	dialogRoot = createRoot(dialogContainer);
	await act(async () => {
		dialogRoot?.render(createElement(I18nProvider, null, createElement(Dialog)));
	});
}

async function cancelConsent(): Promise<void> {
	const button = [...document.querySelectorAll("button")].find(
		button => button.textContent === translate("common.cancel"),
	);
	if (!button) throw new Error("Missing consent Cancel button");
	await act(async () => button.click());
}
const CWD = "/work/app";
const PATH = "/sessions/local.jsonl";
const SSH: SessionTarget = {
	type: "ssh", hostAlias: "dev", cwd: CWD, originCwd: "/local",
	host: { host: "example.com", sourceId: "dev", sourceLevel: "user" },
};
const item: FlatHit = {
	result: {
		path: PATH, sessionId: "saved", cwd: CWD, title: "Saved", modified: 1000, more: 0,
		hits: [{ entryId: "message", role: "assistant", snippet: "saved answer", timestamp: 1000 }],
	},
	hit: { entryId: "message", role: "assistant", snippet: "saved answer", timestamp: 1000 },
};

function seedOrigin(target: SessionTarget): void {
	useTabsStore.setState({
		activeTabId: "origin",
		tabs: [{ id: "origin", cwd: CWD, kind: "agent", status: "ready", target, unreadDone: false }],
	});
	ensureTabRuntime("origin");
	setFocusedSessionRuntime("origin");
	useSessionStore.setState({ sessionId: "working", sessionFile: "/sessions/working.jsonl", cwd: CWD, status: "ready" });
	useModelStore.setState({ model: { provider: "openai", id: "current" } });
}

function bridge() {
	const spawn = vi.fn(async (): Promise<IpcSpawnTabResult | null> => ({ tabId: "local-new" }));
	const setActive = vi.fn(async () => true);
	const switchSession = vi.fn(async () => ({ type: "response", command: "switch_session", success: true }));
	const getSessionOwner = vi.fn(async (): Promise<IpcSessionOwner | null> => null);
	const openInNewWindow = vi.fn(async () => true);
	Object.assign(window, {
		omp: { tabs: { spawn, setActive, getSessionOwner }, sessions: { openInNewWindow }, rpc: { switchSession } },
	});
	return { spawn, setActive, getSessionOwner, openInNewWindow, switchSession };
}

beforeEach(() => {
	useTabsStore.getState().reset();
	useModelRestoreStore.getState().close();
	useTranscriptFocusStore.setState({ target: null });
	useUiStore.getState().closeSessionOverlays();
});
afterEach(async () => {
	if (dialogRoot) await act(async () => dialogRoot?.unmount());
	dialogContainer?.remove();
	dialogRoot = null;
	dialogContainer = null;
	useTabsStore.getState().reset();
	useModelRestoreStore.getState().close();
	useTranscriptFocusStore.setState({ target: null });
	useUiStore.getState().closeSessionOverlays();
	vi.restoreAllMocks();
});

describe("local conversation hit routing", () => {
	it("opens a local owner instead of switching an SSH sidecar with the same cwd", async () => {
		const omp = bridge();
		seedOrigin(SSH);
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		expect(omp.spawn).toHaveBeenCalledWith(expect.objectContaining({
			cwd: CWD, sessionPath: PATH, kind: "agent", target: { type: "local" },
		}));
		expect(omp.switchSession).not.toHaveBeenCalled();
		expect(useTabsStore.getState().activeTabId).toBe("local-new");
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "local-new")?.target).toEqual({ type: "local" });
		expect(sessionRuntimeStore<SessionStore>("origin", "session")?.getState().sessionFile).toBe("/sessions/working.jsonl");
	});

	it("reuses an open local tab and reveals Main without attaching another sidecar", async () => {
		const omp = bridge();
		seedOrigin(SSH);
		useTabsStore.setState(state => ({ tabs: [...state.tabs, {
			id: "owner", cwd: CWD, kind: "agent", status: "starting", target: { type: "local" },
			unreadDone: false, sessionPath: PATH,
		}] }));
		const owner = ensureTabRuntime("owner");
		const view = owner.stores.get("agentView")!;
		view.setState({ target: { kind: "subagent", id: "selected" } });
		await openConversationHit(item, { newTab: true, currentCwd: CWD });
		expect(omp.spawn).not.toHaveBeenCalled();
		expect(omp.setActive).toHaveBeenCalledWith("owner");
		expect(useTabsStore.getState().activeTabId).toBe("owner");
		expect(view.getState()).toMatchObject({ target: { kind: "main" } });
		expect(useTranscriptFocusStore.getState().target).toMatchObject({ sessionPath: PATH, entryId: "message" });
	});

	it("uses the existing busy-session choice instead of aborting a local run", async () => {
		const omp = bridge();
		seedOrigin({ type: "local" });
		useSessionStore.setState({ isStreaming: true });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		expect(useUiStore.getState().sessionSwitchPrompt).toMatchObject({ path: PATH, id: "saved" });
		expect(omp.spawn).not.toHaveBeenCalled();
		expect(omp.switchSession).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessionFile).toBe("/sessions/working.jsonl");
	});

	it("retains the message locator through explicit saved-model consent", async () => {
		const omp = bridge();
		seedOrigin(SSH);
		omp.spawn.mockResolvedValueOnce({ tabId: null, refusal: "model-restore", missingModel: "missing/old" });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		expect(useModelRestoreStore.getState().prompt?.session.path).toBe(PATH);
		expect(useTabsStore.getState().activeTabId).toBe("origin");
		expect(useTranscriptFocusStore.getState().target).toMatchObject({ sessionPath: PATH, entryId: "message" });
		expect(omp.spawn).toHaveBeenCalledTimes(1);
		expect(await confirmModelRestore()).toBe(true);
		expect(omp.spawn).toHaveBeenLastCalledWith(expect.objectContaining({
			sessionPath: PATH, target: { type: "local" }, model: { provider: "openai", modelId: "current" },
		}));
		expect(useTabsStore.getState().activeTabId).toBe("local-new");
		expect(useTranscriptFocusStore.getState().target?.entryId).toBe("message");
	});

	it("clears a failed open without settling a newer search request", async () => {
		const omp = bridge();
		seedOrigin(SSH);
		const reply = Promise.withResolvers<IpcSpawnTabResult | null>();
		omp.spawn.mockReturnValueOnce(reply.promise);
		const pending = openConversationHit(item, { newTab: true, currentCwd: CWD });
		useTranscriptFocusStore.getState().settle(useTranscriptFocusStore.getState().target!.nonce);
		useTranscriptFocusStore.getState().focus("/sessions/newer.jsonl", "newer");
		reply.resolve(null);
		await pending;
		expect(useTranscriptFocusStore.getState().target).toMatchObject({ sessionPath: "/sessions/newer.jsonl", entryId: "newer" });
	});

	it("reveals the already attached session's Main view without replacing it", async () => {
		const omp = bridge();
		seedOrigin({ type: "local" });
		useSessionStore.setState({ sessionFile: PATH, sessionId: "saved" });
		useAgentViewStore.setState({ target: { kind: "subagent", id: "selected" } });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(omp.spawn).not.toHaveBeenCalled();
		expect(omp.switchSession).not.toHaveBeenCalled();
	});

	it("forwards a foreign owner's message locator instead of attaching or retaining it locally", async () => {
		const omp = bridge();
		seedOrigin(SSH);
		omp.getSessionOwner.mockResolvedValue({ tabId: "foreign-tab", winId: 42 });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		expect(omp.openInNewWindow).toHaveBeenCalledWith({
			sessionPath: PATH, cwd: CWD, entryId: "message",
		});
		expect(omp.spawn).not.toHaveBeenCalled();
		expect(useTabsStore.getState().activeTabId).toBe("origin");
		expect(useTranscriptFocusStore.getState().target).toBeNull();
	});

	it("retires the search locator when the actual busy-session dialog is cancelled", async () => {
		bridge();
		seedOrigin({ type: "local" });
		useSessionStore.setState({ isStreaming: true });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		await mountConsent(SessionSwitchDialog);
		await cancelConsent();
		expect(useUiStore.getState().sessionSwitchPrompt).toBeNull();
		expect(useTranscriptFocusStore.getState().target).toBeNull();
	});

	it("delivers the locator when another window acquires the session during the busy-session choice", async () => {
		const omp = bridge();
		seedOrigin({ type: "local" });
		useSessionStore.setState({ isStreaming: true });
		await openConversationHit(item, { newTab: false, currentCwd: CWD });
		await mountConsent(SessionSwitchDialog);
		omp.spawn.mockResolvedValueOnce({ tabId: null, ownerTabId: "foreign-tab" });
		const button = [...document.querySelectorAll("button")].find(
			button => button.textContent === translate("sessionSwitch.openNewTab"),
		);
		if (!button) throw new Error("Missing new-tab choice");
		await act(async () => button.click());
		expect(omp.openInNewWindow).toHaveBeenCalledWith({
			sessionPath: PATH, entryId: "message",
		});
		expect(useUiStore.getState().sessionSwitchPrompt).toBeNull();
		expect(useTranscriptFocusStore.getState().target).toBeNull();
		expect(useTabsStore.getState().activeTabId).toBe("origin");
	});

	it.each(["cancel", "invalidate"] as const)(
		"retires the search locator when saved-model consent is %s",
		async action => {
			const omp = bridge();
			seedOrigin(SSH);
			omp.spawn.mockResolvedValueOnce({ tabId: null, refusal: "model-restore", missingModel: "missing/old" });
			await openConversationHit(item, { newTab: false, currentCwd: CWD });
			await mountConsent(ModelRestoreDialog);
			if (action === "cancel") await cancelConsent();
			else await act(async () => useSessionStore.setState({ sessionId: "different-working-session" }));
			expect(useModelRestoreStore.getState().prompt).toBeNull();
			expect(useTranscriptFocusStore.getState().target).toBeNull();
		},
	);
});
