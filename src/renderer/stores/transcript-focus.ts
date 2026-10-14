/**
 * A request to show one message of a session: set by conversation search, read
 * by the transcript of whichever tab ends up showing that session file. It is
 * window-wide because the message may open in a tab that does not exist yet.
 */
import { create } from "zustand";
import type { ConversationFocusRequest } from "../../shared/ipc-types";

/** A request older than this is dropped instead of scrolling a later visit. */
export const TRANSCRIPT_FOCUS_TTL_MS = 60_000;

export interface TranscriptFocusTarget {
	sessionPath: string;
	entryId: string;
	/** Distinguishes repeated requests for the same message. */
	nonce: number;
	requestedAt: number;
}

interface TranscriptFocusState {
	target: TranscriptFocusTarget | null;
	/** Native delivery survives the shell's boot-time runtime-provider remount. */
	pendingNative: ConversationFocusRequest | null;
	focus: (sessionPath: string, entryId: string) => number;
	/** Done with this request; a newer one stays. */
	settle: (nonce: number) => void;
}
let nextNonce = 0;

export const useTranscriptFocusStore = create<TranscriptFocusState>((set, get) => ({
	target: null,
	pendingNative: null,
	focus: (sessionPath, entryId) => {
		const nonce = ++nextNonce;
		set({ target: { sessionPath, entryId, nonce, requestedAt: Date.now() } });
		return nonce;
	},
	settle: nonce => {
		if (get().target?.nonce === nonce) set({ target: null });
	},
}));
