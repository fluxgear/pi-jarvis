# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-06

### Added
- Initial public release of `pi-jarvis`, a Pi extension that opens a `/jarvis` side-conversation overlay inside the active Pi session.
- Persistent side-session storage and restoration for `/jarvis` conversations.
- Main-model synchronization so `/jarvis` follows the current Pi model selection.
- Automated type-check and regression test coverage.

### Changed
- Added live main-session state capture as groundwork for future context-aware `/jarvis` behavior without replaying the full transcript.
