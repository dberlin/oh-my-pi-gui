import { useLayoutEffect, useMemo, useRef } from "react";
import { STREAM_FORMAT_FLUSH_MS, useThrottledText } from "../../hooks/use-throttled-text";
import { MarkdownRenderer } from "../../lib/markdown";
import { presentStreamingTail, segmentStreamingMarkdown } from "../../lib/streaming-markdown";

/** Slow oversized mutable blocks without delaying ordinary streamed replies. */
const LARGE_TAIL_CHARS = 8_000;
const LARGE_TAIL_FLUSH_MS = 120;

function lastTextElement(root: Element): Element | null {
	let node = root;
	while (true) {
		let next: Element | null = null;
		for (let child = node.lastChild; child; child = child.previousSibling) {
			if (!child.textContent?.trim()) continue;
			// A pseudo-element on the container follows its final text node;
			// descending into an earlier element would put the caret mid-line.
			if (child.nodeType === Node.TEXT_NODE) return node === root ? null : node;
			if (child.nodeType === Node.ELEMENT_NODE) {
				next = child as Element;
				break;
			}
		}
		if (!next || node.classList.contains("katex")) return node === root ? null : node;
		node = next;
	}
}

/** The live Markdown tail consumes only its rendered main/subagent projection. */
export function StreamingText({ text }: { text: string }) {
	const tailLength = useRef(0);
	const displayed = useThrottledText(
		text,
		tailLength.current > LARGE_TAIL_CHARS ? LARGE_TAIL_FLUSH_MS : STREAM_FORMAT_FLUSH_MS,
	);
	const segments = useMemo(() => segmentStreamingMarkdown(displayed), [displayed]);
	const tail = useMemo(() => presentStreamingTail(segments.tail), [segments.tail]);
	const tailRef = useRef<HTMLDivElement>(null);

	// A CSS caret follows the final text-bearing element without injecting source
	// markup or React children into the sanitized Markdown tree.
	useLayoutEffect(() => {
		tailLength.current = segments.tail.length;
		const root = tailRef.current;
		if (!root) return;
		const target = lastTextElement(root);
		for (const marked of root.querySelectorAll("[data-omp-caret]")) {
			if (marked !== target) marked.removeAttribute("data-omp-caret");
		}
		target?.setAttribute("data-omp-caret", "");
	});

	if (!text) return null;

	return (
		<div className="omp-streaming">
			{segments.blocks.map(block => (
				<div className="omp-streaming-block" key={block.end}>
					<MarkdownRenderer content={block.content} />
				</div>
			))}
			<div className="omp-streaming-tail omp-streaming-formatted-tail" ref={tailRef}>
				{tail.markdown && <MarkdownRenderer content={tail.markdown} streaming />}
				{tail.plain && <div className="omp-streaming-plain">{tail.plain}</div>}
				{!tail.markdown && !tail.plain && <span aria-hidden className="omp-caret" />}
			</div>
		</div>
	);
}
