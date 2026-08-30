import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearFindHighlights,
	FIND_CURRENT_HIGHLIGHT,
	FIND_HIGHLIGHT,
	flattenTextNodes,
	paintFindHighlights,
	supportsFindHighlight,
} from "./transcript-find-highlight";

const { document } = parseHTML("<html><body></body></html>");

interface FakeRange {
	startContainer: unknown;
	startOffset: number;
	endContainer: unknown;
	endOffset: number;
	setStart: (node: unknown, offset: number) => void;
	setEnd: (node: unknown, offset: number) => void;
}

const registry = new Map<string, FakeRange[]>();

function installHighlightApi(): void {
	(document as unknown as { createRange: () => FakeRange }).createRange = () => {
		const range: FakeRange = {
			startContainer: null,
			startOffset: 0,
			endContainer: null,
			endOffset: 0,
			setStart(node, offset) {
				range.startContainer = node;
				range.startOffset = offset;
			},
			setEnd(node, offset) {
				range.endContainer = node;
				range.endOffset = offset;
			},
		};
		return range;
	};
	Object.assign(globalThis as Record<string, unknown>, {
		document,
		Highlight: class {
			ranges: FakeRange[];
			constructor(...ranges: FakeRange[]) {
				this.ranges = ranges;
			}
		},
		CSS: {
			highlights: {
				set: (name: string, highlight: { ranges: FakeRange[] }) => registry.set(name, highlight.ranges),
				delete: (name: string) => registry.delete(name),
			},
		},
	});
}

beforeEach(() => {
	registry.clear();
	installHighlightApi();
});

afterEach(() => {
	Reflect.deleteProperty(globalThis as Record<string, unknown>, "CSS");
	Reflect.deleteProperty(globalThis as Record<string, unknown>, "Highlight");
});

function row(html: string): Element {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el as unknown as Element;
}

describe("flattenTextNodes", () => {
	it("joins nested text nodes with the same normalization the index uses", () => {
		const flat = flattenTextNodes(row("<p>The  <strong>NEEDLE</strong>\n is here</p>") as unknown as Node);
		expect(flat.text).toBe("the needle is here");
		expect(flat.nodes).toHaveLength(flat.text.length);
		expect(flat.offsets).toHaveLength(flat.text.length);
	});
});

describe("paintFindHighlights", () => {
	it("registers non-current occurrences under omp-find and the current one under omp-find-current", () => {
		const element = row("<p>needle one needle two</p>");
		paintFindHighlights([{ rowElement: element, occurrences: [0, 1], currentOccurrence: 1 }], "needle");
		expect(registry.get(FIND_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)?.[0]?.startOffset).toBe(11);
	});

	it("spans element boundaries", () => {
		const element = row("<p>a nee<em>dle</em> b</p>");
		paintFindHighlights([{ rowElement: element, occurrences: [0], currentOccurrence: null }], "needle");
		const range = registry.get(FIND_HIGHLIGHT)?.[0];
		expect(range?.startContainer).not.toBe(range?.endContainer);
	});

	it("clears both highlights", () => {
		paintFindHighlights([{ rowElement: row("<p>needle</p>"), occurrences: [0], currentOccurrence: 0 }], "needle");
		clearFindHighlights();
		expect(registry.size).toBe(0);
	});

	it("degrades to a no-op without CSS.highlights instead of throwing", () => {
		Reflect.deleteProperty(globalThis as Record<string, unknown>, "CSS");
		expect(supportsFindHighlight()).toBe(false);
		expect(() =>
			paintFindHighlights([{ rowElement: row("<p>needle</p>"), occurrences: [0], currentOccurrence: 0 }], "needle"),
		).not.toThrow();
		expect(() => clearFindHighlights()).not.toThrow();
	});
});
