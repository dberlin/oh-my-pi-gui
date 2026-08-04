import { useCallback, useEffect } from "react";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../shared/rpc-types";
import { useExtensionUiStore } from "../stores/extension-ui";

interface ExtensionUiResult {
	currentRequest: ExtensionUIRequest | null;
	respond: (response: ExtensionUIResponse) => void;
	cancel: (id: string) => void;
}

/**
 * Subscribes to extension UI requests and manages the dialog queue.
 */
export function useExtensionUi(): ExtensionUiResult {
	const pendingRequests = useExtensionUiStore(s => s.pendingRequests);
	const pushRequest = useExtensionUiStore(s => s.pushRequest);
	const removeRequest = useExtensionUiStore(s => s.removeRequest);

	useEffect(() => {
		const unsubscribe = window.omp.events.onExtensionUi(request => {
			pushRequest(request);
		});
		return unsubscribe;
	}, [pushRequest]);

	const respond = useCallback(
		(response: ExtensionUIResponse) => {
			window.omp.ui.respondExtensionUi(response);
			removeRequest(response.id);
		},
		[removeRequest],
	);

	const cancel = useCallback(
		(id: string) => {
			window.omp.ui.respondExtensionUi({ type: "extension_ui_response", id, cancelled: true });
			removeRequest(id);
		},
		[removeRequest],
	);

	return {
		currentRequest: pendingRequests.length > 0 ? pendingRequests[0] : null,
		respond,
		cancel,
	};
}
