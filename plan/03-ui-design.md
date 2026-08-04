# omp GUI — UI/UX Design

## Design Principles

1. **Conversation is hero.** Chat stream occupies the largest area. Everything else is peripheral and collapsible.
2. **Real-time first.** Streaming, tool execution, subagent activity are live. No manual refresh.
3. **Progressive disclosure.** Collapsed by default, expand on demand. Information density without clutter.
4. **Keyboard-first.** Every action reachable without mouse. Cmd+K palette, fuzzy search, arrow navigation.
5. **Dark by default.** Matches CLI TUI aesthetic. Light mode available. 95-color token system.

---

## Layout

### Main Window (3-column, resizable, min 800×600)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Title Bar                                                           │
│  [Project ▾] [Session: fix-auth-bug ▾]   [claude-4 ▾] [Think: high]│
│  [Fast ⚡] [Context: ████░░ 62%] [tok/s: 87]    [⚙] [📊] [◧]      │
├──────────┬──────────────────────────────────────────┬───────────────┤
│          │                                          │               │
│  Left    │           Conversation Stream            │  Right Panel  │
│  Sidebar │           (virtual scroll)               │  (collapsible)│
│  220px   │                                          │  300px        │
│          │  ┌────────────────────────────────────┐  │               │
│  🔍      │  │ 👤 User                            │  │  [Todo][Agents│
│  ──────  │  │ Fix the auth token refresh bug     │  │   ][Diff][Log]│
│  Sessions│  │                                    │  │  ──────────── │
│  ──────  │  │ 🤖 Assistant                       │  │               │
│  ● S1    │  │  ▸ Thinking (3.2s) [collapsed]     │  │  ☑ Phase 1    │
│  ○ S2    │  │  ▸ read src/auth.ts ✓ 12ms        │  │    ✓ Map bug  │
│  ○ S3    │  │  ▸ edit src/auth.ts ✓ [diff]      │  │    ● Fix it   │
│  ○ S4    │  │  The bug was in the refresh        │  │    ○ Test     │
│          │  │  callback — the token was cached   │  │               │
│  ──────  │  │  after expiry...                   │  │  ☐ Phase 2    │
│  + New   │  │                                    │  │    ○ Review   │
│          │  │  [Copy] [Branch] [Export]          │  │               │
│  ──────  │  └────────────────────────────────────┘  │               │
│  📁 Files│                                          │               │
│  📊 Stats│  ┌────────────────────────────────────┐  │               │
│  📋 Logs │  │ 🤖 streaming...                    │  │               │
│          │  │ The implementation█                 │  │               │
│          │  └────────────────────────────────────┘  │               │
│          ├──────────────────────────────────────────┤               │
│          │  Input Area                              │               │
│          │  ┌────────────────────────────────────┐  │               │
│          │  │ Type a message... (@ file, / cmd)  │  │               │
│          │  │ [📎] [🖼]               [Send ⏎]  │  │               │
│          │  └────────────────────────────────────┘  │               │
│          │  [Steer ▾] [Queue: 2] [⏹ Abort]         │               │
└──────────┴──────────────────────────────────────────┴───────────────┘
```

### Right Panel Tabs

| Tab | Content | Data Source |
|---|---|---|
| Todo | Phase/task tree, editable, drag reorder | `get_state.todoPhases` + `set_todos` |
| Agents | Subagent tree: status, progress, expandable transcript | `subagent_*` events + `get_subagent_messages` |
| Diff | Latest edit diff, file selector, unified/split | `tool_execution_*` for edit/write |
| Files | Workspace file tree, click to preview | Main process fs.readdir |
| Logs | Agent log stream, search, filter by level | Tail `~/.omp/logs/` |

### Responsive Behavior

- < 1000px width: right panel → overlay drawer
- < 800px: left sidebar → icon rail (48px)
- Panels independently resizable via drag handles
- Panel sizes persisted per window (electron-store)

---

## Theme System (95 Colors)

Mapped from `dark.json` / `light.json` (verified against `theme-schema.json`).
GUI uses CSS custom properties; theme JSON loaded at runtime.

### Token Categories

```css
/* Core UI (8) */
--omp-accent: #febc38;
--omp-border: #178fb9;
--omp-border-accent: #0088fa;
--omp-border-muted: #3d424a;
--omp-success: #89d281;
--omp-error: #fc3a4b;
--omp-warning: #e4c00f;
--omp-text: (terminal default → #e4e4e7);

/* Surfaces (7) */
--omp-bg-primary: #18181e;
--omp-bg-secondary: #1e1e24;
--omp-bg-tertiary: #26262e;
--omp-selected-bg: #31363f;
--omp-user-msg-bg: #221d1a;
--omp-custom-msg-bg: #2a2530;
--omp-code-bg: #1d2129;

/* Tool cards (4) */
--omp-tool-pending-bg: #1d2129;
--omp-tool-success-bg: #161a1f;
--omp-tool-error-bg: #291d1d;
--omp-tool-output: #777d88;

/* Markdown (10) */
--omp-md-heading: #febc38;
--omp-md-link: #0088fa;
--omp-md-link-url: #5f6673;
--omp-md-code: #e5c1ff;
--omp-md-code-block: #9CDCFE;
--omp-md-code-block-border: #3d424a;
--omp-md-quote: #777d88;
--omp-md-quote-border: #3d424a;
--omp-md-hr: #3d424a;
--omp-md-list-bullet: #febc38;

/* Diff (3) */
--omp-diff-added: #89d281;
--omp-diff-removed: #fc3a4b;
--omp-diff-context: #777d88;

/* Syntax highlighting (9) */
--omp-syntax-comment: #6A9955;
--omp-syntax-keyword: #569CD6;
--omp-syntax-function: #DCDCAA;
--omp-syntax-variable: #9CDCFE;
--omp-syntax-string: #CE9178;
--omp-syntax-number: #B5CEA8;
--omp-syntax-type: #4EC9B0;
--omp-syntax-operator: #D4D4D4;
--omp-syntax-punctuation: #D4D4D4;

/* Thinking levels (6) */
--omp-thinking-off: #3d424a;
--omp-thinking-minimal: #5f6673;
--omp-thinking-low: #178fb9;
--omp-thinking-medium: #0088fa;
--omp-thinking-high: #b281d6;
--omp-thinking-xhigh: #e5c1ff;

/* Status line (12) */
--omp-status-bg: #121212;
--omp-status-model: #d787af;
--omp-status-path: #00afaf;
--omp-status-git-clean: #5faf5f;
--omp-status-git-dirty: #d7af5f;
--omp-status-context: #8787af;
--omp-status-spend: #5fafaf;
--omp-status-subagents: #febc38;
/* + muted, dim, text, sep */

/* Misc (4) */
--omp-muted: #777d88;
--omp-dim: #5f6673;
--omp-link: #0088fa;
--omp-custom-msg-label: #b281d6;
```

### Theme Modes

- `dark` (default) — values above
- `light` — inverted surfaces, adjusted contrast
- `system` — follows OS `prefers-color-scheme`
- GUI themes are independent of TUI themes (TUI `setTheme` is unavailable via RPC)

### Typography

- UI: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Code: `"JetBrains Mono", "Fira Code", "Cascadia Code", monospace`
- Sizes: 12px (dense) / 13px (default) / 14px (comfortable) — user selectable
- Line height: 1.5 (prose), 1.3 (code)

---

## Component Library

### Primitives

Button (primary/secondary/ghost/danger/icon) · Input (text/textarea/code) ·
Select (single/multi/grouped) · Checkbox · Toggle · Radio · Modal · Drawer ·
Popover · Tooltip · Tabs · Accordion · Collapsible · Badge · Tag · StatusPill ·
Spinner · Skeleton · ProgressBar · Toast · Banner · Table · VirtualList ·
ContextMenu · TreeView

### Domain Components

| Component | Description |
|---|---|
| `MessageBubble` | User/assistant/system with role styling, timestamp, actions (copy/branch/export) |
| `StreamingText` | Token-by-token with blinking cursor; RAF-batched updates |
| `ThinkingBlock` | Collapsible; auto-expand during stream, auto-collapse on `message_end` |
| `ToolCard` | Wrapper: status icon, tool name, duration, expand/collapse, error state |
| `DiffView` | Unified/split, syntax highlighted, streaming stabilization (strip trailing unbalanced removals) |
| `CodeBlock` | Syntax highlight (highlight.js subset), line numbers, copy button, language badge |
| `MarkdownRenderer` | react-markdown + remark-gfm + rehype-katex + rehype-highlight; Mermaid lazy-loaded |
| `SubagentNode` | Tree node: name, type badge, status, elapsed, expandable transcript |
| `TodoList` | Phases + tasks, status badges, drag reorder (@dnd-kit) |
| `ModelSelector` | Grouped dropdown with search, provider icons, auth status |
| `ContextMeter` | Horizontal bar: tokens/contextWindow, color shifts at 75%/90% |
| `CommandPalette` | Cmd+K overlay, fuzzy search, recent commands, keyboard navigation |
| `ApprovalDialog` | Styled select for tool approval: tool name, args preview, tier badge, Approve/Deny |
| `ExtensionDialog` | Renders select/confirm/input/editor/open_url per method |

---

## Interaction Patterns

### Streaming UX

- Text appears token-by-token (batched at 16ms/60fps)
- Thinking blocks auto-expand during stream, auto-collapse on complete
- Tool cards appear on `tool_execution_start`, update live on `tool_execution_update`
- Auto-scroll follows stream; pins when user scrolls up
- "↓ Jump to latest" floating button when pinned + new content

### Tool Execution UX

- Card appears: tool name + spinner + streaming args (partial JSON → formatted)
- Updates show progress (bash output lines, eval cell output)
- Completion: ✓ + duration, or ✗ + error message
- Click to expand full output / collapse to summary
- Large outputs (>10KB) truncated with "Show more" (lazy mount)
- Error cards: red border, error message, "Retry" action (re-prompts)

### Subagent UX

- Tree in right panel, auto-expands on new agent
- Node: name, agent type, status badge (started/running/completed/failed), elapsed
- Progress events update activity line
- Click → expand transcript (loaded via `get_subagent_messages` byte pagination)
- Completed agents dim after 5s

### Approval UX

- Dialog appears mid-stream (agent pauses)
- Shows: tool name, tier badge (read/write/exec), args preview (truncated 2000 chars)
- Buttons: Approve (green) / Deny (red)
- Timeout: none (agent waits indefinitely for approval)
- Responds via `extension_ui_response` {id, confirmed: true/false}

### Error UX

- Inline error cards in conversation (not just toasts)
- Classification: provider error / tool error / timeout / abort
- Auto-retry: countdown banner (attempt N/M, delayMs)
- Fallback: toast "Fell back to <model>"
- Fatal: red banner with "Restart session" action

---

## Accessibility

- Full keyboard navigation (Tab, Arrow, Enter, Escape)
- ARIA labels on all interactive elements
- `aria-live="polite"` on streaming region (announces completion, not every token)
- High contrast mode: bump all muted/dim colors +20% lightness
- Reduced motion: disable streaming cursor animation, thinking shimmer
- Font size scaling: Cmd+/Cmd- (persisted)
- Focus trap in modals/dialogs

---

## Keyboard Shortcuts (Default)

| Shortcut | Action |
|---|---|
| Enter | Send message |
| Shift+Enter | Newline in input |
| Esc | Abort current turn |
| Cmd+K | Command palette |
| Cmd+P | Session search |
| Cmd+N | New session |
| Cmd+, | Settings |
| Cmd+Shift+O | Toggle window (global) |
| Cmd+1-5 | Switch right panel tab |
| Cmd+B | Toggle left sidebar |
| Cmd+J | Toggle right panel |
| Cmd+C (on message) | Copy message text |
| Up/Down (empty input) | Input history |
