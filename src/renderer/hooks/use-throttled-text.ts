import { useEffect, useRef, useState } from "react";

/** Shared maximum parse cadence for growing Markdown/reasoning streams. */
export const STREAM_FORMAT_FLUSH_MS = 120;

/**
 * Keep a fast-growing stream responsive without repeatedly re-rendering its
 * expensive formatted view. Paragraph boundaries flush immediately because
 * they are stable Markdown parse points; all other updates coalesce to the
 * latest value at `intervalMs` cadence.
 */
export function useThrottledText(text: string, intervalMs: number): string {
	const [displayed, setDisplayed] = useState(text);
	const latestRef = useRef(text);
	const timerRef = useRef<number | undefined>(undefined);

	useEffect(
		() => () => {
			window.clearTimeout(timerRef.current);
		},
		[],
	);

	useEffect(() => {
		latestRef.current = text;
		if (text.endsWith("\n\n")) {
			window.clearTimeout(timerRef.current);
			timerRef.current = undefined;
			setDisplayed(text);
			return;
		}
		if (timerRef.current !== undefined) return;
		timerRef.current = window.setTimeout(() => {
			timerRef.current = undefined;
			setDisplayed(latestRef.current);
		}, intervalMs);
	}, [text, intervalMs]);

	return displayed;
}
