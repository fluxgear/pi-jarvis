# Changelog

This changelog tracks the tagged release history of this project. Earlier entries were reconstructed from the repository's release tags where fuller notes were not preserved at release time.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
