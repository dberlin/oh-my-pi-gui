import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearFindHighlights,
	FIND_CURRENT_HIGHLIGHT,
	FIND_HIGHLIGHT,
	flattenTextNodes,
	paintFindHighlights,
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

	it("collapses a whitespace run split across adjacent text nodes (e.g. around an empty inline element)", () => {
		// "a " and " b" are separate text nodes straddling the empty <b>, but
		// together they form one logical whitespace run and must collapse to a
		// single space, matching normalizeFindText("a " + "" + " b") === "a b".
		const flat = flattenTextNodes(row("<p>a <b></b> b</p>") as unknown as Node);
		expect(flat.text).toBe("a b");
		expect(flat.nodes).toHaveLength(flat.text.length);
		expect(flat.offsets).toHaveLength(flat.text.length);
	});

	it("trims trailing whitespace as well as leading, matching normalizeFindText's .trim()", () => {
		const flat = flattenTextNodes(row("<p>  hello world  </p>") as unknown as Node);
		expect(flat.text).toBe("hello world");
	});
});

describe("paintFindHighlights", () => {
	it("registers non-current occurrences under omp-find and the current one under omp-find-current", () => {
		const element = row("<p>needle one needle two</p>");
		paintFindHighlights([{ rowElement: element, currentOccurrence: 1 }], "needle");
		expect(registry.get(FIND_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)?.[0]?.startOffset).toBe(11);
	});

	it("paints every DOM occurrence of the needle in a flagged row, not just the ones the index's occurrence count named", () => {
		// The index's occurrenceInRow and this module's DOM occurrence count are
		// only approximate (see the module docblock): a row's index-side text
		// (markdown source, JSON.stringify'd tool args) can diverge from its
		// rendered DOM text. A row the index flagged as a match must still have
		// every DOM occurrence of the needle painted, even when the DOM has more
		// occurrences than the index recorded for that row.
		const element = row("<p>needle needle needle</p>");
		// currentOccurrence deliberately points past the end, simulating a
		// divergence between the index's count and the DOM's — it must not
		// suppress painting the other two occurrences.
		paintFindHighlights([{ rowElement: element, currentOccurrence: 99 }], "needle");
		expect(registry.get(FIND_HIGHLIGHT)).toHaveLength(3);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)).toHaveLength(0);
	});

	it("spans element boundaries", () => {
		const element = row("<p>a nee<em>dle</em> b</p>");
		paintFindHighlights([{ rowElement: element, currentOccurrence: null }], "needle");
		const range = registry.get(FIND_HIGHLIGHT)?.[0];
		expect(range?.startContainer).not.toBe(range?.endContainer);
	});

	it("clears both highlights", () => {
		paintFindHighlights([{ rowElement: row("<p>needle</p>"), currentOccurrence: 0 }], "needle");
		clearFindHighlights();
		expect(registry.size).toBe(0);
	});

	it("degrades to a no-op without CSS.highlights instead of throwing", () => {
		Reflect.deleteProperty(globalThis as Record<string, unknown>, "CSS");
		expect(() =>
			paintFindHighlights([{ rowElement: row("<p>needle</p>"), currentOccurrence: 0 }], "needle"),
		).not.toThrow();
		expect(() => clearFindHighlights()).not.toThrow();
	});
});
