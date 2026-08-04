# Changelog

## [Unreleased]

### Added

- Added the Electron desktop GUI with session navigation, conversation and tool rendering, model controls, settings, workspace panels, stats, light and dark themes, and compact-window support.

### Fixed

- Fixed packaged applications crashing at startup because main-process dependencies were externalized while `node_modules` was excluded from the application archive.
- Fixed RPC extension UI subscriptions so interactive ask and approval dialogs appear and return user responses.
- Fixed historical tool calls and results rendering as empty assistant messages after session hydration.
