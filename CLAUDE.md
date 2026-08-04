# Raynard Development Guide

Read and follow `AGENTS.md`; it is the canonical repository guide.

## Current Architecture

Raynard is a Tauri v2 app with two separate Pi agents:

- The main Pi agent handles every chat turn using the selected Chat/Explore
  model. Generated API plugins are registered as native Pi tools.
- The Pi coding agent starts only after a native `request_plugin_build` call,
  the Build-mode transition, and explicit user confirmation. It uses the
  separately selected Coding/Build model and may write only inside one
  generated-plugin workspace.

Do not reintroduce regex intent routing or fenced Markdown `tool_call` parsing.
Semantic Explore/Build decisions belong to the main Pi agent and its native
tools.

The runtime path is:

```text
src/main.ts
  -> src/agent-runtime.ts
  -> Rust run_main_agent_stream
  -> scripts/main-agent-sidecar.mjs
     -> native generated-plugin tool -> scripts/plugin-tool-runner.mjs
     -> request_plugin_build -> UI confirmation
        -> Rust run_plugin_builder_stream
        -> scripts/plugin-builder-sidecar.mjs
```

The builder must produce TypeScript API tools, executable mocked tests,
reference-bearing results, and README endpoint documentation. It must not
produce React UI. Completion is validated with `node --test` and runtime tool
discovery.

## Debugging the Latest Chat

On macOS:

```bash
APP_DATA="$HOME/Library/Application Support/ai.raynard"
LATEST_CHAT="$(ls -1t "$APP_DATA/chat-history"/*.json 2>/dev/null | head -1)"
test -n "$LATEST_CHAT" || { echo "No saved chats found"; exit 1; }
CHAT_ID="$(basename "$LATEST_CHAT" .json)"
TURN_LOG="$APP_DATA/agent-turn-logs/$CHAT_ID.jsonl"

jq . "$LATEST_CHAT"
tail -n 100 "$TURN_LOG" | jq .
```

Correlate these JSONL events:

- `thinking_delta`: model reasoning persisted during a running turn.
- `tool_call` / `tool_result` / `tool_error`: native plugin tool lifecycle.
- `build_request`: semantic request to enter the confirmed coding flow.
- `turn_completed` / `turn_error`: terminal main-agent outcome.
- `persist_error`: chat snapshot failure.

For an empty API answer, inspect `.payload.result.text` and
`.payload.result.references` on the `tool_result` JSONL event. If there is no
`tool_call`, inspect the main agent's available tool catalog and tool
descriptions. If there is a `tool_call` but no result, run the generated tool
directly:

```bash
PLUGIN_DIR="$APP_DATA/generated-plugins/hacker-news"
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","toolName":"getStoryList","args":{"type":"top","limit":15}}
EOF
```

More detailed commands and diagnosis cases are in `AGENTS.md`.

## Working Rules

- Preserve the Explore/Build confirmation boundary.
- Keep chat and coding model selection separate.
- Write deterministic tests before changing agent routing, schemas, plugin
  execution, or builder validation.
- Do not edit `dist/`.
- Do not commit secrets or print keychain/API credentials.
- Do not start or restart development processes during documentation-only work.
