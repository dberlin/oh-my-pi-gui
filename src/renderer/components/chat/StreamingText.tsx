import { useMemo } from "react";
import { STREAM_FORMAT_FLUSH_MS, useStreamingTextFrame } from "../../hooks/use-throttled-text";
import { MarkdownRenderer } from "../../lib/markdown";
import { segmentStreamingMarkdown } from "../../lib/streaming-markdown";

/**
 * Live tail of an assistant projection's in-flight reply. Presentation is
 * aligned to browser frames, then split into immutable Markdown blocks plus a
 * cheap unfinished tail. Completed blocks parse once; the live suffix receives
 * a subtle reveal instead of making the whole growing response re-parse and jump.
 */
export function StreamingText({ text }: { text: string }) {
	const frame = useStreamingTextFrame(text, STREAM_FORMAT_FLUSH_MS);
	const segments = useMemo(() => segmentStreamingMarkdown(frame.text), [frame.text]);
	if (!text) return null;

	const deltaOffset = Math.max(0, Math.min(segments.tail.length, frame.deltaStart - segments.tailStart));
	const settledTail = segments.tail.slice(0, deltaOffset);
	const revealedTail = segments.tail.slice(deltaOffset);

	return (
		<div className="omp-streaming">
			{segments.blocks.map(block => (
				<div className="omp-streaming-block" key={block.end}>
					<MarkdownRenderer content={block.content} />
				</div>
			))}
			<div className="omp-streaming-tail">
				{settledTail}
				{revealedTail ? (
					<span className="omp-streaming-reveal" key={frame.revision}>
						{revealedTail}
					</span>
				) : null}
				<span aria-hidden className="omp-caret" />
			</div>
		</div>
	);
}
