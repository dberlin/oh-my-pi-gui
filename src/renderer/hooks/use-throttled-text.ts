import { useEffect, useRef, useState } from "react";

/** Presentation cadence for growing Markdown/reasoning streams (~25 FPS). */
export const STREAM_FORMAT_FLUSH_MS = 40;

export interface StreamingTextFrame {
	text: string;
	/** Source offset where this frame's newly revealed suffix begins. */
	deltaStart: number;
	/** Increments only when visible text advances; useful for one-shot CSS motion. */
	revision: number;
}

function requestPresentationFrame(callback: FrameRequestCallback): number {
	if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
	return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelPresentationFrame(handle: number): void {
	if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
	else window.clearTimeout(handle);
}

/**
 * Align a fast-growing stream to browser paint frames. Incoming IPC batches may
 * arrive more frequently than the display should commit; this coalesces them
 * to the latest prefix at `intervalMs` cadence without adding timer drift.
 */
export function useStreamingTextFrame(text: string, intervalMs: number): StreamingTextFrame {
	const [frame, setFrame] = useState<StreamingTextFrame>({ text, deltaStart: 0, revision: 0 });
	const latestRef = useRef(text);
	const displayedRef = useRef(text);
	const frameRequestRef = useRef<number | undefined>(undefined);
	const lastCommitRef = useRef(0);

	useEffect(
		() => () => {
			if (frameRequestRef.current !== undefined) cancelPresentationFrame(frameRequestRef.current);
		},
		[],
	);

	useEffect(() => {
		latestRef.current = text;

		// Reset/replacement streams must never reveal a suffix from the old value.
		if (!text.startsWith(displayedRef.current)) {
			if (frameRequestRef.current !== undefined) cancelPresentationFrame(frameRequestRef.current);
			frameRequestRef.current = undefined;
			const previousLength = displayedRef.current.length;
			displayedRef.current = text;
			setFrame(current => ({
				text,
				deltaStart: Math.min(previousLength, text.length),
				revision: current.revision + 1,
			}));
			return;
		}

		if (text === displayedRef.current) return;
		if (intervalMs <= 0) {
			const deltaStart = displayedRef.current.length;
			displayedRef.current = text;
			setFrame(current => ({ text, deltaStart, revision: current.revision + 1 }));
			return;
		}
		if (frameRequestRef.current !== undefined) return;

		const commitOnFrame = (now: number) => {
			const elapsed = now - lastCommitRef.current;
			if (lastCommitRef.current !== 0 && elapsed < intervalMs) {
				frameRequestRef.current = requestPresentationFrame(commitOnFrame);
				return;
			}

			frameRequestRef.current = undefined;
			const latest = latestRef.current;
			if (latest === displayedRef.current) return;
			const deltaStart = latest.startsWith(displayedRef.current) ? displayedRef.current.length : 0;
			displayedRef.current = latest;
			lastCommitRef.current = now;
			setFrame(current => ({ text: latest, deltaStart, revision: current.revision + 1 }));
		};

		frameRequestRef.current = requestPresentationFrame(commitOnFrame);
	}, [text, intervalMs]);

	return frame;
}

/** Text-only convenience for formatted consumers that do not animate a tail. */
export function useThrottledText(text: string, intervalMs: number): string {
	return useStreamingTextFrame(text, intervalMs).text;
}
