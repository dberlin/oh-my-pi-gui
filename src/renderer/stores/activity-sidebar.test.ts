import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_SIDEBAR_COMPACT_WIDTH,
	ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
	ACTIVITY_SIDEBAR_MAX_WIDTH,
	ACTIVITY_SIDEBAR_MIN_WIDTH,
	ACTIVITY_TRANSCRIPT_MIN_WIDTH,
	ACTIVITY_TREE_MIN_BODY_HEIGHT,
	useActivitySidebarStore,
} from "./activity-sidebar";

const prefsGet = vi.fn<(key: string) => Promise<unknown>>();
const prefsSet = vi.fn<(key: string, value: unknown) => Promise<void>>();

beforeEach(() => {
	prefsGet.mockReset();
	prefsSet.mockReset();
	prefsGet.mockResolvedValue(undefined);
	prefsSet.mockResolvedValue(undefined);
	(globalThis as Record<string, unknown>).window = { omp: { prefs: { get: prefsGet, set: prefsSet } } };
	useActivitySidebarStore.getState().reset();
});

describe("activity sidebar presentation store", () => {
	it("starts from deterministic presentation defaults", () => {
		expect({
			defaultWidth: ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
			minWidth: ACTIVITY_SIDEBAR_MIN_WIDTH,
			maxWidth: ACTIVITY_SIDEBAR_MAX_WIDTH,
			compactWidth: ACTIVITY_SIDEBAR_COMPACT_WIDTH,
			transcriptMinWidth: ACTIVITY_TRANSCRIPT_MIN_WIDTH,
			treeMinBodyHeight: ACTIVITY_TREE_MIN_BODY_HEIGHT,
		}).toEqual({
			defaultWidth: 300,
			minWidth: 240,
			maxWidth: 420,
			compactWidth: 40,
			transcriptMinWidth: 560,
			treeMinBodyHeight: 48,
		});
		expect(useActivitySidebarStore.getState()).toMatchObject({
			width: 300,
			hydrated: false,
			manualCollapsed: false,
			splitRatio: 0.5,
			treeCollapsed: { todo: false, agents: false },
			expandedMeta: null,
			focusRequest: null,
			narrowOverrideTabId: null,
		});
	});

	it("hydrates and clamps the persisted expanded width", async () => {
		prefsGet.mockResolvedValue({ width: 999 });
		await useActivitySidebarStore.getState().hydrate();
		expect(prefsGet).toHaveBeenCalledWith("activity-sidebar-v1");
		expect(useActivitySidebarStore.getState().width).toBe(420);
		expect(useActivitySidebarStore.getState().hydrated).toBe(true);
	});

	it("does not overwrite a committed width when hydration resolves later", async () => {
		const persisted = Promise.withResolvers<unknown>();
		prefsGet.mockReturnValue(persisted.promise);
		const hydration = useActivitySidebarStore.getState().hydrate();
		useActivitySidebarStore.getState().commitWidth(367);
		persisted.resolve({ width: 260 });
		await hydration;
		expect(useActivitySidebarStore.getState()).toMatchObject({ width: 367, hydrated: true });
	});

	it("falls back for a malformed persisted width", async () => {
		prefsGet.mockResolvedValue({ width: "wide" });
		useActivitySidebarStore.setState({ width: 367 });
		await useActivitySidebarStore.getState().hydrate();
		expect(useActivitySidebarStore.getState()).toMatchObject({ width: 300, hydrated: true });
	});

	it("falls back without an unhandled rejection when preference I/O fails", async () => {
		prefsGet.mockRejectedValue(new Error("read failed"));
		await useActivitySidebarStore.getState().hydrate();
		expect(useActivitySidebarStore.getState()).toMatchObject({ width: 300, hydrated: true });
		prefsSet.mockRejectedValue(new Error("write failed"));
		useActivitySidebarStore.getState().commitWidth(367);
		await Promise.resolve();
		expect(useActivitySidebarStore.getState().width).toBe(367);
	});

	it("clamps committed widths at both expanded bounds", () => {
		useActivitySidebarStore.getState().commitWidth(100);
		expect(useActivitySidebarStore.getState().width).toBe(240);
		useActivitySidebarStore.getState().commitWidth(999);
		expect(useActivitySidebarStore.getState().width).toBe(420);
	});

	it("persists only the committed width once per commit", () => {
		useActivitySidebarStore.getState().commitWidth(367);
		expect(useActivitySidebarStore.getState().width).toBe(367);
		expect(prefsSet).toHaveBeenCalledTimes(1);
		expect(prefsSet).toHaveBeenCalledWith("activity-sidebar-v1", { width: 367 });
	});

	it("clamps and restores the in-memory tree split without writing preferences", () => {
		useActivitySidebarStore.getState().setSplitRatio(-1);
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0);
		useActivitySidebarStore.getState().setSplitRatio(2);
		expect(useActivitySidebarStore.getState().splitRatio).toBe(1);
		useActivitySidebarStore.getState().resetSplitRatio();
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0.5);
		expect(prefsSet).not.toHaveBeenCalled();
	});

	it("toggles each tree section collapse independently", () => {
		useActivitySidebarStore.getState().toggleTree("todo");
		expect(useActivitySidebarStore.getState().treeCollapsed).toEqual({ todo: true, agents: false });
		useActivitySidebarStore.getState().toggleTree("agents");
		expect(useActivitySidebarStore.getState().treeCollapsed).toEqual({ todo: true, agents: true });
	});

	it("keeps Plan and Goal disclosure mutually exclusive", () => {
		useActivitySidebarStore.getState().toggleMeta("plan");
		useActivitySidebarStore.getState().toggleMeta("goal");
		expect(useActivitySidebarStore.getState().expandedMeta).toBe("goal");
		useActivitySidebarStore.getState().toggleMeta("goal");
		expect(useActivitySidebarStore.getState().expandedMeta).toBeNull();
	});

	it("reveals a collapsed section and establishes the active-tab override", () => {
		useActivitySidebarStore.setState({ manualCollapsed: true, treeCollapsed: { todo: true, agents: false } });
		useActivitySidebarStore.getState().revealSection("todo", "tab-a");
		expect(useActivitySidebarStore.getState()).toMatchObject({
			manualCollapsed: false,
			treeCollapsed: { todo: false, agents: false },
			focusRequest: { id: "todo", seq: 1 },
			narrowOverrideTabId: "tab-a",
		});
	});

	it("reveals metadata mutually and increments focus requests", () => {
		useActivitySidebarStore.getState().revealSection("plan", "tab-a");
		useActivitySidebarStore.getState().revealSection("goal", "tab-a");
		expect(useActivitySidebarStore.getState()).toMatchObject({
			expandedMeta: "goal",
			focusRequest: { id: "goal", seq: 2 },
			narrowOverrideTabId: "tab-a",
		});
	});

	it("can reveal the sidebar without replacing the current focus request", () => {
		useActivitySidebarStore.getState().revealSection("agents", "tab-a");
		useActivitySidebarStore.getState().setManualCollapsed(true);
		useActivitySidebarStore.getState().revealSection(null, "tab-a");
		expect(useActivitySidebarStore.getState()).toMatchObject({
			manualCollapsed: false,
			focusRequest: { id: "agents", seq: 1 },
			narrowOverrideTabId: "tab-a",
		});
	});

	it("clears the narrow override on collapse or tab change", () => {
		useActivitySidebarStore.getState().revealSection("agents", "tab-a");
		useActivitySidebarStore.getState().clearNarrowOverride("tab-a");
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBe("tab-a");
		useActivitySidebarStore.getState().setManualCollapsed(true);
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
		useActivitySidebarStore.getState().revealSection("agents", "tab-a");
		useActivitySidebarStore.getState().clearNarrowOverride("tab-b");
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
	});

	it("reset restores defaults without writing preferences", async () => {
		prefsGet.mockResolvedValue({ width: 367 });
		await useActivitySidebarStore.getState().hydrate();
		useActivitySidebarStore.getState().setManualCollapsed(true);
		useActivitySidebarStore.getState().setSplitRatio(0.8);
		useActivitySidebarStore.getState().toggleTree("todo");
		useActivitySidebarStore.getState().toggleMeta("plan");
		prefsSet.mockClear();
		useActivitySidebarStore.getState().reset();
		expect(useActivitySidebarStore.getState()).toMatchObject({
			width: 300,
			hydrated: false,
			manualCollapsed: false,
			splitRatio: 0.5,
			treeCollapsed: { todo: false, agents: false },
			expandedMeta: null,
			focusRequest: null,
			narrowOverrideTabId: null,
		});
		expect(prefsSet).not.toHaveBeenCalled();
	});
});
