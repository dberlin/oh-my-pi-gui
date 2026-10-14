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
const LIST_ITEM_RE = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A lone, possibly-still-growing marker token ("-", "2", "2.") — a list
 * continuation candidate that must not yet end the block. */
const PARTIAL_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)]?)$/;

/** Approximate visual columns of the line's leading whitespace (tab = 4). */
function leadingColumns(line: string): number {
	let columns = 0;
	for (const ch of line) {
		if (ch === " ") columns++;
		else if (ch === "\t") columns += 4 - (columns % 4);
		else break;
	}
	return columns;
}

/** Content column a list continuation must reach, or null when not a list. */
function listContentColumn(line: string): number | null {
	if (!LIST_ITEM_RE.test(line)) return null;
	const marker = line.trimStart().split(/[ \t]/, 1)[0] ?? "";
	return leadingColumns(line) + marker.length + 1;
}

/**
 * Split a growing Markdown stream into immutable blocks and one mutable tail.
 *
 * Blank lines are safe promotion points outside fenced code and display-math
 * blocks. A closed code/math fence is also promoted immediately. Stable blocks
 * can therefore be memoized and parsed exactly once while the unfinished tail
 * is prepared separately for live, sanitized Markdown rendering.
 */
export function segmentStreamingMarkdown(text: string): StreamingMarkdownSegments {
	const blocks: StableMarkdownBlock[] = [];
	let blockStart = 0;
	let offset = 0;
	let fence: FenceState | null = null;
	let displayMath: "$$" | "\\]" | null = null;
	// Blank lines inside a list block are NOT stable boundaries: an indented
	// continuation or a further item still belongs to the same <li>, so
	// promotion defers until a line proves the list ended. Without this,
	// `1. first\n\n   second` rendered `second` outside the list live and
	// jumped at message_end.
	let listColumn: number | null = null;
	let sawFirstLine = false;
	let pendingBoundary: number | null = null;

	const promote = (end: number) => {
		const content = text.slice(blockStart, end);
		if (content.trim().length > 0) blocks.push({ end, content });
		blockStart = end;
		sawFirstLine = false;
		listColumn = null;
		pendingBoundary = null;
	};

	while (offset < text.length) {
		const newline = text.indexOf("\n", offset);
		const hasNewline = newline !== -1;
		const end = hasNewline ? newline + 1 : text.length;
		const line = text.slice(offset, hasNewline ? newline : text.length);
		const trimmed = line.trim();
		let closedFence = false;
		let closedMath = false;

		// A pending list boundary resolves against the FIRST following
		// non-blank line — even when that line opens a fence or math block,
		// which would otherwise swallow the boundary and strand a finished
		// list in the mutable tail for the whole fenced block. The check is
		// partial-line-safe: a bare "2" or "2." may still grow into an item,
		// so it counts as continuing instead of promoting (append-stable).
		if (pendingBoundary !== null && trimmed.length > 0) {
			const continuesList =
				LIST_ITEM_RE.test(line) || PARTIAL_MARKER_RE.test(trimmed) || leadingColumns(line) >= (listColumn ?? 0);
			if (!continuesList) promote(pendingBoundary);
			pendingBoundary = null;
		}

		if (fence) {
			if (closesFence(line, fence)) {
				fence = null;
				closedFence = true;
			}
		} else if (!displayMath) {
			fence = openingFence(line);
		}

		if (!fence && !closedFence) {
			if (displayMath === "$$" && trimmed === "$$") {
				displayMath = null;
				closedMath = true;
			} else if (!displayMath) {
				if (trimmed === "$$") displayMath = "$$";
				else if (trimmed.startsWith("\\[")) displayMath = "\\]";
			}
			// A bracket equation may start/end beside its body. A TeX row break
			// (`\\`) before `]` is content, not a closing delimiter.
			if (displayMath === "\\]" && /(?:^|[^\\])(?:\\\\)*\\\]$/.test(trimmed)) {
				displayMath = null;
				closedMath = true;
			}
		}

		if (hasNewline && !fence && !displayMath && (closedFence || (closedMath && listColumn === null))) {
			promote(end);
		} else if (!fence && !displayMath && !closedFence && !closedMath) {
			if (trimmed.length === 0) {
				if (hasNewline) {
					if (listColumn !== null) {
						if (pendingBoundary === null) pendingBoundary = end;
					} else {
						promote(end);
					}
				}
			} else if (hasNewline && !sawFirstLine) {
				// Classify list-ness only from complete lines — a partial first
				// line ("1.") would freeze a wrong non-list verdict.
				sawFirstLine = true;
				listColumn = listContentColumn(line);
			}
		}

		offset = end;
	}

	return {
		blocks,
		tail: text.slice(blockStart),
		tailStart: blockStart,
	};
}

export interface StreamingTailPresentation {
	markdown: string;
	/** Incomplete display math stays literal until its closing delimiter arrives. */
	plain: string;
}

const UNSETTLED_LINE_RE = /^[ \t]{0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]?|-+|=+|>)[ \t]*$/;

/** Mask code with equal-length filler and retain the exact unfinished delimiter. */
function maskInlineCode(text: string): { masked: string; openMarker: string } {
	let masked = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] === "\\") {
			masked += text.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (text[index] !== "`") {
			masked += text[index];
			index++;
			continue;
		}
		let length = 1;
		while (text[index + length] === "`") length++;
		const marker = "`".repeat(length);
		let close = index + length;
		while (close < text.length) {
			close = text.indexOf("`", close);
			if (close === -1) break;
			let closingLength = 1;
			while (text[close + closingLength] === "`") closingLength++;
			if (closingLength === length) break;
			close += closingLength;
		}
		if (close === -1 || close >= text.length) {
			return { masked: masked + " ".repeat(text.length - index), openMarker: marker };
		}
		masked += " ".repeat(close + length - index);
		index = close + length;
	}
	return { masked, openMarker: "" };
}

/** Restrict synthetic inline closers to the paragraph/list item still being written. */
function openInlineContextStart(body: string): number {
	const lines = body.split("\n");
	let line = lines.length - 1;
	while (line > 0 && !LIST_ITEM_RE.test(lines[line] ?? "") && (lines[line - 1] ?? "").trim() !== "") line--;
	let offset = 0;
	for (let index = 0; index < line; index++) offset += (lines[index]?.length ?? 0) + 1;
	return offset;
}

function closeInlineMarkup(text: string): string {
	// Inspect masked source so tag/link-looking code is never trimmed. Match
	// offsets still refer to the original source, including code inside labels.
	const masked = maskInlineCode(text).masked;
	const image = /!\[[^\]\n]*\](?:\([^)\n]*)?$/.exec(masked);
	const link = /\[([^\]\n]*)\](?:\([^)\n]*)?$/.exec(masked) ?? /\[([^\]\n]*)$/.exec(masked);
	const tag = /<\/?[A-Za-z][^>\n]*$/.exec(masked);
	const out = image
		? text.slice(0, image.index)
		: link
			? text.slice(0, link.index) + text.slice(link.index + 1, link.index + 1 + (link[1]?.length ?? 0))
			: tag
				? text.slice(0, tag.index)
				: text;
	const trailing = /\s*$/.exec(out)?.[0] ?? "";
	let body = out.slice(0, out.length - trailing.length);
	const contextStart = openInlineContextStart(body);
	let scan = maskInlineCode(body.slice(contextStart));
	// Do not show a just-arrived delimiter before its first content character.
	if (!scan.openMarker && /(?:^|\s)(?:\*{1,3}|_{1,3}|~{1,2})$/.test(scan.masked)) {
		body = body.replace(/(?:\*{1,3}|_{1,3}|~{1,2})$/, "");
		scan = maskInlineCode(body.slice(contextStart));
	}
	if (scan.openMarker) body += scan.openMarker;
	const opens = new Map<string, number>();
	for (let index = 0; index < scan.masked.length; index++) {
		const char = scan.masked[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (char !== "*" && char !== "_" && char !== "~") continue;
		const paired = scan.masked[index + 1] === char;
		if (char === "~" && !paired) continue;
		const marker = paired ? `${char}${char}` : char;
		const previous = scan.masked[index - 1] ?? "";
		const next = scan.masked[index + marker.length] ?? "";
		const canOpen = next !== "" && !/\s/.test(next) && (char !== "_" || !/\w/.test(previous));
		const canClose = previous !== "" && !/\s/.test(previous) && (char !== "_" || !/\w/.test(next));
		if (opens.has(marker) && canClose) opens.delete(marker);
		else if (canOpen) opens.set(marker, index);
		index += marker.length - 1;
	}
	const closers = [...opens].sort((left, right) => right[1] - left[1]).map(([marker]) => marker);
	return `${body}${closers.join("")}${trailing}`;
}

/**
 * Render the live block in its final shape without changing the source stream.
 * Synthetic fence/inline closers are display-only; raw HTML still passes through
 * MarkdownRenderer's existing sanitizer. Half-written block markers are held
 * back so an unfinished list item cannot briefly become a heading or rule.
 */
export function presentStreamingTail(tail: string): StreamingTailPresentation {
	if (!tail) return { markdown: "", plain: "" };
	const lines = tail.split("\n");
	let fence: FenceState | null = null;
	let sawFence = false;
	let mathStart = -1;
	let displayMath: "$$" | "\\]" | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		if (fence) {
			if (closesFence(line, fence)) fence = null;
			continue;
		}
		if (!displayMath) {
			const opened = openingFence(line);
			if (opened) {
				fence = opened;
				sawFence = true;
				continue;
			}
			if (trimmed === "$$") {
				displayMath = "$$";
				mathStart = index;
			} else if (trimmed.startsWith("\\[")) {
				displayMath = "\\]";
				mathStart = index;
			}
			if (displayMath === "\\]" && /(?:^|[^\\])(?:\\\\)*\\\]$/.test(trimmed)) displayMath = null;
		} else if (
			(displayMath === "$$" && trimmed === "$$") ||
			(displayMath === "\\]" && /(?:^|[^\\])(?:\\\\)*\\\]$/.test(trimmed))
		) {
			displayMath = null;
		}
	}
	if (fence) {
		const separator = tail.endsWith("\n") ? "" : "\n";
		return { markdown: `${tail}${separator}${fence.marker.repeat(fence.length)}`, plain: "" };
	}
	if (displayMath) {
		return { markdown: lines.slice(0, mathStart).join("\n"), plain: lines.slice(mathStart).join("\n") };
	}
	const end = UNSETTLED_LINE_RE.test(lines[lines.length - 1] ?? "") ? lines.length - 1 : lines.length;
	const kept = lines.slice(0, end).join("\n");
	return { markdown: sawFence ? kept : closeInlineMarkup(kept), plain: "" };
}
