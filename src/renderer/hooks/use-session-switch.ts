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

import type { SessionInfo } from "../../shared/ipc-types";
import { translate } from "../lib/i18n";
import { useSessionStore } from "../stores/session";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { hydrateSession } from "./use-rpc-events";

/**
 * Run the switch immediately. The server aborts any in-flight turn
 * (`switchSession` → `abort({goalReason:"internal"})`) — this is NOT a
 * parallel session, it replaces the current one. Returns true when the
 * switch went through (false on RPC failure or extension-hook veto).
 */
export async function switchSessionNow(session: SessionInfo): Promise<boolean> {
	try {
		const response = await window.omp.rpc.switchSession(session.path);
		if (!response.success) {
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
