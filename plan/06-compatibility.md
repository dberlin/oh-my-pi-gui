# omp GUI — Compatibility & Distribution

## Platform Support Matrix

| Platform | Arch | Min Version | Package Format | Notes |
|---|---|---|---|---|
| macOS | arm64 (Apple Silicon) | 12.0 Monterey | .dmg, .zip (auto-update) | Universal binary preferred |
| macOS | x64 (Intel) | 12.0 Monterey | .dmg, .zip | |
| Windows | x64 | 10 (1809) | NSIS installer, portable .exe | WebView2 not needed (Electron bundles Chromium) |
| Windows | arm64 | 11 | NSIS installer | |
| Linux | x64 | GTK 3.22+ | .AppImage, .deb, .rpm, .tar.gz | |
| Linux | arm64 | GTK 3.22+ | .AppImage, .deb | |

---

## Sidecar Binary Resolution

The GUI spawns `omp` as a sidecar. Resolution order:

```typescript
const RESOLVE_ORDER = [
  // 1. User-configured path (GUI preferences)
  prefs.ompBinaryPath,
  // 2. Adjacent to GUI binary (bundled distribution)
  path.join(path.dirname(app.getPath("exe")), "omp"),
  // 3. PATH lookup
  which("omp"),
  // 4. Common install locations
  path.join(os.homedir(), ".bun/bin/omp"),
  "/usr/local/bin/omp",
  "/opt/homebrew/bin/omp",
  path.join(os.homedir(), ".local/bin/omp"),
  // 5. Bun global (source fallback)
  path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"),
];
```

If resolved path ends in `.js`/`.ts`: spawn via `bun <path> --mode rpc-ui`.
If resolved path is a binary: spawn directly with `--mode rpc-ui`.

### Version Negotiation

On `ready` frame: check `supportedProtocolVersions` includes 2.
If not: show error dialog "omp version too old, please update".
Display both versions in About dialog (GUI version + omp version from `get_state`).

---

## Spawn Configuration

```typescript
spawn(binary, [
  "--mode", "rpc-ui",
  "--approval-mode", approvalMode,  // "always-ask" | "write" | "yolo"
  ...(model ? ["--model", model] : []),
  ...(provider ? ["--provider", provider] : []),
  ...(thinking ? ["--thinking", thinking] : []),
  ...(cwd ? ["--cwd", cwd] : []),
], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_RPC_EMIT_TITLE: "1",   // Enable setTitle events
    PI_NO_PTY: "1",           // No PTY allocation (set by rpc-ui mode anyway)
    PI_NOTIFICATIONS: "off",  // Suppress BEL/OSC (set by rpc-mode anyway)
  },
  cwd: projectDir,
});
```

---

## Coexistence with CLI

### Session Ownership

- GUI acquires a session via `switch_session` (RPC owns the write path)
- Session files have single-writer guarantee (the RPC process appends)
- GUI reads session files read-only for listing/history metadata
- If CLI has a session open: GUI shows "In use" badge, opens read-only
  (detected via file lock or `lsof` on the .jsonl path)

### Config Sharing

- GUI reads `~/.omp/config.yml` for display (never writes)
- Runtime changes go through RPC commands (limited set, see 02-features §14)
- Approval mode set at spawn time via `--approval-mode` flag
- Settings requiring file changes: show "Edit config" button → opens file in system editor

### Auth Sharing

- GUI never reads/writes auth storage directly
- Login flow: RPC `get_login_providers` → `login` → `open_url` extension UI → system browser
- API key status: visible via `get_available_models` (models with valid auth)

---

## Code Signing & Notarization

### macOS

- Developer ID Application certificate
- electron-builder handles signing via `CSC_LINK` / `CSC_KEY_PASSWORD` env
- Notarization: `@electron/notarize` (Apple ID + app-specific password)
- Hardened runtime: enabled
- Entitlements: `com.apple.security.cs.allow-jit` (Electron requirement)

### Windows

- EV code signing certificate (Azure Key Vault or hardware token)
- electron-builder `win.sign` hook
- SmartScreen reputation builds over time

### Linux

- No signing standard; distribute via trusted channels
- AppImage: self-contained, no install needed
- deb/rpm: GPG-signed repository (future)

---

## Auto-Update

| Platform | Mechanism | Channel |
|---|---|---|
| macOS | electron-updater + GitHub Releases | Stable + beta |
| Windows | electron-updater + GitHub Releases | Stable + beta |
| Linux (AppImage) | electron-updater | Stable |
| Linux (deb/rpm) | System package manager | N/A |

Flow: check on launch + every 4h → download in background → notify user →
install on quit (or "Restart now") → keep previous version until confirmed boot.

---

## CI/CD Pipeline

```
Push to main / tag v*
    │
    ├─► Lint + Type check (biome + tsc --noEmit)
    ├─► Unit tests (vitest)
    ├─► Build (electron-vite build)
    │
    ├─► Package (electron-builder, matrix: mac-arm64, mac-x64, win-x64, linux-x64)
    │   ├─► macOS: sign + notarize
    │   ├─► Windows: sign
    │   └─► Linux: AppImage + deb
    │
    ├─► E2E tests (Playwright, per-platform)
    │
    └─► Publish
        ├─► GitHub Releases (draft → publish on tag)
        └─► Auto-update feed (latest.yml / latest-mac.yml)
```

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `OMP_GUI_BINARY` | Override omp binary path | (auto-resolve) |
| `OMP_GUI_STATS_PORT` | Stats server port | 3847 |
| `OMP_GUI_NO_SIDECAR` | Skip sidecar spawn (UI-only dev) | unset |
| `OMP_GUI_LOG_LEVEL` | Main process log verbosity | info |
| `OMP_GUI_APPROVAL_MODE` | Default approval mode | yolo |

---

## Known Platform Issues

| Issue | Platform | Mitigation |
|---|---|---|
| xterm.js GPU rendering artifacts | Linux (WebKitGTK) | Canvas renderer fallback (`xterm-addon-canvas`) |
| fs.watch unreliable | Linux (NFS, some FS) | Poll fallback (1s interval) |
| Wayland support | Linux | `--ozone-platform=wayland` flag in .desktop |
| Large images in conversation | All | Thumbnail + lazy full-size, object URL revocation |
| Multiple omp versions | All | Version check on ready frame, error dialog |
