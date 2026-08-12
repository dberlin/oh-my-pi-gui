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
