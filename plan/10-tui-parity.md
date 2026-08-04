# omp TUI ↔ GUI 深度对等审计(2026-08-03)

Method: 6 parallel read-only audits across both codebases (TUI `packages/coding-agent/src`,
GUI `packages/gui/src`), each producing per-item tables with file:line evidence.
Status: ✅ full · 🟡 partial · ❌ missing · ⚫ n/a (CLI-only by nature).

**Verdict: NOT complete.** Settings surface is a superset of the TUI; session/stats/goal/
approvals are largely full. But three systemic root causes degrade large swaths, plus a
long tail of per-feature gaps. Ordered by load-bearing weight:

---

## SYSTEMIC ROOT CAUSES (fix these first — they explain most 🟡/❌)

### R1. Live tool-result envelope renders as raw JSON (top issue)
Every `tool_execution_end`/`partialResult` reaches the GUI as the full `AgentToolResult`
envelope `{content:[{type:"text",text}], details:{…}}` (agent-loop.ts:2363 → rpc-mode.ts:975
→ tools.ts:122-131). Almost every GUI renderer calls `resultText()` (lib/format.ts:167-190)
which hits its `JSON.stringify` fallback → **live results show raw `{content,details}` JSON**.
Structured extractors then look for top-level fields that actually live in `details` /
`content[].text` and come up empty (bash stdout/exitCode, lsp references, debug frames,
hub peers, web_search results, github entity). Only `resultDetails()`/`resultBodyText()`
(tools/result.ts, used solely by Resolve+Goal) and recursive `extractImageDataUrl` unwrap it.
**Also**: hydration drops `details` (tools.ts:57) → history loses diffs, exit codes, todo
phases, counts. Fix = one shared envelope-unwrapper used by every renderer + carry `details`
through hydration. Blast radius: nearly every tool card.

### R2. RPC command boundary — many TUI features never cross the wire
The GUI can only use what `rpc-ui` exposes (rpc-types.ts). Missing transports:
- **No `fork` RPC** → whole-session clone unreachable; GUI "Fork" dialog is actually a second
  branch picker (ForkDialog.tsx:97 → rpc.branch). Real fork is agent-session.ts:6225.
- **No `dequeue`/`queue` RPC** → queued messages can't be restored to the composer (Alt+Up),
  `/queue` + `->`/`=>` shorthand + enumerated-list splitting absent (queue-input.ts).
- **No python `eval` RPC** → `$` python mode is parsed but wrapped as a prompt telling the
  agent to use its python tool (input-modes.ts:86-91); `!!`/`$$` context-exclusion parsed, dropped.
- **`/plan` + `/queue` are `handleTui`-only builtins** (acp-builtins.ts:54-74) — not even
  advertised/executable over RPC (GUI compensates with PlanPanel toggle).
- **No `askDialog`** (multi-question Ask) in rpc-types.ts:903-963 → degrades vs TUI AskDialogComponent.
- **Foreign sessions** (`@claude`/`@codex`) unresumable; no import flow (`--from-claude/--from-codex`).
- **`/export --themes`** unreachable (rpc-mode.ts:1383 passes only outputPath).

### R3. CLI launch-flag surface absent
GUI spawns `omp --mode rpc-ui` with NO extraFlags (sidecar.ts:133-134). All 47 launch.ts flags
lack a GUI launch surface. Most have runtime/schema equivalents (thinking/model/approval/add-dir/
tools/lsp/skills), but **no GUI control for**: `--config` overlays, `--profile/--alias`,
`--system-prompt/--append-system-prompt`, `--plan-yolo`, `--no-pty`, `--no-rules`, `--no-title`,
`--from-claude/--from-codex`, `--session-dir/--no-session`.

---

## 1. SLASH COMMANDS (command-registry.ts already maps ALL)
GUI `renderer/lib/command-registry.ts` maps every slash command to: native action/picker/window,
**prompt-forward** (~35, sends literal `/cmd` text), or **TUI-only** (17: guided-goal, queue,
switch, collab, join, leave, copy, hotkeys, drop, btw, tan, omfg, debug, live, pause, quit, exit).
Native ✅: new/resume/branch/handoff/rename/compact/retry/session-info/stats/usage/goal/vibe/loop/
model/fast/thinking/approval/settings/export/⌘R/skills/hooks/MCP-toggle. Prompt-fallback 🟡:
share/dump/session pin/delete/shake/fresh/move/add-dir/security/ssh/jobs/changelog/context/tools/
marketplace*/memory*/reload-plugins. ❌: fork, queue/dequeue, drop, and the 17 TUI-only.

## 2. TOOL RENDERERS (28 TUI vs 33 GUI mappings) — degraded by R1
- ❌ **todo**: reads `args.phases` which NEVER exists (todo.ts:78-89 args are {op,list,task,phase,items};
  phases live in `details`) → permanently empty. Broken.
- ❌ **vibe_spawn/send/wait/kill/list**: no registry entry → GenericRenderer JSON dump.
- ❌ **ast_edit**: mapped to EditRenderer but args don't match any branch → placeholder only.
- 🟡 (live broken via R1) bash, read, write, grep, glob, ast_grep, lsp, eval, memory, browser/computer
  text, inspect_image caption, debug, hub, github, web_search.
- 🟡 **edit**: real diff only when `typeof result==="string"` (never) → always plain old/new dump;
  no line numbers/intra-line/indent-viz/context-highlight/streaming preview (diff.ts vs lib/diff.ts).
- 🟡 **task**: header-only (no live agent tree w/ stats/retry/nested/yields); partialResult unused.
- ✅ resolve, goal, image_gen (GUI exceeds: inline image), default GenericRenderer.
- GUI beyond TUI: inline screenshots (browser/computer/image), stdout/stderr split, grep `<mark>`,
  todo progress bars, github open-external, resolve ops/files, duration badge.

## 3. MESSAGE / CONVERSATION RENDERING
- ❌ **mermaid fences** → plaintext code block (TUI renders ASCII diagram; theme/mermaid-cache.ts).
- ❌ **raw HTML subset dropped** (no rehype-raw; TUI normalizes `<ul>/<br>/<code>` etc.).
- ❌ **tool diff drastically reduced**: no line numbers, no intra-line highlight, no indent viz,
  no context syntax highlight, no streaming edit preview, `@@` gaps silently dropped.
- ❌ **custom/extension messages flatten to a bare label** (advisor, async-result, LSP diagnostics,
  skill/collab, IRC, handoff tags, extension renderers) — MessageBubble.tsx:204-232 ignores `details`.
- ❌ **read-tool grouping** (consecutive reads → one group) missing.
- 🟡 **thinking**: plain mono text (no markdown/prose-only elision, no hidden-pulse glyph, no tok/s gauge).
- 🟡 **user messages**: plain pre-wrap (markdown flattened), no copy button.
- 🟡 **usage row**: no TTFT, no timestamp; wire type lacks `developer` role + `retryRecovery` →
  developer/synthetic messages uncollapsed, retry recovery not shown inline.
- ✅ exceeds TUI: task-list checkboxes, code line-number gutter, KaTeX math, per-message copy,
  stream caret, word/line/duration thinking badges, virtual list + jump-to-latest, branch-from-here.

## 4. SETTINGS / CONFIG — superset (all 449 adjustable) with fidelity gaps
- ✅ All 449 schema paths adjustable (10 tabs + Runtime + Advanced[117 no-ui] + GUI prefs). GUI is a
  superset of the TUI panel (which hides numbers/arrays/records).
- 🟡 ordered multiselect (`providers.webSearchOrder/imageOrder`) → ArrayChipEditor append/remove only,
  no reorder/option-checklist. 🟡 `providers.maxInFlightRequests` → generic KV, no per-provider editor.
- 🟡 41 condition-gated settings shown unconditionally (RPC projection drops `condition`).
- 🟡 no theme/status-line live preview while browsing.
- ❌ plugin **config value editor + feature toggles** (TUI plugins tab) — GUI enable/disable only.
- ❌ backward model cycle (⇧⌃P); forward ⌃P only.
- ❌ launch-flag surface (see R3).
- GUI beyond TUI: Advanced tab (117 config-file-only settings), Runtime dashboard tab, ApprovalControl
  chip, tray quick config, ProviderConfigDialog custom-provider CRUD, ModelCompare/ModelRoles windows,
  zh translations of every label, GUI prefs (font/panel/language/renderer themes).

## 5. INPUT MODES & COMPOSER
- 🟡/❌ **python `$` mode** — parsed but no RPC eval (R2); `!!`/`$$` exclusion dropped.
- ❌ **queue/dequeue** — `/queue`, `->`/`=>`, enumerated-split, Alt+Up restore (R2). GUI shows count badge only.
- ❌ **external editor** (⌃G round-trip).
- ❌ **large-paste menu** (`[Paste #N]` collapse / `local://paste-N.md` attach).
- ❌ **history secret scrubbing** (`shouldSkipHistory`) — GUI records everything verbatim → privacy regression.
- ❌ autocomplete: `@` filesystem fuzzy (GUI: 6 hardcoded schemes), slash-arg completions, emoji, GitHub
  `#refs`, `#` prompt-actions, inline ghost hints.
- ✅ normal/shell `!`/plan (via panel), steer/followUp toggle, image paste + picker (exceeds TUI),
  history up/down + ⌃R, abort, steering/followUp/interrupt settings, image thumbnails.

## 6. SESSION / NAV / APPROVALS / INTEGRATIONS
- ❌ true **fork** (R2); **session tree** GUI lacks TUI's 5 filters/labels/summarize (prettier graph though).
- 🟡 **session search** substring-only vs TUI fuzzy + full-message-content + SQLite prompt-history.
- ❌ **~22 keybindings** missing (⇧Tab thinking, ⌃T, ⌥R retry, ⌥⇧P plan, ⌃O expand-tools, ⌥A/⌃S agent hub,
  picker-local keys, user-remapping layer, `/hotkeys` reference).
- ❌ **desktop notifications** on turn-complete/error/ask — preload channel exists but renderer never calls it.
- ❌ **agent management**: no Agent Control Center (subagent definitions), no agent hub (multi-agent/IRC/revive).
- 🟡 **integrations: 7 of 14 capability providers** covered (skills/hooks/MCP/plugins/marketplaces/templates/
  memory). No surface for: context files, extension modules, Gemini extensions, instructions, rules,
  settings-sources, ssh hosts, system prompts, custom tools. MCP add-wizard/test/reauth/resources/prompts/
  smithery + marketplace install/discover/upgrade are prompt-fallback.
- ✅ approvals (Approve/Deny + tier badge + 2000-char preview + timeout countdown, no always-option/no-diff —
  same as TUI), subagent panel (DAG exceeds TUI), stats dashboard (10 routes, exceeds), usage window,
  handoff/rename/compact/branch, session sidebar (grouping + group-delete exceeds), goal mode full.

---

## RANKED ACTION LIST (to reach parity)
1. **R1 envelope unwrapper** shared by all renderers + carry `details` through hydration (fixes most 🟡 tool cards).
2. **todo renderer** → read `details.phases` (currently broken/empty).
3. **RPC additions**: `fork`, `dequeue`, python `eval`, `askDialog`, `/export --themes`, `/plan`+`/queue` over RPC.
4. **Custom/extension message renderers** (advisor/async-result/LSP/skill/collab/IRC/handoff) instead of label-only.
5. **Mermaid + rehype-raw + richer diff** (line numbers/intra-line/indent-viz/context-highlight) in markdown.
6. **vibe_*, ast_edit, web_search, github, task live-tree** renderers.
7. **Desktop notifications** (wire the existing preload channel) + **history secret scrubbing** (privacy).
8. **Keybindings** top-up (⇧Tab/⌥R/⌥⇧P/⌃O/⇧⌃P) + `/hotkeys` sheet.
9. **Agent Control Center + agent hub** surfaces.
10. **Integration surface** to 14/14 capability providers + MCP add-wizard/marketplace mutations.
11. **Settings fidelity**: ordered multiselect, provider-limits editor, conditions, plugin config editor, theme preview.
12. **CLI launch-flag surface** (profile/system-prompt/config overlays) if launch-level control is wanted.

## GUI features BEYOND the TUI (keep)
⌘K fuzzy palette · native StatsDashboard (10 routes) · SubagentDag graph · inline screenshots ·
WorkspaceDialog workspace switcher · ApprovalControl composer chip · approval tier badges + timeout ·
toasts · gui_notify/gui_open_url/gui_clipboard host tools · multi-window · native OS menu ·
sidebar workspace grouping + group delete · Advanced settings tab · Runtime dashboard tab ·
ModelCompare/ModelRoles/ProviderConfig windows · task-list checkboxes · code line numbers · KaTeX ·
stream caret · zh i18n.
