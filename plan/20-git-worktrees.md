# 20 — Git Worktrees: Tab × Worktree Binding + Git Status

Status: design frozen 2026-08-07. Phases P1+P2 implemented in this pass; P3 designed, not implemented.
Source-verified facts: agent side (`AgentSideFacts` scout), GUI side (`GuiSideFacts` scout) — file:line references below.

## Goal

Give every GUI tab the option to run in its own **git worktree** (isolated checkout on its own branch), so parallel tabs never step on each other's files — the workflow Claude Code (`claude -w`) and Codex App offer manually, made first-class in the tab model. Plus the missing **git status segment** in the status footer (TUI parity: the footer doc comment currently says git is "deliberately NOT rendered — no live GUI data source").

Non-goals this pass: PR panel (P3, design below), `omp --worktree` CLI flag, ahead/behind counts, stash counts, automatic branch deletion.

## Wire contract (new agent RPC)

All session-scoped, handled in the single `handleCommand` switch (rpc-mode.ts:1233), slow ops registered in `isBackgroundRpcCommand` (rpc-mode.ts:395).

```ts
// query — cheap (git.head.resolveSync + git.status.summary, porcelain ~10-30ms)
| { id?: string; type: "get_git_status" }
→ data: RpcGitStatus {
    isRepo: boolean;
    branch: string | null;        // null when detached or not a repo
    staged: number; unstaged: number; untracked: number;
  }

// mutation — slow (worktree add on large repos), background command
| { id?: string; type: "worktree_create"; name: string; baseCwd?: string; baseRef?: "HEAD" | "default" }
→ data: RpcWorktreeCreateResult { path: string; branch: string; baseCwd: string }
→ error codes: not_a_repo | invalid_name | worktree_create_failed

// mutation — slow, background command
| { id?: string; type: "worktree_remove"; path: string; force?: boolean }
→ data: { removed: true }
→ error code worktree_dirty (force=false) with data { staged, unstaged, untracked }
   | not_a_worktree | worktree_remove_failed
```

### Naming & disk layout (follows existing conventions)

- Branch: `omp/gui/<name>` — mirrors `omp/task/<taskId>` (task/worktree.ts:768).
- Path: `getWorktreeDir("gui-<name>-<hashPath(primaryRoot)>")` = `~/.omp/wt/gui-<name>-<hash7>` (dirs.ts:601,657; `$OMP_WORKTREE_DIR` override respected) — mirrors PR checkouts `<pr>-<hash7>` (gh.ts:3297) and is swept by `omp worktree list/clear` (worktree-cli.ts:111-130) like the other two producers.
- Collision: suffix `-2..-100` on both path and branch (gh.ts:971 precedent).
- `name` validation agent-side: slugify then `/^[a-z0-9][a-z0-9-]{0,40}$/`, else `invalid_name`.
- Mutations under `git.withRepoLock` (git.ts:580, gh.ts precedent).
- `worktree_remove` dirty check via `git.status.summary(path)`; `force` passes through to `git.worktree.remove`; primary root resolved via `git.repo.linkedWorktreeSync(path)`; `git.worktree.prune` after. **The bound branch is never deleted** (merged-state detection is out of scope; manual `git branch -d` is one command).

New agent file: `src/modes/rpc/rpc-worktree.ts` (mirrors rpc-workspace.ts). Wiring: `rpc-types.ts` union arms + response arms, `rpc-mode.ts` cases + `isBackgroundRpcCommand`.

## GUI wire (main ↔ renderer)

- `IpcSpawnTabPayload.worktree?: IpcTabWorktree` where `IpcTabWorktree = { name: string; branch: string; baseCwd: string }`.
- `PoolEntry.worktree` — immutable acquire-time field, the **`kind` precedent** (sidecar-pool.ts:71-72): main-held, survives renderer reloads, carried through `tabStatusPayload` → `IpcTabInfo` → `SessionTab` → chip.
- Session-switch re-rooting (adoptSessionCwd) can move a worktree tab's chip cwd away from its worktree path; the binding stays advisory (chip icon + close prompt). Known limitation, not a guard.

## P1 — Git status segment (footer)

### Display logic

```
[model ▾] · [mode badges] · [cwd] · [⎇ main *2 +1 ?3] · [context 14%]        [session]
```

- Inserted between the cwd segment (StatusFooter.tsx:200-212) and the context meter (:214-234), same segment idiom: `<Sep/>` + icon + value, `GitBranch` lucide icon at nerd preset, `statusFooter.label.git` at ascii.
- Indicators mirror the TUI `gitSegment` (segments.ts:315-356): `*N` unstaged (warning), `+N` staged (success), `?N` untracked (dim); zero counts omitted.
- Hidden when: not a repo, `minimal` preset, or no branch.
- Tooltip: branch + full counts + path; click = immediate refresh.
- Shown on chat tabs too (they have a cwd).

### Data logic

- New renderer store `stores/git-status.ts`: `{ status: RpcGitStatus | null; refresh(): Promise<void> }`.
- Poll the **active tab's** sidecar via `window.omp.rpc.getGitStatus()` every **2.5 s** while mounted + immediate refresh on active-tab change, session/cwd change (subscribe `useSessionStore.cwd`), and `agent_end` events (a run likely touched files). No background-tab polling — the footer only renders active context.
- Store resets to `null` on tab switch until first response (no stale cross-tab flash).

## P2 — Tab × worktree binding

### Creation flow (UI/UX)

1. Entry points:
   - **TabBar**: third button in `NewTabMenu` (`GitBranchPlus` icon, `tabs.new.worktreeHint`, ⌥T via new remappable keymap action `tab.newWorktree`). The two one-click buttons stay untouched (an earlier dropdown "failed the real-user test").
   - **Sidebar group menu**: new item `sidebar.menu.newWorktreeHere` (baseCwd = that group), next to new-agent-here/new-chat-here.
2. `WorktreeDialog` (new, Modal size="sm", WorkspaceDialog shell precedent):
   - **Name field** — free text, slugified live (lowercase, spaces→`-`, strip `[^a-z0-9-]`); hint shows the resulting branch `omp/gui/<slug>` and path `~/.omp/wt/gui-<slug>-<hash>`.
   - **Base field** — two radio rows: `HEAD`（当前检出）/ `default`（仓库默认分支）. Maps to `baseRef`.
   - Buttons: `[创建并打开]` (primary, spinner while creating) / `[取消]`. Errors toast (`not_a_repo` → "该目录不是 git 仓库" etc.).
3. Operation chain: `window.omp.rpc.worktreeCreate({ name, baseRef })` on the **active tab's sidecar** (it exists — no chicken-egg; `baseCwd` defaults to its session cwd, or the Sidebar group's cwd) → `openTab({ cwd: result.path, worktree: { name, branch, baseCwd } })` → spawn binds `PoolEntry.worktree`.

### Display logic (tab strip)

- Worktree tab chip: `GitBranch` icon before the label (like the chat `MessageCircle` marker, TabBar.tsx:72-74).
- Untitled label = worktree **name** (not the ugly `gui-<name>-<hash7>` basename) — `tabChipLabel` gets a worktree branch: `tab.worktree?.name` before the cwd fallback.
- Tooltip (`title`): `<branch> — <worktree path>`.

### Close flow (lifecycle UX)

`closeTab` on a worktree tab inserts one dialog **after** the existing running-inline-confirm:

1. Query the tab's own sidecar `get_git_status` (still alive pre-close).
2. `WorktreeCloseDialog` (new, Modal size="sm"):
   - **Clean**: "Worktree 没有未提交改动。删除它?" — `[删除并关闭]` (primary) / `[保留并关闭]` / `[取消]`.
   - **Dirty** (warning accent, counts listed): `[强制删除（丢弃改动）]` (danger) / `[保留并关闭]` / `[取消]`.
3. Delete path → `worktree_remove({ path, force })` on the tab's sidecar → close tab. Keep path → just close. Failure → toast, tab stays open.
   - Sidecar release happens via the existing `closeTab` → CLOSE_TAB regardless; worktree removal runs before it.

## P3 — PR panel (designed, NOT this pass)

A drawer tab (queue/subagent precedent): list PRs for the active repo (`gh` via new agent RPC wrapping the github tool ops), one-click **draft PR from the active tab's branch** (title/body agent-drafted in-session), CI status via `run_watch`, PR diff view via `pr://<N>/diff` slices. Needs two more RPCs (`pr_list`, `pr_create`) and a diff renderer — own round.

## Risks / limitations

- **Dirty worktree data loss** — the close dialog is the only guard; `force` is explicit user action. Acceptable.
- **Session-switch escapes the worktree** — advisory binding (above).
- **`omp worktree clear` sweeps GUI worktrees** while a tab is bound → sidecar cwd vanishes mid-session. Mitigation: the CLI sweep skips live-owner dirs via `.omp-isolation-owner.json`; GUI worktrees don't write one this pass — documented; the pool's cwd validation already degrades to an error toast on spawn failure.
- **Not-a-repo workspaces** — the TabBar worktree button always shows; the dialog errors after submit. Cheap enough vs. pre-probing git on every render.

## Verification

- Agent: `test/rpc-worktree.test.ts` — create (branch+path+suffixes), dirty remove refusal + force, invalid name, not-a-repo; tmp git repos.
- GUI: pool test (worktree carried acquire→GET_TABS), tabs store test (chip label + reconcile merge), close-flow test (dialog branches), i18n parity (automatic).
- Smoke: dev instance — footer segment live vs `git status`; create worktree tab, verify `~/.omp/wt/gui-*` + `git branch`; close dialog both paths.
