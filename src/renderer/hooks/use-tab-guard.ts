import { useCallback } from "react";
import { acceptsActiveTabEvents } from "../lib/tab-routing";
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
	capture: () => TabOrigin | null;
	isActive: (origin: TabOrigin | null) => boolean;
} {
	const capture = useCallback((): TabOrigin | null => {
		if (!acceptsActiveTabEvents()) return null;
		const tabId = useTabsStore.getState().activeTabId;
		if (!tabId) return null;
		return { tabId, sessionId: useSessionStore.getState().sessionId ?? null };
	}, []);
	const isActive = useCallback((origin: TabOrigin | null): boolean => {
		if (!origin || !acceptsActiveTabEvents()) return false;
		return (
			useTabsStore.getState().activeTabId === origin.tabId &&
			(useSessionStore.getState().sessionId ?? null) === origin.sessionId
		);
	}, []);
	return { capture, isActive };
}
