# Changelog

## [Unreleased]

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
