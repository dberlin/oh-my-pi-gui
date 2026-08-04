# omp GUI — TUI 对等修复计划与评估(2026-08-03)

Scope rule (from user): **fix confirmed bugs; skip overly-edge features unlikely to be hit.**
Sources: `plan/10-tui-parity.md` (6-area audit with file:line evidence).

---

## 0. SCOPE FILTER — what's in, what's out

### IN — confirmed bugs (broken for real users now)
| # | Bug | Evidence |
|---|---|---|
| B1 | Live tool results render as raw `{content,details}` JSON (15 renderers via `resultText`) | format.ts:167-190; agent-loop.ts:2363 |
| B2 | Hydration drops `details` → history loses diffs/exit-codes/todo-phases/counts | stores/tools.ts:57 |
| B3 | todo renderer reads `args.phases` (never exists) → permanently empty | TodoRenderer.tsx:16-25; todo.ts:78-89 |
| B4 | edit renderer real diff only when `typeof result==="string"` (never) → plain dump | EditRenderer.tsx:12-47 |
| B5 | ast_edit → EditRenderer matches no branch → placeholder only | tools/index.tsx:34 |
| B6 | Structured extractors read top-level fields that live in `details` → empty (bash/lsp/debug/hub/web_search/github/memory) | per-renderer extractors |
| B7 | History secret-scrubbing missing → `/login` `/join` tokens recorded verbatim (privacy regression) | stores/input-history.ts:99-116; TUI input-controller.ts:46-75 |

### IN — high-value feature gaps (clearly hit in normal use)
desktop notifications · `@` file autocomplete · top keybindings · mermaid · raw-HTML-in-markdown ·
rich diff · custom/extension message renderers · vibe_*/web_search/github/task-tree renderers ·
python `$` eval · fork · queue/dequeue · askDialog.

### OUT — edge / skip (per user)
voice/STT/live voice · collab family (join/leave/relay) · terminal-only settings (statusLine.*/tui.*/terminal.*/OSC progress) · `/export --themes` · double-Esc gesture · hex-color swatches / tree-guide wrap / magic-keyword highlight (cosmetic) · foreign-session import (`--from-claude/--from-codex`) · `--session-dir/--no-session/--max-time` (automation) · external-editor ⌃G (GUI has native textarea) · user-remappable keybindings layer (hardcode top ones instead) · launch-flag *launch-time* variants (most have runtime equivalents).

---

## 1. TRACKS — the key structural decision

The original GUI charter said "don't modify omp source / RPC protocol." **Full parity is impossible
under that constraint** (R2). So the plan splits:

- **Track A — GUI-only** (packages/gui): zero risk to the agent. Ships independently. ~70% of the value.
- **Track B — RPC/agent additions** (packages/coding-agent + gui): needed for fork/eval/dequeue/askDialog//plan//queue. Higher blast radius, needs its own tests.

Recommendation: **land Track A fully first** (it fixes every confirmed bug), then evaluate Track B separately.

---

## 2. PHASED PLAN

### PHASE 0 — Confirmed bugs (Track A, GUI-only) — the "make tool cards honest" phase
**Theme: one shared unwrapper; every renderer reads the envelope correctly.**

| Item | Change | Files | Verify |
|---|---|---|---|
| P0.1 Shared envelope unwrapper | Make `resultText()` detect `{content,details}` → return body text; add `resultDetails()` as the single details accessor. Route the 15 renderers through these (delete per-renderer JSON fallbacks). | lib/format.ts (fix `resultText`), reuse tools/result.ts `resultDetails`; sweep Bash/Read/Grep/Glob/AstGrep/Eval/Memory/Lsp/Debug/Hub/Github/WebSearch/InspectImage/Browser/Computer | Feed each renderer a real live envelope + a hydrated array; assert body text + details, not raw JSON |
| P0.2 Hydration keeps details | `result: {content, details}` preserved (not `content ?? details`) | stores/tools.ts:57 | Reload a session with an edit → diff still renders |
| P0.3 todo renderer | Read `details.phases` via unwrapper | tools/TodoRenderer.tsx | Run `/todo` → phases+tasks show, not empty |
| P0.4 edit renderer | Read `details.diff`; render unified diff; handle `edits[]` + apply_patch | tools/EditRenderer.tsx | Do an edit → syntax diff shows (not old/new dump) |
| P0.5 ast_edit renderer | Dedicated renderer reading `details` (replacements/files/parse-errors/groups) | tools/AstEditRenderer.tsx (new), tools/index.tsx:34 | Run an ast_edit → change groups show |
| P0.6 Structured extractors | bash (stdout/exitCode), lsp (references/diagnostics/symbols), debug (frames/variables), hub (peers), web_search (sources), github (entity), memory — read from `details`/`content` via unwrapper | the 6 renderer files | Each tool run shows its structured fields |
| P0.7 History secret scrubbing | Port `shouldSkipHistory` (skip `/login`,`/join`,`/mcp add --token`, api-key-ish) before persisting | stores/input-history.ts:99-116 | Type `/login x` → not in history |

**Effort: M (2-3 waves). Risk: LOW (GUI-only, additive).**

### PHASE 1 — Easy wins (Track A, GUI-only)
| Item | Change | Files | Verify |
|---|---|---|---|
| P1.1 Desktop notifications | On `agent_end`(turn complete)/error/ask → `window.omp.notify(title,body)`. Reuse existing preload channel. Gate behind a GUI pref (default on) | hooks/use-rpc-events.ts, stores/ui.ts, SettingsWindow GUI tab | Fire a turn → OS notification; toggle off works |
| P1.2 `@` file autocomplete | Fuzzy project-file completion via existing `fs.list` IPC (no new IPC), merged with the scheme list | InputArea.tsx:139-148 | Type `@src/App` → file matches |
| P1.3 Top keybindings | ⇧Tab thinking-cycle, ⇧⌃P model-back, ⌥R retry, ⌥⇧P plan, ⌃O expand-all-tools | App.tsx keydown + ToolCard expand-all | Each shortcut triggers the action |
| P1.4 rehype-raw subset | Allow safe HTML subset (br/p/ul/ol/li/code/hr/blockquote/span) in markdown, sanitized | lib/markdown.tsx | Model output with `<ul>` keeps structure |

**Effort: S-M (1-2 waves). Risk: LOW.**

### PHASE 2 — Rendering richness (Track A, GUI-only)
| Item | Change | Files | Verify |
|---|---|---|---|
| P2.1 Mermaid | Render ```mermaid fences to SVG via `mermaid` npm (better than TUI ASCII), cached | lib/markdown.tsx + MermaidBlock.tsx | Mermaid fence → diagram |
| P2.2 Rich diff | Line-number gutter + intra-line word highlight + context syntax highlight + `@@` gap ellipsis (port diff.ts) | lib/diff.ts + DiffView | Edit diff matches TUI detail |
| P2.3 Custom/extension messages | Render advisor/async-result/LSP-diagnostics/skill/IRC/handoff from `details` instead of label-only | MessageBubble.tsx:204-232 + per-type cards | Each custom type renders its card |
| P2.4 Missing renderers | vibe_* (composer ack frame), task live-tree (per-agent stats), github (entity/watch), web_search (answer+sources+meta) | tools/*.tsx | Each shows TUI-level detail |
| P2.5 Thinking polish | prose-only elision + hidden-pulse + tok/s gauge (respect wire) | ThinkingBlock.tsx | Thinking matches TUI presentation |

**Effort: M-L (2-3 waves). Risk: LOW-MED (mermaid lib weight; diff complexity).**

### PHASE 3 — Feature gaps (Track B, needs RPC/agent changes)
| Item | Change | Packages | Verify |
|---|---|---|---|
| P3.1 `fork` RPC + dialog | Add `fork` command (clone session at head) → rpc-types + rpc-mode; GUI ForkDialog calls it (not branch) | coding-agent + gui | Fork → new session with full history |
| P3.2 python `eval` RPC + `$` mode | Add `eval` command (python/js) → wire `$` composer mode to real eval | coding-agent + gui | `$ 1+1` → real result |
| P3.3 `dequeue`/`queue` RPC | Add dequeue → restore queued to composer (Alt+Up); `/queue` command | coding-agent + gui | Queue 2 msgs, Alt+Up restores |
| P3.4 `askDialog` bridge | Add multi-question Ask to rpc-types + GUI dialog | coding-agent + gui | Multi-question ask renders natively |
| P3.5 `/plan` `/queue` over RPC | Make them advertised+executable (not handleTui-only) | coding-agent | Palette `/plan` executes |

**Effort: M each. Risk: MED-HIGH (touches shared agent + wire protocol; needs rpc-mode tests + smoke probe).**

### PHASE 4 — Polish / settings fidelity (defer; mostly Track A)
ordered-multiselect reorder + ProviderLimits editor + condition-gated visibility + plugin config editor +
theme live preview · agent hub / Agent Control Center · integration surface 7→14 (rules/instructions/
context-files/system-prompts/custom-tools) + MCP add-wizard + marketplace mutations · session-tree
filters/labels · session fuzzy+content search · usage-row TTFT/timestamp · read-tool grouping ·
backward-model-cycle (fold into P1.3).

**Effort: L. Risk: LOW-MED. Schedule after P0-P2 stabilize.**

---

## 3. EVALUATION

### Value vs effort vs risk (per phase)
| Phase | Value | Effort | Risk | Ships independently? |
|---|---|---|---|---|
| P0 bugs | ★★★★★ (every tool card, every session) | M (2-3 waves) | LOW | ✅ GUI-only |
| P1 easy wins | ★★★★ (daily UX: notify/@/keys/html) | S-M | LOW | ✅ GUI-only |
| P2 rendering | ★★★ (richness, matches TUI) | M-L | LOW-MED | ✅ GUI-only |
| P3 RPC gaps | ★★★ (real features) | M each | MED-HIGH | ⚠️ needs agent changes + tests |
| P4 polish | ★★ | L | LOW-MED | mostly ✅ |

### Cross-cutting risks & mitigations
1. **P0.1 is the linchpin** — every renderer depends on the unwrapper. Mitigation: change the two helpers
   FIRST, sweep renderers behind them; add a contract test feeding a real `{content,details}` envelope +
   hydrated array to each renderer. If a renderer regresses, it's isolated (helpers are pure).
2. **Hydration shape change (P0.2)** touches history rebuild — could double-render if both `content` and
   `details` shown. Mitigation: unwrapper picks body-from-content, extras-from-details (no duplication);
   test live + hydrated paths for the same tool.
3. **rehype-raw (P1.4) security** — model output is untrusted HTML. Mitigation: whitelist subset via
   rehype-sanitize schema; never allow script/iframe/on*.
4. **Mermaid (P2.1) bundle weight** — `mermaid` is heavy (~500KB). Mitigation: lazy-load only when a
   mermaid fence appears (dynamic import), cache rendered SVG.
5. **Track B (P3) blast radius** — RPC changes touch the shared agent. Mitigation: additive-only commands
   (no changes to existing frames); rpc-mode handler tests; the `omp --smoke-test` probe already validates
   the compiled-binary worker path; keep GUI fallback (prompt-forward) if a command is unavailable.
6. **Regression surface** — 93 GUI tests must stay green; each phase gates on `tsc=0` + `vitest` + CDP smoke.

### Sequencing rationale
- **P0 first**: it fixes the *confirmed bugs* the user mandated, it's GUI-only (no agent risk), and P2's
  renderers build on the same unwrapper. Unblocks everything.
- **P1 next**: cheap, daily-use, independent — banks visible wins without touching P0's surface.
- **P2 after P0**: richness layered on the now-correct data path (no point styling raw JSON).
- **P3 gated**: needs the RPC-boundary decision + agent tests; do it once Track A is stable so agent
  changes aren't entangled with GUI churn. Recommend a go/no-go on Track B after P0-P2 ship.
- **P4 last**: polish, defer without harm.

### Dependency graph
P0.1 → (P0.3,P0.4,P0.5,P0.6,P2.x) · P0.2 → P0.4/P0.3 · P1 independent · P3 independent (agent-side).

### Effort roll-up
P0 M + P1 S-M + P2 M-L + P3 5×M + P4 L. GUI-only Track A (P0-P2) ≈ 5-8 focused waves, each independently
shippable + verifiable. Track B adds 5 medium agent+gui items.

### Definition of done (per item)
`tsc=0` · `vitest` green (add a contract test only for new observable behavior, e.g. unwrapper, scrubbing,
notify) · CDP smoke on the live GUI exercising the changed path · audit doc updated.

### Recommended immediate move
**Phase 0 now** (P0.1 shared unwrapper + P0.2 hydration + P0.3 todo + P0.4 edit + P0.5 ast_edit + P0.6
extractors + P0.7 scrubbing). It fixes every confirmed bug, is GUI-only/low-risk, and is the foundation
for P2. Confirm before starting P3 (Track B) since it modifies the agent/RPC.
