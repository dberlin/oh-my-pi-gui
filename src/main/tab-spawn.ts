/**
 * SPAWN_TAB decision logic, extracted from ipc.ts so the refusal contracts
 * are directly testable without an Electron runtime. The handler stays a
 * thin shell: BrowserWindow lookup + this call.
 *
 * Refusal codes retain the F-OWN shape:
 * - `owned` — the session file is already attached to a tab (double-attach).
 * - `kind-mismatch` — the payload's requested kind disagrees with the file's
 *   stamped kind (I3: reject, never degrade). When the payload omits `kind`,
 *   the file's kind wins instead of refusing.
 * - `model-restore` — real missing saved model; the working tab stays attached.
 * - `restore-failed` — actual startup/native/cancellation/origin failure, never
 *   a success-shaped fallback or a focus of an unrestored target.
 */
import type { BrowserWindow } from "electron";
import { withTimeout } from "../../../utils/src/async";
import { timeoutForCommand } from "../shared/rpc-client";
import type { IpcSpawnTabPayload, IpcSpawnTabResult, SessionKind, SshSessionTarget } from "../shared/ipc-types";
import type { SessionIndex } from "./session-index";
import type { SidecarManager } from "./sidecar";
import type { RpcCommand, RpcSessionState } from "../shared/rpc-types";
import { parseModelRestoreFailure, waitForSidecarReady } from "./model-recovery";
import type { SidecarPool } from "./sidecar-pool";
import { nextSnowflake } from "./snowflake";

export type SpawnTabDeps = {
	sidecarPool: Pick<
		SidecarPool,
		| "sessionOwner"
		| "atCap"
		| "acquire"
		| "waitForSessionRestore"
		| "finishSessionRestore"
		| "releaseTab"
		| "sidecarForTab"
		| "noteSessionFile"
		| "beginSessionRestoreRequest"
		| "finishSessionRestoreRequest"
		| "cancelSessionRestoreRequest"
		| "tabsForWindow"
		| "beginSessionRestore"
		| "failSessionRestore"
	>;
	sessionIndex: Pick<SessionIndex, "kindFor">;
	/** Caller's cwd resolution (ipc.ts's cwdFor, falling back to the app's initial cwd). */
	fallbackCwd: () => string;
	/** GUI-owned Work workspace, created on demand. */
	defaultWorkspace: () => string;
	/** Origin guard captures the real working client/generation before any restore. */
	prepareModelOrigin(payload: IpcSpawnTabPayload): Promise<{ check: () => Promise<boolean> } | { error: string }>;
	watchModelOrigin(payload: IpcSpawnTabPayload, cancel: () => void): () => void;
	authorizeRemoteTarget(
		target: SshSessionTarget,
		cwd: unknown,
		sink: (target: SshSessionTarget) => IpcSpawnTabResult | null,
	): IpcSpawnTabResult | null;
	authorizeRemoteResume(target: SshSessionTarget, cwd: string, sessionId: string): boolean;
};

export async function spawnTabForWindow(
	deps: SpawnTabDeps,
	win: BrowserWindow,
	payload: IpcSpawnTabPayload,
): Promise<IpcSpawnTabResult | null> {
	const restoring = Boolean(payload.sessionPath || payload.resumeSessionId);
	if (!restoring) return spawnTabTransaction(deps, win, payload);
	const requestId = payload.restoreRequestId ?? nextSnowflake();
	const signal = deps.sidecarPool.beginSessionRestoreRequest(win, requestId, payload.modelOrigin);
	let stopWatching: (() => void) | undefined;
	try {
		if (payload.modelOrigin) {
			stopWatching = deps.watchModelOrigin(payload, () => {
				deps.sidecarPool.cancelSessionRestoreRequest(win, requestId);
			});
		}
		return await spawnTabTransaction(deps, win, { ...payload, restoreRequestId: requestId }, signal);
	} catch (error) {
		return { tabId: null, refusal: "restore-failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		stopWatching?.();
		deps.sidecarPool.finishSessionRestoreRequest(win, requestId);
	}
}

async function spawnTabTransaction(
	deps: SpawnTabDeps,
	win: BrowserWindow,
	payload: IpcSpawnTabPayload,
	signal?: AbortSignal,
): Promise<IpcSpawnTabResult | null> {
	const budget = timeoutForCommand({ type: "switch_session", sessionPath: "" })!;
	const wait = <T>(promise: Promise<T>): Promise<T> =>
		withTimeout(promise, budget, "Saved-session restore did not complete", signal);
	if (signal?.aborted) throw signal.reason;
	const remote = payload?.target?.type === "ssh";
	const resumeSessionId =
		typeof payload?.resumeSessionId === "string" && payload.resumeSessionId ? payload.resumeSessionId : undefined;
	if (resumeSessionId !== undefined && !remote) return null;
	const sessionPath =
		!remote && typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
	const restoring = sessionPath !== undefined || resumeSessionId !== undefined;
	let origin: { check: () => Promise<boolean> } | undefined;
	if (payload.model && (!restoring || !payload.modelOrigin || !payload.model.provider || !payload.model.modelId)) {
		return {
			tabId: null,
			refusal: "restore-failed",
			error: "Explicit model recovery requires a saved session and working origin",
		};
	}
	if (restoring && payload.modelOrigin) {
		const prepared = await wait(deps.prepareModelOrigin(payload));
		if ("error" in prepared) return { tabId: null, refusal: "restore-failed", error: prepared.error };
		origin = prepared;
	}
	let kind: SessionKind = payload?.kind === "chat" ? "chat" : "agent";
	let existingTabId = payload.existingTabId;
	if (existingTabId) {
		const existing = deps.sidecarPool.tabsForWindow(win).find(tab => tab.tabId === existingTabId);
		if (!existing || !["asleep", "error", "exited"].includes(existing.status)) {
			return {
				tabId: null,
				refusal: "restore-failed",
				error: "The saved-session owner is not available for recovery",
			};
		}
		kind = existing.kind;
	}
	if (sessionPath) {
		await wait(deps.sidecarPool.waitForSessionRestore(sessionPath));
		const owner = deps.sidecarPool.sessionOwner(sessionPath);
		if (owner) {
			const owned = deps.sidecarPool.tabsForWindow(win).find(tab => tab.tabId === owner.tabId);
			if (owned && ["asleep", "error", "exited"].includes(owned.status) && !owned.restoringSession) {
				if (existingTabId && existingTabId !== owner.tabId) {
					return { tabId: null, refusal: "restore-failed", error: "The saved-session owner changed" };
				}
				existingTabId = owner.tabId;
				kind = owned.kind;
			} else return { tabId: null, ownerTabId: owner.tabId, ownerWinId: owner.winId, refusal: "owned" };
		}
		if (!existingTabId) {
			const fileKind = await wait(deps.sessionIndex.kindFor(sessionPath));
			if (payload?.kind !== undefined && fileKind !== kind) return { tabId: null, refusal: "kind-mismatch" };
			kind = fileKind;
		}
		// kindFor yields: another window may have reserved the file meanwhile.
		// Do not route to its hidden owner until that restore has really settled.
		await wait(deps.sidecarPool.waitForSessionRestore(sessionPath));
		const racedOwner = deps.sidecarPool.sessionOwner(sessionPath);
		if (racedOwner && racedOwner.tabId !== existingTabId)
			return { tabId: null, ownerTabId: racedOwner.tabId, ownerWinId: racedOwner.winId, refusal: "owned" };
	}
	if (!existingTabId && deps.sidecarPool.atCap) return null;
	const cwd = payload.defaultWorkspace
		? deps.defaultWorkspace()
		: typeof payload?.cwd === "string" && payload.cwd.length > 0
			? payload.cwd
			: payload.target?.type === "ssh"
				? payload.target.cwd
				: deps.fallbackCwd();
	const tabId = existingTabId ?? nextSnowflake();
	const acquired: { sidecar: SidecarManager | null } = { sidecar: null };
	let attemptedAcquire = false;
	let result: IpcSpawnTabResult | null;
	if (existingTabId) {
		acquired.sidecar = await wait(deps.sidecarPool.beginSessionRestore(win, existingTabId, payload));
		if (!acquired.sidecar) {
			return { tabId: null, refusal: "restore-failed", error: "The saved-session owner could not be restored" };
		}
		result = { tabId: existingTabId, restoredSession: true };
	} else if (remote) {
		result = deps.authorizeRemoteTarget(payload.target as SshSessionTarget, cwd, target => {
			if (resumeSessionId !== undefined && !deps.authorizeRemoteResume(target, target.cwd, resumeSessionId))
				return null;
			attemptedAcquire = true;
			acquired.sidecar = deps.sidecarPool.acquire({
				cwd: target.cwd,
				win,
				tabId,
				sessionPath: undefined,
				resumeSessionId,
				kind,
				worktree: payload.worktree,
				fresh: resumeSessionId === undefined,
				target,
				...(restoring ? { restoringSession: true } : {}),
				modelOrigin: payload.modelOrigin,
				restoreRequestId: payload.restoreRequestId,
				...(payload.model ? { model: payload.model } : {}),
			});
			return acquired.sidecar ? { tabId } : null;
		});
	} else {
		attemptedAcquire = true;
		acquired.sidecar = deps.sidecarPool.acquire({
			cwd,
			win,
			tabId,
			sessionPath: undefined,
			resumeSessionId: undefined,
			kind,
			worktree: payload?.worktree,
			fresh: true,
			target: payload?.target,
			...(sessionPath ? { restoreSessionPath: sessionPath, restoringSession: true } : {}),
			modelOrigin: payload.modelOrigin,
			restoreRequestId: payload.restoreRequestId,
			...(payload.model ? { model: payload.model } : {}),
		});
		result = acquired.sidecar ? (payload.defaultWorkspace ? { tabId, cwd } : { tabId }) : null;
	}
	if (!acquired.sidecar || !result) {
		if (restoring && attemptedAcquire) {
			return {
				tabId: null,
				failedTabId: tabId,
				refusal: "restore-failed",
				error: "Saved-session sidecar could not start",
			};
		}
		return result;
	}
	if (!restoring) return result;
	const sidecar = acquired.sidecar;
	try {
		await waitForSidecarReady(sidecar, signal);
		const client = sidecar.rpcClient;
		if (!client) throw new Error("Saved-session sidecar is not connected");
		const isCurrent = () =>
			!signal?.aborted &&
			!win.isDestroyed() &&
			sidecar.status === "ready" &&
			sidecar.rpcClient === client &&
			deps.sidecarPool.sidecarForTab(win, tabId) === sidecar;
		if (!isCurrent() || (origin && !(await wait(origin.check()))))
			throw new Error("The working origin changed before recovery");
		if (sessionPath) {
			const command: RpcCommand = {
				type: "switch_session",
				sessionPath,
				...(payload.model ? payload.model : {}),
			};
			const switched = await wait(client.command(command, budget));
			if (!switched.success) throw new Error(switched.error);
			if ((switched.data as { cancelled?: boolean } | undefined)?.cancelled)
				throw new Error("Session opening was cancelled");
		}
		const stateResponse = await wait(client.command({ type: "get_state" }));
		if (!stateResponse.success) throw new Error(stateResponse.error);
		const state = stateResponse.data as Partial<RpcSessionState> | undefined;
		if (
			(sessionPath && state?.sessionFile !== sessionPath) ||
			(resumeSessionId && state?.sessionId !== resumeSessionId)
		) {
			throw new Error("The sidecar did not restore the requested saved session");
		}
		if (
			payload.model &&
			(state?.model?.provider !== payload.model.provider || state?.model?.id !== payload.model.modelId)
		) {
			throw new Error("The connected coding agent did not apply the explicitly approved current model");
		}
		if (!isCurrent() || (origin && !(await wait(origin.check()))) || !isCurrent()) {
			throw new Error("The working origin changed while restoring the saved session");
		}
		if (sessionPath) deps.sidecarPool.noteSessionFile(tabId, sessionPath);
		if (!deps.sidecarPool.finishSessionRestore(tabId)) throw new Error("The restored tab is no longer available");
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (existingTabId) await deps.sidecarPool.failSessionRestore(tabId);
		else deps.sidecarPool.releaseTab(tabId);
		const missingModel = !payload.model && parseModelRestoreFailure(message);
		return {
			tabId: null,
			...(!existingTabId ? { failedTabId: tabId } : {}),
			refusal: missingModel ? "model-restore" : "restore-failed",
			...(missingModel ? { missingModel } : {}),
			error: message,
		};
	}
}
