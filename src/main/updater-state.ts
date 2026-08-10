import type { UpdateStatus } from "../shared/ipc-types";

/**
 * electron-updater may resolve without emitting an available/not-available
 * event (notably in unpackaged builds). Never leave the public state machine
 * stuck in `checking` after the request itself has finished.
 */
export function settleIncompleteUpdateCheck(status: UpdateStatus, manual: boolean): UpdateStatus {
	if (status.state !== "checking") return status;
	return manual ? { state: "error", message: "Update check completed without a result." } : { state: "idle" };
}
