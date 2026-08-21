import { useCallback } from "react";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";

/**
 * Guards await-then-write dock actions against tab switches AND in-place
 * session replacements: capture the origin AT ACTION START (not at render —
 * a re-render during the await must not move the origin), verify before
 * settling. Without this, a response resolving after the user switched
 * tabs/sessions mutates or rolls back whichever session is foreground.
 */
export interface TabOrigin {
	tabId: string;
	sessionId: string | null;
}

export function useTabGuard(): {
	capture: () => TabOrigin;
	isActive: (origin: TabOrigin) => boolean;
} {
	const capture = useCallback(
		(): TabOrigin => ({
			tabId: useTabsStore.getState().activeTabId ?? "",
			sessionId: useSessionStore.getState().sessionId ?? null,
		}),
		[],
	);
	const isActive = useCallback(
		(origin: TabOrigin): boolean => {
			const current = capture();
			return current.tabId === origin.tabId && current.sessionId === origin.sessionId;
		},
		[capture],
	);
	return { capture, isActive };
}
