# pi-answer

Pi extension for answering questions from the last assistant response in terminal Pi or RPC clients such as Paseo.

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
2. Uses `openai-codex/gpt-5.6-terra` to extract questions and optional recommended answers as JSON.
3. Opens an answer-entry flow.
4. Sends your compiled answers back into the session.

In terminal Pi, `/answer` opens the rich interactive Q&A UI. It ghost-fills recommended answers when available; press Right Arrow to accept one. `Ctrl+.` is a terminal shortcut for `/answer`.

In RPC clients such as Paseo, `/answer` falls back to simple dialog cards. Extraction runs without the custom progress UI, then each question appears as a sequential editor/text card. Recommended answers are prefilled when supported. Cancelling a card, or submitting an empty answer, stops without sending compiled answers.

Extraction always uses `openai-codex/gpt-5.6-terra`, independent of the session model. Configure OpenAI Codex authentication in Pi before using `/answer`.

## Development

```bash
npm install
npm run validate
```

## License

Apache-2.0
