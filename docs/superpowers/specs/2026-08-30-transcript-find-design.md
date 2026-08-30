# Transcript Find Design

**Status:** Approved for implementation on 2026-08-30. Design options were reviewed as an artifact; the selected combination is A1 · B1 · C2 · D1 · E1 (placement, navigation, corpus, highlighting, scope).

## Goal

Give the transcript a real find: <kbd>⌘F</kbd> opens a find bar, typing shows every match, and <kbd>↵</kbd> walks matches backwards through history. Today the standard find key does nothing, and the platform's own find is unusable here for the reason in the next section.

## Scope

GUI-only, under `packages/gui`. No sidecar or RPC changes: everything searched is already in renderer stores. The feature is additive — no existing transcript behavior changes except that <kbd>Esc</kbd> gains a higher-priority consumer while the find bar is open.

### Included

- A find bar overlaying the transcript's top-right corner, per transcript viewport.
- Search over the whole row model, including content hidden inside collapsed disclosures.
- Backwards-first match navigation with an explicit forward key and a visible wrap.
- Match highlighting via the CSS Custom Highlight API, with a distinct current-match treatment.
- A match-tick strip showing where the hits sit, shown only while find is open.
- Three remappable keymap actions and their `HotkeysDialog` rows.
- Find in projected subagent transcripts, which share `TranscriptViewport`.

### Non-goals

- Searching across tabs, sessions, or stored history. That is a separate session-search surface.
- Searching the collapsed pre-compaction region (see **Deferred** below).
- Regular expressions, case-sensitivity toggles, or whole-word matching in this version.
- Replacing text. Find is read-only.
- Driving matches from the main process or `webContents.findInPage`.

## The constraint that shapes the design

`TranscriptViewport` renders through `@tanstack/react-virtual` with `overscan: 8`. Rows outside the viewport are not in the DOM. Both the browser's native find and Electron's `webContents.findInPage` search the rendered document, so in any transcript longer than a screenful they would silently miss almost everything — the worst possible failure mode for a find feature, because it reports zero matches rather than reporting an error.

Find therefore runs over the row model, not the DOM:

1. Build a match index from `rows: Row[]` and the same data those rows render from.
2. Scroll to a match with `virtualizer.scrollToIndex(rowIndex, { align: … })` — the mechanism `jumpToConversation` already uses for `ConversationNavigator`.
3. Paint highlights when the row mounts, and repaint on remount.

Steps 1 and 3 are separable, which is what makes the feature tractable: the index is pure data and unit-testable without a DOM.

## Search corpus

The index covers every row kind that carries text:

| Row kind | Searched text |
| --- | --- |
| `message` | Message text; thinking blocks; tool-call names and serialized arguments |
| `readGroup` | Each grouped entry's path and rendered result text |
| `process` | Constituent messages, as for `message` |
| `todoSnapshot` | Phase names and task content |
| `streaming` | The live message's text and thinking |
| `queued` | Queued prompt text |
| `expander` | Nothing — see **Deferred** |

Text extraction reuses the shape `lib/transcript-copy.ts` already established for `/dump`: one function per content block, driven off `MessageContent`. That module renders markdown for the clipboard, so find gets a sibling extractor that returns plain text plus the offsets needed to locate a match inside a specific block, rather than reusing `formatTranscriptMarkdown` directly.

Critically, the index does not care whether a disclosure is open. A thinking block collapsed by default, a tool result capped by its preview height, and a diff scrolled inside its own box all contribute matches. The match count is therefore stable no matter what the user has expanded — expanding a row never changes the number in the find bar.

### Revealing hidden matches

When navigation lands on a match inside collapsed content, find opens the disclosure that contains it by calling `setDisclosureOpen` on the `ui` store, scoping the key through `useDisclosureScope()` exactly as every existing consumer does. That store already owns disclosure state precisely so it survives the virtualizer unmounting a row, so the reveal is durable and the user can collapse it again afterwards.

Each match therefore carries the disclosure key it lives behind, or `null` when it is always visible. One row kind is `null` by necessity: `ReadGroupCard` keeps its expansion in local component state rather than the `ui` store, so matches inside a collapsed read group are counted and scrolled to but not auto-revealed. Moving that card onto the disclosure store is out of scope here.

## Match model

```
TranscriptMatch {
  rowIndex: number        // index into rows[], for scrollToIndex
  rowKey: string          // stable identity across rerenders
  ordinal: number         // 0-based position in document order
  disclosureKey: string | null
  locator: …              // enough to re-find the text node once mounted
}
```

The index is rebuilt when the query changes or `rows` changes, memoized on `[query, rowKeys]`. Streaming appends rows continuously, so the rebuild must be O(new rows) in the common case rather than O(transcript); the index keeps per-row match lists keyed by `rowKey` and only re-scans rows whose key it has not seen.

Matching is case-insensitive substring on a whitespace-normalized copy of the text. No regex: a stray `(` in a query should find a literal `(`.

## Navigation

Direction is **backwards through history by default**, because a transcript is a log and the thing you are looking for is almost always something you already saw.

- **Find** (opening the bar with a query, or editing the query): select the first match at or above the bottom edge of the visible viewport, searching upward. If none, wrap once to the bottom of the transcript and continue upward.
- **Find next** (<kbd>↵</kbd>, <kbd>⌘G</kbd>): the next match upward from the current one, wrapping once at the top of the transcript.
- **Find previous** (<kbd>⇧↵</kbd>, <kbd>⇧⌘G</kbd>): the next match downward, toward the live edge, wrapping once at the bottom.

Wrapping is announced rather than silent: the counter shows a wrap indicator for one navigation step, so a jump from the oldest match back to the newest never reads as a glitch. The counter itself reads `n / total` in document order — match 1 is the oldest — so the number means the same thing regardless of which direction the user is travelling.

Scrolling to a match uses `align: "center"` rather than `jumpToConversation`'s `align: "start"`, so a match near a row's end is not parked under the find bar. Navigation otherwise mirrors `jumpToConversation` exactly: it clears `userScrollIntentRef` and sets `pinned` false, so a programmatic scroll is never mistaken for the user unpinning the live edge.

Closing the bar with <kbd>Esc</kbd> restores the scroll position and pinned state from before find opened.

## Find bar

Overlays the top-right of the transcript, inside `TranscriptViewport` so split panes and subagent transcripts inherit it. It never reflows the transcript.

Contents, left to right: the query input; the match counter (`3 / 17`, tabular figures, with the wrap indicator); a separator; previous and next buttons whose arrows point in the travel direction; a close button.

- Opening with a non-empty transcript selection seeds the query from that selection.
- Opening while already open re-selects the query text rather than clearing it.
- The query persists per transcript while the tab lives, so reopening find offers the last search.
- An empty query shows no matches and no highlights, not "0 / 0" styled as an error.
- A query with no matches marks the input with the error token and reads `0 / 0`.

Match ticks show where the hits sit in the transcript, with the current one emphasized. There is no existing scroll rail to hang them on — `--omp-transcript-rail` is only a dashed border colour — so they render as their own thin overlay strip down the transcript's right edge, present only while find is open. Ticks are positioned from the virtualizer's measured offsets, so they are approximate for unmeasured rows and settle as rows are measured — acceptable, and the same limitation a scrollbar has.

## Highlighting

Matches are painted with the CSS Custom Highlight API: `Range` objects registered in `CSS.highlights` under a named highlight, styled through `::highlight(omp-find)` and `::highlight(omp-find-current)`. Electron 43 ships a Chromium that supports it.

This is the only mechanism that works across every renderer without their cooperation. The alternative — wrapping matches in `<mark>` during render, as `HistorySearchOverlay` does for its own result list — would require every text-emitting renderer to participate and would fight `CodeBlock` and `DiffView`, which build their own span trees for syntax highlighting.

Ranges are (re)computed for mounted rows only, on mount and whenever the current match changes. A row scrolling out of view drops its ranges; scrolling back in recreates them.

Color: all matches take a soft amber wash, the current match solid amber. Amber because the app's periwinkle accent already means "selected" and green and red already mean tool success and failure. Both values need a token pair per theme, added alongside the existing `--omp-*` tokens.

## Keybindings

Three entries in `KEYMAP_ACTIONS` (`lib/keymap.ts`), which gives them remapping, conflict detection, and `HotkeysDialog` rows for free. <kbd>⌘F</kbd>, <kbd>⌃F</kbd>, and <kbd>⌘G</kbd> are all currently unbound, so nothing collides.

| Action id | Defaults | `overlaySafe` |
| --- | --- | --- |
| `transcript.find` | `⌘F`, `⌃F` | `false` |
| `transcript.findNext` | `⌘G` | `false` |
| `transcript.findPrevious` | `⇧⌘G` | `false` |

`overlaySafe: false` throughout — find must not fire while the command palette or a dialog owns the keyboard.

### Reaching the right viewport

`App.tsx`'s keymap dispatch acts on global stores, but find state lives inside a `TranscriptViewport` instance, and a split workspace can mount several. The action therefore travels as an `omp:transcript-find` window event that each mounted viewport listens for and answers only if it owns the focused pane, falling back to the main-mode viewport when nothing claims it. This follows the existing `omp:insert-mention` event that `FilesPanel` dispatches and `InputArea` consumes, rather than inventing a second routing mechanism.

<kbd>↵</kbd> and <kbd>⇧↵</kbd> are handled locally by the find input, not through the keymap, because they are only meaningful while that input has focus. <kbd>⌘G</kbd> and <kbd>⇧⌘G</kbd> work with focus anywhere in the pane, so the user can navigate matches after clicking back into the transcript.

### Escape

`App.tsx` currently treats <kbd>Esc</kbd> as "abort the running turn", guarded by `!event.defaultPrevented` and the absence of `[role="dialog"]`. The find bar closes on <kbd>Esc</kbd> and calls `preventDefault()`, which the existing guard already honors — so an open find bar swallows the key and a running turn is not aborted by a user dismissing find. No change to `App.tsx` is required for this; the guard is why it was written that way.

## Component boundaries

### New

- `chat/transcript-find.ts` — pure match indexing and navigation arithmetic over `Row[]`. No React, no DOM. Carries the bulk of the tests.
- `chat/useTranscriptFind.ts` — hook owning query, current ordinal, open state, saved scroll position, and disclosure reveal. Depends on the virtualizer instance and the row model.
- `chat/TranscriptFindBar.tsx` — presentational bar. Props in, callbacks out.
- `chat/transcript-find-highlight.ts` — `CSS.highlights` range management, isolated so a browser without the API degrades to no highlight rather than crashing.

### Changed

- `TranscriptViewport.tsx` — mounts the hook and the bar, exposes the virtualizer to the hook, and applies find's scroll requests. This file is already 1076 lines; find's logic lives in the modules above rather than growing it further.
- `lib/keymap.ts` — three action entries.
- `App.tsx` — three cases in the keymap dispatch, routed to the focused pane.
- `locales/en.ts`, `locales/zh.ts` — bar labels, counter format, hotkey row labels.
- `styles/theme-light.css`, `styles/theme-dark.css` — the two find tokens.

## Accessibility

The bar is a `role="search"` region with a labelled input. The counter is an `aria-live="polite"` status so match counts and wraps are announced. Navigation moves focus nowhere — the input keeps focus so typing continues to refine the query — but each landed match is announced through the same status region. The previous and next buttons carry direction-explicit labels ("older match", "newer match") rather than "previous" and "next", which are ambiguous when travel is backwards.

## Failure handling

- No `CSS.highlights` support: navigation and scrolling still work; highlighting is skipped. The feature degrades, it does not break.
- A match whose row has been removed (compaction, session switch): the index is rebuilt on any `rows` change, and the current ordinal clamps into range rather than persisting a dangling reference.
- Transcript switches (`transcriptId` change): find closes and clears, matching how the viewport already resets `pinned` and the size cache.

## Deferred

Two decisions were explicitly deferred and are additive on top of this design:

- **Pre-compaction history in the corpus.** The `expander` row hides everything before the last compaction summary — potentially thousands of messages the user deliberately folded away. Unfolding it from a single <kbd>↵</kbd> is too blunt. The intended shape is a secondary count ("214 more in collapsed history") that the user opts into, not automatic inclusion.
- **Turn-stepping.** A single tool result can hold dozens of matches, making <kbd>↵</kbd> tedious. <kbd>⌥↵</kbd> jumping to the previous *turn* containing a match, reusing `buildConversationAnchors`, would fix that. Not required for the first version.

## Verification

- Unit tests for `transcript-find.ts`: match ordering, the backwards seed from a given viewport edge, wrap in both directions, counter numbering, incremental reindexing when rows append, and matches inside thinking blocks, tool arguments, tool results, and todo snapshots.
- Component tests for the bar: seeding from selection, empty and no-match states, the counter, and direction-correct button labels.
- Integration tests in `TranscriptViewport.test.tsx`: opening find scrolls to the expected row index; landing on a collapsed match opens its disclosure; closing restores scroll and pinned state; switching transcripts clears find.
- Keymap tests: the three actions compile to their chords and are reported in conflict detection.
- Manual: a transcript long enough that the target match is unmounted at open time — the case that rules out every DOM-based approach.

## Changelog

- 2026-08-30 — Initial design, following the options review.
- 2026-08-30 — Corrected against the code while planning: there is no scroll
  rail to hang match ticks on (they get their own overlay strip); navigation
  clears `userScrollIntentRef` as `jumpToConversation` does, rather than
  leaving it alone; disclosure keys scope through `useDisclosureScope()`;
  `ReadGroupCard` matches cannot auto-reveal; and keymap actions reach the
  right viewport over an `omp:transcript-find` window event.
