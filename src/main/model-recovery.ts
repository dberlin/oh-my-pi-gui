import { withTimeout } from "../../../utils/src/async";
import { timeoutForCommand } from "../shared/rpc-client";
import type { IpcSpawnTabPayload } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, RpcSessionState, SidecarStatusPayload } from "../shared/rpc-types";
import type { SidecarManager } from "./sidecar";
import { SESSION_CHANGING_COMMANDS } from "../shared/session-changing-commands";

type SwitchCommand = Extract<RpcCommand, { type: "switch_session" }>;
type PreparedRecovery = { command: SwitchCommand } | { response: RpcResponse };

/** Queued session OR current-model mutations invalidate pending confirmations. */
export function createModelRecoveryGuard() {
	const generations = new WeakMap<object, number>();
	const listeners = new WeakMap<object, Set<() => void>>();
	return {
		observe(client: object, command: RpcCommand): void {
			if (
				SESSION_CHANGING_COMMANDS[command.type] ||
				command.type === "set_model" ||
				command.type === "cycle_model"
			) {
				generations.set(client, (generations.get(client) ?? 0) + 1);
				for (const listener of listeners.get(client) ?? []) listener();
			}
		},
		capture(client: object): () => boolean {
			const generation = generations.get(client) ?? 0;
			return () => (generations.get(client) ?? 0) === generation;
		},
		subscribe(client: object, listener: () => void): () => void {
			let subscribed = listeners.get(client);
			if (!subscribed) {
				subscribed = new Set();
				listeners.set(client, subscribed);
			}
			subscribed.add(listener);
			return () => {
				subscribed.delete(listener);
				if (subscribed.size === 0) listeners.delete(client);
			};
		},
	};
}

/**
 * GUI confirmation is tied to the working session and its CURRENT model.
 * Validate against the originating vanilla process, not a renderer cache, and
 * strip GUI-only metadata before forwarding the actual vanilla command.
 * The same process/transport contract applies to local and SSH sidecars.
 */
export async function prepareModelRecoveryCommand(
	command: SwitchCommand,
	read: (command: RpcCommand) => Promise<RpcResponse>,
	isCurrent: () => boolean,
): Promise<PreparedRecovery> {
	const { expectedSessionId, ...vanillaCommand } = command;
	if (expectedSessionId === undefined) return { command: vanillaCommand };
	const refuse = (error: string, code = "session_model_recovery_stale"): PreparedRecovery => ({
		response: { id: command.id, type: "response", command: "switch_session", success: false, error, code },
	});
	if (!isCurrent()) return refuse("The originating session is no longer available");
	if (!expectedSessionId || !command.provider || !command.modelId) {
		return refuse(
			"Current-model recovery requires a working session and an explicit model",
			"session_model_recovery_unavailable",
		);
	}
	let response: RpcResponse;
	try {
		response = await read({ type: "get_state" });
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error), "session_model_recovery_unavailable");
	}
	if (!isCurrent()) return refuse("The originating sidecar changed before confirmation");
	if (!response.success)
		return refuse(
			response.error ?? "The working session could not be verified",
			"session_model_recovery_unavailable",
		);
	const state = response.data as Partial<RpcSessionState> | undefined;
	if (state?.sessionId !== expectedSessionId) return refuse("The working session changed before confirmation");
	if (!state?.model) return refuse("No current model is available", "session_model_recovery_unavailable");
	if (state.model.provider !== command.provider || state.model.id !== command.modelId) {
		return refuse("The current model changed before confirmation");
	}
	return { command: vanillaCommand };
}

/** Selector-only parsing excludes Bun's echoed `${...}` template source. */
export function parseModelRestoreFailure(error: string | undefined): string | null {
	return error ? (/Could not restore model ([\w.:@/+-]+)(?=$|\s)/m.exec(error)?.[1] ?? null) : null;
}

/** Event-driven readiness for the normal pooled process; no polling or new timer implementation. */
export async function waitForSidecarReady(sidecar: SidecarManager, signal?: AbortSignal): Promise<void> {
	if (sidecar.status === "ready") return;
	const ready = Promise.withResolvers<void>();
	const onStatus = (payload: SidecarStatusPayload) => {
		if (payload.status === "ready") ready.resolve();
		else if (
			payload.status === "error" ||
			payload.status === "exited" ||
			(payload.status === "restarting" && parseModelRestoreFailure(payload.message))
		) {
			ready.reject(new Error(payload.message ?? `Sidecar ${payload.status}`));
		}
	};
	sidecar.on("status", onStatus);
	try {
		if (sidecar.status === "error" || sidecar.status === "exited") {
			throw new Error(`Sidecar ${sidecar.status}`);
		}
		await withTimeout(
			ready.promise,
			timeoutForCommand({ type: "switch_session", sessionPath: "" })!,
			"Session startup did not become ready",
			signal,
		);
	} finally {
		sidecar.off("status", onStatus);
	}
}

/** Capture the real working origin for initial saved opens and explicit rebinds. */
export async function prepareModelRestoreOrigin(
	payload: IpcSpawnTabPayload,
	read: (command: RpcCommand) => Promise<RpcResponse>,
	isCurrent: () => boolean,
): Promise<{ check: () => Promise<boolean> } | { error: string }> {
	const expected = payload.modelOrigin;
	if (!expected?.tabId || !expected.sessionId) return { error: "Saved-session restore requires a working origin" };
	const readState = async (): Promise<Partial<RpcSessionState>> => {
		const response = await read({ type: "get_state" });
		if (!response.success) throw new Error(response.error ?? "The working session could not be verified");
		const state = response.data as Partial<RpcSessionState> | undefined;
		if (!state || typeof state.sessionId !== "string") throw new Error("The working session state is unavailable");
		return state;
	};
	try {
		if (!isCurrent()) return { error: "The working origin is no longer available" };
		const state = await readState();
		if (!isCurrent() || state.sessionId !== expected.sessionId)
			return { error: "The working session changed before restore" };
		const provider = state.model?.provider ?? null;
		const modelId = state.model?.id ?? null;
		if (payload.model && (provider !== payload.model.provider || modelId !== payload.model.modelId)) {
			return { error: "The explicitly approved model is no longer the current model" };
		}
		return {
			check: async () => {
				if (!isCurrent()) return false;
				const current = await readState();
				return (
					isCurrent() &&
					current.sessionId === expected.sessionId &&
					(current.model?.provider ?? null) === provider &&
					(current.model?.id ?? null) === modelId
				);
			},
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
