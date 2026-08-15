# Activity Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontal workspace dock with the visually approved right activity sidebar while leaving the composer full-width and preserving existing Main/subagent behavior.

**Architecture:** Introduce a focused Zustand presentation store, extract Todo and Agents into reusable tree bodies, and compose those with compact Plan/Goal sections inside `ActivitySidebar`. `WorkspaceCanvas` owns transcript/rail geometry and responsive collapse; existing domain stores and RPC paths remain authoritative.

**Tech Stack:** React 19, Zustand 5, TypeScript 7, Tailwind 4, Vitest/linkedom, Electron renderer preferences, `@dnd-kit`.

## Global Constraints

- Work only inside `packages/gui`; do not modify the enclosing monorepo or sidecar.
- Add no RPC commands and change no local/SSH wire contracts.
- Preserve `ChatCanvas` as the single Main/subagent transcript surface; separating the context bar must not create a second transcript renderer.
- Preserve shipped agent selection, activation, historical loading, reconnect, and Main restoration semantics.
- Plan and Goal become compact collapsible sidebar rows; Queue becomes a composer chip.
- Todo and Agents remain simultaneously visible, independently scrollable, independently collapsible, and balanced by default.
- Sidebar width is 300px by default, clamps to 240–420px, persists only the last expanded width, and collapses to a 40px launcher when constrained.
- Auto-collapse triggers when the remembered rail width would leave less than 560px for the transcript.
- Remove the agent graph and List/Graph toggle; do not replace them.
- Main-owned Todo/Plan/Goal controls remain read-only while a subagent is viewed; agent navigation and lifecycle controls remain available.
- Every user-visible string must exist in both `src/renderer/locales/en.ts` and `src/renderer/locales/zh.ts` with identical keys.
- Never use `mock.module()`; use imported-module spies or existing store seams.
- Do not source-scan implementation files in tests. Assert rendered behavior and state/RPC effects.
- Do not commit or push unless the user explicitly asks.

---

### Task 1: Activity sidebar presentation store

**Files:**
- Create: `src/renderer/stores/activity-sidebar.ts`
- Create: `src/renderer/stores/activity-sidebar.test.ts`

**Interfaces:**
- Produces constants `ACTIVITY_SIDEBAR_DEFAULT_WIDTH`, `ACTIVITY_SIDEBAR_MIN_WIDTH`, `ACTIVITY_SIDEBAR_MAX_WIDTH`, `ACTIVITY_SIDEBAR_COMPACT_WIDTH`, `ACTIVITY_TRANSCRIPT_MIN_WIDTH`, and `ACTIVITY_TREE_MIN_BODY_HEIGHT`.
- Produces `ActivitySectionId = "plan" | "goal" | "todo" | "agents"` and `ActivityTreeId = "todo" | "agents"`.
- Produces `useActivitySidebarStore` with the exact public state/actions below.
- Persists only `{ width: number }` under `window.omp.prefs` key `activity-sidebar-v1`.

- [ ] **Step 1: Write failing store tests**

Cover defaults, rejected/malformed persisted values, clamping, rejected writes, one-write-per-committed resize, section collapse, mutual Plan/Goal disclosure, section reveal/focus, split restoration, and per-tab narrow override.

```ts
it("hydrates and clamps the persisted expanded width", async () => {
	prefsGet.mockResolvedValue({ width: 999 });
	await useActivitySidebarStore.getState().hydrate();
	expect(useActivitySidebarStore.getState().width).toBe(420);
	expect(useActivitySidebarStore.getState().hydrated).toBe(true);
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

it("persists only the committed width", () => {
	useActivitySidebarStore.getState().commitWidth(367);
	expect(useActivitySidebarStore.getState().width).toBe(367);
	expect(prefsSet).toHaveBeenCalledWith("activity-sidebar-v1", { width: 367 });
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

it("keeps Plan and Goal disclosure mutually exclusive", () => {
	useActivitySidebarStore.getState().toggleMeta("plan");
	useActivitySidebarStore.getState().toggleMeta("goal");
	expect(useActivitySidebarStore.getState().expandedMeta).toBe("goal");
});

it("clears the narrow override on collapse or tab change", () => {
	useActivitySidebarStore.getState().revealSection("agents", "tab-a");
	useActivitySidebarStore.getState().setManualCollapsed(true);
	expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
	useActivitySidebarStore.getState().revealSection("agents", "tab-a");
	useActivitySidebarStore.getState().clearNarrowOverride("tab-b");
	expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bunx vitest run src/renderer/stores/activity-sidebar.test.ts`

Expected: FAIL because `activity-sidebar.ts` does not exist.

- [ ] **Step 3: Implement the store and clamp helpers**

Use this public contract:

```ts
export const ACTIVITY_SIDEBAR_DEFAULT_WIDTH = 300;
export const ACTIVITY_SIDEBAR_MIN_WIDTH = 240;
export const ACTIVITY_SIDEBAR_MAX_WIDTH = 420;
export const ACTIVITY_SIDEBAR_COMPACT_WIDTH = 40;
export const ACTIVITY_TRANSCRIPT_MIN_WIDTH = 560;
export const ACTIVITY_TREE_MIN_BODY_HEIGHT = 48;

export type ActivitySectionId = "plan" | "goal" | "todo" | "agents";
export type ActivityTreeId = "todo" | "agents";

export interface ActivitySidebarStore {
	width: number;
	hydrated: boolean;
	manualCollapsed: boolean;
	splitRatio: number;
	treeCollapsed: Record<ActivityTreeId, boolean>;
	expandedMeta: "plan" | "goal" | null;
	focusRequest: { id: ActivitySectionId; seq: number } | null;
	narrowOverrideTabId: string | null;
	hydrate: () => Promise<void>;
	commitWidth: (width: number) => void;
	setManualCollapsed: (collapsed: boolean) => void;
	setSplitRatio: (ratio: number) => void;
	resetSplitRatio: () => void;
	toggleTree: (id: ActivityTreeId) => void;
	toggleMeta: (id: "plan" | "goal") => void;
	revealSection: (id: ActivitySectionId | null, tabId: string) => void;
	clearNarrowOverride: (activeTabId: string | null) => void;
	reset: () => void;
}
```

`hydrate` catches read failures and always settles with `hydrated: true`; malformed values fall back to 300px. `commitWidth` clamps, updates memory, and catches a rejected fire-and-forget preference write. `setSplitRatio` clamps to `[0, 1]`; the component applies pixel minima because it knows actual height. `revealSection` clears manual collapse, records the tab override, expands a requested tree/meta section, and increments `focusRequest.seq` when `id` is non-null. `setManualCollapsed(true)` clears the override. `reset` restores deterministic in-memory defaults and `hydrated: false` without writing preferences.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `bunx vitest run src/renderer/stores/activity-sidebar.test.ts`

Expected: all store tests pass and preference writes contain only `width`.

---

### Task 2: Shared activity section chrome

**Files:**
- Create: `src/renderer/components/chat/activity/ActivitySection.tsx`
- Create: `src/renderer/components/chat/activity/ActivitySection.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes `ActivitySectionId`, `ActivityTreeId`, and `useActivitySidebarStore` from Task 1.
- Produces `ActivitySection`, the common header/body disclosure used by Plan, Goal, Todo, and Agents.
- Header actions are separate from the disclosure button so lifecycle/action clicks never toggle the section.

```ts
export interface ActivitySectionProps {
	id: ActivitySectionId;
	title: string;
	icon: LucideIcon;
	badge?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}
```

- [ ] **Step 1: Write failing disclosure and focus tests**

```tsx
it("keeps the section header mounted and restores focus when collapsed", async () => {
	await mount(
		<ActivitySection id="todo" icon={ListTodo} title="Todos">
			<button data-body type="button">Inside todos</button>
		</ActivitySection>,
	);
	const disclosure = screen.getByRole("button", { name: "Collapse Todos" });
	container.querySelector<HTMLButtonElement>("[data-body]")!.focus();
	act(() => useActivitySidebarStore.getState().toggleTree("todo"));
	expect(screen.getByRole("region", { name: "Todos" })).not.toBeNull();
	expect(container.querySelector("[data-body]")).toBeNull();
	expect(document.activeElement).toBe(disclosure);
});

it("expands, focuses, and flashes when the section receives a reveal request", async () => {
	useActivitySidebarStore.setState({ treeCollapsed: { todo: true, agents: false } });
	await mount(
		<ActivitySection id="todo" icon={ListTodo} title="Todos">
			<div data-body>body</div>
		</ActivitySection>,
	);
	act(() => useActivitySidebarStore.getState().revealSection("todo", "tab-a"));
	const disclosure = screen.getByRole("button", { name: "Collapse Todos" });
	expect(document.activeElement).toBe(disclosure);
	expect(disclosure.closest('[data-activity-focused="true"]')).not.toBeNull();
	expect(container.querySelector("[data-body]")).not.toBeNull();
});

it("does not toggle when a header action is activated", async () => {
	await mount(
		<ActivitySection actions={<button type="button">Refresh</button>} id="todo" icon={ListTodo} title="Todos">
			<div data-body>body</div>
		</ActivitySection>,
	);
	await click(screen.getByRole("button", { name: "Refresh" }));
	expect(useActivitySidebarStore.getState().treeCollapsed.todo).toBe(false);
});
```

Use the repository’s linkedom harness with `I18nProvider`, deterministic fake timers for the focus flash, and store reset in `afterEach`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bunx vitest run src/renderer/components/chat/activity/ActivitySection.test.tsx`

Expected: FAIL because `ActivitySection` does not exist.

- [ ] **Step 3: Implement accessible disclosure chrome**

- Use `section` with `aria-label={title}` and a full-width disclosure button with `aria-expanded`.
- Read Plan/Goal collapse from `expandedMeta` and Todo/Agents collapse from `treeCollapsed`.
- Route toggles through `toggleMeta` or `toggleTree`; do not duplicate collapse state locally.
- Watch only the matching `focusRequest.seq`; expand/focus the header and show the existing accent-ring behavior for 1200ms.
- When a body loses visibility while focus is inside it, move focus to the disclosure button before unmounting the body.
- Render `actions` outside the disclosure button.
- Add these exact locale keys to both locale files:

```ts
"activitySidebar.collapseSection": "Collapse {section}",
"activitySidebar.expandSection": "Expand {section}",
```

Chinese values:

```ts
"activitySidebar.collapseSection": "折叠{section}",
"activitySidebar.expandSection": "展开{section}",
```

- [ ] **Step 4: Run focused tests and locale parity**

Run: `bunx vitest run src/renderer/components/chat/activity/ActivitySection.test.tsx src/renderer/locales/locales.test.ts`

Expected: both files pass.

---

### Task 3: Extract the full Todo tree with read-only mode

**Files:**
- Create: `src/renderer/components/chat/activity/TodoTree.tsx`
- Create: `src/renderer/components/chat/activity/TodoTree.test.tsx`
- Modify: `src/renderer/components/chat/dock/TodoDockCard.tsx`
- Modify: `src/renderer/components/chat/dock/TodoDockCard.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Produces `TodoTree({ readOnly }: { readOnly: boolean })`.
- Todo hierarchy and mutations continue to consume `useTodoStore` and `window.omp.rpc.setTodos`.
- `TodoDockCard` temporarily becomes a thin old-layout wrapper around `TodoTree`; Task 6 deletes it after the new sidebar is mounted.

- [ ] **Step 1: Write failing extraction and read-only tests**

Move the observable Todo contracts from `TodoDockCard.test.tsx` to `TodoTree.test.tsx`, then add:

```tsx
it("renders a stable empty tree body", async () => {
	await mount(<TodoTree readOnly={false} />);
	expect(screen.getByText("No todos")).not.toBeNull();
});

it("keeps Main todos visible but removes every mutation path when read-only", async () => {
	useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
	await mount(<TodoTree readOnly />);
	expect(screen.getByText("one")).not.toBeNull();
	expect(screen.queryByRole("button", { name: /status/i })).toBeNull();
	expect(screen.queryByRole("button", { name: /reorder/i })).toBeNull();
	expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
	await doubleClick(screen.getByText("one"));
	expect(container.querySelector("input")).toBeNull();
	expect(setTodos).not.toHaveBeenCalled();
});

it("restores status, edit, and drag mutations on Main", async () => {
	useTodoStore.getState().setPhases([phase("Build", [task("one", "pending"), task("two", "pending")])]);
	await mount(<TodoTree readOnly={false} />);
	await click(screen.getByRole("button", { name: /status/i }));
	expect(setTodos).toHaveBeenCalledWith([
		{ name: "Build", tasks: [{ content: "one", status: "in_progress" }, { content: "two", status: "pending" }] },
	]);
});

it("preserves tree semantics and blocks keyboard mutation while read-only", async () => {
	useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
	await mount(<TodoTree readOnly />);
	const tree = screen.getByRole("tree", { name: "Todos" });
	const row = within(tree).getByRole("treeitem", { name: /one/ });
	expect(row.getAttribute("aria-level")).toBe("2");
	await keyDown(row, { key: " " });
	expect(setTodos).not.toHaveBeenCalled();
});

it("uses roving focus and navigates visible phase/task rows", async () => {
	useTodoStore.getState().setPhases([
		phase("Build", [task("one", "pending"), task("two", "pending")]),
		phase("Ship", [task("three", "pending")]),
	]);
	await mount(<TodoTree readOnly={false} />);
	const items = screen.getAllByRole("treeitem");
	expect(items.filter(item => item.tabIndex === 0)).toHaveLength(1);
	items[0]!.focus();
	await keyDown(items[0]!, { key: "ArrowDown" });
	expect(document.activeElement?.textContent).toContain("one");
	await keyDown(document.activeElement!, { key: "End" });
	expect(document.activeElement?.textContent).toContain("three");
	await keyDown(document.activeElement!, { key: "Home" });
	await keyDown(document.activeElement!, { key: "ArrowLeft" });
	expect(items[0]!.getAttribute("aria-expanded")).toBe("false");
	await keyDown(items[0]!, { key: "ArrowRight" });
	expect(items[0]!.getAttribute("aria-expanded")).toBe("true");
});
```

- [ ] **Step 2: Run Todo tests and confirm RED**

Run: `bunx vitest run src/renderer/components/chat/activity/TodoTree.test.tsx`

Expected: FAIL because `TodoTree` does not exist.

- [ ] **Step 3: Extract without the dock summary path**

- Move `pushTodos`, `SortableTaskRow`, `PhaseSection`, phase collapse, DnD sensors, task patching, reminder rendering, and task counts into `TodoTree.tsx`.
- Always render every phase; remove `buildTodoDockSummary`, `showFull`, `focusedCard`, and “View all todos” behavior from the extracted tree.
- In read-only mode, render status icons as non-button spans; omit drag handles, edit buttons, dismiss-reminder mutation, DnD listeners, double-click editing, mutation keyboard shortcuts, and every call to `pushTodos`.
- Render the phases as one `role="tree"`; phase/task rows use `role="treeitem"`, correct `aria-level`, and phase `aria-expanded`. Use roving `tabIndex`: ArrowUp/Down traverse visible rows, Home/End jump, Right expands a phase or moves to its first child, and Left collapses a phase or moves a task to its parent. Keep phase disclosure available in read-only mode because it is presentation-only; mutation keys remain disabled there.
- Render a stable empty body with new key `activitySidebar.todo.empty`.
- Keep `TodoDockCard` compiling by rendering `<TodoTree readOnly={false} />` inside its existing `DockCard` until Task 6.
- Add locale values:

```ts
// en.ts
"activitySidebar.todo.empty": "No todos",
// zh.ts
"activitySidebar.todo.empty": "暂无待办",
```

- [ ] **Step 4: Run Todo and locale tests**

Run: `bunx vitest run src/renderer/components/chat/activity/TodoTree.test.tsx src/renderer/components/chat/dock/TodoDockCard.test.tsx src/renderer/locales/locales.test.ts`

Expected: Todo mutations, read-only behavior, empty state, reminders, phase collapse, and locale parity pass.

---

### Task 4: Extract the Agents tree and remove the graph

**Files:**
- Create: `src/renderer/components/chat/activity/AgentTree.tsx`
- Create: `src/renderer/components/chat/activity/AgentTree.test.tsx`
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.tsx`
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.test.tsx`
- Modify: `src/renderer/components/panels/PanelsCrashRepro.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`
- Delete: `src/renderer/components/panels/SubagentDag.tsx`
- Delete: `src/renderer/components/panels/SubagentDag.test.tsx`
- Delete: `src/renderer/components/panels/subagent-graph.ts`
- Delete: `src/renderer/components/panels/subagent-graph.test.ts`

**Interfaces:**
- Produces `AgentTree({ pollMs? }: { pollMs?: number })`.
- Preserves the shipped synthetic Main root, single-click selection, double-click/Enter activation, route-readiness guard, lifecycle RPCs, live elapsed-time updates, streaming poll, hierarchy derivation, and active-target synchronization.
- Removes `PanelView`, `ViewToggle`, graph imports, summary truncation, and “View all agents”.

- [ ] **Step 1: Write failing list-only tests**

Move list behavior from `AgentsDockCard.test.tsx` to `AgentTree.test.tsx` and assert the approved surface:

```tsx
it("renders Main even when no subagent exists", async () => {
	await mount(<AgentTree />);
	const rows = screen.getAllByRole("treeitem");
	expect(rows).toHaveLength(1);
	expect(rows[0]?.textContent).toContain("Main");
});

it("renders the complete hierarchy without a summary cutoff", async () => {
	useSubagentsStore.getState().setSnapshots(Array.from({ length: 12 }, (_, index) => snap({ id: `a${index}`, index })));
	await mount(<AgentTree />);
	expect(screen.getAllByRole("treeitem")).toHaveLength(13);
	expect(screen.queryByRole("button", { name: /graph/i })).toBeNull();
	expect(screen.queryByText(/view all/i)).toBeNull();
});

it("selects without activation and activates on Enter", async () => {
	useSubagentsStore.getState().setSnapshots([snap({ id: "child", index: 0 })]);
	await mount(<AgentTree />);
	const child = screen.getAllByRole("treeitem")[1]!;
	await click(child);
	expect(selectSubagent).not.toHaveBeenCalled();
	await keyDown(child, { key: "Enter" });
	expect(selectSubagent).toHaveBeenCalledWith(expect.objectContaining({ id: "child" }));
});

it("retains focused row identity across refresh and falls back focus to Main when it disappears", async () => {
	useSubagentsStore.getState().setSnapshots([snap({ id: "child", index: 0 })]);
	await mount(<AgentTree />);
	const child = screen.getAllByRole("treeitem")[1]!;
	child.focus();
	act(() => useSubagentsStore.getState().setSnapshots([snap({ id: "child", index: 0, status: "completed" })]));
	expect(document.activeElement?.textContent).toContain("child");
	act(() => useSubagentsStore.getState().setSnapshots([]));
	expect(document.activeElement?.textContent).toContain("Main");
});

it("uses roving focus and visible-row keyboard navigation", async () => {
	useSubagentsStore.getState().setSnapshots([
		snap({ id: "parent", index: 0 }),
		snap({ id: "child", index: 1, parentSubagentId: "parent" }),
	]);
	await mount(<AgentTree />);
	const rows = screen.getAllByRole("treeitem");
	expect(rows.filter(row => row.tabIndex === 0)).toHaveLength(1);
	rows[0]!.focus();
	await keyDown(rows[0]!, { key: "End" });
	expect(document.activeElement?.textContent).toContain("child");
	await keyDown(document.activeElement!, { key: "Home" });
	expect(document.activeElement?.textContent).toContain("Main");
	await keyDown(document.activeElement!, { key: "ArrowDown" });
	expect(document.activeElement?.textContent).toContain("parent");
});
```

Retain focused tests for abort/revive action isolation, route readiness, polling only while streaming, active-target synchronization, hierarchy ancestry, historical terminal agents, `role=\"tree\"`/`role=\"treeitem\"`, correct `aria-level`, and focus retention by stable row key during roster refresh.

- [ ] **Step 2: Run Agent tree tests and confirm RED**

Run: `bunx vitest run src/renderer/components/chat/activity/AgentTree.test.tsx`

Expected: FAIL because `AgentTree` does not exist.

- [ ] **Step 3: Extract the list and delete graph behavior**

- Move `AgentDockRow`, `rowKey`, `AgentRow`, lifecycle action handling, polling, hierarchy derivation, selection, and activation into `AgentTree.tsx`.
- Always include `{ kind: "main" }`, even with an empty subagent store.
- Render every `buildSubagentList` row; remove `buildAgentDockSummary` and `keepActiveRowInSummary` from this path.
- Keep actions inside rows with propagation stopped for click, double-click, Enter, and Space. Preserve `role="tree"`, row `role="treeitem"`, `aria-level`, selected/viewing state, and stable row keys.
- Use one roving `tabIndex` across visible rows. ArrowUp/Down traverse, Home/End jump, Right expands a branch or moves to its first child, and Left collapses a branch or moves to its parent. Enter retains activation; Space retains selection without activation.
- When a focused row survives refresh, restore focus to the corresponding DOM row. When it disappears and the existing agent-view store falls back to Main, focus the Main row.
- Keep `AgentsDockCard` temporarily as an old-layout `DockCard` wrapper around `<AgentTree pollMs={pollMs} />`; remove all graph/list toggle code.
- Before deleting graph files, run LSP references for `SubagentDag` and `buildSubagentGraph`; migrate or remove every live caller. `PanelsCrashRepro.test.tsx` must mount `AgentTree` and assert list navigation only.
- Add stable empty-copy key for the list body beneath Main:

```ts
// en.ts
"activitySidebar.agents.empty": "No subagents",
// zh.ts
"activitySidebar.agents.empty": "暂无子智能体",
```

- [ ] **Step 4: Run Agent, panel, and locale tests**

Run: `bunx vitest run src/renderer/components/chat/activity/AgentTree.test.tsx src/renderer/components/chat/dock/AgentsDockCard.test.tsx src/renderer/components/panels/PanelsCrashRepro.test.tsx src/renderer/locales/locales.test.ts`

Expected: list navigation/lifecycle/polling tests pass and no rendered graph toggle remains.

---

### Task 5: Compose Plan, Goal, Todo, and Agents in the rail

**Files:**
- Create: `src/renderer/components/chat/activity/ActivitySidebar.tsx`
- Create: `src/renderer/components/chat/activity/ActivitySidebar.test.tsx`
- Create: `src/renderer/components/chat/activity/ActivityMetaRows.tsx`
- Create: `src/renderer/components/chat/activity/ActivityMetaRows.test.tsx`
- Rename: `src/renderer/components/chat/dock/PlanDockCard.tsx` → `src/renderer/components/chat/activity/PlanActivitySection.tsx`
- Rename: `src/renderer/components/chat/dock/PlanDockCard.test.tsx` → `src/renderer/components/chat/activity/PlanActivitySection.test.tsx`
- Rename: `src/renderer/components/chat/dock/GoalDockBar.tsx` → `src/renderer/components/chat/activity/GoalActivitySection.tsx`
- Rename: `src/renderer/components/chat/dock/GoalDockBar.test.tsx` → `src/renderer/components/chat/activity/GoalActivitySection.test.tsx`
- Modify: `src/renderer/components/chat/dock/WorkspaceDock.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes `ActivitySection`, `TodoTree`, `AgentTree`, agent-view target, session stores, and Task 1 presentation state.
- Produces `ActivitySidebar({ compact, activeTabId }: { compact: boolean; activeTabId: string })`.
- Produces `ActivityMetaRows({ readOnly, maxDetailHeight }: { readOnly: boolean; maxDetailHeight: number })`, which renders Plan then Goal and owns their mutually exclusive detail composition.
- `PlanActivitySection({ readOnly, maxDetailHeight }: { readOnly: boolean; maxDetailHeight: number })` preserves plan loading/polling/review behavior.
- `GoalActivitySection({ readOnly, maxDetailHeight }: { readOnly: boolean; maxDetailHeight: number })` preserves goal pause/resume/edit/drop behavior.

- [ ] **Step 1: Write failing composition and split tests**

```tsx
it("keeps Plan, Goal, Todo, and Agents headers mounted in approved order", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	expect(
		[...container.querySelectorAll("[data-activity-section]")].map(node => node.getAttribute("data-activity-section")),
	).toEqual(["plan", "goal", "todo", "agents"]);
});

it("starts Todo and Agents balanced and commits a clamped drag split", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	const separator = screen.getByRole("separator", { name: "Resize Todo and Agents sections" });
	expect(separator.getAttribute("aria-valuenow")).toBe("50");
	await dragSeparator(separator, { fromY: 300, toY: 380 });
	expect(useActivitySidebarStore.getState().splitRatio).toBeGreaterThan(0.5);
	expect(Number(separator.getAttribute("aria-valuemin"))).toBeGreaterThanOrEqual(0);
});

it("hides Main mutation controls but keeps agent lifecycle controls for a subagent target", async () => {
	useAgentViewStore.setState({ target: { kind: "subagent", id: "child" } });
	useSubagentsStore.getState().setSnapshots([snap({ id: "child", status: "running" })]);
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	expect(screen.queryByRole("button", { name: /reorder/i })).toBeNull();
	expect(screen.queryByRole("button", { name: /pause goal/i })).toBeNull();
	expect(screen.getByRole("button", { name: /abort agent/i })).not.toBeNull();
});

it("collapses one tree, restores its prior split, and leaves both headers visible", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	useActivitySidebarStore.getState().setSplitRatio(0.62);
	await click(screen.getByRole("button", { name: "Collapse Todos" }));
	expect(screen.queryByRole("separator", { name: /Todo and Agents/ })).toBeNull();
	await click(screen.getByRole("button", { name: "Expand Todos" }));
	expect(useActivitySidebarStore.getState().splitRatio).toBe(0.62);
});

it("handles short canvas, disabled split input, cancellation, and independent scrolling", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	resizeTreeArea(150);
	expect(readTreeBodyHeights()).toEqual([46, 46]);
	const separator = screen.getByRole("separator", { name: "Resize Todo and Agents sections" });
	expect(separator.getAttribute("aria-disabled")).toBe("true");
	await keyDown(separator, { key: "ArrowDown", shiftKey: true });
	expect(useActivitySidebarStore.getState().splitRatio).toBe(0.5);
	resizeTreeArea(320);
	expect(separator.getAttribute("aria-disabled")).toBe("false");
	await keyDown(separator, { key: "ArrowDown", shiftKey: true });
	expect(useActivitySidebarStore.getState().splitRatio).toBe(0.6);
	await doubleClick(separator);
	expect(useActivitySidebarStore.getState().splitRatio).toBe(0.5);
	const setSplitRatio = vi.spyOn(useActivitySidebarStore.getState(), "setSplitRatio");
	await pointerDown(separator, { clientY: 100 });
	await pointerMove(document, { clientY: 120 });
	await pointerCancel(document);
	expect(setSplitRatio).toHaveBeenCalledTimes(1);
	expect(activeDocumentDragListenerCount()).toBe(0);
	const [todoScroll, agentsScroll] = container.querySelectorAll<HTMLElement>("[data-activity-tree-scroll]");
	todoScroll!.scrollTop = 30;
	expect(agentsScroll!.scrollTop).toBe(0);
});

it("leaves both headers mounted when both trees collapse", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	await click(screen.getByRole("button", { name: "Collapse Todos" }));
	await click(screen.getByRole("button", { name: "Collapse Agents" }));
	expect(screen.queryByRole("separator", { name: /Todo and Agents/ })).toBeNull();
	expect(screen.getByRole("region", { name: "Todos" })).not.toBeNull();
	expect(screen.getByRole("region", { name: "Agents" })).not.toBeNull();
});

it("bounds expanded metadata without stealing tree minima", async () => {
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	resizeActivityRail(420);
	await click(screen.getByRole("button", { name: "Expand Plan" }));
	const detail = container.querySelector<HTMLElement>("[data-activity-meta-detail='plan']")!;
	expect(Number.parseInt(detail.style.maxHeight, 10)).toBeLessThanOrEqual(220);
	expect(readTreeBodyHeights().every(height => height >= 48)).toBe(true);
});

it("renders compact counts and reveals the requested tree with focus", async () => {
	useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
	useSubagentsStore.getState().setSnapshots([snap({ id: "child", index: 0 })]);
	await mount(<ActivitySidebar activeTabId="tab-a" compact />);
	expect(screen.getByRole("button", { name: /Todos.*1/ })).not.toBeNull();
	expect(screen.getByRole("button", { name: /Agents.*1/ })).not.toBeNull();
	await click(screen.getByRole("button", { name: /Agents.*1/ }));
	expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBe("tab-a");
	expect(useActivitySidebarStore.getState().focusRequest?.id).toBe("agents");
});

it.each(sectionFailureCases)("isolates a complete $label section failure from its siblings", async ({
	breakSection,
	label,
	survivingLabels,
}) => {
	breakSection();
	await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
	expect(screen.getByText(new RegExp(`${label}.*failed`, "i"))).not.toBeNull();
	for (const sibling of survivingLabels) {
		expect(screen.getByRole("region", { name: sibling })).not.toBeNull();
	}
});
```

Add `ActivityMetaRows` and Plan/Goal tests proving: headers remain present when Plan mode is off or Goal is absent; only one details body expands; the measured detail max-height preserves both tree headers and 48px bodies; detail overflow scrolls independently; actions work on Main; action controls are omitted in read-only mode; existing error rollback remains intact.

- [ ] **Step 2: Run composition tests and confirm RED**

Run: `bunx vitest run src/renderer/components/chat/activity/ActivitySidebar.test.tsx src/renderer/components/chat/activity/ActivityMetaRows.test.tsx src/renderer/components/chat/activity/PlanActivitySection.test.tsx src/renderer/components/chat/activity/GoalActivitySection.test.tsx`

Expected: FAIL because the rail and renamed sections do not exist.

- [ ] **Step 3: Convert Plan and Goal to compact activity sections**

Use LSP `rename_file` for both source files so imports update safely.

- Create `ActivityMetaRows` as the sole Plan/Goal ordering and disclosure owner; `ActivitySidebar` renders it once above the tree area.
- Replace Plan’s outer `DockCard` with `ActivitySection id="plan"`; keep the plan parser, path resolution, polling, refresh, raw/steps tabs, review footer, and retry/error states.
- When Plan mode is off, keep the compact header visible with an “Off” badge. On Main, its expanded body may enable Plan mode through the existing RPC; in read-only mode omit toggle, feedback, approve, and request-change controls.
- Replace Goal’s single strip with `ActivitySection id="goal"`. Header shows active/paused/empty summary; expanded body shows objective and existing controls. When Goal is absent, Main may open the existing Goal mode editor; read-only mode remains descriptive only.
- Give each metadata detail `overflow-y-auto` and the measured `maxDetailHeight`; preserve existing optimistic goal rollback and toast behavior.

- [ ] **Step 4: Implement rail composition and vertical allocation**

- Render Activity header, then `ActivityMetaRows`, then a `minmax(0, 1fr)` tree area.
- Measure total rail height. Reserve Activity, Plan, Goal, Todo, and Agents headers, the separator, and `2 * ACTIVITY_TREE_MIN_BODY_HEIGHT`; pass only the remaining non-negative height to `ActivityMetaRows` as `maxDetailHeight`.
- Compute Todo/Agents grid rows from collapse state and `splitRatio`. Each body owns a distinct `min-h-0 overflow-y-auto` container marked `data-activity-tree-scroll`.
- During pointer drag, keep a local preview ratio; on pointer release or cancellation call `setSplitRatio` exactly once and remove all document listeners.
- Clamp using measured tree-area height so each expanded tree retains its header plus `ACTIVITY_TREE_MIN_BODY_HEIGHT`. If both minima cannot fit, use equal non-negative body heights and disable the separator until height recovers.
- Hide the separator whenever either tree is collapsed; preserve the stored ratio; leave both headers and no bodies when both are collapsed.
- Double-click resets 50/50. Arrow keys move by 2 percentage points; Shift+Arrow moves by 10.
- In `ActivityMetaRows`, wrap each complete Plan and Goal section—including summary/header, actions, and body—in its own `PanelErrorBoundary`. In `ActivitySidebar`, do the same around each complete Todo and Agents section; no boundary may wrap only a tree/detail body.
- In compact mode render only the 40px launcher with live Todo/Agents status/count indicators and an expand control. Todo/Agents buttons call `revealSection(id, activeTabId)`; the general expand control calls `revealSection(null, activeTabId)`.
- Add exact locale keys:

```ts
// en.ts
"activitySidebar.title": "Activity",
"activitySidebar.collapse": "Collapse activity sidebar",
"activitySidebar.expand": "Expand activity sidebar",
"activitySidebar.resizeTrees": "Resize Todo and Agents sections",
"activitySidebar.plan.off": "Off",
"activitySidebar.goal.empty": "No active goal",
// zh.ts
"activitySidebar.title": "活动",
"activitySidebar.collapse": "折叠活动侧栏",
"activitySidebar.expand": "展开活动侧栏",
"activitySidebar.resizeTrees": "调整待办和智能体区域大小",
"activitySidebar.plan.off": "关闭",
"activitySidebar.goal.empty": "无活动目标",
```

- Keep `WorkspaceDock.tsx` compiling until Task 6 by importing the renamed Plan/Goal sections with `readOnly={false}`.

- [ ] **Step 5: Run rail, Plan, Goal, Todo, Agent, and locale tests**

Run: `bunx vitest run src/renderer/components/chat/activity src/renderer/locales/locales.test.ts`

Expected: all activity component and locale tests pass.

---

### Task 6: Integrate the workspace, composer Queue chip, and command focus

**Files:**
- Create: `src/renderer/components/layout/WorkspaceCanvas.tsx`
- Create: `src/renderer/components/layout/WorkspaceCanvas.test.tsx`
- Rename: `src/renderer/components/chat/dock/QueueDockChip.tsx` → `src/renderer/components/layout/QueueComposerChip.tsx`
- Modify: `src/renderer/components/layout/InputArea.tsx`
- Modify: `src/renderer/components/layout/InputArea.queue-shorthand.test.tsx`
- Modify: `src/renderer/components/layout/InputArea.agent-view.test.tsx`
- Modify: `src/renderer/components/chat/AgentViewContextBar.tsx`
- Modify: `src/renderer/components/chat/AgentViewContextBar.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/App.agent-view.test.tsx`
- Modify: `src/renderer/stores/ui.ts`
- Modify: `src/renderer/lib/command-registry.ts`
- Modify: `src/renderer/lib/command-registry-actions.test.ts`
- Modify: `src/renderer/lib/command-registry-submenus.test.ts`
- Modify: `src/renderer/components/dialogs/CommandPalette.tsx`
- Modify: `src/renderer/components/dialogs/CommandPalette.agent-view.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`
- Delete: `src/renderer/components/chat/dock/WorkspaceDock.tsx`
- Delete: `src/renderer/components/chat/dock/DockCard.tsx`
- Delete: `src/renderer/components/chat/dock/WorkspaceDockFocus.tsx`
- Delete: `src/renderer/components/chat/dock/TodoDockCard.tsx`
- Delete: `src/renderer/components/chat/dock/TodoDockCard.test.tsx`
- Delete: `src/renderer/components/chat/dock/AgentsDockCard.tsx`
- Delete: `src/renderer/components/chat/dock/AgentsDockCard.test.tsx`
- Delete: `src/renderer/components/chat/dock/dock-summary.ts`
- Delete: `src/renderer/components/chat/dock/dock-summary.test.ts`

**Interfaces:**
- Produces `WorkspaceCanvas({ children }: { children: ReactNode })`.
- Renames command dependency `focusDockCard` to `focusActivitySection`; the GUI implementation calls `useActivitySidebarStore.getState().revealSection(id, activeTabId)`.
- Produces presentational `QueueComposerChip({ count, onOpen }: { count: number; onOpen: () => void })`. `InputArea` owns queue selection, modal state, target gating, and supplies the callback.

- [ ] **Step 1: Write failing workspace geometry tests**

Use a controllable `ResizeObserver` fixture and the real activity store/components:

```tsx
it("places transcript and rail side by side with no dock above the composer", async () => {
	await mount(<WorkspaceCanvas><div data-transcript /></WorkspaceCanvas>);
	const canvas = container.querySelector("[data-workspace-canvas]")!;
	expect(canvas.querySelector("[data-transcript]")).not.toBeNull();
	expect(canvas.querySelector("[data-activity-sidebar]")).not.toBeNull();
	expect(container.querySelector("[data-testid='workspace-dock-scroll']")).toBeNull();
});

it("moves rail focus to the launcher, restores it on recovery, and never steals transcript focus", async () => {
	await mount(<WorkspaceCanvas><button data-transcript-focus>Transcript</button></WorkspaceCanvas>);
	resizeWorkspace(1000);
	screen.getByRole("button", { name: "Collapse Todos" }).focus();
	resizeWorkspace(800);
	const launcher = screen.getByRole("button", { name: "Expand activity sidebar" });
	expect(container.querySelector('[data-activity-mode="compact"]')).not.toBeNull();
	expect(document.activeElement).toBe(launcher);
	resizeWorkspace(1000);
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse Todos" }));
	const transcript = container.querySelector<HTMLButtonElement>("[data-transcript-focus]")!;
	transcript.focus();
	resizeWorkspace(800);
	expect(document.activeElement).toBe(transcript);
});

it("applies persisted width and keeps remembered manual state when measurement is unavailable", async () => {
	prefsGet.mockResolvedValue({ width: 380 });
	disableResizeObserverMeasurement();
	await mount(<WorkspaceCanvas><div data-transcript /></WorkspaceCanvas>);
	expect(container.querySelector<HTMLElement>("[data-activity-sidebar]")!.style.width).toBe("380px");
	expect(container.querySelector('[data-activity-mode="expanded"]')).not.toBeNull();
});

it("suspends auto-collapse during drag and commits cancellation exactly once", async () => {
	await mount(<WorkspaceCanvas><div data-transcript /></WorkspaceCanvas>);
	const separator = screen.getByRole("separator", { name: "Resize activity sidebar" });
	await pointerDown(separator, { clientX: 700 });
	resizeWorkspace(700);
	expect(container.querySelector('[data-activity-mode="expanded"]')).not.toBeNull();
	await pointerMove(document, { clientX: 620 });
	await pointerCancel(document);
	expect(prefsSet).toHaveBeenCalledTimes(1);
	expect(useActivitySidebarStore.getState().width).toBeGreaterThanOrEqual(240);
	expect(activeDocumentDragListenerCount()).toBe(0);
});
```

Add executable tests for width keyboard steps, Shift steps, 240/420 clamping, double-click reset, Activity-header manual collapse, general launcher expansion focusing the Activity header, automatic focus restoration, tab-change override clearing, the outer panel reducing observed canvas width, and no rail on chat tabs.

- [ ] **Step 2: Write failing App/composer/command integration tests**

```tsx
it("keeps banners, context, transcript/sidebar, composer, and footer in order with one transcript surface", async () => {
	await mountApp();
	const banner = container.querySelector("[data-update-banner]")!;
	const context = container.querySelector("[data-agent-view-context]")!;
	const canvas = container.querySelector("[data-workspace-canvas]")!;
	const composer = container.querySelector(".omp-composer-region")!;
	const footer = container.querySelector("[data-status-footer]")!;
	expect(banner.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(context.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(canvas.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(composer.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(container.querySelectorAll("[data-chat-canvas]")).toHaveLength(1);
});

it("renders Queue in the Main toolbar, opens its manager, and omits it for a subagent", async () => {
	queueTwoMessages();
	await mount(<InputArea />);
	const queue = screen.getByRole("button", { name: /2 queued/i });
	await click(queue);
	expect(screen.getByRole("dialog", { name: /Queue/ })).not.toBeNull();
	await reorderQueueItem("second", "first");
	expect(useQueueStore.getState().followUp.map(item => item.text)).toEqual(["second", "first"]);
	act(() => useAgentViewStore.setState({ target: { kind: "subagent", id: "child" } }));
	expect(screen.queryByRole("button", { name: /queued/i })).toBeNull();
});

it("uses the real command path to reveal and focus a section from automatic compact mode", async () => {
	useTabsStore.setState({ activeTabId: "tab-a" });
	await mount(<WorkspaceCanvas><div data-transcript /></WorkspaceCanvas>);
	resizeWorkspace(800);
	expect(container.querySelector('[data-activity-mode="compact"]')).not.toBeNull();
	await runCommand("todo edit");
	expect(container.querySelector('[data-activity-mode="expanded"]')).not.toBeNull();
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse Todos" }));
	expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBe("tab-a");
	act(() => useTabsStore.setState({ activeTabId: "tab-b" }));
	expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
	expect(container.querySelector('[data-activity-mode="compact"]')).not.toBeNull();
});

it("keeps transcript and composer mounted when one complete activity section crashes", async () => {
	vi.spyOn(todoTreeModule, "TodoTree").mockImplementation(() => {
		throw new Error("todo failed");
	});
	await mountApp();
	expect(container.querySelector("[data-chat-canvas]")).not.toBeNull();
	expect(container.querySelector(".omp-composer-region")).not.toBeNull();
	expect(screen.getByText(/todo failed/i)).not.toBeNull();
});
```

Retain Agent Hub tests proving it remains navigation/management only and never mounts a transcript.

- [ ] **Step 3: Run integration tests and confirm RED**

Run: `bunx vitest run src/renderer/components/layout/WorkspaceCanvas.test.tsx src/renderer/App.agent-view.test.tsx src/renderer/components/layout/InputArea.agent-view.test.tsx src/renderer/components/layout/InputArea.queue-shorthand.test.tsx src/renderer/components/dialogs/CommandPalette.agent-view.test.tsx src/renderer/lib/command-registry-actions.test.ts`

Expected: FAIL because `WorkspaceCanvas` and the new queue/focus paths do not exist.

- [ ] **Step 4: Implement `WorkspaceCanvas` geometry**

- Render chat-tab children directly with the existing flex sizing and no rail.
- For agent tabs, render a `min-h-0 min-w-0 flex-1` horizontal container with a flexible transcript column and `ActivitySidebar`.
- Hydrate the activity preference once on mount and apply the hydrated width to the rail style.
- Measure the canvas with `ResizeObserver` and derive `autoCompact = canvasWidth - width < 560`. Until the first valid measurement, use remembered width/manual state and do not enter automatic compact mode.
- Derive effective compact state from manual collapse, automatic compact, current tab ID, and `narrowOverrideTabId`.
- Freeze effective mode while dragging. Use local preview width during pointer movement; pointer release/cancellation commits once, removes every document listener, then performs one responsive evaluation.
- Separator uses `role="separator"`, `aria-orientation="vertical"`, current/min/max values, 8px Arrow steps, 32px Shift+Arrow steps, and double-click reset.
- On manual or automatic collapse, move focus from inside the rail to the launcher without stealing focus from the transcript. Automatic recovery restores the prior surviving rail target by semantic section/row identity; general manual launcher expansion focuses the Activity header; a command reveal calls `revealSection(id, activeTabId)` and focuses the requested section disclosure/tree.
- Add locale values:

```ts
// en.ts
"activitySidebar.resize": "Resize activity sidebar",
// zh.ts
"activitySidebar.resize": "调整活动侧栏大小",
```

- [ ] **Step 5: Move Queue into the composer**

- Use LSP `rename_file` to move `QueueDockChip.tsx` to `QueueComposerChip.tsx` and LSP symbol rename for the exported component.
- Make `QueueComposerChip` render only the compact `count` button and call `onOpen`; it must not import queue stores, `Modal`, or `QueuePanel`.
- Remove `WorkspaceDock` from `ComposerRegion`.
- In `MainInputArea`, select queued messages, own `queueOpen`, render the queue-manager `Modal`/`QueuePanel`, and pass total count plus `setQueueOpen(true)` to `QueueComposerChip` immediately before the toolbar’s flexible spacer.
- Do not render queue controls in `SubagentReadOnlyInputArea`; `InputArea` remains the mutation gate.
- Preserve remove, clear, and drag-reorder behavior through the existing `QueuePanel` inside the Main-owned modal.

- [ ] **Step 6: Recompose App and remove the bundled slot**

Replace:

```tsx
<AgentViewTranscriptSlot>
	<ChatCanvas />
</AgentViewTranscriptSlot>
<InputArea key={activeTabId ?? "no-tab"} />
```

with:

```tsx
<AgentViewContextBar />
<WorkspaceCanvas>
	<ChatCanvas />
</WorkspaceCanvas>
<InputArea key={activeTabId ?? "no-tab"} />
```

Delete the exported `AgentViewTranscriptSlot` after running LSP references and migrating every caller/test. This keeps the context bar full-width above the transcript/sidebar row.

- [ ] **Step 7: Migrate command focus and delete obsolete dock state**

- Rename `CommandContext.focusDockCard` to `focusActivitySection` and keep its command-facing type `(id: ActivitySectionId) => void`.
- In `CommandPalette` and the default command context, implement that callback as `id => useActivitySidebarStore.getState().revealSection(id, useTabsStore.getState().activeTabId ?? "no-tab")`.
- Preserve the current Agent Hub behavior where applicable; the branch that previously focused `"agents"` must reveal the Agents rail section through the same callback.
- Remove `DockCardId`, `dockCollapsed`, `toggleDockCard`, `dockFocus`, and `focusDockCard` from `useUiStore` after LSP references are empty.
- Delete `WorkspaceDock`, `DockCard`, `WorkspaceDockFocus`, old Todo/Agents wrappers/tests, and dock-summary files only after LSP references show no live callers.

- [ ] **Step 8: Run the focused integration set and confirm GREEN**

Run: `bunx vitest run src/renderer/components/chat/activity src/renderer/components/layout/WorkspaceCanvas.test.tsx src/renderer/App.agent-view.test.tsx src/renderer/components/chat/AgentViewContextBar.test.tsx src/renderer/components/layout/InputArea.agent-view.test.tsx src/renderer/components/layout/InputArea.queue-shorthand.test.tsx src/renderer/components/dialogs/CommandPalette.agent-view.test.tsx src/renderer/lib/command-registry-actions.test.ts src/renderer/lib/command-registry-submenus.test.ts src/renderer/locales/locales.test.ts`

Expected: all focused tests pass; no old dock or graph surface is rendered.

---

### Task 7: Application-level regressions, live smoke, and cleanup

**Files:**
- Modify if required by behavioral failures: files introduced or migrated in Tasks 1–6 only.
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces no new API. This task proves the approved behavior on the actual Electron surface and performs final cleanup only after the smoke succeeds.

- [ ] **Step 1: Run typecheck and the full Vitest suite through context-mode**

Run through `ctx_execute`/`ctx_batch_execute` with summarized output:

```bash
bun run check:types
bunx vitest run
```

Expected: TypeScript exits 0; every Vitest file and test passes. If a failure appears, reproduce its focused file, fix the source rather than suppressing the symptom, and rerun the focused file before rerunning the full suite.

- [ ] **Step 2: Run Biome on every touched file**

Run:

```bash
bunx biome check --write <all touched source, test, locale, changelog, spec, and plan files>
```

Expected: exit 0 and no remaining diagnostics. Re-run focused tests for any file Biome changes semantically.

- [ ] **Step 3: Build the production renderer**

Run through context-mode:

```bash
bun run build
```

Expected: Electron/Vite production build exits 0 with renderer output generated.

- [ ] **Step 4: Launch Electron and exercise the actual surface with Browser/CDP**

Launch the GUI against the bundled sidecar, attach Browser/CDP, and exercise these observable scenarios:

1. Open a persisted agent session containing Todo phases and subagents.
2. Confirm the context bar is full-width above the transcript/sidebar row.
3. Confirm Plan, Goal, Todo, and Agents headers appear in the right rail in that order.
4. Confirm no List/Graph toggle or graph canvas exists.
5. Resize the rail to both clamps, double-click reset to 300px, cancel one drag, and verify the transcript remains the sibling column without a mode jump.
6. Drag the Todo/Agents separator, collapse each tree independently, collapse both, and restore them; confirm each expanded tree scrolls independently.
7. Make the canvas shorter than both normal minima; confirm headers remain reachable and no negative/overflow geometry appears.
8. Expand Plan then Goal and confirm the other metadata row closes; confirm long details scroll without hiding Todo/Agents headers.
9. Narrow the actual canvas and open the existing outer tools panel; confirm automatic compact mode uses the slim launcher with current Todo/Agents counts/status.
10. Expand Todo and Agents from the compact launcher and confirm focus lands in the requested tree.
11. Activate a live or historical subagent; confirm Main Todo/Plan/Goal remain visible but mutation controls and Queue are absent, while agent navigation/lifecycle controls remain.
12. Open Agent Hub and confirm it remains transcript-free; activate an agent and confirm the Hub closes and the main canvas changes target.
13. Return to Main; confirm the original Main transcript and interactive composer return unchanged.
14. Queue messages, open the manager from the composer chip, reorder/remove/clear entries, and close it.
15. Submit one Main message to prove the composer path still works.
Capture the exact scenarios actually exercised. If no session supplies Plan, Goal, Todo, Queue, or subagents, seed state only through supported GUI/RPC interactions; do not claim an unobserved scenario.

- [ ] **Step 5: Update the existing Unreleased changelog entry**

Amend the existing agent-view navigation entry under `## [Unreleased]` to state that Todo and Agents now live in a resizable right activity sidebar, Plan/Goal are compact rail rows, Queue is in the full-width composer, and the graph view was removed. Do not create a duplicate entry.

- [ ] **Step 6: Final cleanup and verification rerun**

- Use LSP references to confirm no remaining imports of `WorkspaceDock`, `DockCard`, `WorkspaceDockFocus`, `TodoDockCard`, `AgentsDockCard`, `QueueDockChip`, `SubagentDag`, `subagent-graph`, `focusDockCard`, or `DockCardId`.
- Remove only genuinely unreferenced dock styles/imports/test fixtures revealed by those checks.
- Re-run `bun run check:types`, the focused activity/App/InputArea/command tests, `bunx vitest run`, Biome on touched files, and `bun run build` through context-mode.
- Repeat the smallest Browser/CDP scenario affected by any cleanup change.

Expected: all automated gates exit 0 and the final live surface still matches the approved visual decisions.
