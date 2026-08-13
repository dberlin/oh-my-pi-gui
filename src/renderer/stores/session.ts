import { create } from "zustand";
import type { ContextUsage, RpcLoopModeState, RpcSessionState, SidecarStatus } from "../../shared/rpc-types";

interface SessionStore {
	sessionId: string;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	isStreaming: boolean;
	isCompacting: boolean;
	/** Client clock (Date.now()) of the current turn_start while no assistant
	 * message has begun streaming — drives the chat's pending-model indicator
	 * so a stalled provider request is visibly alive instead of dead air. */
	awaitingModelSince: number | null;
	/** Live auto-retry window (auto_retry_start → auto_retry_end): drives the
	 * inline retry row with a live countdown. `startedAt` is the client clock
	 * at event time so the countdown survives re-renders. */
	retryInfo: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAt: number } | null;
	/** Live auto-compaction window (auto_compaction_start → auto_compaction_end):
	 * carries the TUI loader's reason/action text for the inline status row. */
	compactionInfo: { reason: "threshold" | "overflow" | "idle" | "incomplete"; action: string } | null;
	status: SidecarStatus;
	contextUsage: ContextUsage | null;
	messageCount: number;
	queuedMessageCount: number;
	planModeEnabled: boolean;
	/** Whether a prewalk model switch is armed and waiting for the first edit/write. */
	prewalkArmed: boolean;
	agentsPaused: boolean;
	agentsPausedAt: number | null;
	goal: { objective?: string } | null;
	goalState: { status?: string } | null;
	/** Live loop-mode state: loop_mode_update frames, hydrated via get_loop_mode
	 * (not on the get_state wire). null = not yet fetched; chips treat as off. */
	loopMode: RpcLoopModeState | null;
	/** Vibe mode emits no event — hydrated via get_vibe_mode and mirrored when
	 * the Modes window toggles it. */
	vibeModeEnabled: boolean;
	setFromState: (state: RpcSessionState) => void;
	setStatus: (status: SidecarStatus, cwd: string) => void;
	reset: () => void;
}

const initialState = {
	sessionId: "",
	sessionName: null,
	sessionFile: null,
	cwd: "",
	isStreaming: false,
	isCompacting: false,
	awaitingModelSince: null,
	retryInfo: null,
	compactionInfo: null,
	status: "starting" as SidecarStatus,
	contextUsage: null,
	messageCount: 0,
	queuedMessageCount: 0,
	planModeEnabled: false,
	prewalkArmed: false,
	agentsPaused: false,
	agentsPausedAt: null,
	goal: null,
	goalState: null,
	loopMode: null,
	vibeModeEnabled: false,
};

export const useSessionStore = create<SessionStore>()(set => ({
	...initialState,
	setFromState: state =>
		set(current => ({
			sessionId: state.sessionId,
			// Sessions whose auto-title never ran carry an empty title slot on
			// disk; normalize "" to null so the TitleBar falls through to the
			// session-list title/first message instead of rendering blank.
			sessionName: state.sessionName || null,
			sessionFile: state.sessionFile,
			cwd: state.cwd ?? current.cwd,
			isStreaming: state.isStreaming,
			isCompacting: state.isCompacting,
			contextUsage: state.contextUsage,
			messageCount: state.messageCount,
			queuedMessageCount: state.queuedMessageCount,
			planModeEnabled: state.planModeEnabled ?? false,
			prewalkArmed: state.prewalkArmed ?? false,
			agentsPaused: state.agentsPaused ?? false,
			agentsPausedAt: state.agentsPausedAt ?? null,
		})),
	setStatus: (status, cwd) => set({ status, cwd }),
	reset: () => set(initialState),
}));
