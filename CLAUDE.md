# Raynard Development Guide

Read and follow `AGENTS.md`; it is the canonical repository guide.

## Current Architecture

Raynard is a Tauri v2 app with two separate Pi agents:

- The main Pi agent handles every chat turn using the selected Chat/Explore
  model. Generated API plugins are registered as native Pi tools.
- The Pi coding agent runs only after a native `request_plugin_build` call and
  explicit plugin-writing confirmation. The confirmed pass is scoped to one
  generated-plugin workspace. A new plugin is scaffolded; an existing plugin is
  edited in place. Every later ordinary message returns to Explore, so another
  coding pass requires another semantic build request and confirmation. The
  builder uses the separately selected Coding/Build model.

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
        -> resolve plugin (existing = edit, new = scaffold)
        -> Rust run_plugin_builder_stream (editMode + prior messages)
        -> scripts/plugin-builder-sidecar.mjs  (one editing pass per turn)
```

A fresh build must produce TypeScript API tools, executable mocked tests,
reference-bearing results, and README endpoint documentation, and is validated
with `node --test` and runtime tool discovery. An interactive **edit** turn is
not forced through that whole-plugin validation — the coding agent reads the
existing files, makes the smallest change the user asked for, and runs
`node --test` via its bash tool when appropriate. Neither mode may produce React
UI. Final-data tools carry a fixed declarative result-`card` (+ `data`) rendered
by the host; the builder never writes React.

Agent and builder runs are tracked per chat. Multiple chats may run
concurrently; navigation reattaches to the selected chat's live message state,
and Stop cancels only that chat's stream.

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

- Preserve the Explore/Build boundary. Every ordinary message runs in Explore;
  only explicit confirmation of a plugin-writing request enters Build.
- Keep chat and coding model selection separate.
- Write deterministic tests before changing agent routing, schemas, plugin
  execution, or builder validation.
- Do not edit `dist/`.
- Do not commit secrets or print keychain/API credentials.
- Do not start or restart development processes during documentation-only work.
