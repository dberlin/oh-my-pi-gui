/**
 * Shared session-switch entry. One window owns one sidecar, and the server
 * aborts the in-flight turn on `switch_session` (TUI parity) — so while the
 * attached session is busy (streaming / compacting), callers route through
 * {@link requestSessionSwitch}, which opens the SessionSwitchDialog offering
 * "open in a new tab" (a pooled parallel sidecar in this window, the
 * recommended non-destructive path) or a new window instead of silently
 * killing the run. Sidebar, ⌘P picker, deep links, and
 * the dialog itself all funnel through here so the switch flow — RPC, hook
 * veto, hydrate, toasts — exists exactly once.
 */

import type { IpcSessionOwner, SessionInfo } from "../../shared/ipc-types";
import { translate } from "../lib/i18n";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { hydrateSession } from "./use-rpc-events";

/**
 * F-OWN: route the user to the tab/window already attached to a session file
 * instead of attaching a second sidecar to it. Owner lives in THIS window →
 * switchTab (which hydrates); a foreign window → openInNewWindow, which main
 * turns into a focus of the owner window for an owned path. Resolves with
 * openInNewWindow's result for the foreign case, true for the local switch.
 */
export async function routeToSessionOwner(owner: IpcSessionOwner, sessionPath: string): Promise<boolean> {
	const tabsStore = useTabsStore.getState();
	if (tabsStore.tabs.some(tab => tab.id === owner.tabId)) {
		await tabsStore.switchTab(owner.tabId);
		return true;
	}
	return window.omp.sessions.openInNewWindow({ sessionPath });
}

/**
 * Run the switch immediately. The server aborts any in-flight turn
 * (`switchSession` → `abort({goalReason:"internal"})`) — this is NOT a
 * parallel session, it replaces the current one. Returns true when the
 * switch went through (false on RPC failure or extension-hook veto).
 *
 * F-OWN belt guard: when the file is already attached to a tab, route to the
 * owner instead of double-attaching. Main independently refuses raced
 * attaches with `session_owned_elsewhere` (handled below), so a failed
 * pre-check is safe to ignore.
 */
export async function switchSessionNow(session: SessionInfo): Promise<boolean> {
	try {
		const owner = await window.omp.tabs.getSessionOwner(session.path);
		if (owner) return await routeToSessionOwner(owner, session.path);
	} catch {
		// Pre-check best-effort — the main-process refusal is the backstop.
	}
	try {
		const response = await window.omp.rpc.switchSession(session.path);
		if (!response.success) {
			// Raced attach refused by main: route via the owner in the payload.
			if (response.code === "session_owned_elsewhere") {
				const data = response.data as { ownerTabId?: unknown; ownerWinId?: unknown } | undefined;
				if (typeof data?.ownerTabId === "string" && typeof data.ownerWinId === "number") {
					return await routeToSessionOwner({ tabId: data.ownerTabId, winId: data.ownerWinId }, session.path);
				}
			}
			toast({ variant: "error", title: translate("sidebar.openFailed"), message: response.error });
			return false;
		}
		// Hook veto: success:true with cancelled:true — stay on the current session.
		const data = response.data as { cancelled?: boolean } | undefined;
		if (data?.cancelled) {
			toast({ variant: "info", message: translate("sidebar.openCancelled") });
			return false;
		}
		// `||` not `??`: an empty title slot (auto-title never ran) must fall
		// through to the first message, not hydrate as an empty name.
		await hydrateSession(session.title || session.firstMessage);
		return true;
	} catch (error) {
		toast({ variant: "error", title: translate("sidebar.openFailed"), message: String(error) });
		return false;
	}
}

/**
 * Switch to `session` unless the attached session is busy. Streaming /
 * compacting means the switch would abort the run server-side, so ask first
 * via the SessionSwitchDialog (new tab / new window vs abort-and-switch).
 * Idle sessions switch straight through.
 */
export function requestSessionSwitch(session: SessionInfo): void {
	const { isStreaming, isCompacting, sessionId } = useSessionStore.getState();
	if (session.id === sessionId) return;
	if (isStreaming || isCompacting) {
		useUiStore.getState().requestSessionSwitch(session);
		return;
	}
	void switchSessionNow(session);
}
