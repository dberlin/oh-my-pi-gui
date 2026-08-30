/**
 * Paints ⌘F matches onto mounted rows using the CSS Custom Highlight API
 * (`CSS.highlights`). This module is the only DOM-touching half of transcript
 * find — `transcript-find.ts` stays pure and indexes the row model.
 *
 * The index's per-match `occurrenceInRow` and this module's DOM occurrence
 * count are only *approximately* the same quantity: `transcript-find.ts`
 * counts over markdown source, `JSON.stringify`'d tool arguments, and text
 * behind still-collapsed sibling disclosures, while this module counts over
 * the flattened text of the whole mounted row (rendered markdown, formatted
 * tool arguments, row chrome). The two can diverge within a row, shifting
 * every later occurrence index. Rather than trust that mapping to select
 * *which* DOM occurrences to paint, this module paints every DOM occurrence
 * of the needle in a row the index has already flagged as containing a
 * match — strictly more robust, and it matches what a user expects of a
 * highlighted row. The occurrence index is used only as a best-effort guess
 * for which occurrence gets the "current match" emphasis.
 *
 * TypeScript 7's bundled DOM lib does not reliably declare `Highlight` /
 * `CSS.highlights`, so this module declares a local structural view of the
 * API (`HighlightRegistryLike`, `HighlightCtor`) instead of widening
 * tsconfig or adding an ambient global .d.ts.
 */

export const FIND_HIGHLIGHT = "omp-find";
export const FIND_CURRENT_HIGHLIGHT = "omp-find-current";

/** One mounted row the index flagged as containing a match. */
export interface FindHighlightTarget {
	rowElement: Element;
	/**
	 * Best-effort DOM occurrence index of the current match (from the index's
	 * `occurrenceInRow`). Approximate — see the module docblock — so it only
	 * decides which occurrence gets the current-match emphasis; every DOM
	 * occurrence of the needle in this row is still painted as a plain match.
	 */
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

const WHITESPACE = /\s/;

/**
 * Flatten a subtree's text nodes into one whitespace-normalized lowercase
 * string plus a per-character (node, offset) source map — the same
 * normalization `normalizeFindText` applies, so model offsets and DOM offsets
 * agree.
 *
 * Whitespace is collapsed across the whole flattened stream, not per text
 * node: two text nodes that each contribute part of one logical run of
 * whitespace (e.g. adjacent to an empty inline element) must still collapse
 * to a single space, the way `normalizeFindText` collapses it in the row's
 * concatenated segment text. `lastWasSpace` carries that collapsing state
 * across node boundaries.
 */
export function flattenTextNodes(root: Node): { text: string; nodes: Text[]; offsets: number[] } {
	const nodes: Text[] = [];
	const offsets: number[] = [];
	let text = "";
	// Starting true means leading whitespace is skipped rather than emitted,
	// mirroring `normalizeFindText`'s leading trim.
	let lastWasSpace = true;

	function visit(node: Node): void {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			const data = (node as Text).data;
			for (let i = 0; i < data.length; i++) {
				const ch = data[i] ?? "";
				if (WHITESPACE.test(ch)) {
					if (!lastWasSpace) {
						text += " ";
						nodes.push(node as Text);
						offsets.push(i);
						lastWasSpace = true;
					}
					// Subsequent whitespace in the run (in this node or a later one)
					// contributes nothing further — the run is already represented.
				} else {
					text += ch.toLowerCase();
					nodes.push(node as Text);
					offsets.push(i);
					lastWasSpace = false;
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

	// Trailing whitespace of the whole flattened string is dropped so the
	// result equals normalizeFindText (which trims both ends) of the
	// concatenation.
	if (lastWasSpace && text.length > 0) {
		text = text.slice(0, -1);
		nodes.pop();
		offsets.pop();
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
		let occurrence = 0;
		let at = flat.text.indexOf(needle);
		while (at !== -1) {
			const range = rangeFor(flat, at, at + needle.length);
			if (range) (occurrence === target.currentOccurrence ? current : plain).push(range);
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
