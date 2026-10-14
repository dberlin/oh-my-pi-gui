/**
 * Snippets arrive with match markers from the main-process index; the dialog
 * must highlight exactly the matched runs and never print a marker character.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSearchResult } from "../../shared/ipc-types";
import { flattenHits, loadRecentSearches, rememberSearch, snippetParts } from "./conversation-search";

afterEach(() => vi.unstubAllGlobals());

describe("snippetParts", () => {
	it("splits marked matches from the text around them", () => {
		expect(snippetParts("…why \u0001notarize\u0002 and \u0001sign\u0002 fail…")).toEqual([
			{ text: "…why ", match: false },
			{ text: "notarize", match: true },
			{ text: " and ", match: false },
			{ text: "sign", match: true },
			{ text: " fail…", match: false },
		]);
	});

	it("drops unbalanced markers instead of showing them", () => {
		const parts = snippetParts("\u0002cut \u0001open to the end");
		expect(parts).toEqual([
			{ text: "cut ", match: false },
			{ text: "open to the end", match: true },
		]);
		expect(parts.map(part => part.text).join("")).not.toMatch(/[\u0001\u0002]/);
	});
});

describe("conversation search helpers", () => {
	it("preserves session and message order for keyboard selection", () => {
		const result = (path: string, ids: string[]): ConversationSearchResult => ({
			path, sessionId: path, cwd: "/local", title: null, modified: 1000, more: 0,
			hits: ids.map(entryId => ({ entryId, role: "user", snippet: entryId, timestamp: 1000 })),
		});
		expect(flattenHits([result("/one", ["a", "b"]), result("/two", ["c"])]).map(
			item => [item.result.path, item.hit.entryId],
		)).toEqual([["/one", "a"], ["/one", "b"], ["/two", "c"]]);
	});

	it("keeps trimmed recents case-insensitively unique and bounded", () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		const next = rememberSearch(["one", "Two", "three", "four", "five", "six"], " two ");
		expect(next).toEqual(["two", "one", "three", "four", "five", "six"]);
		expect(loadRecentSearches()).toEqual(next);
		expect(rememberSearch(next, "seven")).toEqual(["seven", "two", "one", "three", "four", "five"]);
	});

	it("tolerates corrupt or unavailable recent-search storage", () => {
		vi.stubGlobal("localStorage", { getItem: () => "{broken" });
		expect(loadRecentSearches()).toEqual([]);
		vi.stubGlobal("localStorage", {
			getItem: () => '["real", null, 5]',
			setItem: () => { throw new Error("Storage disabled"); },
		});
		expect(loadRecentSearches()).toEqual(["real"]);
		expect(rememberSearch(["real"], "next")).toEqual(["next", "real"]);
	});
});
