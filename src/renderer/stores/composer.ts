/**
 * Composer content. Lives in a store (not InputArea-local state) so session
 * tabs can snapshot/restore text and image attachments together.
 *
 * Writes still flow through the same call sites as the old useState: every
 * producer (typing, paste markers, mentions, history recall, dequeue
 * restore, the `omp:fill-composer` window event) calls setDraft with a value
 * or an updater.
 */
import { create } from "zustand";
import type { ImageContent } from "../../shared/rpc-types";

export interface ComposerImage {
	content: ImageContent;
	preview: string;
}

interface ComposerStore {
	draft: string;
	images: ComposerImage[];
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	reset: () => void;
}

export const useComposerStore = create<ComposerStore>()(set => ({
	draft: "",
	images: [],
	setDraft: next => set(state => ({ draft: typeof next === "function" ? next(state.draft) : next })),
	setImages: next => set(state => ({ images: typeof next === "function" ? next(state.images) : next })),
	reset: () => set({ draft: "", images: [] }),
}));
