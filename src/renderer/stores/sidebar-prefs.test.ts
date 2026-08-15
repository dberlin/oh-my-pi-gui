/**
 * sidebar-prefs store contract: pin toggles, MRU access times, workspace
 * aliases, persistence payloads, and hydrate-from-blob.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarPrefs } from "./sidebar-prefs";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	get.mockClear();
	set.mockClear();
	useSidebarPrefs.getState().reset();
});

describe("sidebar-prefs store", () => {
	it("toggles group and session pins, persisting each change", () => {
		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/a"]);
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: ["/work/a"] }));

		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: [] }));

		useSidebarPrefs.getState().toggleSessionPin("/s/one.jsonl");
		useSidebarPrefs.getState().toggleSessionPin("/s/two.jsonl");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/one.jsonl", "/s/two.jsonl"]);
	});

	it("sets and clears workspace aliases, dropping empty values", () => {
		useSidebarPrefs.getState().setGroupAlias("/work/a", "  Frontend  ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ groupAliases: { "/work/a": "Frontend" } }));

		useSidebarPrefs.getState().setGroupAlias("/work/a", null);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});

		useSidebarPrefs.getState().setGroupAlias("/work/a", "   ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});
	});

	it("touches sessions and workspaces with one monotonic persisted MRU clock", () => {
		useSidebarPrefs.setState({
			workspaceLastUsed: { "/work/old": 20 },
			sessionLastUsed: { "/sessions/old.jsonl": 30 },
		});

		useSidebarPrefs.getState().touchSession("/sessions/new.jsonl", "/work/new");
		const sessionTimestamp = useSidebarPrefs.getState().sessionLastUsed["/sessions/new.jsonl"];
		expect(sessionTimestamp).toBeGreaterThan(30);
		expect(useSidebarPrefs.getState().workspaceLastUsed["/work/new"]).toBe(sessionTimestamp);
		expect(set).toHaveBeenLastCalledWith(
			"sidebar",
			expect.objectContaining({
				sessionLastUsed: expect.objectContaining({ "/sessions/new.jsonl": sessionTimestamp }),
				workspaceLastUsed: expect.objectContaining({ "/work/new": sessionTimestamp }),
			}),
		);

		useSidebarPrefs.getState().touchWorkspace("/work/old");
		expect(useSidebarPrefs.getState().workspaceLastUsed["/work/old"]).toBeGreaterThan(sessionTimestamp ?? 0);
	});

	it("hydrates from the persisted blob once and tolerates missing prefs", async () => {
		get.mockResolvedValueOnce({
			pinnedGroups: ["/work/pinned"],
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			workspaceLastUsed: { "/work/a": 100, bad: "yesterday" },
			sessionLastUsed: { "/s/p.jsonl": 200, bad: -1 },
		});
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/pinned"]);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Alias" });
		expect(useSidebarPrefs.getState().workspaceLastUsed).toEqual({ "/work/a": 100 });
		expect(useSidebarPrefs.getState().sessionLastUsed).toEqual({ "/s/p.jsonl": 200 });

		// Second hydrate is a no-op (already hydrated).
		const calls = get.mock.calls.length;
		await useSidebarPrefs.getState().hydrate();
		expect(get.mock.calls.length).toBe(calls);

		// Unreadable prefs degrade to empty defaults, never a throw.
		useSidebarPrefs.getState().reset();
		get.mockRejectedValueOnce(new Error("io"));
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
	});
});
