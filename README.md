# Raynard

Barebones Tauri v2 desktop chat app inspired by the first Raynard screen and the conversation view in `raynard-frontend`.

## Current Behavior

- Starts with a short splash screen.
- Shows a centered intro composer with prompt suggestions.
- On first submit, transitions to the conversation view.
- Streams Moonshot/Kimi responses through the same OpenAI-compatible API shape used by `raynard-backend`.
- Shows explicit provider-supplied reasoning deltas as a short live thinking preview when the upstream model sends them.
- Falls back to a deterministic hello-world response if no model key is configured.
- Reads `.env` from the Tauri backend without exposing secret values in the UI.
- Supports `/models` to connect or switch providers.
- Supports editable daily, weekly, monthly, quarterly, and yearly Explore tasks
  whose results are saved to dedicated or existing chats.

## Run

```bash
npm install
npm run tauri:dev
```

## Run the Documentation Site

The Docusaurus documentation site lives in `docs/` and runs independently from
the desktop app:

```bash
cd docs
npm install
npm start
```

The development site is available at `http://localhost:3000` by default.

## Build Checks

```bash
npm run build
cd src-tauri && cargo check
```

## Model Env

The defaults match `raynard-backend`:

```bash
MOONSHOT_API_KEY=your_key_here
STOCKBOT_DEFAULT_MODEL=kimi-k2.5
```

Supported provider/config variables:

- `STOCKBOT_DEFAULT_PROVIDER` or `STOCKBOT_MODEL_PROVIDER`, default `moonshot`
- `STOCKBOT_MODEL_BASE_URL`, default `https://api.moonshot.ai/v1`
- `STOCKBOT_DEFAULT_MODEL`, default `kimi-k2.5`
- `STOCKBOT_MODEL_API_KEY`, or provider-specific keys such as `STOCKBOT_MOONSHOT_API_KEY` and `MOONSHOT_API_KEY`

## Model Settings

Type `/models` in the composer to open the provider picker.

Current providers:

- OpenAI
- Claude
- Moonshot / Kimi

API keys entered through `/models` are stored in the operating system credential vault through the Rust `keyring` crate. The app config JSON stores only the active provider preference, not the secret values. Existing `.env` keys still work during the transition, but keychain storage takes precedence.

## Agent Runtime

The agent boundary starts in `src/agent-runtime.ts`.

For now, `runAgentTurnStream()` calls the Tauri backend command that performs a direct OpenAI-compatible streaming chat completion. The Pi packages used by `raynard-frontend` are installed:

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`

When you replace this with a fuller agent loop, keep orchestration inside this runtime boundary and load secrets from `.env` through Tauri commands rather than `VITE_` variables.
