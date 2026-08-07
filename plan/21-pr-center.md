# 21 — PR Center: 全屏 PR 面板(列表 / 详情 / Diff / 创建 / Checkout)

Status: design frozen 2026-08-08. Builds on plan/20 (tab × worktree binding).
Facts: agent gh surface (`AgentPrFacts`), GUI patterns (`GuiPrFacts` partial + direct verification).

## Goal

A **PR Center** — an in-renderer fullscreen panel (AgentHubWindow precedent, Modal `size="full"`) that makes GitHub PRs a first-class GUI surface: rich list, markdown detail, syntax-highlighted per-file diffs, CI badges, AI-drafted PR creation from the active branch, and one-click PR checkout that lands in a bound worktree tab (plan/20 tie-in).

Non-goals: inline review comments, merge/rebase actions, notifications, multi-remote.

## Wire contract (new agent RPCs — rpc-pr.ts, mirrors rpc-worktree.ts)

All session-scoped (repo resolved from session cwd), network ops → `isBackgroundRpcCommand`. Reuses exported machinery: `git.github.{available,json,text}` (git.ts:2412-2472), `getOrFetchPr` / `getOrFetchPrDiff` + `parsePrUnifiedDiff` (gh.ts:2697/3160/2760, cached), `completeSimple` drafting (commit/analysis/summary.ts pattern).

```ts
| { type: "pr_repo" }
→ RpcPrRepo { available: true; repo: string; defaultBranch: string | null }
  | { available: false; reason: "gh_missing" | "not_a_repo" | "no_github_remote" }

| { type: "pr_list"; state?: "open"|"closed"|"merged"|"all"; limit?: number }
→ RpcPrListItem[] { number, title, url, isDraft, authorLogin, headRefName, baseRefName,
                    additions, deletions, updatedAt, reviewDecision: string|null,
                    checks: { success, failure, pending } }

| { type: "pr_get"; number: number }
→ RpcPrDetail { number, title, url, isDraft, authorLogin, body, baseRefName, headRefName,
                mergeStateStatus, additions, deletions, files: RpcPrFile[],
                checks: { name, status, conclusion }[] }
   RpcPrFile { path, changeType, additions, deletions }   // NO diff text (wire size)

| { type: "pr_diff"; number: number; path: string }        // per-file, lazy
→ { diff: string }                                          // unified slice for DiffView

| { type: "pr_draft"; base?: string; head?: string }
→ { title: string; body: string }                           // completeSimple + omptype tool,
                                                            // commits + truncated diff input

| { type: "pr_create"; title: string; body: string; base?: string; draft?: boolean }
→ { url: string; number: number }                           // gh pr create --body-file

| { type: "pr_checkout"; number: number }
→ { path: string; branch: string }                          // gh.ts checkoutPullRequest
                                                            // (export it — one-word change)
```

Error codes: `gh_missing | not_a_repo | no_github_remote | pr_not_found | pr_create_failed | pr_checkout_failed | pr_draft_failed`.

## GUI structure

### Shell & entry

- ui store: `prCenterOpen` + `openPrCenter()` / `closePrCenter()`; lazy `panels/PrCenterWindow.tsx` mounted in App.tsx (AgentHubWindow precedent).
- Entries: palette command `cmd.prCenter` ("PR 中心" / "PR Center", category view, window affordance); keymap action `pr.center` default **⌥P** (verify free); Sidebar group menu item for repo groups? (skip — palette + chord is enough v1).
- `stores/pr-center.ts`: `{ repo, list, selected, detail, fileDiffs, phase }` + actions refresh/select/toggleFile/draft/create/checkout. No persistence.

### Layout (three-pane, Modal size="full", h-[80vh])

```
┌────────────────────────────────────────────────────────────┐
│ ⎇ PR Center — owner/repo     [Open▾] [Draft] [All]  ⟳  +新建│
├─────────────┬──────────────────────────────────────────────┤
│ list 300px  │ #123 Add worktree binding        [Draft][✓CI]│
│ ┌─────────┐ │ @zach · omp/gui/fix → main · +120 -30 · 3h   │
│ │✓ #123   │ │ [在浏览器打开] [Checkout 到 worktree]        │
│ │ title   │ │ ── 正文 (MarkdownRenderer, collapsible) ──   │
│ │ Z·+12-3 │ │ ── Checks: ✓ build ✓ lint ✗ test (3) ──      │
│ │ 2h      │ │ ── Files ▾ src/foo.ts +12 -3 ──              │
│ └─────────┘ │    └ DiffView (syntax hl, lazy per file)     │
└─────────────┴──────────────────────────────────────────────┘
```

### Display decisions (GUI 优势)

- **CI badge per row**: ✓ green / ✗ red / ● yellow from `checks` counts — one glance health.
- **Avatar**: CSP `img-src 'self' data: blob:` blocks remote images → **initial-letter badges** (Linear-style: login[0], deterministic hue from login hash). Avatar-via-main-fetch is a noted upgrade, not v1.
- **Diff**: per-file lazy — file index from `pr_get`, slice fetched on first expand (`pr_diff`), rendered by the existing **DiffView** (lib/diff: old/new line numbers, gap markers, word-level intra-line highlight, hljs syntax). Per-file RPC keeps the wire small (8MiB gh cap).
- **Body**: MarkdownRenderer, collapsed beyond ~12 lines with 展开.
- **Checks detail**: name + status/conclusion icon rows; pending spins.
- **Empty states**: gh_missing → install hint; no_github_remote → "not a GitHub repo"; list empty → filtered-empty art.

### Create flow (AI 优势)

`+新建` → PrCreateDialog: base/head shown (head = active tab's git branch via get_git_status), [AI 起草] → `pr_draft` fills title/body (editable), draft checkbox, [创建 PR] → `pr_create` → toast with URL + list refresh.

### Checkout flow (plan/20 tie-in)

Detail header [Checkout 到 worktree] → `pr_checkout` → `openTab({ cwd: result.path, worktree: { name: "pr-<N>", branch, baseCwd: repo } })` → the tab carries the worktree binding (chip marker, close prompt) — PR 评审在隔离 worktree 里跑,关闭时走清理提示。

## Risks

- **gh auth** — no proactive probe; errors map via formatGhFailure semantics → typed `gh_missing`/auth message. Acceptable.
- **Diff size** — per-file lazy loading bounds it; binary files render a placeholder row.
- **pr_draft cost** — one small model call per click, user-initiated only.
- **gh.ts export** — `checkoutPullRequest` is module-private; exporting it (single keyword) is the only change to that file.

## Verification

- Agent: rpc-pr.test.ts — `vi.spyOn(git.github, "json"/"text")` fixtures (no live gh): repo detect states, list mapping, get/diff slicing, create arg shape, checkout reuse, draft schema parse.
- GUI: pr-center store test, list row render (badges/initials), create dialog draft→edit→create flow, checkout → openTab wiring.
- Smoke: live instance on nornzach/oh-my-pi-gui — list real PRs, open detail, expand a diff, checkout into a tab.
