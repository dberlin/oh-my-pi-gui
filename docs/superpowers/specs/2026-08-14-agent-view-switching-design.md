# Agent View Switching Design

**Date:** 2026-08-14  
**Status:** Approved design; awaiting written-spec review

## Goal

Let users switch the GUI’s main transcript canvas between the Main agent and any subagent in the current session. Agent lists become navigation and lifecycle-management surfaces instead of secondary transcript viewers.

The feature must work identically for local and SSH sessions against an unmodified latest omp installation. All implementation stays inside `packages/gui`.

## Product Decisions

- Main is the default view target.
- The Agents dock includes a synthetic Main root row followed by the session’s subagent hierarchy.
- Single-click selects a row or graph node. Double-click or Enter activates it in the main canvas.
- List, graph, and Agent Hub use the same activation behavior.
- Main and subagent views share the main transcript presentation.
- Subagent views are live but read-only because latest omp RPC does not expose a command for targeting prompts or steering at a specific subagent.
- The selected view target is remembered independently per GUI session tab for the app lifetime.
- The active-agent identity uses a persistent slim context bar above the transcript.
- Embedded and slide-over subagent transcripts are removed from the Agents dock, graph inspector, and Agent Hub.

## Compatibility Constraint

The GUI may use only commands already exposed by latest omp RPC:

- `set_subagent_subscription("events")`
- `get_subagents`
- `get_subagent_messages`
- `abort_subagent`
- `revive_subagent`

The design does not require a custom omp build, a new RPC command, direct transcript-file access from the renderer, or a second sidecar attached to the same session. This constraint is load-bearing for SSH sessions, where the remote host is only guaranteed to run latest omp.

## Architecture

### Per-tab view target

Each GUI session tab owns an agent view target:

- Main; or
- a stable subagent ID.

The target participates in the existing per-tab capture/restore lifecycle. It is not persisted across application restarts. On restore, the GUI resolves a subagent target against that tab’s current roster. An unresolvable ID falls back to Main.

Main’s current session, message, tool, queue, todo, model, extension UI, and composer stores remain authoritative and unchanged.

### Isolated subagent projection

A subagent transcript projection is scoped to the currently viewed subagent. It contains:

- hydrated finalized messages;
- live streaming message, text, and reasoning state;
- transcript-local tool entries;
- the persisted byte cursor;
- load/error state; and
- a generation identifier used to reject stale asynchronous work.

The projection is never copied into Main’s global message or tool stores. Events for non-viewed agents mark their data stale but do not retain unbounded live projections. Activating an agent hydrates its persisted transcript before applying subsequent live events.

### Shared transcript viewport

The main transcript presentation is separated from its Main-specific data acquisition. The shared viewport renders either:

- Main’s existing projection and Main-only rows; or
- the selected subagent projection in read-only mode.

Shared presentation includes Markdown, reasoning, images, errors, usage, tool cards, virtualized scrolling, pin-to-bottom behavior, and transcript density. Main-only behavior remains Main-only:

- queued messages;
- todo history and live todo state;
- compaction controls;
- branch/fork actions;
- session-level status and retry state; and
- editable composer behavior.

The subagent path reuses the same presentation primitives without consulting or mutating Main’s stores.

## Components and Responsibilities

### Agent view state

Owns the active target and tab-scoped capture/restore behavior. It validates restored subagent IDs against the current roster and exposes one activation API used by every agent surface.

### Subagent transcript projection

Hydrates `get_subagent_messages`, reconciles persisted and live deliveries, applies `subagent_event` frames for the active target, and owns transcript-local tool state. It discards late work whose generation no longer matches the active target.

### Transcript viewport

Owns rendering, virtualization, scrolling, and shared transcript presentation. It receives an explicit Main or subagent projection rather than reaching into the wrong store implicitly.

### Agent context bar

A fixed-height row above the transcript prevents layout shift while making the rendered identity explicit.

- Main view: Main identity and current session status.
- Subagent view: display label, agent type, lifecycle status, and live indicator.

It does not duplicate model, token, or context controls.

### Agent navigation surfaces

The Agents dock, graph, and Agent Hub display identity, hierarchy, status, timing, progress, and lifecycle actions. They do not render transcripts.

All surfaces follow the same interaction contract:

- click: select;
- double-click: activate;
- Enter: activate the keyboard-selected row;
- abort/revive controls: perform only their named action and never activate the row.

Agent Hub closes after successful activation so the selected transcript is visible in the main canvas.

### Composer state

Main view retains the existing composer unchanged. Subagent view replaces it with a non-editable state that names the viewed agent and instructs the user to select Main to send a message. It never accepts input and silently routes it elsewhere.

All new labels, status text, notices, and errors use the existing i18n layer with identical keys in the English and Chinese locale tables.

## Data Flow

### Activation

1. A list row, graph node, or Hub row requests activation through the shared agent-view API.
2. The API resolves the target against the current session roster.
3. Main activation clears the subagent projection and restores the existing Main canvas.
4. Subagent activation increments the projection generation, records the tab target, and requests transcript data through `get_subagent_messages`.
5. The hydrated result is reconciled by stable message identity and rendered through the shared viewport.
6. Subsequent `subagent_event` frames matching the active subagent update live message and tool state.

### Live event handling

The existing `events` subagent subscription remains the sole live transport. Matching events update the isolated projection:

- message start and deltas create streaming text/reasoning;
- message end and agent end finalize deliveries without duplication;
- tool start/update/end drive pending, running, completed, and failed cards;
- lifecycle/progress frames update roster metadata and the context bar.

Events for Main continue through the existing Main event path. Events for other subagents do not mutate the active projection.

### Target and tab switching

Every activation starts a new generation. Transcript loads and event work capture that generation; stale completions are ignored.

Switching GUI session tabs captures the current target ID with the tab bundle. Returning to a tab re-resolves the target and catches up from persisted transcript state. Background tabs do not require retained subagent live projections.

### Reconnect

After sidecar readiness or reconnect, the GUI reasserts the existing subagent event subscription, refreshes the roster, and reloads the selected transcript. It keeps the selected target when the ID is resolvable and falls back to Main otherwise.

Local and SSH sessions follow this same preload/RPC path.

## Error Handling

- Transcript load failure keeps the selected subagent context visible and renders an inline error with Retry.
- A stale or replaced target cannot repaint the current view because generation checks reject late work.
- An agent that remains in the roster may be inspected regardless of terminal status.
- A target removed from the roster entirely causes a fallback to Main and a non-error notice.
- Invalid or unmatched subagent events are ignored without affecting Main.
- Main remains usable if subagent hydration or projection fails.
- No fallback sends composer input to Main while a subagent transcript is displayed.

## Interaction Details

### Selection versus active target

Keyboard/list selection and the viewed target are separate states. The active target receives a persistent accent marker and “Viewing” state. Ordinary selection receives only focus/selection styling. This avoids implying that one click already switched the transcript.

### Main row

Main is always the first/root agent entry and the default active target. Activating Main is the explicit path back to the editable conversation.

### Graph

The graph remains a navigation view. Its nodes use click to select and double-click/Enter to activate. The current lower transcript inspector is removed.

### Agent Hub

The Hub keeps status counts, roster metadata, abort, revive, and refresh behavior. “View messages” and the transcript slide-over are removed. Row activation switches the main canvas and closes the Hub.

## Testing Strategy

### Projection contracts

- Hydrated history and live events reconcile without duplicate messages.
- Repeated provider tool-call IDs pair with their results by occurrence.
- Streaming text and reasoning finalize into one delivery.
- Tool states transition through pending, running, completed, and failed.
- Events for one subagent never affect Main or another subagent.
- A stale generation cannot apply a late transcript load or event.

### Store and tab contracts

- Main is the default target.
- Each GUI session tab captures and restores its own target.
- A missing restored target falls back to Main.
- Switching targets does not mutate Main message, tool, queue, todo, model, or composer state.

### Component contracts

- Agent lists contain Main and subagent rows without embedded transcripts.
- Click selects without activation.
- Double-click and Enter activate.
- List, graph, and Hub invoke one shared activation path.
- Context bar reflects Main and subagent targets.
- Subagent composer is disabled and names the viewed agent.
- Hub closes after activation.
- Abort and revive controls do not activate rows.

### Regression coverage

Existing Main transcript rendering, composer submission, tab switching, Agent Hub lifecycle actions, and remote-session hydration remain unchanged.

### Behavioral smoke checks

1. Start a real local subagent.
2. Switch Main → subagent → Main from the list.
3. Repeat through the graph and Agent Hub.
4. While viewing the subagent, observe live reasoning, tool transitions, and finalized output.
5. Confirm that the subagent composer is read-only and Main becomes editable again immediately after activation.
6. Repeat the same path on an SSH session against an unmodified latest omp host.

## Acceptance Criteria

- Users can activate Main or any rostered subagent in the main canvas from every agent navigation surface.
- The main canvas clearly identifies its target and renders the selected subagent live with Main-transcript presentation quality.
- No secondary surface embeds or overlays a transcript.
- Subagent views never allow or misroute composer input.
- Target selection is isolated per GUI session tab.
- Main and subagent state cannot contaminate each other.
- Local and remote behavior require no omp changes outside `packages/gui`.

## Non-goals

- Messaging or steering a subagent.
- New or modified omp RPC commands.
- Modifying files outside `packages/gui`.
- Persisting agent selection across app restarts.
- Switching model, queue, todo, extension UI, or session controls to subagent state.
- Opening another sidecar against a live subagent session file.
