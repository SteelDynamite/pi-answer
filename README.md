# pi-answer

Interactive pi extension for answering questions from the last assistant response.

Adapted from [`mitsuhiko/agent-stuff/extensions/answer.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts).

## Install

```bash
pi install git:github.com/SteelDynamite/pi-answer
```

For local testing:

```bash
pi -e ./index.ts
```

## Usage

Run:

```text
/answer
```

Or press `Ctrl+.`.

The extension:

1. Finds the last completed assistant message.
2. Uses a model to extract questions as JSON.
3. Opens an interactive Q&A UI.
4. Sends your compiled answers back into the session.

Extraction defaults to the current model with thinking off.

Run:

```text
/answer-settings
```

Use it to save a global extraction model and thinking level. Settings are stored in `~/.pi/agent/pi-answer.json`. If the saved model is unavailable or unauthenticated, `/answer` falls back to the current model.

## Development

```bash
npm install
npm run validate
```

## License

Apache-2.0
