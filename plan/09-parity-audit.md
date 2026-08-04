# omp GUI ≷ TUI — Parity Audit & P0 Construction List

Date: 2026-08-03. Method: source-level audit of `packages/coding-agent` (TUI),
`packages/coding-agent/src/modes/rpc` (wire surface), and `packages/gui`
(current state), with precise counts.

## Headline finding (counter-intuitive)

The GUI's **breadth** is already decent; the real gap is **depth** and
**GUI-native quality**. The complaint "still depends on TUI logic" is the
accurate diagnosis: many features are wired by **forwarding `/command` text to
the agent** (TUI's code path) instead of being extracted into native GUI
controls, and the render area is shallower than the TUI's.

## Measured numbers

| Metric | Value | Meaning |
|---|---|---|
| RPC command types (wire ceiling) | **54** | covers sessions/models/providers/settings/usage/plan/todos/subagents/messages/export/host-tools — the wire is NOT the bottleneck |
| Builtin slash commands | **69** | 13 are `handleTui`-only, but most of those now have RPC equivalents |
| GUI command-registry entries | **71** | the "wrap /commands as menus" framework already exists |
| TUI tool renderers | **32** | reference set |
| GUI tool renderers | **21** | 11 short |
| Wire event types / GUI handled | 15 / 16 | events essentially fully consumed |

## Category matrix  ✅ full · 🟡 partial · ❌ missing · ⚠️ TUI-logic-forward

| Domain | Status | Note |
|---|---|---|
| Conversation core (prompt/steer/followup/abort/stream) | ✅ ~95% | wired |
| Render area | 🟡 ~50% | 21/32 renderers; thinking/diff/markdown plain |
| /commands → menus | ⚠️ breadth 85% / depth 50% | ~20 still `kind:"prompt"` forwards |
| Session management | 🟡 ~55% | branch/fork/tree/rename/export UI thin (RPC exists) |
| Models/Providers | 🟡 ~65% | local-model download, custom-model editor, perf stats, cycle missing |
| Settings | 🟡 ~40% | 5 tabs only; `set_setting` RPC covers ALL schema paths but GUI underuses it |
| Stats/Usage | ✅ ~85% | StatsDashboard + UsageWindow + internal stats server |
| Input | 🟡 ~60% | history search, `!`/`$` modes, voice, external editor missing |
| Status/telemetry | 🟡 ~55% | partial segments; no git branch / plan indicator |
| Subagents/Todos | ✅ ~80% | drag/edit + tree/transcripts |
| Extension UI | 🟡 ~70% | custom() components, rich widget, askDialog missing |
| Modes (plan/vibe/goal/loop) | ❌ ~20% | plan RPC exists, UI thin; vibe/goal/loop absent |
| Memory/Skills/Hooks/MCP/Plugins/PromptTemplates/ContextFiles | ❌ ~10% | no GUI surfaces |
| Theme | 🟡 ~30% | only dark/light, not the 95-token system |

**Overall: breadth ≈70%, depth ≈45%.**

## Three root causes

1. **Forward-not-native.** ~20 registry items use `kind:"prompt"` (= typing
   `/cmd` for the user). Native means a picker / window / toggle / input dialog.
2. **Render area is a text stream, not structured cards.** 11 missing renderers
   + markdown/mermaid/latex/table/image/thinking/usage-row below TUI level.
3. **Whole feature domains have no surface.** Memory/Skills/Hooks/MCP/Plugins/
   PromptTemplates/ContextFiles/themes/modes.

## P0 construction list

### P0a — Command nativization (convert `prompt`/`unavailable` → native)

RPC commands available (verified in the 54): `branch`, `cycle_model`,
`cycle_thinking_level`, `get_branch_messages`, `get_session_stats`,
`set_session_name`, `export_html`, `handoff`, `set_plan_mode`, `compact`,
`get_usage`, `login`, `logout`, `get_providers`, `get_settings`, `set_setting`,
`get_settings_schema`, `get_subagents`, `get_messages`, `new_session`, `abort`,
`prompt`, `steer`, `follow_up`, `bash`, `set_todos`, + all `set_*` toggles.

Conversions (high value first):
- `rename` → native input dialog → `set_session_name` (was `p("/rename ")`).
- `branch` → native branch picker: `get_branch_messages` + `branch` (was prompt).
- `tree` → NEW session-tree view (branch graph) via `get_branch_messages` (was "unavailable").
- `model cycle` → `cycle_model` action (NEW item; TUI has Ctrl+P).
- `thinking cycle` → `cycle_thinking_level` action (NEW item).
- `export` → path-picker dialog → `export_html(path)` (was bare action).
- `resume` → native session picker (list from session-index) → switch (was `p("/resume ")`).
- `retry` → native action: re-send last user message via `get_last_assistant_text`/messages + `prompt` (was "unavailable").
- `session info` → native panel via `get_session_stats` (was `sub` prompt).

Leave as forward (genuinely needs agent-side execution): advisor, shake,
computer, vision, browser, force, mcp, marketplace, plugins, memory, security,
ssh, move/dirs, jobs, changelog, prewalk, fresh, context, tools, dump, share.
These run agent-side logic with TUI-rendered output; converting them needs
either dedicated RPC or accepting the forwarded text result. Track for P1.

### P0b — Render completion

Missing renderers to add (GUI `tools/index.tsx` REGISTRY):
- `resolve` / `reject` — xd:// resolution-device renderer.
- `goal` — goal tool renderer.
- `apply_patch` — alias to EditRenderer (1 line).
- `vibe_spawn/send/wait/kill/list` — defer until vibe is RPC-exposed (P1).

Quality upgrades to existing render:
- markdown: tables, code-fence language badges, lists, links (parity with TUI markdown.ts).
- mermaid diagram rendering (TUI renders mermaid; GUI should too).
- latex/math rendering.
- thinking block: collapsible, shimmer-while-streaming.
- usage/cost row under assistant messages (TUI `usage-row.ts`).
- image inline render (already ImageRenderer; verify base64 display).

### Deferred to P1/P2 (recorded, not forgotten)

- Settings window: expand from 5 tabs to all schema groups via `get_settings_schema` + `set_setting`.
- Session branch/tree/fork full visualization; handoff UI.
- plan/vibe/goal/loop native panels (plan RPC ready; vibe/goal/loop need agent RPC).
- Memory/Skills/Hooks/MCP/Plugins/PromptTemplates/ContextFiles panels (may need agent RPC exposure).
- Input: history search, `!`/`$` modes, voice/STT, external editor.
- Theme system (95-token) + theme picker.
- "Exceed TUI": graphical subagent DAG, visual diff timeline, interactive plan review, drag session tree, provider/model compare.

## Process

Multi-round audit → verify (typecheck + build + smoke dual-process) → deliver.
Each round re-audits against the TUI reference and fixes what it finds.

---

## P0 OUTCOME (2026-08-03) — DELIVERED & VERIFIED

### P0a — Command nativization: 9 conversions shipped

| Command | Was | Now |
|---|---|---|
| rename | `p("/rename ")` | RenameSessionDialog → `set_session_name` |
| resume | `p("/resume ")` | SessionPickerDialog (sessions.list) → `switch_session` |
| branch | `p("/branch")` | BranchPickerDialog (`get_branch_messages`) → `branch` |
| tree | unavailable | SessionTreeDialog (branch lineage, per-node fork) |
| retry | unavailable | action: re-send last user msg (`prompt`/`abort_and_prompt`) |
| export | bare action | exportSessionHtml (save dialog → `export_html`) |
| session info | sub prompt | SessionInfoDialog (`get_session_stats` native panel) |
| model cycle | — | NEW action → `cycle_model` (⌃P) |
| thinking cycle | — | NEW action → `cycle_thinking_level` |

Left as `kind:"prompt"` (need dedicated structured RPC — P1): advisor, shake,
computer, vision, browser, force, todo, mcp, marketplace, plugins, memory,
security, ssh, move/dirs, jobs, changelog, prewalk, fresh, context, tools,
dump, share. True TUI-only remainder stays `unavailable` (23).

### P0b — Render completion shipped

- New renderers: `resolve`/`reject` (ResolveRenderer), `goal` (GoalRenderer),
  `apply_patch`→EditRenderer alias. resolve/reject/goal no longer fall to Generic.
- UsageRow under assistant messages (model, ↑in, ↓out, cached, $cost, duration,
  tok/s) — TUI usage-row parity.
- ThinkingBlock: collapsed-by-default, shimmer while streaming, word/line counts.
- ImageRenderer: base64 inline verified + details-image fallback.
- markdown (GFM/KaTeX/Mermaid/highlight) was already at parity — untouched.

### Verification (3 audit rounds)

- Round 1 (integration): conversions native in registry; 5 dialogs mounted in
  App; resolve/reject/goal/apply_patch registered; all new components in bundle.
- Round 2 (runtime, CDP on the live window): dual-process closed loop up
  (sidecar `--mode rpc-ui` + stats `--noOpen` on :3847); "Rename Session" opens a
  NATIVE dialog (screenshot); "Session Tree" opens a native lineage window
  (screenshot, empty-state); "Cycle Model ⌃P" present as native action.
- Round 3 (pipeline): UsageRow + ThinkingBlock wired into MessageBubble/ChatStream;
  resolve/goal registrations live.
- `tsc --noEmit` = 0; `bun run build` = 0 (renderer+main+preload).

### Next cycle (P1, not started)

Settings window → all schema groups (`get_settings_schema`+`set_setting`);
session branch/fork/handoff UI; plan/vibe/goal/loop native panels (plan RPC
ready); Memory/Skills/Hooks/MCP/Plugins/PromptTemplates panels (may need agent
RPC); input history-search / `!`/`$` modes / voice; theme system.

---

## P1+P2 OUTCOME (2026-08-03, second wave) — DELIVERED & VERIFIED

### Shipped this wave

| Feature | Status | Evidence |
|---|---|---|
| Settings → all schema groups | ✅ | 13 tabs live (Runtime + 10 schema + Advanced + GUI), was 5 |
| Session fork/handoff UI | ✅ | ForkDialog + HandoffDialog wired; 10 tests pass |
| plan-mode panel | ✅ | Plan tab in workspace drawer; review→message feedback |
| Memory/Skills/Hooks/MCP/Plugins/Templates panels | ✅ | ExtensionsPanel (Skills 8, MCP 5) + InventoryPanel (Plugins 0, Memory off) — real `get_*` RPC data, read-only |
| Input enhancements | ✅ | history (Ctrl+R + Up/Down), `!`/`$` bash/python badges, live-verified |
| Theme system (95-token style) | ✅ | 5 themes × 117 tokens (key-parity 0/0), picker applies Nord live (accent #88c0d0, bg #2e3440), persists |
| Subagent DAG | ✅ | SubagentDag List/Graph toggle, tidy-tree SVG, 9 layout fixtures pass |
| Diff timeline | ✅ | DiffPanel Current/Timeline, activity sparkline, per-file +/- |
| Interactive plan review | ✅ (message-based) | PlanPanel approve/request-changes → steer/prompt |
| Provider/model compare | ✅ | ModelCompare matrix, 7 tests pass |
| Agent-RPC exposure | ✅ | 7 read-only commands added (`get_skills/hooks/mcp_servers/plugins/marketplaces/prompt_templates/memory_report`) in coding-agent; binary rebuilt |

### Remaining (blocked on deeper agent RPC — next cycle)

- **vibe/goal/loop mode panels** — these modes are `handleTui`-only; no RPC
  carries their state. Needs agent-side RPC (install mode handlers + expose
  mode state/events), then panels.
- **Structured plan approval** — plain RPC `set_plan_mode` never installs a
  plan-proposal handler (`rpc-mode.ts`), so the TUI approve-and-execute popup
  has no RPC path. Plan review is currently message-based. Needs a sidecar
  change (install handler + emit proposal as an RPC event).
- **Drag session tree** — SessionTreeDialog (P0) is a lineage list; drag-based
  rearrange is a further UX build.
- **set_* domain actions** — Extensions/Inventory panels are read-only; enable/
  disable/install need set_* RPC (e.g. `set_skill_enabled`, `mcp_action`).

---

## FINAL WAVE OUTCOME (2026-08-03) — ALL REMAINING DELIVERED & VERIFIED

### Agent-RPC unblocked (coding-agent, binary rebuilt)

- **Plan approval**: `plan_proposal` event {planFilePath, title?, planContent,
  options[]} + `plan_approval` {approved, option?, feedback?} — full TUI
  approve-execute/compact/keep_context/refine port (rpc-plan.ts).
- **Mode state**: `get/set_vibe_mode`, `get/set_goal` {objective?, tokenBudget?,
  action?}, `get/set_loop_mode` {enabled, args?} + `loop_mode_update` event
  (rpc-modes.ts).
- **Domain actions**: `set_skill_enabled`, `set_hook_enabled` (persist; binds
  next session — no live rebind exists anywhere, same as TUI),
  `set_plugin_enabled`, `mcp_action` {enable|disable|reconnect|remove}
  (rpc-actions.ts).
- **Session tree**: `get_session_tree` → {tree:[{entryId, parentId (nearest
  included ancestor), role, textPreview, timestamp, onActiveBranch, isLeaf}],
  activeLeafId} (rpc-session-tree.ts).
- **Subagent parent link**: `parentSubagentId` on lifecycle/progress frames →
  true nested DAG edges.

### GUI delivered

- **ModesPanel** (vibe/goal/loop tabs) — real get/set mode RPC + live events.
- **PlanApprovalDialog** — structured plan approval popup (11 tests).
- **Extensions/Inventory interactive** — skills/hooks/plugins toggles + MCP
  enable/disable/reconnect/remove menus (set_* + live re-fetch).
- **SessionTreeDialog** — visual branch tree (pan/zoom/drag, feature-detects
  get_session_tree with flat fallback; 8 DOM + 31 layout tests).

### Verification
- `tsc --noEmit` = 0 (gui); `bun run build` = 0; `vitest run` 78/78 (9 files).
- CDP live: ModesPanel Goal (start form) + Loop (state off) real data; Skills
  8 interactive toggles; session tree visual canvas; dual-process closed loop.

### Honest caveats
- `set_hook_enabled` is persist-only (no live rebind exists — same as TUI).
- `mcp_action remove` is project-scope (wire has no config-scope field).
- Structured plan approval verified at component (11 tests) + RPC (56 smoke)
  + wiring (sidecar forwards plan_proposal); the live end-to-end
  plan→approve flow needs an agent turn to produce a plan (not exercised).

---

## FIX WAVE OUTCOME (2026-08-03) — user-reported gaps, DELIVERED & VERIFIED

### ① Settings dropdowns ("manual input" complaint)

- Enum→`<select>` already worked (named tabs carry 5–18 selects each).
- Real gap: model/provider-referencing STRING settings were free text. Now
  `ModelValueSelect` renders them as searchable dropdowns populated from
  `get_available_models` (verified live: 40 models listed) / `get_providers`.
  Converted exactly 3 (providers.webSearchGeminiModel, mnemopi.llmModel,
  mnemopi.embeddingModel) — schema sweep proof, zero false positives; enum
  *Model settings keep native select; secrets stay password.

### ② Third-party provider add/configure

- New `main/models-config.ts` reads/writes `~/.omp/agent/models.yml`
  (`yaml` pkg); agent live-reloads on mtime. New IPC
  `models:listProviders/upsertProvider/deleteProvider` + `window.omp.models.*`.
- `ProviderConfigDialog` (list + add/edit/delete form: id, api protocol select,
  baseUrl, apiKey masked+preserved, models editor, headers). "Add provider"
  button in ProvidersWindow + `add-provider` command.
- Verified live via CDP: add wrote a correct models.yml entry; list masks keys
  (•••last4); delete round-trip; builtin ids rejected.

### ③ i18n switcher + coverage

- `LangSwitcher` (EN⇄中文, persists) mounted in TitleBar + Settings GUI tab.
  Verified live: sidebar re-rendered English on toggle.
- 112 new keys/locale (real Chinese) internationalizing TitleBar/Sidebar/
  InputArea + 9 new components; en/zh parity 635/635 guarded by a new vitest
  locale-parity test.

### Verification
`tsc --noEmit` = 0; `bun run build` = 0; `vitest run` 91/91 (12 files); CDP
live: settings dropdown lists 40 models; provider add→models.yml→delete;
LangSwitcher EN⇄中文.

---

## SETTINGS-PAGE OVERHAUL OUTCOME (2026-08-03) — user screenshot issues, DELIVERED & VERIFIED

### ① Fullscreen layout ("铺开, 铺满, 不要弹窗")

SettingsWindow rewritten from a centered `Modal` (h-62vh) to a full-viewport
settings PAGE: `fixed inset-0` overlay — header (title + close), LEFT vertical
tab rail (13 tabs), RIGHT scrollable content (max-w-3xl centered). Escape +
close button dismiss (custom, no Modal). Verified live: bounding rect
0,0,1800×1032 = exactly the viewport.

### ② Comprehensive i18n ("i18n 不全, 大量地方没做")

- Window chrome + 13 tab labels + Runtime tab + GUI tab (Main).
- Schema content: 53/53 group titles + 332/332 named-tab setting
  labels/descriptions translated (SchemaI18n, via a zh-only `schema-zh.ts` map
  with English fallback; Advanced tab's 117 obscure settings stay English by
  design). Verified live: Tools tab group "可用工具" + all-Chinese setting
  labels/descriptions.
- Broader components: ~60 files wired to useT (all dialogs, stats
  dashboard+routes, chat chrome, tool renderers, panels, common,
  UsageWindow/ProvidersWindow/ModelValueSelect) — BroaderI18n, ~435 keys/locale.
- Locales parity guarded: en/zh = 1151/1151, parity test green (now 26+
  namespaces).

### ③ Input optimization ("不能手输 JSON / 可穷举必须下拉")

- `ArrayChipEditor` — array-of-strings (disabledProviders, enabledModels, …)
  → chip/tag editor (verified live: chips render, zero JSON textareas on the tab).
- `RecordKvEditor` — flat record (tools.approval) → key-value rows; enum-valued
  (allow/prompt/deny) → per-row dropdown.
- Complex nested arrays stay validated JSON (documented fallback).
- Enum → native select (already worked); model/provider strings → searchable
  dropdowns (prior wave); tools.approval enum-valued record → dropdowns.

### Verification
`tsc --noEmit` = 0; `bun run build` = 0; `vitest run` 93/93 (12 files, incl. 2
new zh-i18n tests); CDP live: fullscreen rect = viewport; Tools tab fully
Chinese; chip editor renders; enum dropdowns present.

---

## ENUMERABLE→DROPDOWN + ADVANCED-I18N OUTCOME (2026-08-03) — DELIVERED & VERIFIED

User: "these are obviously dropdowns, why make me hand-write", "translation
incomplete", "modelRoles values shouldn't be hand-typed".

- **theme.dark / theme.light → theme dropdown** (EnumerableSelect) fed by NEW
  agent RPC `get_themes` (getAvailableThemesWithPaths, builtin+custom). Binary
  rebuilt. Verified live: dropdown opens the real theme list (titanium,
  dark-abyss, dark-catppuccin, dark-dracula, …).
- **shellPath → shell dropdown** (common shells + custom-allowed).
- **modelRoles (model-valued record) → model dropdown per value cell**
  (RecordKvEditor `valueKind="model"` → ModelValueSelect). Verified live: 10
  role value dropdowns open the 40-model catalog.
- **Advanced tab i18n**: schema-zh.ts extended to ALL 117 Advanced settings
  (ZH_SETTINGS now 449 = 332 named + 117 Advanced). Verified live: Advanced tab
  fully Chinese with proper nouns preserved.
- **New `EnumerableSelect` editor** (searchable dropdown for enumerable string
  settings) + `settings.editors.*` keys.
- **Bug fixed**: pressing Escape inside a dropdown closed the whole settings
  page (fullscreen shell's capture-phase Escape handler raced the dropdown's).
  Now the shell skips when a `[role=listbox]` is open — first Escape closes the
  dropdown, second closes the page. Verified live.

### Verification
`tsc --noEmit` = 0; `bun run build` = 0; `vitest run` 93/93; CDP live: theme
list opens; 10 model dropdowns in modelRoles; Advanced fully Chinese; Escape
closes dropdown-then-page correctly.

---

## CHAT-HISTORY REVIEW OUTCOME (2026-08-03) — "can't see previous messages", DELIVERED & VERIFIED

**Root cause**: `get_messages` returns `agent.state.messages` = the LLM context
window (`buildDisplaySessionContext`), which truncates after compaction — so
the GUI only ever showed the recent window, never the full history.

**Fix**: new agent RPC `get_transcript` returning
`buildTranscriptSessionContext().messages` — the full display history
(session-manager: "with { transcript: true } — the full-history display
transcript"). Binary rebuilt. GUI `ChatStream` + `hydrateSession` now hydrate
display from `getTranscript()` instead of `getMessages()`.

**Verified live**: on a 1880-message session, getTranscript=1880 ⊇ getMessages=1876;
the GUI loads all 1880 into the store (virtualizer scrollHeight ~240k px) and
scrolling to the top shows the session's FIRST message. Streaming/new-message
append unaffected (same store path). Tests: added `getTranscript` to the
dialog-test mocks (ForkHandoff/SessionTree). `tsc`=0, `vitest`=93/93, build=0.

---

## NOTICE-NOISE FILTER OUTCOME (2026-08-03) — "vision/xdev toasts on every model switch", DELIVERED & VERIFIED

**Problem**: every model switch (or GUI open) flooded the bottom-right toast
stack with `vision: inspect_image is now available/hidden…` and `xdev: xd://:
mounted/unmounted inspect_image` — routine mount/unmount reconciliation
(`session-tools.ts reconcileInspectImageAfterModelChange`, level info, source
vision/xdev). No user action needed; pure churn.

**Fix**: `use-rpc-events` notice handler now drops info-level notices from a
`QUIET_NOTICE_SOURCES = {"vision","xdev"}` set. Warnings/errors and notices
from any other source still toast (code path unchanged).

**Verified live**: `cycleModel` (which fires the vision/xdev mount notices)
produced ZERO vision/xdev toast cards and no `inspect_image is now…` text in
the DOM. `tsc`=0, `vitest`=93/93.

---

# FULL-CHAIN AUDIT + OPTIMIZATION (2026-08-03) — architecture / feature / design / layout / color / performance

Five parallel scouts audited every dimension with file:line evidence; findings
were synthesized and fixed across 4 optimization workers + Main. All verified:
`tsc`=0, `vitest`=93/93, `bun run build`=0, CDP live.

## Headline wins

- **Eager bundle 3.85MB → 739.71 kB (-81%)**: manualChunks vendor splitting
  (react/codemirror/katex/markdown/charts/highlight/dnd-kit) + React.lazy for
  every heavy overlay (SettingsWindow, StatsDashboard, ModelCompare,
  Extensions/Inventory/Modes panels, Usage/ModelRoles/Providers windows).
- **Message correctness (P0)**: `agent_end` was replacing the full transcript
  with run-scoped messages (history wiped at turn end) — now append-merges via
  suffix/prefix overlap; `turn_end` cross-batch duplicates deduped by identity
  key; streaming text moved to append-only buffers (no O(n) re-concat).
- **Hydration races**: streamed messages now survive hydration (prefix+key
  merge); `model_changed` no longer refetches the full transcript (light
  get_state sync); restart resets all session stores (incl. extension-ui,
  plan-approval).
- **FilesPanel real fs IPC** (`fs:list`/`fs:read`, node:fs, gitignore-aware,
  cross-platform) replacing the agent bash RPC (`find|head`).
- **extension-UI setStatus/setWidget** now surfaced (was silently dropped).
- **a11y**: pickers get full keyboard nav + dialog semantics; ChatStream
  aria-live storm removed; SettingsWindow focus trap; EnumerableSelect correct
  listbox semantics.
- **Settings global search** across all tabs (TUI type-to-search parity) +
  fullscreen page (was a small modal).
- **Color**: dim/muted/danger contrast fixed to ≥4.5:1 in light/titanium/nord/
  solarized; Bash/Eval/Button/Modal/global/components/index.html/chart all
  token-driven (no hardcoded colors); boot bg scheme-aware.
- **Event pipeline**: sidecar Set hoisted; session-index notifies only on real
  change (5s unconditional→signature-gated 10s); log lines batched 150ms
  (replaces per-line IPC); LogPanel follow-scroll fixed; subagents.frames dead
  array removed; tools Map lazy-copy.
- **Feature completion**: ⌃P model cycle bound; extensions/agents/plan-review
  nativized (were TUI-only); command-registry stale entries cleaned; TitleBar
  plan+context% segments; 800px TitleBar crush fixed (shrink-0).

## Verification
`tsc --noEmit`=0 (all changes incl. themes); `vitest run`=93/93 (12 files);
`bun run build`=0 with full chunk split; CDP live: app boots, lazy SettingsWindow
loads on demand (Chinese fullscreen), settings global search returns cross-tab
results, no vision/xdev toast spam on model switch.

---

# VISUAL DESIGN OVERHAUL (2026-08-03) — default-light + refined palette + component design

User: "default to white not dark; the color scheme is too AI/cheap; redesign
buttons/colors/chat-rendering/inputs/borders/spacing/typography."

### ① Default light
- App default is light (ui store + getPersistedThemeSelection fallback); boot
  pre-paint background flipped from dark (#11151c) to white so no dark flash.

### ② Refined palette (de-AI)
Rewrote theme-light.css + lib/themes.ts `light` entry (119 tokens, identical):
- Warm paper neutrals (#ffffff/#faf9f8/#f2f0ed surfaces, warm hairline borders
  #e5e2dc) — NO cobalt-blue surface tints (selected/user-msg/sidebar-active all
  neutral now, was blue #eaf2ff/#eff5ff).
- Deep teal accent #0f766e (replaces saturated cobalt #2563eb) used sparingly.
- **Near-black primary buttons #21262c** (was blue accent) — the single biggest
  de-generic move; secondary = neutral surface + hairline.
- De-purpled: md-code purple #7c3aed → warm #9d4e15; thinking-high/xhigh
  purple → warm amber tones; status-model kept a refined deep violet.
- Refined syntax + thinking-level + status token sets.

### ③ Component design polish (all token-driven, zero hardcoded colors)
- Button: 8px radius, refined sizing, top-edge inner highlight, hover/active,
  teal focus ring; secondary hairline; danger via error tokens.
- Input: 8px radius, comfortable padding, teal focus ring, error uses error tokens.
- MessageBubble: symmetric 12px user bubble (warm neutral, hairline+shadow,
  max-w 75%); assistant ink-tile avatar, editorial prose; refined meta rows.
- CodeBlock: 8px radius, language badge top-right, hover copy, 12.5px mono.
- ToolCard: true 2px left rail, 10px radius, refined header.
- InputArea composer: 12px radius, near-black send button (was teal), softened shadow.
- Modal: 14px radius, refined title/shadow/animation. components.css: markdown
  hierarchy (h5/h6), editorial blockquote, refined pre/table/links, consistent radius+rhythm.
- Typography: body 14.5px / 1.62 line-height with OpenType features.

### Verification
`tsc`=0, `vitest run`=93/93, `bun run build`=0. CDP visual: data-theme=light by
default, accent #0f766e, near-black "新建会话"/send buttons, warm-neutral user
bubble, clean code block, teal composer focus ring — confirmed no blue AI tint.

---

# DENSITY COMPRESSION + COLOR TUNING (2026-08-03) — "layout can be compressed/simplified, colors optimized"

- **Composer (the pointed-out teal glow)**: the prominent `--omp-shadow-glow`
  focus ring (1px border + 14px teal glow) → a subtle 1px `--omp-border-accent`
  ring, no glow; radius 12→8px, min-height 52→44px, padding pt-3.5→2.5/pb-2→1.5,
  toolbar min-h-12→10, gap 1.5→1. Verified: focus shows a thin teal border, no glow.
- **Sidebar**: width 280→248px; header h-52px→h-12; section spacing tightened;
  "新建会话" primary button bg-accent(teal)→**near-black btn-primary-bg**
  (consistency with the button system); search input h-9→h-8 + glow removed;
  scope toggle + session items tightened (py-2.5→2, rounded-xl→lg).
- **TitleBar**: header h-52px→h-12, icon buttons h-9→h-8, gap-2→gap-1.
- All token-driven (no hardcoded colors).

### Verification
`tsc`=0, `vitest run`=93/93, `bun run build`=0; CDP visual: composer thin teal
border (no glow), shorter; sidebar 248px with near-black primary button;
 titlebar tighter; layout visibly denser and cleaner.

---

# BREADCRUMB WORKSPACE FIX (2026-08-03) — "breadcrumb doesn't follow the session's real workspace"

**Root cause**: TitleBar's workspace label used the **sidecar process cwd** (the
GUI's launch dir) via `setStatus`, which never changes on session switch — so
resuming a session in another workspace still showed the old dir.

**Fix**: agent `get_state` now returns `cwd: session.sessionManager.getCwd()`
(the session's real recorded workspace). GUI `sessionStore.setFromState` sets
`cwd` from it, so the TitleBar breadcrumb (`basename(cwd)`) reflects the
session's actual workspace and updates on every GUI session switch
(sidebar `openSession` = switchSession + hydrateSession → getState → setFromState).
Binary rebuilt. Types updated in both rpc-types.ts + gui shared/rpc-types.ts.

**Verified live**: after switching to a Norn-project session the breadcrumb
shows "Norn > Commit and push changes"; switching back to an oh-my-pi session
via the sidebar shows "oh-my-pi" (live update, no reload). get_state cwd
matches the session's real workspace in all cases. `tsc`=0, `vitest`=93/93.

---

# SIDEBAR REDESIGN (2026-08-03) — search+new row, workspace grouping, compact list, moved utilities, i18n fix

1. **Search + new-session on one row**: search input (flex) + near-black "+"
   icon button on the right (was a full-width stacked button + separate search).
2. **Local/Global toggle removed** → Codex-style **workspace grouping**: sessions
   grouped by `cwd` (basename header + count + chevron), most-recent workspace
   first, current workspace expanded, others collapsed by default, collapsible.
3. **Compact session list**: title-only rows (description/summary line removed),
   tighter spacing (py-1.5, space-y-0.5), status dot + time + hover pencil
   (inline rename for the ACTIVE session via setSessionName) + trash.
4. **文件/统计/日志 moved out of the left footer** → Files/Logs live in the right
   workspace drawer tabs, stats via titlebar; left bottom is now a compact
   utility row (files / stats / theme / language / settings icons).
5. **i18n "中文" two-line squeeze fixed**: LangSwitcher moved from the crowded
   TitleBar to the sidebar bottom utility row AND made `whitespace-nowrap` — it
   can no longer wrap to two lines. Sidebar width 248→236px.

**Verified live**: search+"+" one row; workspace groups oh-my-pi(6)/gui(3)/
Norn(7 expanded, current)/Infron(10)/… collapsed; title-only compact items with
hover rename+delete; utility icon row at bottom; no text 文件/统计/日志 footer;
TitleBar decluttered. `tsc`=0, `vitest run`=93/93, `bun run build`=0.

---

# WORKSPACE GROUP DELETE + ICON DIFFERENTIATION (2026-08-03)

1. **Workspace groups are deletable as a whole** (stops infinite proliferation):
   each group header gets a hover trash button → confirmation modal showing the
   workspace name + session count + a permanent-deletion warning → deletes every
   session file in the group (sequential `deleteSession` loop) and removes it
   from the list. Verified: modal shows \"Delete workspace 'oh-my-pi' and all 6
   sessions — permanent, cannot be undone\"; cancel path safe.
2. **Duplicate globe icons fixed**: the theme-picker utility button now uses a
   **Palette** icon while the language switcher keeps **Globe** — no more two
   identical globes in the bottom utility row.

`tsc`=0, `vitest run`=93/93, `bun run build`=0.

---

# UNIFIED π LOGO (2026-08-03)

- Designed a proper **π SVG** (clean geometric glyph: top bar + two legs with a
  curved right foot, rounded strokes, crisp from 12px favicon to 512px icon) as
  a single `PiLogo` component (size/color/tile props, teal on near-black tile).
- Unified every usage to it: sidebar tile, empty-chat logo, redesigned
  `resources/icon.svg` (was a gold π on dark — replaced with teal-on-ink),
  inline SVG `favicon` in index.html. Exported from the common barrel.
- Verified: sidebar tile + empty-chat logo render the same teal π SVG; no more
  inconsistent gold/font glyphs. `tsc`=0, `vitest run`=93/93, `bun run build`=0.

---

# APPROVAL CONTROL + WORKSPACE MANAGER (2026-08-03)

## ① Runtime approval-mode control (Codex-style "full access")

- `tools.approvalMode` is a schema setting the agent reads **fresh on every
  approval decision** (session-tools.ts:569, agent-session.ts:3117), and
  `set_setting` applies to the live session in-memory + flushes. **Verified
  `set_setting("tools.approvalMode")` applies at runtime** (getSettings reads
  back the new value immediately — no restart).
- Removed the sidecar `--approval-mode` spawn flag (it was highest-precedence
  and would override set_setting); legacy `approvalMode` pref is migrated into
  the config setting once by the composer control.
- New **`ApprovalControl`** composer chip (Shield): shows current mode, dropdown
  of yolo / write / always-ask → setSetting. Settings → GUI approval section
  switched from prefs to set_setting too; note text updated to "applies
  immediately". Verified: picking 每次询问 read back `always-ask` at runtime,
  restored yolo.

## ② Workspace manager (Codex-style)

- New `SIDECAR_SET_PROJECT` IPC: validates the dir exists (async fsp.stat), then
  lastProject + sessionIndex.setCwd + sidecar.restart(path) — same proven tail
  as select-project but for a KNOWN path (no native picker).
- New **`WorkspaceDialog`**: lists every known workspace (deduped session cwds +
  current project, sorted by recency) with name, session count, path, and a
  "current" badge; "Add workspace…" opens the native picker. TitleBar breadcrumb
  project button now opens this dialog instead of the bare native picker.
- Verified: dialog lists 8 workspaces (oh-my-pi/Infron/gui/…) with counts +
  paths, gui badged current; `setProject(cwd)` returned true and the sidecar
  restarted + reconnected ready in the same cwd.

`tsc`=0, `vitest run`=93/93, `bun run build`=0.

---

# SYSTEM TRAY EXPANSION + APPROVAL PORTAL FIX + APP IDENTITY (2026-08-03)

## ① Rich system-tray menu (Codex-style quick access)
- Renderer pushes a `TrayState` snapshot (status/model/thinking/fast/approval/
  context% + tokens/workspaces/language) to main via a new fire-and-forget
  `TRAY_STATE_PUSH` channel (`useTraySync` hook); main caches it and rebuilds
  the native tray menu on every change, so it's always fresh when opened.
- Menu: status header · config info (model·thinking / fast·approval) · context
  % + tokens · Usage Stats… · **工作区跳转** submenu · **快速开始** (new/open/
  handoff) · **快速配置** (fast checkbox, thinking cycle, approval radios,
  language toggle) · Show/Hide · Quit. Labels translated in main from the pushed
  language. Actions route back to the renderer via MENU_ACTION (now an envelope
  `{action, ...payload}` — menu.ts + tray.ts both updated).
- `approvalMode` moved into the shared settings store (`setApprovalMode` →
  set_setting, pref migration) so ApprovalControl + tray share reactive state.
- Verified via AppleScript on the real menubar: 15 top items incl. `kimi-k3 ·
  思考强度 max`, `工具审批: 完全访问`, `上下文: 2% · 20.2k tokens`, 工作区跳转 /
  快速开始 / 快速配置 submenus — all in Chinese matching the app language.

## ② Approval dropdown clipping fix
- The composer approval dropdown was clipped by the composer's overflow-hidden.
  Rebuilt `ApprovalControl` to render the menu in a `createPortal` on
  document.body, fixed-positioned from the trigger rect (z-100). Verified: all 3
  options fully visible, `clippedAboveViewport: 0`.

## ③ App identity (name + icon)
- Designed a mac-style π icon (teal π on ink rounded tile with margin) and
  generated it from SVG via `scripts/gen-icons.ts` (sharp → icon.png 1024px,
  iconset → `iconutil` → icon.icns, linux PNG set). `bun run gen:icons`.
- `electron-builder.yml` productName → `omp`; mac icon → resources/icon.icns.
- main: `app.setName("omp")` + `app.dock.setIcon(icon.png)` on darwin in dev.
- Verified: `app.getName()="omp"`, dock.setIcon called with valid π PNG (dev
  dock tile now π). **Dev limitation**: the macOS app-menu title + dock *name*
  still read "Electron" because macOS uses the Electron bundle's CFBundleName
  for a running dev binary — and this repo's GUI electron is a symlink into
  `litellm-desktop/node_modules`, so patching the bundle would wrongly brand a
  cross-project binary. Fully resolved in packaged builds (productName=omp +
  baked icon.icns).

`tsc`=0, `vitest run`=93/93, `bun run build`=0.

---

# P0 — CONFIRMED-BUG FIXES (2026-08-03, TUI-parity plan P0)

- **Unwrapper (P0.1)**: `resultText` now unwraps the `{content,details}` envelope (recurses content array, skips non-text blocks); `resultDetails`/`resultBodyText` centralized in lib/format, re-exported via tools/result.ts. Contract test format.test.ts 6/6.
- **Hydration (P0.2)**: tools store keeps the full `{content,details}` envelope (was `content ?? details`) → history no longer loses diffs/exit-codes/todo-phases.
- **Renderers (P0.3-6)**: todo reads `details.phases` (was args.phases → permanently empty); edit reads `details.diff` via DiffView (multi-file/delete/move/edits[]/apply_patch); new AstEditRenderer (replacements/files/change-groups/parse-issues/limit); 7 extractors rewired to details (bash stats line, lsp typed, debug snapshot/frames/vars, hub dispatch, web_search answer+sources+meta, github entity/watch, memory op).
- **Scrubbing (P0.7)**: history persist filters `/login`/`/join`/`/mcp add --token` + hydrate drops legacy persisted secrets (input-history.test.ts 10/10).
- Verified: tsc=0, vitest 109/109, CDP live — bash card shows structured stdout, NO {content,details} JSON blob.

---

# P1 — EASY WINS (2026-08-03, TUI-parity plan P1)

- **Desktop notifications (P1.1)**: turn-complete/error/ask via `system.notify`, gated by window-focus + GUI master pref (Settings GUI tab) + agent schema settings (completion/error/ask.notify read live). Mirrors TUI event-controller logic.
- **@ file autocomplete (P1.2)**: fuzzy project-file completion via `fs.list` IPC (debounced, per-cwd cache, subsequence-rank, cap 20) above the 6 scheme entries. CDP-verified live ("@App" → file list).
- **Top keybindings (P1.3)**: ⇧Tab thinking-cycle (composer-scoped), ⌥R retry (shared lib/messages.ts), ⌥⇧P plan toggle, ⌃O expand-all-tools (ui store + ToolCard sync), ⇧⌃P model (forward-only; backward is an RPC gap, TODO).
- **rehype-raw subset (P1.4)**: rehype-raw + rehype-sanitize strict whitelist (br/p/ul/ol/li/code/pre/hr/blockquote/span/inline-semantics/a-safe-href; script/iframe/on*/style/javascript: dropped) — raw HTML subset renders, XSS closed (25/25 worker assertions), GFM/katex/highlight intact.
- Verified: tsc=0, vitest 109/109.

---

# P2 — RENDERING RICHNESS (2026-08-03, TUI-parity plan P2)

- **Mermaid (P2.1)**: ```mermaid fences render as real SVG via lazy `import("mermaid")` (theme-aware re-init on flip, fnv1a SVG cache LRU-50, strict sanitize — hostile fences neutralized, SSR-guarded CodeBlock fallback). CDP-verified live (flowchart → SVG `omp-mermaid-0` with Start/End nodes).
- **Rich diff (P2.2)**: lib/diff.tsx rewrite — dual old/new line-number gutter, intra-line word highlight (`diff` pkg), leading-whitespace viz (·/→), context-line syntax highlight (shared lazy hljs → new lib/highlight.ts), `@@` gap ellipsis rows, 3000-row cap. Fixed SplitDiff `123|` leak. 27/27 smoke.
- **Custom message cards (P2.3)**: CustomMessageCard dispatcher + per-type bodies — advisor (severity badges/collapse), async-result (job rows + preview), LSP late-diagnostics (severity-sorted, 5-cap), skill (collapsed prompt), collab (author bubble), IRC (incoming/autoreply/relay), handoff (`<handoff-context>` extraction, no raw tags). 26 SSR assertions.
- **vibe_* + task tree (P2.4)**: all 5 vibe_* ops (VibeRenderer: spawn/send ack, wait TV-wall, kill, list) registered; TaskRenderer rewrite — live agent tree (per-agent stats/retry countdown/nested trees/yields/review) + run-summary footer. 12 SSR scenarios, 52 i18n keys.
- **Thinking polish (P2.5)**: lib/thinking.ts (prose-only elision 72/72 TUI-equivalent, hidden-pulse eased starburst, SpeedTracker tok/s gauge); fixed ChatStream live-thinking dead code; added CONFIG_UPDATE push (ipc-types/sidecar/ipc/preload) so settings edits re-render ThinkingBlock live.
- Verified: tsc=0, vitest 109/109, build 0 (mermaid 6.3MB lazy chunk, main 969KB).

---

# P3 — RPC/AGENT ADDITIONS (2026-08-03, TUI-parity plan P3, Track B)

Agent-side (coding-agent rpc-types.ts/rpc-mode.ts, type-clean; GUI runs via source sidecar):
- **fork**: `{type:"fork"}` session-change command → session.fork(). CDP-verified live (new session created).
- **eval** + **abort_eval**: `{type:"eval",language,code,excluded}` routes python through the exact TUI path (session.executePython), background-dispatched; abort_eval = bash analog. CDP-verified live (`$ print(6*7)` → real eval, output 42, not prompt-wrapped). Non-python → explicit error.
- **dequeue**: `{type:"dequeue"}` → session.clearQueue (Alt+Up semantics) → returns queued messages in restore order.
- **/queue**: added text-mode `handle` → now RPC-executable + advertised (streaming→followUp, idle→start-immediately). /plan documented as covered by the RPC-native set_plan_mode.
- **askDialog**: new extension_ui_request/response variant `{method:"askDialog",questions}` + RpcExtensionUIContext.askDialog method (multi-question bridge).

GUI wiring:
- fork → palette action (forkSession: rpc.fork + hydrate + toast).
- eval `$`/`$$` mode → rpc.eval directly + running ExecutionBubble (pulsing pill + Cancel→abortEval); deleted buildPythonModePrompt.
- dequeue ⌥Up → restoreQueuedMessages (last queued → composer via fill-composer, earlier → re-queue via followUp, empty toast).
- askDialog → multi-question AskDialog (single-radio/multi-checkbox/recommended/custom/note/unanswered/timeout) in ExtensionDialog.
- /queue → prompt-forward in palette (invocable, session category).

Verified: agent `bun run check:types` rpc files clean; GUI tsc=0, vitest 109/109; fork+eval CDP-verified live via source sidecar. **Distribution note**: the new RPC commands require rebuilding the bundled binary (`bun run build:omp`) for the packaged GUI; the source sidecar has them now.

---

# P4 — POLISH (2026-08-03, TUI-parity plan P4)

- **Settings fidelity**: ordered multiselect reorder (ArrayChipEditor + agent `ordered` projection); ProviderLimitsEditor (TUI parity); condition-gated visibility (agent carries `condition` in rpc-extensions + GUI isSettingVisible live-eval, 39 gated entries); theme live preview (ephemeral apply/revert).
- **AgentHubWindow** (new, lazy, 2 tabs): Definitions (enable/disable/model-override/prewalk via task.* settings RPC) + Hub (live subagent table + abort); `agents` command opens it. Gaps (no definitions-discovery/revive/per-agent-abort RPC) noted in-UI.
- **Integrations**: audited all 14 capability providers; added the one reachable uncovered provider (custom slash commands) as a Commands tab; mcp/marketplace list-verbs → native windows. Remaining 7 providers have NO RPC (honestly noted, not fabricated) — RPC-boundary limit reached.
- **Session tree + search**: tree filter modes (all/current/user/labeled), label edit (new set_entry_label RPC), keyboard nav; session search upgraded to fuzzy + full-transcript content grep (new main-process session-file grep IPC), scope/sort/path toggles.
- **Regression fixes**: lib/theme.ts top-level `window.matchMedia` made SSR-safe (was breaking SettingsWindow SSR test); SessionTreeDialog test targeted the footer Branch button specifically (worker added a per-node hover "Branch" button that shadowed the text query).
- Verified: agent `bun run check:types` rpc files clean; GUI tsc=0, vitest 113/113, build 0.

---

# FULL-CHAIN AUDIT + FIX (2026-08-04) — usage/render/logic/function/config/UX/UI

7 parallel auditors (composer/render/session/config/panels/ux/polish) + live smoke found **~46 confirmed issues**; 5 parallel fix workers + targeted fixes landed all of them. Verified: BLOCKER (approval) live-tested (Approve now runs the tool, no denial), tsc=0, vitest 108/108, build 0.

**BLOCKER**: ApprovalDialog Approve button responded `{confirmed:true}` but the select parser only honors `value`/`cancelled` → every approval was denied. Fixed to `{value:"Approve"}`/`{value:"Deny"}`; live-verified bash runs on Approve.

**MAJOR (logic/state)**: deep links (omp://) — broken URL parsing (hostname vs pathname) + no consumer → full parse fix + onDeepLink bridge + App.tsx handler; Escape aborting the running turn when dismissing palette/dropdowns/inline-edits → defaultPrevented guard; fast-mode + approval-mode desyncs (composer/tray/palette/Settings ignored the RPC response) → shared toggleFastMode + store.applyApprovalMode + config_update re-syncs approval; workspace group delete could delete the ACTIVE session file → guard (active/streaming); session-tree branch on assistant nodes (sidecar is user-only) → role-gated; switch/branch hook-veto (cancelled:true) silently re-hydrated → all 4 call sites check cancelled.

**MAJOR (render)**: GrepRenderer rewrote to details.* (was parsing legacy text → 0-match); CodeBlock now actually injects hljs highlight; KaTeX via added remark-math + katex CSS; live tool cards now render during arg-stream (dead StreamingRows path); GenericRenderer unwraps envelope; StreamingText px-4/85%→matches finalized geometry; streaming caret inline.

**MAJOR (panels)**: TodoPanel syncs agent todos (agent_end refresh + todo_auto_clear→setPhases([])); PlanPanel reads plan via fs:read-plan IPC (was rpc.bash polluting context+transcript); DiffPanel reads details.diff (was raw args → replace-mode edits vanished); palette toggles applyToggle (check success + apply returned state); Edit-config button → models.openConfig IPC; stats Sync no longer false-success; SubagentTranscript keeps refresh for running agents; EditorDialog keyed per request.

**MINOR/POLISH**: Tabs -mb-px; sidebar media min-width; ExtensionDialog→Modal px-5; PanelContainer separator hidden ≤1000px; panel-default pref hydrated at boot; theme radio→applyThemeByName; goal/plan chips sync server state (no more stuck-on); More chip highlights only on non-default; ⌃O→⌃⇧O (native shadow); RecordKvEditor stable keys; ModelRolesWindow loads models; menu/tray target focused window + create-window-when-closed; notification dedup across windows; dead code removed (ForkDialog, StatsPopover, palette recents plumbing→Recents section). Verified: tsc=0, vitest 108/108, build 0.

---

# COMPOSER QUICK-ACCESS CLUSTER (2026-08-04)

The composer toolbar now surfaces the most coding-relevant toggles that were buried in Settings:
- **Plan** (toggles plan mode, syncs titlebar badge), **Goal** (opens goal panel, active-state highlight), **Roles** (opens model-roles window), and **More** dropdown (auto-compact / auto-retry / steering / interrupt toggles).
- Each mirrors the exact RPC + store sync used by Settings/palette so state stays consistent (session store goal/goalState fields added for the Goal chip).
- New `ComposerModes` component; i18n en+zh. Verified: chips render, Plan toggle flips rpc planMode, More dropdown shows 4 toggles. tsc=0, vitest 113/113, build 0.

---

# MODAL BODY PADDING — COMPREHENSIVE ALIGNMENT (2026-08-04)

The confirmation dialogs' body text was flush to the modal edges (Modal body had no padding; the title bar had px-5). Comprehensive fix:
- **Modal body now defaults to `px-5 py-4`** (aligning with the title bar's px-5) via a new `bodyClassName` prop (overridable).
- **Simple content dialogs** (delete confirmations, WorkspaceDialog, PlanApproval, provider-delete confirm) get uniform title-aligned padding automatically.
- **Removed redundant self-padding** from Approval/Handoff/RenameSession/SessionInfo/Usage/ModelCompare/ModelRoles/Providers (they now use the Modal's uniform px-5).
- **Complex / own-layout dialogs** (Settings, ModelPicker/SessionPicker/BranchPicker chromeless, SessionTree/AgentHub/ModesPanel/FilesPanel/Inventory/Extensions/StatsDashboard/ExtensionDialog×6/ProviderConfigDialog) get `bodyClassName="p-0"` to preserve their internal layouts (no double-padding).
- Verified: WorkspaceDialog body padL=20/padT=16, body content left = title text left (both 661) — aligned. tsc=0, vitest 113/113, build 0.

---

# "+" BUTTON → WORKSPACE PICKER (2026-08-03)

- The sidebar "+" (new session) no longer default-creates in the current
  workspace — it opens the **WorkspaceDialog** in a new `"new-session"` intent
  (title "新建会话 — 选择工作区"), so every new session starts by choosing a
  workspace, matching the breadcrumb's picker.
- `WorkspaceDialog` gained an `intent` prop: `"new-session"` picks the CURRENT
  workspace via `rpc.newSession()` (no restart); picking another workspace uses
  `setProject` (the sidecar restart boots a fresh session there — that IS the
  new session, since `omp --mode rpc-ui` always boots a fresh session).
  `"switch"` (breadcrumb) is unchanged. Sidebar's own `newSession` removed.
- Verified live: "+" opens the picker (all workspaces + 当前 badge); picking
  gui (current) closed the dialog and landed on the empty state with a fresh
  sessionId; breadcrumb shows "gui › 新建会话".

`tsc`=0, `vitest run`=93/93, `bun run build`=0.
