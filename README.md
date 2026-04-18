# pi-jarvis

`pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay inside the Pi coding agent.

## Features

- Opens a floating `/jarvis` overlay from within the current Pi session
- Keeps a separate `/jarvis` side-session history
- Restores prior `/jarvis` conversation state from a session file under `jarvis-sessions/`
- Follows the main Pi model by default, with `/jarvis-model` available to pin a different model or return to follow-main
- Supports permission-gated local repo/system tools plus optional forwarding of a concise note or redirected instruction into the main session
- Includes a focused automated regression suite

## How to use

Start the side session from any point in Pi:

```bash
/jarvis
```

`/jarvis` opens an overlay where you can ask for quick help without interrupting your primary workflow.

You can start with a direct question:

```bash
/jarvis check this file for obvious regressions
```

Or run in the background while you continue with normal interaction:

```bash
/jarvis summarize last 20 lines of build output and suggest next action
```

Behavior notes:

- `/jarvis` has its own isolated conversation state, separate from the main session.
- `/jarvis` follows the main model by default. Use `/jarvis-model <provider/model>` to pin a side-session model, or `/jarvis-model follow-main` to restore follow-main mode.
- The overlay controls `Repo tools`, `Note main`, and `Redirect` are all off by default.
- When `Repo tools` is enabled, `/jarvis` may use local `read`, `bash`, `edit`, and `write`, plus `mcp` when it is available in the current Pi environment.
- Thinking-step streaming is intentionally collapsed to a polished animated fallback for `/jarvis` readability.

## Installation

```bash
npm install pi-jarvis
```

Then register the extension in Pi with the published entrypoint `./dist/index.js`.

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

## Package contents

The published npm package includes the compiled extension plus the public docs and metadata used by Pi and npm:

- `dist/`
- `README.md`
- `LICENSE`
- `package.json`

## License

MIT
