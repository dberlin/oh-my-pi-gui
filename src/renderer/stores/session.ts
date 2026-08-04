import { create } from "zustand";
import type { ContextUsage, RpcSessionState, SidecarStatus } from "../../shared/rpc-types";

interface SessionStore {
	sessionId: string;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	isStreaming: boolean;
	isCompacting: boolean;
	status: SidecarStatus;
	contextUsage: ContextUsage | null;
	messageCount: number;
	queuedMessageCount: number;
	planModeEnabled: boolean;
	goal: { objective?: string } | null;
	goalState: { status?: string } | null;
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
	status: "starting" as SidecarStatus,
	contextUsage: null,
	messageCount: 0,
	queuedMessageCount: 0,
	planModeEnabled: false,
	goal: null,
	goalState: null,
};

export const useSessionStore = create<SessionStore>()(set => ({
	...initialState,
	setFromState: state =>
		set({
			sessionId: state.sessionId,
			sessionName: state.sessionName,
			sessionFile: state.sessionFile,
			cwd: state.cwd,
			isStreaming: state.isStreaming,
			isCompacting: state.isCompacting,
			contextUsage: state.contextUsage,
			messageCount: state.messageCount,
			queuedMessageCount: state.queuedMessageCount,
			planModeEnabled: state.planModeEnabled ?? false,
		}),
	setStatus: (status, cwd) => set({ status, cwd }),
	reset: () => set(initialState),
}));
