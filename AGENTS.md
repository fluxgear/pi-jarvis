# pi-jarvis Agent Notes

## Project Scope
- `pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay.
- Core runtime files: `index.ts`, `side-session.ts`, `overlay.ts`, `jarvis-config.ts`, `session-ref.ts`.

## Current `/jarvis-model` Behavior
- `/jarvis-model <provider/model>` writes a project-scoped override to `.pi/jarvis.json`.
- `/jarvis-model --global <provider/model>` writes a global default to `~/.pi/agent/extensions/pi-jarvis.json`.
- `/jarvis-model [--project|--global] follow-main` stores a scoped `follow-main` override.
- `/jarvis-model [--project|--global] clear` removes that scope's override so fallback applies.
- Resolution order is: project config, then global config, then built-in `follow-main`.

## Validation
- Run `npm test` for full validation.
- Run `npm run build` before release packaging.

## Docs To Keep In Sync
- `README.md`
- `CHANGELOG.md`
- `package.json` version
- this `AGENTS.md` when command/config behavior changes
