# Repository Guidelines

## Project Structure & Module Organization

This repository is a Tauri v2 desktop chat app with two Pi agent runtimes and
generated API plugins.

- `src/main.ts`: renderer UI, chat flow, slash commands, markdown rendering, and chat history interactions.
- `src/agent-runtime.ts`: typed frontend boundary for main-agent and plugin-builder streams.
- `src/build-request-flow.ts`: Explore-to-Build mode transition rules.
- `src/chat-run-registry.ts`: per-chat ownership for concurrent main-agent and builder runs.
- `src/errors.ts`: shared error formatting helpers.
- `src/plugin-suggestions.ts`: selection of empty-chat prompts across installed plugins.
- `src/result-card/`: React host renderer, declarative card resolution, examples, and tests.
- `src/components/ui/`: shadcn-style primitives used by the host result-card renderer.
- `src/styles.css`: global app, chat, sidebar, modal, and markdown styles.
- `src/*.test.ts`: Vitest unit tests for frontend helpers/runtime behavior.
- `scripts/main-agent-sidecar.mjs`: real Pi chat agent, native generated-plugin tools, and semantic build requests.
- `scripts/main-agent-core.mjs`: testable main-agent prompts, model/history conversion, schema conversion, and tool factories.
- `scripts/plugin-builder-sidecar.mjs`: confirmed Pi coding agent scoped to one generated-plugin directory.
- `scripts/plugin-builder-core.mjs`: testable coding-agent prompts and plugin validation rules.
- `scripts/plugin-tool-runner.mjs`: isolated TypeScript plugin discovery and execution, including multi-file plugins.
- `scripts/*.test.mjs`: sidecar, prompt, schema, and plugin-runner tests.
- `src-tauri/src/lib.rs`: Rust Tauri commands for sidecar streaming, cancellation, keychain/config, chat history, logs, and generated-plugin files.
- `src-tauri/Cargo.toml`: Rust dependencies and Tauri crate configuration.
- `dist/`: generated Vite build output; do not edit by hand.

## Current UI

- Startup briefly shows the centered Northfox mark, then opens with the sidebar
  folded. A persistent 54 px rail provides Chats, Generated Plugins, and New
  Chat actions; opening Chats or Plugins expands the secondary sidebar.
- Utility icons come from Lucide. The Northfox fox is a local brand SVG, not a
  Lucide icon.
- An empty conversation shows the Northfox wordmark, three suggestion cards,
  and the composer. When generated plugins provide manifest `samplePrompts`, the
  suggestions are drawn round-robin across plugins before any plugin repeats.
  If fewer than three usable plugin prompts exist, the three built-in prompts
  are shown. Clicking a suggestion fills the composer without submitting it.
- Explore and Build are automatic, host-owned states. The mode controls are
  visible but disabled, the composer identifies the selected model/role, and a
  persisted status line is inserted when the host actually changes mode.
- User messages use a muted gray block across the message width. Assistant
  output uses the app sans-serif font and supports bounded Markdown, reasoning
  details, citations, tables, and persisted result cards.
- Result cards are host-rendered React/shadcn UI beneath assistant output and
  are collapsed by default. Their disclosure label uses each plugin card's
  singular/plural names (`1 monster`, `2 monsters`, `1 resource`) and matches
  the assistant output typography while retaining the existing card color.
- The plugin sidebar lists generated plugins and opens a detail screen with
  metadata, runtime tools, card previews, README content, and selected source
  files. Splash prompts are intentionally not displayed on this screen.
- Builder turns render a live activity timeline with filesystem/test events,
  reasoning, heartbeat, and final summary. Runs belong to chats: multiple chats
  can work concurrently, navigation does not cancel them, and returning to a
  busy chat reconnects its live state and Stop control.
- `/models` opens provider configuration. Chat/Explore and Coding/Build models
  are selected independently, and API keys are stored through the OS keychain.

## Agent Architecture

There is no regex intent router and no Markdown pseudo-tool protocol in the
active chat path.

1. `src/main.ts` sends every user turn to `runMainAgentStream()`.
2. Rust command `run_main_agent_stream` resolves the selected chat model,
   discovers generated plugins, and starts `scripts/main-agent-sidecar.mjs`.
3. The sidecar creates a real Pi `Agent`. Generated plugin definitions become
   native Pi tools with JSON-schema-derived parameters.
4. Plugin calls execute through `scripts/plugin-tool-runner.mjs`. Results
   include model-visible text and structured references used for citations.
5. If capability is missing, the main agent calls the native
   `request_plugin_build` tool. It returns a structured request containing the
   plugin name, broad capability description, documentation URLs, and reason.
6. Explore mode presents the plugin-writing confirmation while remaining in
   Explore. Only the confirmation button switches the app into Build.
7. The resolved plugin name decides the confirmed flow. A brand-new plugin is
   scaffolded before the coding pass. An existing plugin is opened for in-place
   editing: Rust preserves the author's files. Plugins reuse the host-installed
   `@raynard/plugin-sdk`. The chat records an `activeBuildPlugin`,
   but every later ordinary message returns to Explore; another coding pass must
   be requested semantically and confirmed again.
8. The builder is a separate Pi coding agent with filesystem coding tools
   (read/edit/write/grep/ls/bash) scoped to that plugin directory. It uses the
   selected coding model. Each confirmed coding request is one editing pass;
   `run_plugin_builder_stream` forwards `editMode` and the recent conversation so
   follow-ups have context.
9. A fresh build is gated on executable mocked tests, `node --test`, runtime tool
   discovery, at least one exported tool, a README Endpoint Inventory, and
   exactly three valid splash prompts in `plugin.json.samplePrompts` (validation
   failure gives one repair pass). An interactive edit turn is not forced
   through that gate — the agent makes the smallest change and runs the
   relevant tests via `node --test` when appropriate.
10. Every generated API tool carries a fixed declarative result-`card` (+
    `data`) rendered by the host as a React/shadcn card, including list/search
    tools. The builder only authors the declarative template — never React.

Every ordinary user message switches to Explore and uses the selected
Chat/Explore model. The Pi coding agent uses the separately selected
Coding/Build model only after the plugin-writing confirmation. `/models`
configures these roles independently.

The Stop button calls `cancel_model_chat_stream`. Rust records cancellation and
terminates the selected chat's main-agent or builder sidecar process; Pi also
receives `SIGTERM` and aborts that run. Runs are owned per chat, so other chats
can continue concurrently. Navigating back to a busy chat reconnects the
renderer to its in-memory messages and stream controls.

## Generated Plugin Contract

Generated plugins live in the Tauri app-local-data `generated-plugins`
directory, not in this repository. A completed current plugin normally contains:

- `plugin.json`: plugin metadata, SDK version, sources, and three sample prompts.
- `tools.ts`: runtime entry and exported `defineTools({...})` registry.
- Optional `client.ts` and other API-specific supporting modules.
- `README.md`: tools, source documentation, and Endpoint Inventory.
- `*.test.ts`, `*.test.js`, or `*.test.mjs`: executable mocked API tests.

The host installs one shared, versioned `@raynard/plugin-sdk` under the
generated-plugin root. It owns runtime helpers, tool/card/reference types, and
mocked-test helpers. Plugins do not copy `index.ts`, `runtime.ts`, `testing.ts`,
or `contract.test.ts`. Local supporting modules use explicit `.ts` ESM paths.

Each tool needs a specific routing description, an object JSON parameter
schema, an async `execute(args)` implementation, a fixed declarative result
card, and matching structured `data` on every successful result path.
API-derived results must also return useful text and source references.
References should retain the source URL and enough structured/raw API payload
for the main agent to support and cite its claims.

## Build, Test, and Development Commands

- `npm run dev`: start the Vite renderer on `127.0.0.1:1420`.
- `npm run tauri dev`: run the full desktop app in development mode.
- `npm test -- --run`: run the Vitest suite once.
- `npm run build`: type-check TypeScript and build the renderer.
- `cargo check --manifest-path src-tauri/Cargo.toml`: check the Rust/Tauri backend.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: run Rust unit tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml`: format Rust code.
- `node --check scripts/main-agent-sidecar.mjs`: syntax-check a sidecar without starting the app.

Do not start `npm run dev` or `npm run tauri dev` when the user asks for
documentation-only work or explicitly wants the current application process
left undisturbed.

## Coding Style & Naming Conventions

Use TypeScript for renderer code and Rust for Tauri commands. Keep UI helpers small and close to their call sites unless they are shared across files. Prefer explicit type aliases for Tauri payloads and responses. Use `camelCase` in TypeScript and serialized JSON payloads, and `snake_case` for Rust internals with Serde renaming where needed.

Use existing formatting conventions: two-space indentation in TypeScript/CSS, `cargo fmt` for Rust, and descriptive command names such as `save_chat_history`.

## Testing Guidelines

Vitest is the frontend test framework. Place tests next to source files as `*.test.ts`. Add focused tests for runtime behavior, error handling, and parsing logic when those surfaces change. Always run `npm test -- --run` and `npm run build` before committing frontend changes. Run `cargo check` when touching `src-tauri`.

For agent architecture changes, also add focused tests under `scripts/` for
prompt policy, native tool schemas, builder validation, and plugin execution.
Use a failing test first. Do not use a live provider call as the only test;
live calls are optional smoke tests after deterministic tests pass.

## Debugging Recent Chats

On macOS, Tauri data for this application is normally stored under:

```text
~/Library/Application Support/ai.raynard/
├── chat-history/
├── agent-turn-logs/
└── generated-plugins/
```

Find and inspect the latest saved conversation:

```bash
APP_DATA="$HOME/Library/Application Support/ai.raynard"
LATEST_CHAT="$(ls -1t "$APP_DATA/chat-history"/*.json 2>/dev/null | head -1)"
test -n "$LATEST_CHAT" || { echo "No saved chats found"; exit 1; }
echo "$LATEST_CHAT"
jq . "$LATEST_CHAT"
```

Show only the message timeline, including persisted thinking, model, status,
and error fields:

```bash
jq -r '.messages[] | [.timestamp, .role, (.status // ""), (.provider // ""), (.model // ""), (.thinking // ""), .text, (.error // "")] | @tsv' "$LATEST_CHAT"
```

Agent turn logs use the chat filename as the chat ID:

```bash
CHAT_ID="$(basename "$LATEST_CHAT" .json)"
TURN_LOG="$APP_DATA/agent-turn-logs/$CHAT_ID.jsonl"
tail -n 100 "$TURN_LOG" | jq .
```

Useful event types are `turn_start`, `stream_id`, `thinking_delta`,
`tool_call`, `tool_result`, `tool_error`, `build_request`, `turn_completed`,
`turn_error`, and `persist_error`.

Quick diagnosis:

- No `build_request` for a capability-creation prompt means the main Pi agent
  did not call `request_plugin_build`; inspect the main-agent prompt, native
  tool registration, provider/model, and stored thinking.
- `build_request` exists but no confirmation appears points to renderer stream
  handling or `src/build-request-flow.ts`.
- `tool_call` without `tool_result` points to plugin loading, execution,
  network behavior, or cancellation. A following `tool_error` contains the
  surfaced failure.
- `tool_result` contains empty text/references means the generated plugin
  executed but returned an inadequate result.
- A chat stuck with assistant `status: "running"` means the process ended
  before a final snapshot. Check the last JSONL event for `turn_error`,
  `persist_error`, or an unfinished tool call.
- Builder progress is summarized into the persisted assistant result. Detailed
  builder filesystem/test activity is streamed as thinking/status while the
  turn runs, so reproduce with the plugin tests and runner when post-mortem
  detail is insufficient.

Inspect the installed plugin and list its runtime tools:

```bash
PLUGIN_DIR="$APP_DATA/generated-plugins/hacker-news"
jq . "$PLUGIN_DIR/plugin.json"
sed -n '1,260p' "$PLUGIN_DIR/README.md"
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","listTools":true}
EOF
```

Call one plugin tool directly:

```bash
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","toolName":"hn_list_top_stories","args":{"limit":15}}
EOF
```

The runner prints one JSON object. Success requires `"ok": true`; inspect
`result.text` and `result.references`, not only process exit status.

## Commit & Pull Request Guidelines

Current commits use short imperative summaries, for example `Initial Tauri chat app` and `Add chat history sidebar and markdown rendering`. Keep commits scoped and avoid mixing unrelated UI, backend, and documentation work unless they are part of one feature.

Pull requests should describe the user-facing change, list verification commands run, and include screenshots or screen recordings for visual UI changes.

## Security & Configuration Tips

Do not commit `.env` or API keys. `.env.example` documents expected variables. API keys entered through `/models` are stored in the operating system keychain via Rust `keyring`; app config should store preferences only, not secrets.

Never print API keys while debugging sidecars. Pass credentials through the
normal Rust/keychain path. Generated plugin directories are constrained and
validated by Rust before the coding agent or tool runner is started.
