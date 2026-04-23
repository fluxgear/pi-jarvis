# Changelog

This changelog tracks the documented release history of this project. Earlier entries were reconstructed from the repository's release tags where fuller notes were not preserved at release time.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

> Historical note: releases before the `pi-jarvis` 1.x line refer to the project's earlier `pi-btw` and `/btw` naming. Those entries are preserved as historical release records and do not describe the current product name or command surface.

## [1.2.2] - 2026-04-22

### Fixed
- Made `/jarvis` report MCP availability from the actual loaded tool set instead of extension-path discovery alone, so non-MCP extension paths no longer surface a false `MCP available` state.

### Changed
- Added regression coverage for the non-MCP extension-path case, shipped `AGENTS.md` in the published package surface, and aligned the README package-contents section with the actual npm tarball.
- Marked the stale phase-02 and next-session prompt files as historical implementation artifacts instead of live product guidance.

## [1.2.1] - 2026-04-22

### Fixed
- Hardened `/jarvis` state and overlay behavior by recognizing `npm pack --dry-run` as validation, avoiding false `done` summaries after passing validation alone, bounding latest-message refresh to post-compaction entries, preserving concurrent anonymous same-name tool activity, and keeping confirmation/footer content visible on short terminal heights.
- Improved `/jarvis-model` recovery by letting `clear` remove malformed scoped config files and by falling back between project and global settings independently when one layer is malformed.
- Tightened overlay transcript sanitization so multiline leaked tool-routing payloads are stripped while legitimate assistant content remains visible.

### Changed
- Added regression coverage for malformed config recovery, short-height confirmation rendering, package-manifest contract checks, and the new state/runtime edge cases covered by the audit sweep.
- Marked stale phase/versioned prompts as historical implementation artifacts and clarified the legacy `/btw` naming in the changelog history.

## [1.2.0] - 2026-04-22

### Added
- Added layered `/jarvis` model settings with project overrides in `.pi/jarvis.json`, global defaults in `~/.pi/agent/extensions/pi-jarvis.json`, and fallback to built-in `follow-main`.

### Changed
- Updated `/jarvis-model` to support scoped `--project` and `--global` writes plus `clear` semantics for falling back through the config layers.
- Replaced the prior branch-scoped `/jarvis` model persistence with explicit config-backed precedence and refreshed the regression coverage and README.

## [1.1.5] - 2026-04-19

### Changed
- Added the `pi-package` and `extension` keywords so `pi-jarvis` is discoverable by the `pi.dev` package index.

## [1.1.1] - 2026-04-17

### Fixed
- Fixed `/jarvis` overlay transcript leakage and redraw polish.

## [1.1.0] - 2026-04-17

### Changed
- Finished `/jarvis` awareness and overlay polish.

## [1.0.4] - 2026-04-16

### Fixed
- Stabilized `/jarvis` overlay behavior by sanitizing inherited main-agent workflow policy.
- Kept the polished `Thinking...` fallback animation and removed inconsistent structured thinking-step rendering.
- Updated regression coverage for overlay/runtime behavior.

## [1.0.0] - 2026-04-07

### Changed
- Prepared the first `1.x` release of `pi-jarvis`.

## [0.95.0] - 2026-04-07

### Added
- Added `/btw-model` side-session model selection.

## [0.9.0] - 2026-04-06

### Changed
- Release tag `v0.9.0`; detailed notes were not preserved in the changelog at the time.

## [0.8.0] - 2026-04-06

### Changed
- Bumped the package version to `0.8.0`.

## [0.7.0] - 2026-04-06

### Changed
- Release tag `v0.7.0`; detailed notes were not preserved in the changelog at the time.

## [0.6.0] - 2026-04-06

### Added
- Added `/btw` overlay forwarding toggles.

## [0.5.0] - 2026-04-06

### Added
- Added the `/btw` main-agent communication bridge.

## [0.4.0] - 2026-04-06

### Changed
- Removed direct repo and system tool access from `/btw`.

## [0.3.0] - 2026-04-06

### Added
- Injected live main-session context into `/btw`.

## [0.2.0] - 2026-04-06

### Added
- Added main-session summary context builders.

## [0.1.0] - 2026-04-06

### Added
- Initial public release of `pi-btw`, a Pi extension that opens a `/btw` side-conversation overlay inside the active Pi session.
- Persistent side-session storage and restoration for `/btw` conversations.
- Main-model synchronization so `/btw` follows the current Pi model selection.
- Automated type-check and regression test coverage.

### Changed
- Added live main-session state capture as groundwork for future context-aware `/btw` behavior without replaying the full transcript.
