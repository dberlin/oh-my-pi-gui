# Dannyb Fork Changelog

Fork-specific changes relative to `nornzach/oh-my-pi-gui`. The shared `CHANGELOG.md` follows upstream unchanged so rebases do not conflict over fork release notes.

## [Unreleased]

### Added

- **Find in transcript**: ⌘F (or ⌃F) opens a find bar over the transcript that searches the whole conversation — including text folded inside collapsed thinking blocks, tool results, and todo snapshots that are not currently on screen. ↵ and ⌘G walk matches backwards through history, ⇧↵ and ⇧⌘G forwards (the ⌘G chords work with focus anywhere in the pane); matches are washed in amber with the current one solid, a tick strip along the transcript's right edge shows where the hits sit while find is open, and wrapping past either end is announced rather than silent.

### Changed

- Agent questions now render inline above the composer so the transcript remains scrollable while choosing an answer.
- Completed tool cards now expose bounded, scrollbar-free collapsed previews that remain wheel- and touch-scrollable; context-mode cards show actual execution output rather than echoed commands.
- The composer now fills the available workspace width with standard horizontal gutters.
- Conversation jumping now lives in an expandable Activity section after Goal instead of a persistent marker rail beside the transcript.
- **Lint and format tooling**: replaced Biome with oxlint and oxfmt, matching the monorepo root — which dropped its own `biome.json`, leaving this package extending a config that no longer existed. The oxfmt options reproduce the previous Biome output, so only 6 of 481 files reformatted, and formatting runs off explicit globs because oxfmt denies by extension and would otherwise reach the CSS and JSON Biome never touched. Config lives in the package rather than reaching outside it, so upstream rebases stay self-contained.

### Fixed

- Update error banners can now be dismissed permanently for the affected release without hiding future release warnings.
- **Assistant reaction badges**: upstream 0.9.4 lifts an assistant's opening emoji onto the user turn it answers, but wires it inside `ChatStream`, which this fork replaced with `TranscriptViewport` — so the feature arrived inert, computed and rendered but passed by nobody. The viewport now forwards the reaction and the badge appears as upstream intended.

## Imported fork history

### Update

- **Current package and build stack**: updated direct runtime and development dependencies to their current stable releases, replaced `electron-vite` with `vite-plugin-electron`, and moved the renderer, main, and preload builds to Vite 8 while preserving the packaged `out/` layout.
- **Nested-checkout React resolution**: added the missing `linkedom` test dependency and made Vitest use one React module graph across hoisted workspace dependencies, preventing invalid-hook failures after clean dependency installs.

### Fix SSH tab

- **SSH host settings**: made session hydration preserve the tab working directory when older sidecars omit it, preventing the Settings window from crashing while SSH hosts load.
- **Electron packaging**: pinned the Electron toolchain version so `electron-builder` can resolve the platform binary from the nested GUI checkout, and restored dedicated arm64/x64 configs over one shared base so each package selects the correct sidecar and native companions.
- **Signed sidecar startup**: packaged the matching `pi_natives` addon beside the bundled `omp` binary so electron-builder signs both with the same team, preventing hardened-runtime library validation from terminating RPC and stats sidecars at startup.
- **Bundled stats dashboard**: restored a supported `omp stats --no-open` mode for the embedded server and recognized IPv4 loopback readiness output, avoiding external browser launches and stale startup state.
- **Electron development commands**: made `preview` launch the built desktop app again and kept Chromium sandboxing enabled during Vite development unless `NO_SANDBOX=1` is explicitly set.

### Add remote SSH sessions

- Added remote SSH sessions with host-scoped history, remote directory browsing, and existing RPC UI parity.
- **Sidebar keeps the inline rail**: the 0.8.3 Code/Work lane switcher and picker-only search are not carried here; the sidebar keeps its one-row inline search, workspace groups, and the remote SSH host section.

### Transcript view work

- **Subagent transcripts**: render Markdown, reasoning, images, usage, and completed tool cards with the main conversation presentation instead of plain truncated text.

### Fix SSH host settings timeout

- **SSH host settings**: load and manage project/user host configuration in the local GUI process instead of sending unsupported RPC commands through the active sidecar, eliminating the 30-second host-list timeout.

### Remove obsolete MuPDF build steps

- **Bundled sidecar build**: stopped invoking the removed MuPDF-WASM generation scripts now that PDF inspection ships through the native addon, restoring `build:omp` after upstream omp 17.3.4.

### Add agent transcript navigation

- **Agent transcript navigation**: agent rows and graph/Hub actions now switch the main transcript canvas to a live read-only subagent view, keep the Agents dock available for returning to Main, and reconstruct completed agents from persisted task calls when browsing historical sessions.

### Unify agent transcript and activity navigation

- **Agent transcript and activity navigation**: agent rows and Hub actions switch the single main transcript canvas to a live read-only subagent view; a persistent, resizable right activity sidebar keeps Plan, Goal, Todo, and Agents visible beside it, collapses to compact launchers on narrow canvases, and reconstructs completed agents from persisted task calls in historical sessions.

### Restore agent transcript scrolling

- **Agent transcript scrolling**: restored the constrained flex layout around the shared transcript viewport so mouse-wheel and scrollbar navigation work while the activity sidebar is visible.

### Activate agent rows on single click

- **Agent transcript and activity navigation**: single-clicking agent rows or Hub cards switches the main transcript canvas to a live read-only subagent view; a persistent, resizable right activity sidebar keeps Plan, Goal, Todo, and Agents visible beside it, collapses to compact launchers on narrow canvases, and reconstructs completed agents from persisted task calls in historical sessions.

### Prevent stalled turn-boundary sends

- **Composer turn-boundary sends**: route new text through the sidecar's authoritative run state so messages submitted as a turn finishes start immediately instead of remaining invisible until refresh.

### Restore sidecar startup and clean quit

- **Bundled stats dashboard**: launch the current `omp stats` command with supported flags and shadow only its best-effort platform opener, restoring the embedded server without opening a browser, disabling port-conflict recovery, or entering a restart loop.
- **Bundled sidecar compatibility**: fresh project sessions now create over RPC instead of passing the removed `--no-auto-resume` flag, and local/remote chats use the supported tool-free mode instead of the removed `--chat` flag without allowing launch profiles to re-enable tools.
- **Reliable application quit**: closed-window cleanup no longer reads destroyed Electron `webContents`, preventing the JavaScript error that interrupted the first quit attempt.

### Add adaptive tool rendering

- **Adaptive tool activity**: the default transcript now keeps completed tool calls visible as compact lookup rows or expandable rich cards instead of hiding them behind a generic process summary; `xd://` dispatches use the underlying built-in renderer, and MCP/dynamic tools show structured arguments, results, errors, images, and truncation metadata.

### Improve transcript and sidecar reliability

- Peer IRC sends and receives now stay visible in the transcript instead of hiding inside collapsed Hub cards, while job and process operations remain compact.
- Compact reasoning now renders directly as muted italic text with its own expansion control instead of nesting under a completed-steps disclosure.
- Provider usage now uses the sidecar's transcript `/usage` report instead of the unsupported quota modal, and unsupported RPC commands fail immediately with actionable errors instead of misleading timeouts.
- Sustained valid RPC output no longer trips a GUI-side SSH stdout rate limit and terminates the remote session; per-frame validation and stream backpressure remain enforced.

### Switch tabs with Command-bracket

- **Tab switching shortcuts**: Command-[ and Command-] step to the previous and next tab, wrapping at both ends. Like the other tab keys they live in the renderer keymap, so they can be remapped and never fire while an overlay is open.
- **Single-press quit**: Command-Q exits on the first press again. Draining sidecars cancels the initial quit, and the follow-up `app.quit()` was issued from inside that cancelled sequence, where Electron ignores it; it now lands on a fresh macrotask.

### Route tool preview ceilings through shared tiers

- **Consistent preview ceilings**: every tool renderer now draws its scroll cap from the shared `PREVIEW_SCROLL_*` tiers instead of a per-renderer `max-h-*`, so cards line up across the transcript and a global height change lands in one place. Ast-grep, Debug, GitHub, Goal, Help, Hub, Image, Lsp, MCP, Memory, Resolve, Task, Think, and Vibe cards shift by up to 96px as a result.

### Carry status and session actions into the title bar

- **Title bar carries the status strip's readouts**: alongside the 0.8.3 session metrics the toolbar now shows the working directory and the git branch with its staged/unstaged/untracked counts (click to refresh), and it keeps the PR, Agent Hub, stats, usage, providers, workspace-panel, and settings actions that 0.8.3 moved into its sidebar navigation.

### Keep transcript disclosures where the reader leaves them

- **Sidebar keeps the inline rail**: the 0.8.3 Code/Work lane switcher and picker-only search are not carried here; the sidebar keeps its one-row inline search, workspace groups, and the remote SSH host section.
- **Title bar carries the status strip's readouts**: alongside the 0.8.3 session metrics the toolbar now shows the working directory and the git branch with its staged/unstaged/untracked counts (click to refresh), and it keeps the PR, Agent Hub, stats, usage, providers, workspace-panel, and settings actions that 0.8.3 moved into its sidebar navigation.
- **Disclosures stay where you leave them**: reasoning blocks, tool cards, and archived todo snapshots now keep their open/closed state in the UI store keyed per tab, so scrolling a row out of the virtualizer and back no longer collapses it. A reasoning block opened while the turn streams also stays open once the live row is replaced by its finalized bubble. Control-O still overrides every tool card at once.
