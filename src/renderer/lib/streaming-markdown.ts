export interface StableMarkdownBlock {
	/** Stable source-end offset; remains unchanged as later text arrives. */
	end: number;
	content: string;
}

export interface StreamingMarkdownSegments {
	blocks: StableMarkdownBlock[];
	tail: string;
	tailStart: number;
}

interface FenceState {
	marker: "`" | "~";
	length: number;
}

function openingFence(line: string): FenceState | null {
	const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
	const fence = match?.[1];
	if (!fence) return null;
	return { marker: fence[0] as "`" | "~", length: fence.length };
}

function closesFence(line: string, fence: FenceState): boolean {
	const candidate = line.replace(/^[ \t]{0,3}/, "");
	let length = 0;
	while (candidate[length] === fence.marker) length++;
	return length >= fence.length && candidate.slice(length).trim().length === 0;
}

/**
 * Split a growing Markdown stream into immutable blocks and one mutable tail.
 *
 * Blank lines are safe promotion points outside fenced code and display-math
 * blocks. A closed code/math fence is also promoted immediately. Stable blocks
 * can therefore be memoized and parsed exactly once while the unfinished tail
 * remains cheap plain text until its structure is complete.
 */
export function segmentStreamingMarkdown(text: string): StreamingMarkdownSegments {
	const blocks: StableMarkdownBlock[] = [];
	let blockStart = 0;
	let offset = 0;
	let fence: FenceState | null = null;
	let displayMath = false;

	const promote = (end: number) => {
		const content = text.slice(blockStart, end);
		if (content.trim().length > 0) blocks.push({ end, content });
		blockStart = end;
	};

	while (offset < text.length) {
		const newline = text.indexOf("\n", offset);
		const hasNewline = newline !== -1;
		const end = hasNewline ? newline + 1 : text.length;
		const line = text.slice(offset, hasNewline ? newline : text.length);
		const trimmed = line.trim();
		let closedFence = false;
		let closedMath = false;

		if (fence) {
			if (closesFence(line, fence)) {
				fence = null;
				closedFence = true;
			}
		} else if (!displayMath) {
			fence = openingFence(line);
		}

		if (!fence && !closedFence && trimmed === "$$") {
			displayMath = !displayMath;
			closedMath = !displayMath;
		}

		if (hasNewline && !fence && !displayMath && (trimmed.length === 0 || closedFence || closedMath)) {
			promote(end);
		}

		offset = end;
	}

	return {
		blocks,
		tail: text.slice(blockStart),
		tailStart: blockStart,
	};
}
