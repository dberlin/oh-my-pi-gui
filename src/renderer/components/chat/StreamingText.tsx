import { useMemo } from "react";
import { STREAM_FORMAT_FLUSH_MS, useStreamingTextFrame } from "../../hooks/use-throttled-text";
import { MarkdownRenderer } from "../../lib/markdown";
import { segmentStreamingMarkdown } from "../../lib/streaming-markdown";

/**
 * Live tail of an assistant projection's in-flight reply. Presentation is
 * aligned to browser frames, then split into immutable Markdown blocks plus a
 * cheap unfinished tail. Completed blocks parse once; the live suffix reveals
 * as a list of append-only chunks so text already on screen keeps its node and
 * only transitions to full opacity instead of being replaced every commit.
 */
export function StreamingText({ text }: { text: string }) {
	const frame = useStreamingTextFrame(text, STREAM_FORMAT_FLUSH_MS);
	const segments = useMemo(() => segmentStreamingMarkdown(frame.text), [frame.text]);
	if (!text) return null;

	const tailEnd = segments.tailStart + segments.tail.length;
	// Reveal boundaries that still fall inside the unfinished tail. Offsets are
	// absolute, so a chunk keeps its identity as the tail grows and as earlier
	// chunks leave for a promoted block.
	const edges = [
		segments.tailStart,
		...frame.frontiers.filter(offset => offset > segments.tailStart && offset < tailEnd),
		tailEnd,
	];

	return (
		<div className="omp-streaming">
			{segments.blocks.map(block => (
				<div className="omp-streaming-block" key={block.end}>
					<MarkdownRenderer content={block.content} />
				</div>
			))}
			<div className="omp-streaming-tail">
				{edges.slice(0, -1).map((start, index) => {
					const end = edges[index + 1];
					if (end === undefined || end <= start) return null;
					return (
						<span
							key={start}
							className={
								index === edges.length - 2 ? "omp-streaming-chunk omp-streaming-reveal" : "omp-streaming-chunk"
							}
						>
							{frame.text.slice(start, end)}
						</span>
					);
				})}
				<span aria-hidden className="omp-caret" />
			</div>
		</div>
	);
}
