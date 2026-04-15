# pi-jarvis

`pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay inside the Pi coding agent.

## Features

- Opens a floating `/jarvis` overlay from within the current Pi session
- Keeps a separate side-session history
- Restores prior `/jarvis` conversation state from the session file
- Preserves the active Pi model selection for the side conversation
- Includes a small automated test suite

## Installation

```bash
npm install pi-jarvis
```

Then register the extension in Pi using the built package entrypoint.

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

The published npm package includes compiled output only:

- `dist/`
- `README.md`
- `LICENSE`

## License

MIT
