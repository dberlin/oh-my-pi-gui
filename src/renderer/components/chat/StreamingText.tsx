import { STREAM_FORMAT_FLUSH_MS, useThrottledText } from "../../hooks/use-throttled-text";
import { MarkdownRenderer } from "../../lib/markdown";
import { useMessagesStore } from "../../stores/messages";

/**
 * Live tail of the assistant's in-flight reply. The store accumulates
 * text_delta events into `streamingText` (RAF-batched upstream); the blinking
 * cursor is pure CSS. Markdown re-parses are throttled to STREAM_FLUSH_MS so
 * a 16ms token batch doesn't trigger a full re-parse each frame. Unmounts
 * when message_end finalizes the message and ChatStream renders the
 * completed MessageBubble instead.
 */
export function StreamingText() {
	const streamingText = useMessagesStore(s => s.streamingText);
	const throttledText = useThrottledText(streamingText, STREAM_FORMAT_FLUSH_MS);
	if (!streamingText) return null;
	// Geometry matches the finalized MessageBubble (StreamingRows already pads
	// px-6; no inner max-width) so the reply doesn't jump when it finalizes.
	// The caret is a sibling of the markdown output; components.css pulls the
	// wrapper + trailing paragraph inline so the caret stays on the last text
	// line instead of wrapping below the final block.
	return (
		<div className="omp-streaming">
			<MarkdownRenderer content={throttledText} />
			<span aria-hidden className="omp-caret" />
		</div>
	);
}
