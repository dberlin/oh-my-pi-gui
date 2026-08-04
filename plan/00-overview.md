# omp GUI — Project Overview

## What

A standalone Electron desktop GUI for the omp coding agent. It spawns
`omp --mode rpc-ui` as a child process and communicates exclusively over
stdio NDJSON. It never imports, modifies, or links against any existing
package source at runtime.

## Architecture in One Sentence

Electron main process spawns omp as a sidecar, parses the NDJSON wire
protocol, and bridges typed commands/events to a React renderer via IPC.

## Hard Constraints

1. **No Rust.** All code is TypeScript/JavaScript.
2. **No source modification.** `packages/gui/` is purely additive to the monorepo.
3. **No runtime imports** of `@oh-my-pi/*` packages in the built application.
4. **No writes to `~/.omp/`** except `~/.omp/gui/` (GUI preferences) and
   session file deletion (user-initiated, confirmed).
5. **omp binary is the only backend.** All agent capabilities accessed by
   spawning `omp --mode rpc-ui` or reading its output files.
6. **`--mode rpc-ui`** (not `rpc`). This mode wires the extension UI context
   (`hasUI = true`), enabling approval prompts, the `ask` tool, and extension
   dialogs over the wire. Plain `rpc` has `hasUI = false` and these fail closed.

## Wire Interfaces

| Interface | Transport | Direction | Purpose |
|---|---|---|---|
| `omp --mode rpc-ui` | stdio NDJSON (v1/v2, 64MB chunks) | Bidirectional | All agent operations |
| `omp stats` HTTP server | localhost:3847, GET JSON | Read-only | Usage/cost/behavior analytics |
| `~/.omp/sessions/*.jsonl` | File read | Read-only | Session listing, history metadata |
| `~/.omp/config.yml` | File read | Read-only | Display current configuration |
| `~/.omp/logs/omp.*.log` | File read (tail) | Read-only | Log viewer |
| `~/.omp/daemon/<hash>/broker.sock` | Unix socket + token auth | Bidirectional | Process management, PTY (optional) |

## Known v1 Limitations (Verified Against Source)

These capabilities exist only in the TUI's `handleTui`-only slash commands
and have no RPC transport. They are **unavailable in GUI v1**:

| Capability | Why blocked |
|---|---|
| Plan mode (enter/exit/approve) | `/plan` is handleTui-only; filtered by `executeAcpBuiltinSlashCommand` |
| Goal mode (enter/exit/guided) | `/goal`, `/guided-goal` are handleTui-only |
| Vibe mode (enter/exit) | `/vibe` is handleTui-only |
| Loop mode (enter/exit) | `/loop` is handleTui-only |
| Arbitrary settings get/set | No `get_settings`/`set_setting` RPC command exists |
| Theme switching | `setTheme` returns error in RPC; `getAllThemes` returns `[]` |
| Retry last failed turn | TUI `alt+r` has no RPC equivalent |
| Message dequeue | TUI `alt+up` has no RPC equivalent |
| Rich askDialog (multi-question) | `RpcExtensionUIContext` omits `askDialog` entirely |

Workarounds where possible:
- Retry last turn → re-send the last user message via `prompt`
- Settings → read `config.yml` for display; runtime changes limited to
  dedicated RPC commands (`set_fast_mode`, `set_thinking_level`, etc.)
  and spawn-time flags (`--approval-mode`)
- Session delete → direct file deletion (confirmed, exception to read-only)

## Non-Goals

- Replacing the TUI (both coexist, share `~/.omp/`)
- Modifying the RPC protocol or omp source
- Supporting multiple simultaneous agent processes in one window
- Web-only deployment (Electron first; extraction is a future option)
