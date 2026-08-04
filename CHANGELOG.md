# Changelog

## [0.3.0] - 2026-08-05

### Added

- Added true parallel sessions: up to 10 windows, each with its own independent agent sidecar process. Opening a session "in a new window" (per-session row button, ⌘⇧N / File → New Window, tray, deep link) spawns a dedicated sidecar for that window, so a session running in one window is never disturbed by switching or creating sessions in another. The sidecar manager is now a per-window pool (cap 10) instead of a global singleton; all IPC routes by `event.sender` to the calling window's sidecar, and each sidecar's events forward only to its owning window. Desktop notifications dedupe within a window but no longer collapse distinct windows' notifications, and the tray/dock indicator aggregates across windows (any error > streaming > waiting > idle).
- Added a per-row "open in new window" action in the session sidebar for explicit parallelism; the default click/`+` behavior (replace the current window's session, server aborts first) is unchanged.

### Changed

- Reworked session/workspace deletion to inline confirm: the first click swaps the trash button for an in-place ✓/✕ pair (confirm sits exactly where delete was), a second click deletes, ✕ or clicking away cancels — no more modal dialog in the center of the screen. Applies to both single sessions and whole workspace groups.
- Rebalanced sidebar visual hierarchy: session titles are now larger and bolder while workspace group headers are smaller and muted, so the session (the thing you act on) reads as the primary row and the workspace as a quiet grouping label.
- Made the left session sidebar resizable by dragging its right edge (mirrors the existing right-panel drag), clamped to 180–420 px.
- The rename (pencil) button on the active session row is now always visible instead of hover-only, so it can no longer be squeezed out of view by neighboring content.
- Upgraded `bun scripts/gen-types.ts` from a command-name-only comparison to a structural shape check: it now parses every `Rpc*` interface in the agent's `rpc-types.ts` and fails (`--check`) when the GUI's same-named interface drifts in field names. The host-tool, subagent, and `toolcall_delta` drifts below all slipped through the old name-only check.

### Fixed

- Fixed the Handoff, plan-approval, and session-tree label dialogs losing focus on every keystroke. The Modal component re-ran its focus-capture effect whenever the caller's `onClose` closure identity changed (on each `setState`), yanking focus from the input back to the dialog's close button; focus capture now runs once per open transition, and close-time focus restore no longer blurs an element inside a freshly opened dialog.
- Fixed the chat not following long streaming replies: the pinned-to-bottom effect only re-ran on row-count changes, so text accumulating inside the constant streaming row and the final message swap never scrolled. It now also tracks streaming text/thinking length so content growth snaps back to the bottom.
- Fixed the agent's `ask` tool (askDialog) leaving no waiting signal: `BLOCKING_UI_METHODS` omitted `askDialog`, so the title marker, sidebar signal light, tray waiting state, and unfocused-window notification all stayed off while the agent waited for an answer.
- Fixed spurious "RPC timeout" errors on long-running `!cmd` bash, `$ code` python, `/compact`, and HTML export. The sidecar only answers these after the work finishes, but every command shared an 8s timeout, so anything longer errored out while actually running; these commands now get generous windows and `window.omp.rpc.command` accepts a per-call timeout.
- Fixed streaming tool cards never showing their accumulating arguments: the `toolcall_delta` wire shape had drifted (`{contentIndex, delta, partial}` vs the assumed `{toolCallId, name, argsDelta}`), so the attribution id was always undefined and every delta overwrote one undefined-key phantom entry. Tool-call deltas are now attributed by the real id from `partial.content[contentIndex]`.
- Fixed live subagent updates attributing to the wrong (or a single undefined-key) entry: `subagent_lifecycle`/`progress`/`event` frames arrive nested as `{type, payload}`, but the GUI read flat fields off the top level, so `id`/`index` were always undefined. Lifecycle frames are now read from `payload`, and progress frames attribute by `payload.progress.id` (the batch-local `index` repeats across task batches).
- Fixed opening a session in a new window showing a blank conversation instead of the target session: the sidecar switch raced the window's boot hydration. The switch now happens in the new window's renderer on boot (it pulls a `pendingSessionPath` and runs `switch_session` + hydrate itself), which both orders the hydration correctly and surfaces switch failures in that window.
- Removed the `gui_open_url`/`gui_notify`/`gui_clipboard_read` host-tool registrations. They were deadlocked end-to-end: the agent emits `{id, toolName, arguments}` frames, the main-process executor read the drifted `{callId, name, args}` fields (always undefined), the renderer had zero `onHostToolCall` consumers, and the agent-side call has no timeout — a model call to any of these hung the turn until the sidecar restarted. Registration is removed until the host-tool pipeline is properly wired; the main-process executor stays in place.

## [Unreleased]

## [0.2.1] - 2026-08-04

### Fixed

- Fixed a renderer crash (white screen) when opening the Agents or Diff workspace tab while the agent was running. Live subagent frames carry runtime statuses the panels' status table never mapped (`running`, `pending`, `aborted`, `parked`, `idle`), so `STATUS_META[status]` was `undefined` and reading `.live`/`.variant` off it tore down the whole React tree; progress payloads also arrived without the assumed shape, spraying `reading 'description'` errors mid-run. Status metadata now covers every runtime status with a safe fallback, "is this agent live" is a single shared predicate instead of scattered `status === "started"` checks, and each workspace panel is wrapped in an error boundary so a future panel-local failure degrades to an inline retry card instead of blanking the window.

## [0.2.0] - 2026-08-04

### Added

- Added the Electron desktop GUI with session navigation, conversation and tool rendering, model controls, settings, workspace panels, stats, light and dark themes, and compact-window support.
- Added voice features driven by the agent's speech/STT pipelines: a composer microphone (honors `stt.enabled`, `stt.modelName`, `stt.submitTrigger`, `stt.language`) that records, resamples to 16 kHz mono WAV, and transcribes server-side via the new `transcribe_audio` RPC, and auto-speak of assistant output (honors `speech.enabled`, `speech.mode`, `speech.voice`, `tts.localModel`) via the new `synthesize_speech` RPC with local TTS synthesis. Packaged builds carry the macOS microphone usage description and audio-input entitlement.
- Added dock/tray run progress honoring `terminal.showProgress`: dock badge (● working, ! waiting) and window progress bar, plus an amber waiting state in the tray icon.
- Added unified themes: the GUI now honors the agent's `theme.dark`/`theme.light` theme names by resolving them server-side (`get_theme_colors` RPC) and layering the colors over the active GUI theme, re-applied on config updates and theme switches.
- Added a status footer bar honoring `statusLine.preset` (default/minimal/compact/full/nerd/ascii) with model + thinking level, cwd, context meter, and session name segments.
- Added compact density (`tui.tight`, root zoom) and a color-blind-safe palette (`colorBlindMode`, Okabe-Ito tokens) — both formerly TUI-only.
- The GUI now honors four settings that were previously TUI-only: `display.showTokenUsage` (per-turn usage row on assistant messages — note the schema default is off, so usage rows now follow the setting and stay hidden until enabled), `display.collapseCompacted` (pre-compaction history folds behind an expandable divider), `tui.titleState` (run-state marker in the window title: `●` working, `!` waiting on you, `›` your turn), and `goal.statusInFooter` (composer goal chip).
- Added a signal light to session rows in the sidebar: a pulsing green dot for sessions that are currently running (live store state for the attached session, the session file's tail status for others), and a pulsing yellow warning when the attached session is blocked on a confirmation (plan approval, ask, or permission prompt) — visible at a glance while juggling multiple sessions.
- Added an explicit thinking-level picker in the composer (Codex/Claude Code style): the chip now opens a menu listing `off`, `auto`, and exactly the effort levels the active model supports, with the current selector checked — replacing the blind click-to-cycle that jumped to an unspecified next value. The get_state wire now carries `thinkingConfigured` and `availableThinkingLevels`, and `set_thinking_level` accepts `auto`.
- Added a Settings → GUI toggle to expand reasoning (thinking) blocks by default; blocks can still be collapsed individually and the preference persists across launches.

### Fixed

- Fixed settings edited from the GUI settings window not taking effect in the running session for runtime-cached keys (sampling parameters, default thinking level, advisor, memory backend, vision mode, provider search/image orders, MCP notifications, conversation-flow modes, omit-thinking, mermaid prompt refresh) — `set_setting` now applies them live via the shared runtime-apply path.
- Fixed the settings window showing stale values after a setting was changed elsewhere (TUI, composer controls, another window); it now refreshes on config_update while open, without clobbering an in-progress row edit.
- TUI-chrome-only settings (status line, terminal images, boot screens, speech/audio, …) are now badged "TUI only" in the settings window so it's clear they have no GUI effect.
- Settings cached at session construction (tool/prompt registration, thinking budgets, autolearn, LSP pool, …) are now badged "restart required" — edits take effect after a sidecar restart in every client.
- Fixed `plan.defaultOnStartup` never applying to GUI sessions, and closed todos never auto-clearing (`tasks.todoClearDelay` now runs in the agent session, not the TUI).
- Fixed the chat showing no feedback while the agent was busy but nothing had streamed yet. A live status row now mirrors the TUI's loader line: waiting for the model's first event (elapsed seconds, escalating slow-response hint after 30s), auto-retry delay/attempt with a live countdown and failure detail, and auto-compaction maintenance with the TUI's reason/action text — each carrying an Esc-interrupt hint. The row also appears when attaching to a session that is already streaming (launch/reconnect/session switch), and stays visible through the user-prompt echo and the empty assistant shell that precede the first streamed token.
- Fixed the composer sending the message when Enter was pressed while an IME candidate window was open (e.g. Chinese pinyin); Enter now commits the composition instead.
- Fixed packaged applications crashing at startup because main-process dependencies were externalized while `node_modules` was excluded from the application archive.
- Fixed RPC extension UI subscriptions so interactive ask and approval dialogs appear and return user responses.
- Fixed historical tool calls and results rendering as empty assistant messages after session hydration.
