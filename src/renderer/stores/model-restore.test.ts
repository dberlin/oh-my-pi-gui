import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiStore } from "./extension-ui";
import { beginRestoreInteraction, routeRestoreInteraction, useModelRestoreStore } from "./model-restore";
import {
	deleteSessionRuntime,
	focusedRuntimeTabId,
	onFocusedSessionRuntimeChange,
	sessionRuntime,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
} from "./session-runtime-context";
import type { SessionStore } from "./session";
import { ensureTabRuntime } from "./tab-runtime";

const previousWindow = globalThis.window;
let finish: (() => void) | undefined;
afterEach(() => {
	finish?.();
	finish = undefined;
	for (const id of ["restore-working", "restore-hidden", "restore-other"]) deleteSessionRuntime(id);
	setFocusedSessionRuntime(null);
	useModelRestoreStore.getState().close();
	Object.assign(globalThis, { window: previousWindow });
});

describe("restore-only interaction lifetime", () => {
	it("clears a live hidden question and cancels its pending restore when the actual working runtime retires", async () => {
		const respond = vi.fn();
		const cancel = vi.fn(async () => true);
		Object.assign(globalThis, {
			window: {
				omp: {
					ui: { respondExtensionUi: respond },
					tabs: { cancelRestore: cancel },
				},
			},
		});
		const working = ensureTabRuntime("restore-working");
		setFocusedSessionRuntime(working.tabId);
		const origin = sessionRuntimeStore<SessionStore>(working.tabId, "session")!;
		origin.setState({ sessionId: "working-history" });
		const isCurrent = () =>
			sessionRuntime(working.tabId) === working &&
			focusedRuntimeTabId() === working.tabId &&
			origin.getState().sessionId === "working-history";
		finish = beginRestoreInteraction("restore-live", working.tabId, isCurrent, changed => {
			const stopSession = origin.subscribe(changed);
			const stopFocus = onFocusedSessionRuntimeChange(changed);
			return () => {
				stopSession();
				stopFocus();
			};
		});
		expect(
			routeRestoreInteraction(
				"restore-hidden",
				{
					type: "extension_ui_request",
					id: "restore-question",
					method: "input",
					title: "Project approval",
				},
				{ restoringSession: true, restoreRequestId: "restore-live" },
			),
		).toBe(true);
		const hidden = sessionRuntimeStore<ExtensionUiStore>("restore-hidden", "extensionUi")!;
		expect(hidden.getState().pendingRequests).toHaveLength(1);
		expect(focusedRuntimeTabId()).toBe(working.tabId);

		ensureTabRuntime("restore-other");
		setFocusedSessionRuntime("restore-other");
		await Promise.resolve();
		expect(hidden.getState().pendingRequests).toHaveLength(0);
		expect(useModelRestoreStore.getState().interactions).toHaveLength(0);
		expect(respond.mock.calls.map(([response]) => response.cancelled)).toEqual([true]);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(origin.getState().sessionId).toBe("working-history");
		expect(
			routeRestoreInteraction(
				"restore-hidden",
				{
					type: "extension_ui_request",
					id: "late-question",
					method: "confirm",
					title: "Late approval",
					message: "Approve?",
				},
				{ restoringSession: true, restoreRequestId: "restore-live" },
			),
		).toBe(false);
		expect(hidden.getState().pendingRequests).toHaveLength(0);
	});
});
