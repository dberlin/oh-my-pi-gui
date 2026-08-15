import type { SessionKind } from "../shared/ipc-types";

export interface WindowSpawnTarget {
	cwd: string;
	kind: SessionKind;
	fresh: boolean;
	placeholder: boolean;
}

/**
 * Resolve the sidecar target for a newly created window.
 *
 * A window created without an explicit workspace/session is an idle global
 * chat. Its cwd is only an internal process requirement and must not inherit
 * the last workspace; `fresh` also prevents CLI auto-resume from attaching an
 * unrelated transcript. Explicit targets retain the existing agent/default
 * behavior.
 */
export function resolveWindowSpawnTarget(
	cwd: string | undefined,
	pendingSessionPath: string | undefined,
	kind: SessionKind | undefined,
	fallbackCwd: string,
	idleCwd: string,
): WindowSpawnTarget {
	const idle = cwd === undefined && pendingSessionPath === undefined && kind === undefined;
	if (idle) return { cwd: idleCwd, kind: "chat", fresh: true, placeholder: true };
	return {
		cwd: cwd && cwd.length > 0 ? cwd : fallbackCwd,
		kind: kind ?? "agent",
		fresh: false,
		placeholder: false,
	};
}
