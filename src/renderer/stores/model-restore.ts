import { create } from "zustand";
import type { IpcExtensionUiContext, SessionInfo } from "../../shared/ipc-types";
import { BLOCKING_UI_METHODS, type ExtensionUIRequest, type RpcCommand } from "../../shared/rpc-types";
import type { ExtensionUiStore } from "./extension-ui";
import { sessionRuntimeStore } from "./session-runtime-context";
import { ensureTabRuntime } from "./tab-runtime";
import { toast } from "./toast";

/** An explicit vanilla binding, never an implicit default-role selection. */
export type SessionModelOverride = Required<
	Pick<Extract<RpcCommand, { type: "switch_session" }>, "provider" | "modelId">
>;

export interface ModelRestorePrompt {
	/** Identity known at the entry point; no invented history metadata for new-tab/SSH opens. */
	session: Partial<Pick<SessionInfo, "path" | "id" | "cwd" | "kind">>;
	missingModel: string;
	currentModel: SessionModelOverride | null;
	currentLabel: string | null;
	isCurrent: () => boolean;
	subscribeOrigin: (changed: () => void) => () => void;
	restore: () => Promise<boolean>;
}

interface ModelRestoreStore {
	prompt: ModelRestorePrompt | null;
	busy: boolean;
	/** Restore-only request scopes; ordinary tab focus/transcript never moves. */
	interactions: Array<{ requestId: string; tabId: string; originTabId: string | null }>;
	request: (prompt: ModelRestorePrompt) => void;
	close: () => void;
}

export const useModelRestoreStore = create<ModelRestoreStore>(set => ({
	prompt: null,
	busy: false,
	interactions: [],
	request: prompt => set({ prompt, busy: false }),
	close: () => set({ prompt: null, busy: false }),
}));

interface RestoreInteractionOperation {
	originTabId: string | null;
	isCurrent: () => boolean;
	tabId?: string;
	stopWatching?: () => void;
}

const restoreInteractions = new Map<string, RestoreInteractionOperation>();

/** Live renderer operation identity exists before sending its spawn IPC. */
export function beginRestoreInteraction(
	requestId: string,
	originTabId: string | null,
	isCurrent: () => boolean,
	subscribeOrigin: ModelRestorePrompt["subscribeOrigin"],
): () => void {
	const operation: RestoreInteractionOperation = { originTabId, isCurrent };
	restoreInteractions.set(requestId, operation);
	const finish = () => {
		if (restoreInteractions.get(requestId) !== operation) return;
		restoreInteractions.delete(requestId);
		operation.stopWatching?.();
		if (operation.tabId) {
			const store = sessionRuntimeStore<ExtensionUiStore>(operation.tabId, "extensionUi");
			for (const request of store?.getState().pendingRequests ?? []) {
				if (BLOCKING_UI_METHODS[request.method]) {
					window.omp.ui.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
				}
			}
			store?.getState().clearAll();
		}
		useModelRestoreStore.setState(state => ({
			interactions: state.interactions.filter(item => item.requestId !== requestId),
		}));
	};
	operation.stopWatching = subscribeOrigin(() => {
		if (isCurrent()) return;
		finish();
		void window.omp.tabs
			.cancelRestore({ restoreRequestId: requestId })
			.catch(error => toast({ variant: "error", message: String(error) }));
	});
	return finish;
}

/** Only a currently registered operation may mount a hidden tab's request UI. */
export function routeRestoreInteraction(
	tabId: string,
	request: ExtensionUIRequest,
	context: IpcExtensionUiContext,
): boolean {
	const requestId = context.restoreRequestId;
	const operation = requestId ? restoreInteractions.get(requestId) : undefined;
	if (!requestId || !operation || !operation.isCurrent() || (operation.tabId && operation.tabId !== tabId))
		return false;
	if (!BLOCKING_UI_METHODS[request.method] && request.method !== "cancel") return false;
	if (!operation.tabId) {
		operation.tabId = tabId;
		const runtime = ensureTabRuntime(tabId);
		const store = sessionRuntimeStore<ExtensionUiStore>(runtime.tabId, "extensionUi")!;
		// A retained cold owner has no live prior request process; stale UI cannot
		// shadow the newly emitted bootstrap/before-switch question.
		store.getState().clearAll();
		useModelRestoreStore.setState(state => ({
			interactions: [...state.interactions, { requestId, tabId, originTabId: operation.originTabId }],
		}));
	}
	sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")!.getState().pushRequest(request);
	return true;
}
