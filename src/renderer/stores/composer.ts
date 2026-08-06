/**
 * Composer draft text. Lives in a store (not InputArea-local state) so the
 * session-tabs switch can snapshot/restore the draft per tab — a half-typed
 * message survives hopping to another tab and back.
 *
 * Writes still flow through the same call sites as the old useState: every
 * producer (typing, paste markers, mentions, history recall, dequeue
 * restore, the `omp:fill-composer` window event) calls setDraft with a value
 * or an updater.
 */
import { create } from "zustand";

interface ComposerStore {
	draft: string;
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	reset: () => void;
}

export const useComposerStore = create<ComposerStore>()(set => ({
	draft: "",
	setDraft: next => set(state => ({ draft: typeof next === "function" ? next(state.draft) : next })),
	reset: () => set({ draft: "" }),
}));
