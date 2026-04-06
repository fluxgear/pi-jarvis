# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-06

### Added
- Initial public release of `pi-btw`, a Pi extension that opens a `/btw` side-conversation overlay inside the active Pi session.
- Persistent side-session storage and restoration for `/btw` conversations.
- Main-model synchronization so `/btw` follows the current Pi model selection.
- Automated type-check and regression test coverage.

### Changed
- Added live main-session state capture as groundwork for future context-aware `/btw` behavior without replaying the full transcript.
