import { create } from "zustand";
import type { TodoPhase, TodoTask } from "../../shared/rpc-types";

export interface UiTodoTask extends TodoTask {
	id: string;
}

export interface UiTodoPhase extends Omit<TodoPhase, "tasks"> {
	id: string;
	tasks: UiTodoTask[];
}

/**
 * One archived todo state: appended whenever the phases actually change after
 * the session's first hydration, rendered as a transcript snapshot row. The
 * first setPhases after a reset is hydration (get_state pull), never a
 * change; later identical re-applies (every agent_end re-pulls state) are
 * deduped by semantic fingerprint so the archive only carries real edits.
 */
export interface TodoSnapshot {
	id: string;
	ts: number;
	phases: TodoPhase[];
}

/** Archive cap — the transcript keeps the newest snapshots, drops the oldest. */
const HISTORY_LIMIT = 30;

interface TodoStore {
	phases: UiTodoPhase[];
	reminderVisible: boolean;
	reminderTodos: TodoTask[];
	/** Change archive since the session's first hydration (transcript rows). */
	history: TodoSnapshot[];
	/** False until the first post-reset setPhases — that one is hydration, not a change. */
	historyHydrated: boolean;
	setPhases: (phases: TodoPhase[]) => void;
	showReminder: (todos: TodoTask[]) => void;
	clearReminder: () => void;
	reset: () => void;
}

const initialState = {
	phases: [] as UiTodoPhase[],
	reminderVisible: false,
	reminderTodos: [] as TodoTask[],
	history: [] as TodoSnapshot[],
	historyHydrated: false,
};

function normalizePhases(phases: TodoPhase[]): UiTodoPhase[] {
	return phases.map((phase, phaseIndex) => {
		const existingPhaseId = "id" in phase && typeof phase.id === "string" ? phase.id : null;
		const phaseId = existingPhaseId ?? `phase:${phaseIndex}:${phase.name}`;
		return {
			...phase,
			id: phaseId,
			tasks: phase.tasks.map((task, taskIndex) => ({
				...task,
				id: "id" in task && typeof task.id === "string" ? task.id : `${phaseId}:task:${taskIndex}`,
			})),
		};
	});
}

/** Semantic identity of a phase list — ids are UI-assigned and must not count as change. */
function fingerprintPhases(
	phases: readonly { name: string; tasks: readonly { content: string; status: string }[] }[],
): string {
	return JSON.stringify(phases.map(phase => [phase.name, phase.tasks.map(task => [task.content, task.status])]));
}

export const useTodoStore = create<TodoStore>()((set, get) => ({
	...initialState,
	setPhases: phases => {
		const state = get();
		const next = normalizePhases(phases);
		if (!state.historyHydrated || fingerprintPhases(next) === fingerprintPhases(state.phases)) {
			set({ phases: next, historyHydrated: true });
			return;
		}
		const snapshot: TodoSnapshot = {
			id: `todo-snapshot-${Date.now()}-${state.history.length}`,
			ts: Date.now(),
			phases: next.map(phase => ({
				name: phase.name,
				tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
			})),
		};
		const history = [...state.history, snapshot];
		if (history.length > HISTORY_LIMIT) history.shift();
		set({ phases: next, history, historyHydrated: true });
	},
	showReminder: todos => set({ reminderVisible: true, reminderTodos: todos }),
	clearReminder: () => set({ reminderVisible: false, reminderTodos: [] }),
	reset: () => set(initialState),
}));
