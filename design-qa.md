# Dock large-list design QA

- source visual truth: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-aedfd50e-68a6-46c7-ac35-81d7299b6904.png`
- implementation summary screenshot: `/Users/zach/AiProject/oh-my-pi/packages/gui/tmp/dock-summary-qa.jpeg`
- implementation focused screenshot: `/Users/zach/AiProject/oh-my-pi/packages/gui/tmp/dock-agents-focus-qa.jpeg`
- viewport: Electron window, 1224 x 768 px screenshot, desktop CSS viewport at device scale factor 1
- source pixels: 2586 x 762; implementation pixels: 1224 x 768
- normalization: source establishes the bottom-dock layout problem rather than a pixel-identical mock. Comparison used the same light theme, composer-adjacent location, and populated Todo + Agents state; focused crops were inspected at native screenshot density.
- state: 15 todos (3 actionable, 12 completed) and 8 agents (2 live, 1 failed, 5 completed)

## Full-view comparison evidence

The source shows a tall Todo body above the composer and describes the failure mode when Todo and Agents both own scroll regions. The implementation keeps the composer visible, renders a six-row Todo summary plus a five-row Agents summary, and gives the combined dock one bounded vertical scroll owner. Neither card renders `overflow-y-auto` in its list body.

## Focused-region comparison evidence

The summary capture shows the intended compression: all actionable todos, the newest three completed todos, all urgent agents, newest completed agents, and explicit remaining-count affordances. The focused capture shows all eight agents, a sticky “返回摘要” action, and the Todo card reduced to its header. Agent row status colors, borders, title hierarchy, counts, and controls remain aligned with the existing design system.

## Findings

- No actionable P0/P1/P2 visual mismatch remains.
- Typography: existing GUI family, weights, compact sizes, line heights, truncation, and Chinese labels remain consistent; no wrapping or clipping appeared.
- Spacing and layout: summary density preserves the source hierarchy while removing nested vertical scrolling. The composer remains persistent beneath the dock.
- Colors and tokens: existing semantic status tokens and border tokens are reused; contrast and selected/focused hierarchy remain legible.
- Image quality and assets: this UI contains no raster imagery or custom illustrative assets. Existing Lucide controls remain sharp and consistent.
- Copy and content: remaining counts and “查看全部 / 返回摘要” are clear in Chinese and mirrored in English locale entries.
- Interaction and accessibility: tested summary → Agents full focus → return behavior; semantic buttons expose expanded state and accessible labels. Todo and Agents summary/full contracts are also covered by component tests.

## Comparison history

- Initial implementation QA found no P0/P1/P2 visual defect. No visual fix iteration was required.
- A full-suite compatibility failure for standalone `AgentsDockCard` mounting was fixed by making focus management explicitly provider-scoped; post-fix evidence is 767 passing tests and the focused Electron capture above.

## Primary interactions tested

- Large Todo and Agents collections render simultaneously in summary mode.
- “查看全部 8 个代理” enters focus mode and renders all eight rows.
- Non-focused Todo becomes header-only in Agents focus mode.
- “返回摘要” is exposed in the focused header (also covered by click-through component test).
- Composer remains visible throughout.
- Electron renderer remained responsive; no app error surface appeared.

## Follow-up polish

- P3: consider replacing always-stable scrollbar gutter with overlay scrollbars on macOS if the extra right inset feels visually heavy at narrower widths.

final result: passed

---

# Compact execution and goal surfaces QA

- source visual truth: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-97a03058-9bfa-430f-88ab-bf28a3d3da7c.png`
- implementation screenshot: `tmp/compact-renderer-expanded.jpeg`
- focused source/implementation comparison: `tmp/compact-renderer-comparison.png`
- viewport: Electron development window, 1224 x 768, device scale factor 1
- state: hydrated session with three completed tasks; the same card was exercised in expanded and collapsed states

## Source truths carried into omp

- One rounded disclosure owns the task hierarchy; the header combines the section title, exact live counts and a far-right chevron.
- Task state is communicated with compact semantic icons rather than a row of badges, nested cards or repeated phase chrome.
- Completed historical execution phases collapse to one summary line; live work and failures stay open so progress and actionable errors are not hidden.
- The current goal is a separate single-line control strip. Its objective truncates instead of increasing the dock height, while pause/resume, edit and drop remain directly available.

## Findings

- No actionable P0/P1/P2 visual or interaction mismatch remains in the compact task surface.
- The focused comparison confirms the same hierarchy, radius, quiet border, right-aligned disclosure and flat status-row treatment as the source while retaining omp typography and semantic color tokens.
- The dock now owns at most `min(30vh, 240px)` for task/plan/agent detail and scrolls internally, so the composer remains stable. When no task, plan, agent, queue or goal exists, the dock collapses to zero height.
- Single-phase task lists omit the redundant phase heading and vertical rail. Multi-phase lists retain collapsible phase labels because removing them would destroy task grouping.
- No new black, green or gray decorative panel was introduced; surfaces use the existing secondary background as a restrained neutral layer, and state colors are limited to icons and error/warning semantics.
- The active-goal strip was not injected into the user's hydrated session for the screenshot. Its objective/edit control and native pause state transition are covered by component tests without mutating session history.

## Primary interactions tested

- Clicking the task header collapsed the live Electron card to one row; clicking it again restored all three tasks.
- Completed historical execution groups stay closed until requested.
- A failed execution group opens automatically and preserves its details.
- Task counts distinguish running, pending and completed work.
- Goal edit opens the existing goal settings surface; pause calls the native `set_goal` RPC and updates the visible status in place.

## Verification

- Type check passed.
- Biome check of all touched renderer files passed.
- Full suite passed: 779 tests across 90 files.
- Production Electron build passed.
- `git diff --check` passed.

final result: passed

---

# Conversation navigator QA

- source visual truths: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-9eff0948-648d-4e05-a4ea-11936be6e318.png` (preview interaction) and `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-4432d560-3f5b-4fd6-b800-9c602fb59552.png` (compact centered marks)
- implementation screenshots: `tmp/conversation-navigator-centered.png`, `tmp/conversation-navigator-centered-preview.png`
- source pixels: 416 x 1144 for the compact-mark crop; implementation pixels: 1224 x 768 at Electron device scale factor 1
- viewport: Electron development window, 1224 x 768 CSS px
- state: hydrated `Sanitize .env.example credentials` transcript with seven user-authored turns; first anchor focused and clicked

## Full-view comparison evidence

The implementation now matches the reference composition: the turn marks form one compact group centered vertically in the left rail. Short marks share a fixed rhythm, the current-location mark is longer and darker, and the group no longer stretches across the transcript height. It remains integrated into the existing omp transcript/editorial rail rather than copying the reference application's surrounding chrome.

## Focused interaction evidence

- The accessibility tree exposes `对话快速导航` plus seven named anchor buttons for the seven user turns.
- Clicking the first anchor moved the virtualized transcript from its latest position to the first `继续` prompt; the target prompt and following assistant work were visible after the jump.
- The preview showed `第 1/7 轮对话`, `14:49`, the bounded prompt summary and `点击定位`.
- Edge anchors open their preview inward so the card remains inside the transcript viewport even when the mark stack becomes dense.

## Findings

- No actionable P0/P1/P2 visual or interaction mismatch remains.
- Typography: existing omp UI and mono type tokens are reused; the preview preserves the reference hierarchy with a quiet kicker, strong prompt and muted action hint.
- Spacing and layout: the rail occupies 34 px along the transcript edge; marks use a compact fixed rhythm and the stack is centered vertically without reducing the shared full-width message surface.
- Colors and tokens: existing text, muted, border, elevated-surface, focus-ring and shadow tokens are reused in both themes.
- Image quality: this feature contains no raster or illustrative assets; marks are native controls and remain sharp at the captured density.
- Copy and content: user-message summaries collapse whitespace and cap at 180 characters; image-only prompts receive a localized fallback.
- Accessibility: the rail is a named navigation landmark, each marker names its turn and preview, the current turn uses `aria-current=location`, and arrow/Home/End navigation uses roving tab focus.
- Responsiveness: the rail hides below 720 px, where a narrow viewport would make the hover surface obstruct the conversation.

## Comparison history

- Pass 1 matched the rail and preview interaction, but a first-anchor preview could approach the top edge and long SQL labels were too verbose.
- Pass 2 clamps the preview to a 92 px top/bottom safe area and bounds summaries to 180 characters. The post-fix Electron capture confirms the preview stays inside the app while the target prompt remains visible.
- Pass 3 replaces full-height percentage positioning with one vertically centered compact stack, adds dense modes for long conversations, and anchors preview cards to the selected mark. The 1224 x 768 Electron capture confirms seven marks remain grouped at the left-center and navigation still lands on the selected turn.

## Verification

- Primary interactions tested: follow-current-turn state, hover/focus preview, first-anchor click-to-jump, keyboard marker traversal, latest-button coexistence.
- Automated: 774 tests across 87 files pass; type check, Biome, production Electron build, and diff check pass.
- Electron renderer remained responsive and no app error surface appeared.

final result: passed

---

# Full-width transcript rendering QA

- source visual truth: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-c17568c5-341b-4f2f-a873-77ed61e40fed.png`
- implementation screenshot: `tmp/transcript-full-width-qa.jpeg`
- side-by-side comparison: `tmp/transcript-full-width-comparison.png` (source left, implementation right)
- viewport: Electron development window, 1224 x 768, device scale factor 1
- state: same `常用-配置reasoning` transcript containing a long SQL user prompt, assistant prose, tools, table and code blocks

## Full-view comparison target

Every substantive transcript block must fill the available rendering track between the common left and right transcript padding. User, assistant, reasoning, tool, execution, context, collaboration and queued-message surfaces must not stop at an 84ch reading measure.

## Findings

- The previous 84ch implementation was a P1 interpretation error: it made the blocks equal but intentionally left unused horizontal space.
- The revised contract uses `width: 100%` and a growable content surface. Code blocks and tables retain their own horizontal scrolling when their contents exceed that full-width container.
- The live Electron capture confirms that the long user prompt card, assistant prose/tool rows, code surface and composer share the same right-hand rendering boundary; the content no longer ends at the old narrow card width.
- Long SQL text wraps inside the full-width user surface, while code preserves syntax formatting and its own overflow behavior.

## Comparison history

- Pass 1 incorrectly constrained every content surface to 84ch and is explicitly marked blocked above.
- Pass 2 removes the 84ch cap and makes the shared transcript content surface fill the rendering track.
- Verification: 769 tests across 86 files, type check, Biome check of touched renderer files, and the production Electron build all pass.

final result: passed

---

# Compact context usage popover QA

- source visual truth: `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-4f15c1bd-52a1-4add-a896-7f8ae0fe93b2.png`
- implementation screenshot: `tmp/context-usage-popover-live.jpeg`
- focused source/implementation comparison: `tmp/context-usage-comparison.png`
- viewport: Electron development window, 1224 x 768, device scale factor 1
- state: hydrated `Sanitize .env.example credentials` session at 64% context usage with a native provider-anchored context report

## Source truths carried into omp

- The resting composer keeps one compact circular usage control immediately before Send instead of displaying a permanent meter or a second settings panel.
- Hover, focus or click reveals a neutral elevated popover with percentage and total first, a thin segmented bar second, and three plain category rows last.
- Token detail is grouped into system context, tools and conversation messages. Colors appear only as small category markers and progress segments.

## Findings

- No actionable P0/P1/P2 visual or interaction mismatch remains in the context usage surface.
- The focused comparison confirms the source hierarchy, restrained radius and shadow, tabular token values, three-row grouping and compact trigger placement while retaining omp typography and theme tokens.
- The system row intentionally combines the system prompt, system context and skill instructions. This avoids presenting provider-owned prompt material as three noisy implementation rows.
- The popover is portalled above the composer, clamps to a 12 px viewport safe area, flips below the trigger when there is insufficient room above, and follows resize or nested scroll changes.
- Opening the popover requests the native `get_context_report` breakdown. The already-known percentage and total stay available while loading and when that detailed request fails.
- No decorative black, green or gray panel was introduced. The surface uses the standard elevated background; semantic color is limited to the progress segments, tiny category markers and active trigger ring.

## Primary interactions tested

- Click pins the popover; clicking the trigger again, pressing Escape or clicking outside closes it.
- Hover and keyboard focus reveal the same non-modal detail without pinning it.
- In the live Electron session the control exposed `查看上下文用量，已使用 64%`, and the opened dialog showed `~173.7k / 272.0k`, system context `~7.9k`, tools `~9.0k` and conversation messages `~156.8k`.
- Sessions without context telemetry render no empty usage control.
- A failed detailed-report request preserves the current total and presents a quiet unavailable message rather than breaking the composer.

## Verification

- Type check passed.
- Biome check of all touched context-usage and composer files passed.
- Full suite passed: 784 tests across 91 files.
- Production Electron build passed.
- Source and live implementation were judged together in `tmp/context-usage-comparison.png`.

final result: passed

---

# Execution History Redesign QA

## Comparison target

- Source visual truth:
  - `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-dbe19c9b-c97a-488b-8c25-e9f05c7491b6.png`
  - `/var/folders/4g/qdz4d625641d0d8x4td6t2qm0000gp/T/codex-clipboard-aa486474-a8e0-4f2d-9215-1d5a8d6f09d4.png`
- Implementation screenshots:
  - Collapsed answer-first state: `/tmp/omp-execution-redesign-final.png`
  - Expanded activity state: `/tmp/omp-execution-redesign-expanded.png`
- Full-view comparison: `/tmp/omp-execution-redesign-comparison.png`
- Focused activity comparison: `/tmp/omp-execution-redesign-focused-comparison.png`
- Viewport: implementation Electron window captured at 1224 x 768 logical pixels.
- Pixel dimensions: source 3600 x 2260; implementation 1224 x 768; comparison 2448 x 768.
- CSS size and density normalization: the attached source screenshot does not expose its CSS viewport or device scale. It was proportionally normalized from 3600 x 2260 to 1224 x 768. The Computer Use implementation capture was exported at its 1224 x 768 logical window size. The two captures have the same aspect ratio, so normalization required no crop.
- State: completed coding run, with the assistant answer primary and execution history available in collapsed and manually expanded states.

## Required fidelity surfaces

- Fonts and typography: retained omp's established UI and monospace families, reduced activity summaries to the secondary `text-omp-md` scale, and removed the competing bold `任务` label. The result matches the reference hierarchy without importing foreign typography.
- Spacing and layout rhythm: activity chrome is a 30px disclosure row; the 42px card header, 16px card radius, nested padding, minimum timeline height, and inner 320px viewport were removed. Expanded rows now flow in the transcript's single scroll owner.
- Colors and visual tokens: activity uses existing muted, accent, error, and success tokens. Container fills, status rails, and the continuous timeline rule were removed; semantic state remains in small icons.
- Image quality and asset fidelity: no raster, logo, illustration, or custom image asset is part of this component. Existing Lucide icons remain vector-sharp and consistent with the product.
- Copy and content: completed and failed counts remain explicit; the redundant generic `任务` title is gone. Tool names, commands, paths, durations, reasoning, and errors remain available after expansion.

## Comparison history

### Iteration 1

- [P2] Multiple narrated phases still left a stack of nearly identical completed summary rows.
  - Evidence: `/tmp/omp-execution-redesign-implementation-v3.png` and the hydrated accessibility tree exposed eight consecutive completed disclosures before the final answer.
  - Impact: the large cards were gone, but the remaining repeated rows still consumed attention and did not match the reference's one activity summary per run.
  - Fix: compact transcript construction now keeps narrated tool phases in one process group until the final assistant answer; background/custom transcript records remain legitimate boundaries.

### Iteration 2

- Post-fix evidence: `/tmp/omp-execution-redesign-final.png` keeps the answer visually primary; `/tmp/omp-execution-redesign-expanded.png` shows the full tool history without a nested card or inner scrollbar. The same hydrated transcript now exposes three activity summaries, separated by real background-task records, rather than eight phase summaries.
- No actionable P0, P1, or P2 mismatch remains in the requested execution-history surface.

## Interaction checks

- Completed groups hydrate collapsed.
- Failed groups hydrate collapsed with an error count and can be expanded.
- Active groups open automatically and collapse when execution settles.
- Manual expansion reveals the complete history in the main transcript scroll owner.
- Long runs do not create an internal vertical scrollbar.

## Residual scope notes

- The persistent Todo dock and background-task result cards are separate product surfaces and were not restyled as part of this execution-history request.
- The source and implementation contain different conversation content, so copy wrapping and document length were evaluated as hierarchy and density rather than literal line-for-line fidelity.

final result: passed
