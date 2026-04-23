# pi-jarvis

`pi-jarvis` adds a polished `/jarvis` side-conversation overlay to Pi so you can ask for help without derailing the main session.

## Why use it

`/jarvis` gives you a second lane for quick questions, triage, and local investigation while the main session keeps moving. Instead of interrupting the primary flow, it opens a separate persistent side thread with explicit controls for tool access and main-session handoff.

## What you get

- A floating `/jarvis` overlay inside the current Pi session
- A separate side-session history that survives reopening the overlay
- Automatic follow-main model behavior, with optional `/jarvis-model` pinning
- Permission-gated local `read`, `bash`, `edit`, and `write` access, plus `mcp` when available
- Optional non-interrupting notes or confirmed redirects back to the main session
- A focused regression suite covering the risky runtime and overlay paths

## Quick start

### 1. Install the package

```bash
npm install pi-jarvis
```

### 2. Register the extension entrypoint in Pi

Use the published entrypoint:

```text
./dist/index.js
```

This package is intended to run inside a Pi installation that provides the required peer dependencies.

### 3. Open `/jarvis`

```bash
/jarvis
```

You can also send the first message immediately:

```bash
/jarvis check this file for obvious regressions
```

Or use it as a background helper while continuing the main flow:

```bash
/jarvis summarize last 20 lines of build output and suggest next action
```

## Commands

### `/jarvis`
Opens the side overlay. If you pass text after the command, that text becomes the first side-session prompt.

### `/jarvis-model [--project|--global] <provider/model>`
Pins `/jarvis` to a specific model without changing the main session model. Plain `/jarvis-model <provider/model>` writes a project-local override in `.pi/jarvis.json`.

### `/jarvis-model [--project|--global] follow-main`
Sets the selected scope back to follow-main. A project follow-main override still wins over a global pinned setting.

### `/jarvis-model [--project|--global] clear`
Removes the selected scope's override so `/jarvis` falls back to the remaining config layer or the built-in default.

## Overlay behavior
- the current main-session state
- the active `/jarvis` model and mode
- what changed since the last `/jarvis` turn
- whether local tools are off, enabled, or enabled without MCP

The main header controls are:
- `Repo tools`
- `Note main`
- `Redirect`

All three are off by default.

## Permission model

### Repo tools
When enabled, `/jarvis` may use local:

- `read`
- `bash`
- `edit`
- `write`
- `mcp` when the MCP adapter is available in the current Pi environment

When disabled, `/jarvis` works from injected session context and the bridge controls only.

### Note main
Allows `/jarvis` to send a concise, non-interrupting note back to the main session.

### Redirect
Allows `/jarvis` to send a redirecting instruction to the main session, but every actual redirect still requires explicit confirmation.

## Session model
- `/jarvis` keeps its own isolated conversation state
- prior side-session history is restored from a session file under `jarvis-sessions/`
- `/jarvis` resolves its model from project config (`.pi/jarvis.json`), then global config (`~/.pi/agent/extensions/pi-jarvis.json`), then the built-in `follow-main` default
- plain `/jarvis-model <provider/model>` writes the project override; use `--global` to change the global default
- thinking-step streaming is collapsed to a cleaner animated fallback for readability

## Development

Install dependencies:
```bash
npm install
```

Type-check:

```bash
npm run check
```

Run tests:

```bash
npm test
```

Build the published package contents:

```bash
npm run build
```

## Published package contents

The npm package publishes:

- `dist/`
- `README.md`
- `AGENTS.md`
- `LICENSE`
- `package.json`
## License

MIT
