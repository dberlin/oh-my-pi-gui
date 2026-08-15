# Activity Sidebar Design

**Status:** Approved for implementation on 2026-08-15 through the visual design review.

## Goal

Replace the horizontal workspace dock above the composer with the visually approved persistent right-side activity rail. The upper canvas becomes a horizontal split between the existing transcript and the new rail; the composer remains the only full-width band beneath both.

The approved visual decisions are authoritative:

1. **Sidebar metadata plus composer queue:** Plan and Goal become compact rail rows; queued-message access moves into the composer.
2. **Balanced independent trees:** Todo and Agents remain simultaneously visible, scroll independently, collapse independently, and share space through a draggable divider.
3. **Resizable plus compact collapse:** the rail has a remembered width, a draggable transcript divider, a slim collapsed launcher, and automatic narrow-canvas collapse.

The rail removes the agent graph and retains the Main/subagent list as the sole agent navigation presentation.

## Scope

This is a GUI-only change under `packages/gui`. It uses the existing local and SSH session RPC contracts and the existing Todo, subagent, agent-view, Plan, Goal, Queue, and session stores.

### Included

- Right-side activity rail for agent-session tabs.
- Resizable and collapsible rail with responsive compact mode.
- Independently scrollable and collapsible Todo and Agents trees.
- Draggable vertical allocation between Todo and Agents.
- Compact Plan and Goal summaries and details.
- Queue access in the composer.
- Main as the root of the Agents hierarchy.
- Existing agent selection, activation, polling, and lifecycle actions.
- Read-only Main-owned activity while a subagent transcript is selected.
- Removal of the agent graph and its List/Graph toggle.

### Non-goals

- Sidecar or RPC changes.
- New Todo, subagent, Plan, Goal, or Queue domain state.
- Changes to transcript projection, hydration, recovery, or agent-view selection semantics.
- Agent steering or messaging.
- Persisting the selected agent across application restarts.
- Changing the existing outer tools panel.

## Layout

The existing agent-session workspace is rearranged into four vertical regions:

1. Existing session banners and notices.
2. A one-row active-agent context bar.
3. `WorkspaceCanvas`, containing the transcript and activity rail side by side.
4. The full-width composer followed by the unchanged status footer.

`WorkspaceCanvas` uses a flexible transcript column and a fixed-width rail column. The transcript owns all remaining width. The rail never inserts another product-content band between transcript and composer. The status footer remains application chrome, not a content band.

Chat-session tabs do not mount agent activity today and retain their existing transcript/composer layout; this change does not introduce agent state into chat sessions.

## Activity Rail

The expanded rail contains, from top to bottom:

1. **Activity header** with the manual collapse control.
2. **Plan summary row**.
3. **Goal summary row**.
4. **Todo tree**.
5. **Horizontal allocation separator**.
6. **Agents tree**.

The Todo and Agents headers remain visible even when their stores are empty. Empty sections render a compact semantic empty state rather than disappearing.

### Width

- Default: 300px.
- Minimum: 240px.
- Maximum: 420px.
- The left rail edge is a pointer- and keyboard-operable vertical separator.
- Dragging changes width continuously within the limits.
- Double-clicking the separator resets width to 300px.
- The last expanded width is stored in GUI preferences and restored across application restarts. Manual collapsed state is app-lifetime UI state; a new app launch begins expanded unless canvas geometry requires automatic compact mode.

### Todo/Agents allocation

- Default split: 50/50 of the space remaining after the header and Plan/Goal rows.
- The horizontal separator supports pointer drag and keyboard adjustment.
- The separator is clamped to leave each expanded section its header and at least 48px of body space. If the canvas is too short for both minima, both headers remain and the available body space is shared equally.
- Double-clicking the separator restores 50/50.
- The split ratio is app-lifetime presentation state, not a persisted preference.
- Each tree scrolls independently.
- Each tree may be collapsed independently. Collapsing one hides the separator and gives its body space to the other while retaining both headers. Collapsing both leaves the two headers and no tree body. Re-expansion restores the prior split.

### Plan and Goal

Plan and Goal are the approved compact collapsible summary rows. Activating a row reveals its existing detail presentation inline in the rail.

Only one may be expanded at a time. Expanded detail scrolls within a bounded region and may consume only space above the two tree-section minima. Expanding Plan collapses Goal and vice versa.

## Responsive behavior

A `ResizeObserver` owned by `WorkspaceCanvas` measures the actual canvas; window width alone is insufficient because the existing outer tools panel also consumes canvas width.

The rail enters automatic compact mode when reserving its remembered width would leave less than 560px for the transcript. Compact mode is a 40px slim launcher with Todo and Agents status/count indicators plus an expand control, matching the approved narrow-canvas visual.

Automatic compact mode does not overwrite the remembered width or app-lifetime manual state. Todo and Agents launcher buttons expand the rail at its remembered width and focus the requested tree. An explicit user expansion overrides automatic compact mode for the current tab until the user collapses the rail or changes tabs; user action therefore never appears to be ignored. Plan and Goal remain reachable through the full-rail expand control.

Responsive mode changes are suspended during width dragging and evaluated once on pointer release or cancellation, so a threshold crossing cannot unmount an active resize handle.

## Component boundaries

### New or extracted components

- `WorkspaceCanvas`: owns the horizontal transcript/rail composition, `ResizeObserver`, rail width, manual/automatic compact resolution, and the vertical resize separator.
- `ActivitySidebar`: owns rail content, Plan/Goal disclosure, Todo/Agents collapse, and the horizontal allocation separator.
- `ActivityMetaRows`: renders Plan and Goal summaries/details.
- `TodoTree`: extracts Todo hierarchy and interactions from `TodoDockCard` without owning Todo domain data.
- `AgentTree`: extracts Main/subagent hierarchy and interactions from `AgentsDockCard` without owning subagent domain data.
- `QueueComposerChip`: is a presentational queue affordance inside `InputArea`; `InputArea` remains responsible for target gating and supplies its existing queue actions.

### Existing components

- `ChatCanvas` remains the only Main/subagent transcript surface. The current `AgentViewTranscriptSlot` wrapper is removed after its context bar is separated from the transcript row; no replacement transcript path is added.
- `InputArea` remains the composer target gate.
- `AgentViewContextBar` remains the active-target identity row.
- Agent Hub remains a management/navigation surface without an embedded transcript.

`WorkspaceDock`, dock-only card wrappers, focus plumbing, summaries, and styles are removed after their behavior has migrated. Shared pieces are retained only when another live caller still uses them.

The `SubagentDag`, graph derivation utilities, graph inspector behavior, tests, and List/Graph toggle are removed after reference checks confirm no remaining callers. No replacement graph is introduced.

## State and data flow

Domain state remains authoritative in the existing stores:

- Todo phases and mutations: Todo store and current Todo RPC path.
- Subagent roster, polling, progress, lifecycle, and persisted reconstruction: subagent store and existing hooks.
- Main/subagent target and isolated transcript projection: agent-view store.
- Plan, Goal, and Queue: their existing stores and actions.

The rail adds presentation state only:

- App-lifetime manual expanded/collapsed state.
- Persisted expanded width.
- App-lifetime Todo/Agents split ratio.
- App-lifetime collapsed state of each tree.
- App-lifetime expanded Plan-or-Goal key.
- Focused rail section.
- Per-tab narrow-width user override.
- Derived automatic compact state.

Presentation state is global to the GUI except for the narrow-width override, which is cleared on tab change. Agent target remains per tab. Only expanded width is persisted across application restarts.

No component fetches transcript messages. Agent activation delegates to the existing agent-view store, preserving generation cancellation, historical fallback, live event buffering, and reconnect behavior.

## Interaction rules

### Main selected

- Todo status changes, phase collapse, ordering, and current keyboard behavior remain enabled.
- Plan and Goal retain their current actions.
- Queue controls appear as a composer chip.
- Agent abort/revive and navigation actions remain enabled.

### Subagent selected

- Main-owned Todo, Plan, and Goal remain visible for context but are read-only.
- Their mutation controls, drag handles, and mutation keyboard shortcuts are disabled or omitted.
- The read-only composer omits Queue mutation controls.
- Agent navigation and existing abort/revive lifecycle actions remain enabled.
- Returning to Main restores the untouched Main transcript and full composer behavior.

### Agent navigation

The extracted tree preserves the already-shipped selection and activation contract rather than redefining agent-view semantics:

- Main is the synthetic root row above the subagent hierarchy.
- Single-click changes row selection/focus without switching transcripts.
- Double-click and Enter activate the focused Main or subagent target.
- Existing commands that expose Agents focus the Agents tree; Todo commands focus the Todo tree.
- Completed, failed, aborted, cancelled, and parked agents remain selectable when their persisted transcript is available.

## Accessibility

- Todo and Agents use tree/treeitem semantics and preserve hierarchy through `aria-level` and expanded state.
- Resize handles use separator semantics, expose current values, and support arrow-key adjustments.
- Collapse, reset, lifecycle, and activation controls have explicit accessible labels.
- Focus remains inside the selected tree during roster refresh whenever the selected row still exists.
- When a selected agent disappears, the existing agent-view fallback returns to Main; the Agents tree moves focus to Main.
- Collapsing a tree while focus is in its body moves focus to that tree's header. Collapsing the whole rail moves focus to the rail launcher; automatic compact mode follows the same rule.

## Failure handling

- Plan/Goal, Todo, and Agents are isolated by section-level error boundaries. A sidebar section failure cannot unmount the transcript or composer.
- Existing RPC failures retain their current toast and retry behavior; the rail does not invent optimistic success.
- The persisted width is clamped on load. A missing or malformed value falls back to 300px.
- Pointer cancellation commits the last valid resize value, always removes drag listeners, and then performs one responsive-mode evaluation.
- If measurement is temporarily unavailable, the rail uses the remembered manual state and width rather than flashing between expanded and compact modes.
- Existing historical-agent load errors remain inline in the transcript with Retry; they do not change the selected target or rail hierarchy.

## Verification

Behavioral tests will cover:

- Agent-session layout places transcript and rail side by side with the composer beneath both.
- Chat-session layout does not mount the rail.
- Width resize, clamping, keyboard adjustment, reset, persisted-width restore, and app-lifetime manual collapse.
- Todo/Agents split resize, short-canvas minimum behavior, reset, independent collapse, split restoration, and independent scrolling.
- Automatic compact mode based on measured canvas width, including width consumed by the outer tools panel, drag-threshold suspension, and per-tab user override.
- Slim launcher indicators, tree focus, full-rail expansion, and focus restoration.
- Plan/Goal mutual disclosure and bounded overflow.
- Main Todo/Plan/Goal mutations and Queue chip behavior.
- Subagent read-only guards prevent Main mutations while retaining agent lifecycle/navigation actions.
- Main root, row focus, double-click/Enter activation, historical terminal agents, and missing-agent fallback.
- Removal of graph and List/Graph behavior through rendered-surface assertions, never source-text scans.
- Existing agent-view recovery suites remain green for tab routing, reconnect, stale roster protection, historical reconstruction, live-frame buffering, and Main restoration.

A browser-driven Electron smoke will exercise:

1. Main with populated Todo and Agents trees.
2. Main → live or historical subagent → Main.
3. Read-only activity while viewing the subagent.
4. Full-width Main composer submission and Queue chip.
5. Rail resize, tree split, manual collapse, and narrow compact mode.
6. Coexistence with the outer tools panel.

## Changelog

Update the GUI `[Unreleased]` changelog entry for agent-view navigation to describe the right activity sidebar, full-width composer, persistent Todo/Agents navigation, and graph removal. Do not add a second entry describing the same user-facing change.