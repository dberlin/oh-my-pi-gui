/**
 * Paints ⌘F matches onto mounted rows using the CSS Custom Highlight API
 * (`CSS.highlights`). This module is the only DOM-touching half of transcript
 * find — `transcript-find.ts` stays pure and indexes the row model, this
 * module re-derives the same normalized text from the live DOM (via
 * `flattenTextNodes`) so a model offset lands on the right characters.
 *
 * TypeScript 7's bundled DOM lib does not reliably declare `Highlight` /
 * `CSS.highlights` (see plan Open Question 8), so this module declares a
 * local structural view of the API (`HighlightRegistryLike`, `HighlightCtor`)
 * instead of widening tsconfig or adding an ambient global .d.ts.
 */

export const FIND_HIGHLIGHT = "omp-find";
export const FIND_CURRENT_HIGHLIGHT = "omp-find-current";

/** One mounted row and which of its occurrences to paint. */
export interface FindHighlightTarget {
	rowElement: Element;
	/** Occurrence indices within the row (ascending) that this needle produced. */
	occurrences: readonly number[];
	/** The occurrence index that is the current match, or null. */
	currentOccurrence: number | null;
}

interface HighlightRegistryLike {
	set: (name: string, highlight: object) => void;
	delete: (name: string) => void;
}
type HighlightCtor = new (...ranges: Range[]) => object;

function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightCtor } | null {
	try {
		const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
		const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
		if (!css?.highlights || typeof ctor !== "function") return null;
		return { registry: css.highlights, Highlight: ctor };
	} catch {
		return null;
	}
}

/** True when this renderer implements the CSS Custom Highlight API. */
export function supportsFindHighlight(): boolean {
	try {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
	} catch {
		return false;
	}
}

const WHITESPACE_RUN = /\s+/g;

/**
 * Flatten a subtree's text nodes into one whitespace-normalized lowercase
 * string plus a per-character (node, offset) source map — the same
 * normalization `normalizeFindText` applies, so model offsets and DOM offsets
 * agree.
 */
export function flattenTextNodes(root: Node): { text: string; nodes: Text[]; offsets: number[] } {
	const nodes: Text[] = [];
	const offsets: number[] = [];
	let text = "";

	function visit(node: Node): void {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			const data = (node as Text).data;
			WHITESPACE_RUN.lastIndex = 0;
			let cursor = 0;
			while (cursor < data.length) {
				WHITESPACE_RUN.lastIndex = cursor;
				const match = WHITESPACE_RUN.exec(data);
				if (match && match.index === cursor) {
					// Whole run collapses to one space, mapped to the run's first character.
					text += " ";
					nodes.push(node as Text);
					offsets.push(cursor);
					cursor += match[0].length;
				} else {
					text += data[cursor]?.toLowerCase();
					nodes.push(node as Text);
					offsets.push(cursor);
					cursor += 1;
				}
			}
			return;
		}
		const children = node.childNodes;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child) visit(child);
		}
	}

	visit(root);

	// Leading whitespace of the whole flattened string is dropped so the
	// result equals normalizeFindText of the concatenation.
	let start = 0;
	while (start < text.length && text[start] === " ") start++;
	if (start > 0) {
		text = text.slice(start);
		nodes.splice(0, start);
		offsets.splice(0, start);
	}

	return { text, nodes, offsets };
}

function rangeFor(flat: { text: string; nodes: Text[]; offsets: number[] }, start: number, end: number): Range | null {
	const startNode = flat.nodes[start];
	const endNode = flat.nodes[end - 1];
	if (!startNode || !endNode) return null;
	const range = document.createRange();
	range.setStart(startNode, flat.offsets[start] ?? 0);
	range.setEnd(endNode, (flat.offsets[end - 1] ?? 0) + 1);
	return range;
}

/** Replace both named highlights with ranges for the given targets. No-op without CSS.highlights. */
export function paintFindHighlights(targets: readonly FindHighlightTarget[], needle: string): void {
	const api = highlightApi();
	if (!api || !needle) return;
	const plain: Range[] = [];
	const current: Range[] = [];
	for (const target of targets) {
		const flat = flattenTextNodes(target.rowElement);
		const wanted = new Set(target.occurrences);
		let occurrence = 0;
		let at = flat.text.indexOf(needle);
		while (at !== -1) {
			if (wanted.has(occurrence)) {
				const range = rangeFor(flat, at, at + needle.length);
				if (range) (occurrence === target.currentOccurrence ? current : plain).push(range);
			}
			occurrence++;
			at = flat.text.indexOf(needle, at + needle.length);
		}
	}
	api.registry.set(FIND_HIGHLIGHT, new api.Highlight(...plain));
	api.registry.set(FIND_CURRENT_HIGHLIGHT, new api.Highlight(...current));
}

/** Remove both named highlights. Safe to call unconditionally. */
export function clearFindHighlights(): void {
	const api = highlightApi();
	if (!api) return;
	api.registry.delete(FIND_HIGHLIGHT);
	api.registry.delete(FIND_CURRENT_HIGHLIGHT);
}
