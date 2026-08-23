# Repository Guidelines

`CLAUDE.md` is a symlink to this file: both names resolve to the same bytes on
disk, and there is nothing to keep in sync. Edit `AGENTS.md`. Applying the same
change to both paths inserts it twice — a script that reads, edits, and writes
each name in turn will silently duplicate whatever it added, and a `diff` of the
two paths cannot catch it because it always reports them identical. Check with
`ls -la CLAUDE.md` if in doubt.

## Project Structure & Module Organization

This repository is a Tauri v2 desktop chat app with two Pi agent runtimes and
generated API plugins.

- `src/main.ts`: renderer UI, chat flow, slash commands, markdown rendering, and chat history interactions.
- `src/agent-runtime.ts`: typed frontend boundary for main-agent and plugin-builder streams.
- `src/build-request-flow.ts`: Explore-to-Build mode transition rules.
- `src/chat-run-registry.ts`: per-chat ownership for concurrent main-agent and builder runs.
- `src-tauri/src/scheduled_tasks.rs`: persisted recurring schedules, due-task
  claiming, calendar/time-zone calculation, completion, and interrupted-run
  recovery.
- `src/errors.ts`: shared error formatting helpers.
- `src/plugin-suggestions.ts`: selection of empty-chat prompts across installed plugins.
- `src/result-card/`: React host renderer, declarative card resolution, examples, and tests.
- `src/result-card/template-fields.ts`: the single walker over the `CardBlock` union; drives both example data and share-link projection.
- `src/share/`: share-link payload, codec, degradation ladder, share sheet, and deep-link import.
- `share.config.json`: share base URL, app URL scheme, and DMG download link, read by both the app and `docs/`.
- `src/components/ui/`: shadcn-style primitives used by the host result-card renderer.
- `src/styles.css`: global app, chat, sidebar, modal, and markdown styles.
- `src/*.test.ts`: Vitest unit tests for frontend helpers/runtime behavior.
- `scripts/main-agent-sidecar.mjs`: real Pi chat agent, native generated-plugin tools, and semantic build requests.
- `scripts/main-agent-core.mjs`: testable main-agent prompts, model/history conversion, schema conversion, and tool factories.
- `scripts/plugin-builder-sidecar.mjs`: confirmed Pi coding agent scoped to one generated-plugin directory.
- `scripts/plugin-builder-core.mjs`: testable coding-agent prompts and plugin validation rules.
- `scripts/plugin-tool-runner.mjs`: isolated TypeScript plugin discovery and execution, including multi-file plugins.
- `scripts/*.test.mjs`: sidecar, prompt, schema, and plugin-runner tests.
- `extensions/`: bundled, pre-approved extension catalog installed through `/extensions`.
- `docs/src/pages/s.js` + `docs/src/lib/share-link.js`: the share-link landing page and its decode-only copy of the codec.
- `src-tauri/src/lib.rs`: Rust Tauri commands for sidecar streaming, cancellation, keychain/config, chat history, logs, generated-plugin files, and deep-link delivery.
- `src-tauri/Cargo.toml`: Rust dependencies and Tauri crate configuration.
- `dist/`: generated Vite build output; do not edit by hand.

## Current UI

- Startup briefly shows the centered Northfox mark, then opens with the sidebar
  folded. A persistent 54 px rail provides Chats, Generated Plugins, and New
  Chat actions; opening Chats or Plugins expands the secondary sidebar.
- Utility icons come from Lucide. The Northfox fox is a local brand SVG, not a
  Lucide icon.
- A finished assistant answer carries a hover action row (`.message-actions`)
  with Bookmark and Share. Share opens a sheet that builds a link, names
  anything the link had to trim, and refuses to show a link it knows is too
  long. An answer opened from a share link is marked `sharedImport` and renders
  a banner saying its results are a snapshot — a follow-up runs live, because
  the model only ever sees the transcript text, never the imported card data.
- An empty conversation shows the Northfox wordmark, three suggestion cards,
  and the composer. When generated plugins provide manifest `samplePrompts`, the
  suggestions are drawn round-robin across plugins before any plugin repeats.
  If fewer than three usable plugin prompts exist, the three built-in prompts
  are shown. Clicking a suggestion fills the composer without submitting it.
- Explore and Build are automatic, host-owned states. There are no mode
  buttons: the composer carries one muted line naming the active
  `provider/model` and its role (`explorer` or `builder`), and a persisted
  status line is inserted when the host actually changes mode. That line never
  mentions `.env` — where a credential came from is a setup detail owned by
  onboarding and `/models`.
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
- `/extensions` opens a catalog with the user's installed extensions and the
  pre-approved extensions bundled with the app. It separates locally coded
  extensions (`Your extensions`), installed catalog entries (`Installed`), and
  catalog entries not yet copied into app data (`Available`). Installing copies
  a bundled folder into app-local `generated-plugins`, where it becomes an
  ordinary, editable extension.
- The timer icon opens Scheduled tasks. Recurring requests first render an
  editable host confirmation; saving creates a daily, weekly, monthly,
  quarterly, or yearly Explore task in the selected time zone. A task targets
  either a dedicated task chat or an existing chat and can be edited, paused,
  resumed, run immediately, or deleted from its detail screen. Run now does not
  move the recurring schedule.
- The composer stays live while an Explore turn is working. Enter queues what
  you type as a **steering** message the agent picks up at its next tool-round
  boundary; Alt+Enter queues a **follow-up** that waits until the agent would
  otherwise stop. Queued text sits in a dim strip above the composer, never in
  the transcript, until the agent actually takes it — at which point the answer
  so far is closed off, the message becomes a real user bubble, and a new
  assistant bubble opens under it. Stopping the turn, or its ending first, hands
  anything undelivered back to the composer. A builder turn has no steering
  channel and still locks the composer.
- Builder turns render a live activity timeline with filesystem/test events,
  reasoning, heartbeat, and final summary. Runs belong to chats: multiple chats
  can work concurrently, navigation does not cancel them, and returning to a
  busy chat reconnects its live state and Stop control.
- On a first run with nothing connected anywhere — no keychain credential and
  no key in `.env` — a full-screen gate asks for a provider before the app can
  be used: one "Sign in with ChatGPT" button and an "Other" link that reveals
  the key-based providers, each with a link to the console that issues keys.
- `/models` opens provider configuration and lists ChatGPT, Claude, and Kimi.
  One provider serves both roles, at that provider's default model; the model
  is not editable in the UI. The key-based `api.openai.com` account is not a
  fourth row — it sits behind a secondary link, and is promoted to a row only
  while it is the active provider. API keys are stored through the OS keychain.

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
   discovery, at least one exported tool, a README Endpoint Inventory, exactly
   three valid splash prompts in `plugin.json.samplePrompts`, valid
   `plugin.json.catalogMetadata` contribution suggestions, at least one test
   pinning the API host as a literal absolute URL, and **one live call**: the
   first zero-argument tool is executed against the real API and must return
   text, references, and a non-empty list. Validation failure gives one repair
   pass. Mocked tests alone cannot see a wrong base URL — a mock matching on a
   path fragment, or on a base-URL constant imported from the module under
   test, stays green through a total rewrite of the host. An interactive edit
   turn is not forced through the full gate — the agent makes the smallest
   change and runs the relevant tests via `node --test` — but an edit that
   changed files runs the same live call, with one repair attempt, and a
   failure is reported to the user rather than being reported as done.
10. Every generated API tool carries a fixed declarative result-`card` (+
    `data`) rendered by the host as a React/shadcn card, including list/search
    tools. The builder only authors the declarative template — never React.

## Steering a Running Turn

Typing during an Explore turn does not start a second one. `submitMessage` in
`src/main.ts` routes the text to `steer_main_agent_stream` instead, and the
message joins pi's own queue inside the running sidecar.

1. `run_main_agent_stream` keeps the sidecar's `ChildStdin` instead of dropping
   it, parked in `AgentSteerState` under the run's `stream_id`. A `Drop` guard
   removes it however the command returns. This mirrors `OAuthLoginState` and
   `submit_provider_oauth_code`, which do the same for a pasted sign-in code.
2. `scripts/main-agent-sidecar.mjs` therefore reads stdin as newline-delimited
   JSON for the whole turn: the first line is the request, later
   `{"type":"steer"|"follow_up","text":...}` lines are commands. Because stdin
   no longer closes, the sidecar closes its own reader once the turn is done.
3. A command calls `agent.steer(...)` or `agent.followUp(...)` on the Pi
   `Agent`. Both queues stay at pi's `one-at-a-time` default. `agent-loop`
   drains steering after every `turn_end` — after that round's tool results are
   in the transcript, before the next model request — and drains follow-ups only
   when the agent would otherwise stop.
4. The sidecar mirrors the texts it queued so it can recognise a delivery: the
   loop emits a plain user `message_start` for an injected message, and the
   turn's own prompt looks identical. On a match it emits `steering_applied`.
5. The host answers that event by closing the current assistant record and
   opening a new one, with the steered message as a real user record between
   them. This is not decoration: the sidecar's final `text` is only the last
   assistant message, so one record per turn would discard everything written
   before the steer.
6. Undelivered messages live on the run in `ChatRunRegistry`, so navigating away
   from a busy chat and back does not lose them, and Stop returns them to the
   composer rather than dropping them with the process.

The plugin builder is deliberately not steerable: its turn is several prompt
phases plus a validation gate, and an injected message landing in a repair pass
is worse than waiting.

Every ordinary user message switches to Explore and uses the selected
Chat/Explore model. The Pi coding agent uses the separately selected
Coding/Build model only after the plugin-writing confirmation. The two roles
still have separate config fields (`active_provider`/`active_model` and
`active_coding_provider`/`active_coding_model`), but `/models` writes both at
once with `role: "both"`, so one provider and model serve the whole app.

The Stop button calls `cancel_model_chat_stream`. Rust records cancellation and
terminates the selected chat's main-agent or builder sidecar process; Pi also
receives `SIGTERM` and aborts that run. Runs are owned per chat, so other chats
can continue concurrently. Navigating back to a busy chat reconnects the
renderer to its in-memory messages and stream controls.

## Scheduled Tasks

Scheduling is a host-owned Explore flow, not a separate agent mode and not a
background capability granted to generated plugins.

1. When the user asks for recurring work, the main agent's first and only tool
   call is `request_scheduled_task`. The tool returns a structured draft with a
   name, execution-only prompt, destination, recurrence, local time, and IANA
   time zone. It does not perform the requested research in that turn.
2. `src/main.ts` renders the draft as an editable confirmation. Saving calls
   `create_scheduled_task`; Rust validates the destination and calendar fields
   before persisting the task under app-local data at
   `scheduled-tasks/tasks.json`.
3. `src-tauri/src/lib.rs` owns a 30-second wake loop and streams wake events to
   the renderer through `subscribe_scheduled_tasks`. The renderer lists and
   claims due work, queues executions one at a time, and waits when a target
   chat already owns another run.
4. A scheduled execution is an ordinary main Pi agent run with scheduling
   disabled, so it cannot recursively create another task. It uses Explore,
   the currently selected provider/model, installed plugin tools, and the
   normal result-card/source persistence path.
5. Dedicated tasks create one chat on their first run and reuse it thereafter.
   Existing-chat tasks append to the selected chat. Both the user and assistant
   records carry the task name and execution ID so the transcript can label
   their origin.
6. Scheduled work cannot silently enter Build. A missing capability is recorded
   as an explanation to open the chat and request the build interactively;
   credential requests likewise remain user-owned.
7. Completing a run records its status, error, last-run time, and destination.
   A manual **Run now** does not advance the recurring occurrence. Startup
   clears abandoned execution IDs and marks those runs interrupted.
8. The scheduler runs only while the Raynard process is alive. A task left due
   while the app is closed is claimed once after the next configured launch;
   missed occurrences are not replayed individually.

## Sharing an Answer

An assistant answer can be shared as a link. There is no server and no account:
the whole payload rides in the URL **fragment**, which is never transmitted, so
nothing is uploaded and nothing is stored anywhere.

    https://<shareBaseUrl>/s#<base64url(deflate-raw(json))>

1. The Share button on a message opens `src/share/share-modal.ts`. It hydrates
   any artifact-backed cards (`read_result_artifact`), builds the payload, and
   measures it.
2. `src/share/payload.ts` carries the question, the answer markdown, its
   `cards`, its `sources`, and the extensions behind them. It deliberately
   leaves out `usage`, `provider`, `model`, `thinking`, builder activity,
   credential requests, timestamps, the chat id, and the card `artifact` ref —
   a local path that would leak a chat id. Nothing identifies the sender.
3. `src/share/degrade.ts` encodes, measures, and degrades until the link fits
   `SHARE_URL_BUDGET_CHARS` (8192). Rungs, in order: drop citation excerpts,
   project card data, cap table rows at 100, then 25, then keep the first five
   cards. Each rung is derived from the original payload, never from the
   previous rung. If nothing fits, `degraded.overBudget` is set and the sheet
   refuses to show a link rather than hand over a broken one. **Answer text is
   never truncated.**
4. Projection (`src/share/project.ts`) is the biggest lever and is lossless from
   the reader's point of view: `src/result-card/resolve.ts` is the only
   interpreter of card `data`, so a field the template never names cannot reach
   the screen. That is why the share sheet reports trimmed rows and dropped
   cards but stays silent about projection.
5. `docs/src/pages/s.js` decodes the fragment in the browser and shows only a
   teaser — the question, the card count, the extension. The app precomputes
   those strings into `payload.teaser`, so the docs site needs no copy of the
   card renderer. `src/share/docs-parity.test.ts` is what stops its duplicated
   decoder from drifting.
6. "Open in Raynard" opens `raynard://share/<encoded>`. Rust validates the URL
   (`share_deep_link_payload`), buffers it if the webview is not up yet
   (`PendingDeepLinks`), and pushes it over a `Channel` via
   `subscribe_deep_links`. It is deliberately **not** `listen()` from
   `@tauri-apps/api/event`: that would require the app's first capability file
   and change the whole webview's permission posture.
7. `openSharedAnswer` in `main.ts` opens a new chat holding the question and
   answer. Viewing needs no credentials. An uninstalled bundled extension is
   offered through the existing inline install card.

Why 8192 when browsers allow far more: a fragment escapes every server
request-line limit, but plaintext email hard-wraps at RFC 5322's 998 octets and
can silently corrupt a long URL. Measured against 256 real answers, the ladder
fits **99.2%** under that budget, and 210 of them need no degrading at all.

**The macOS URL ceiling is not the constraint.** LaunchServices was measured
delivering `raynard://` URLs of **262,166 characters** intact, cold and warm —
32x the budget. No clipboard handoff or file fallback is needed.

`CompressionStream('deflate-raw')` requires Safari 16.4, which is why
`minimumSystemVersion` is `13.0`. The macOS distribution is Apple-Silicon-only
and every such Mac can run macOS 13+, so this costs no macOS users and avoids a
Rust deflate dependency.

Deep links cannot be registered at runtime on macOS, so `npm run tauri dev`
never receives one. Load `http://127.0.0.1:1420/#share=<encoded>` instead — the
dev backdoor in `src/share/deep-link.ts` runs the identical import path.

## Generated Plugin Contract

Generated plugins live in the Tauri app-local-data `generated-plugins`
directory, not in this repository. A completed current plugin normally contains:

- `plugin.json`: plugin metadata, SDK version, sources, three sample prompts,
  and builder-authored catalog contribution suggestions.
- `tools.ts`: runtime entry and exported `defineTools({...})` registry.
- Optional `client.ts` and other API-specific supporting modules.
- `README.md`: tools, source documentation, and Endpoint Inventory.
- `*.test.ts`, `*.test.js`, or `*.test.mjs`: executable mocked API tests.

The host installs one shared, versioned `@raynard/plugin-sdk` under the
generated-plugin root. It owns runtime helpers, tool/card/reference types, and
mocked-test helpers. Plugins do not copy `index.ts`, `runtime.ts`, `testing.ts`,
or `contract.test.ts`. Local supporting modules use explicit `.ts` ESM paths.

Bundled extensions use the same runtime contract but live under the repository
`extensions/` catalog. Their static `plugin.json` adds catalog metadata such as
`category`, `icon`, and `contributes.tools`; listing never executes extension
code. Catalog contract tests validate manifests, run mocked `node --test` tests,
and perform runtime tool discovery before a contributed folder can ship.

### Plugin locality and catalog promotion

Plugins created through chat are local by default. They stay under the user's
app-local `generated-plugins` directory and must not be copied into, committed
to, or otherwise inferred as candidates for the repository `extensions/`
catalog. A working local plugin is not automatically a bundled extension.

Promotion is an explicit publishing action. Only promote a local plugin when
the user specifically asks to make that named plugin central, bundled, or
available in the repository catalog. Promotion should:

1. Leave the app-local original in place and copy only the authored plugin
   files into a new `extensions/<kebab-case-slug>/` directory.
2. Exclude credentials, `.env` files, runtime caches, `.plugin-data`, build
   output, and other machine-local files.
3. Convert `plugin.json` into a static catalog manifest: use a stable
   `raynard.catalog.<slug>` ID, `status: "bundled"`, catalog metadata
   (`category`, `tags`, `icon`, `author`, and `homepage`), exactly three sample
   prompts, source URLs, and a `contributes.tools` summary matching the exported
   runtime tools. Never include secret values.
4. Preserve the normal plugin contract: `@raynard/plugin-sdk`, declarative
   cards, useful text and references, matching structured data, mocked tests,
   and a README Endpoint Inventory.
5. Run the focused catalog gate with
   `npx vitest run scripts/extension-catalog.test.mjs`, then run
   `npm test -- --run` and `npm run build` before committing.
6. Commit the complete `extensions/<slug>/` folder. Merge/acceptance of that
   repository change is the approval step; it ships in the bundled catalog with
   the next packaged release.

Removing an extension from the central catalog is the reverse publishing
decision, not deletion of the user's plugin. Before removing
`extensions/<slug>/`, verify the user has an app-local copy if they want to keep
using it. Removing the repository folder stops bundling it in future releases;
it must not delete or overwrite an already installed app-local copy.

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

## Packaged Desktop Releases

A shipped app cannot rely on the developer's machine, so the desktop bundle
embeds its own Node runtime. `scripts/standalone-runtime.mjs` downloads the
checksum-pinned Node for `aarch64-apple-darwin`,
`x86_64-unknown-linux-gnu`, or `x86_64-pc-windows-msvc` and stages two build
outputs, both gitignored:

- `src-tauri/binaries/node-<target-triple>` (plus `.exe` on Windows), declared
  as `externalBin`, so Tauri places the renamed `node` executable beside the
  packaged Raynard executable.
- `src-tauri/runtime/agent-runtime`, declared as a bundle `resources` entry, so
  it lands under Tauri's platform resource directory with `scripts/`,
  `plugin-sdk/`, and the target-native locked `node_modules`.

`beforeBuildCommand` is `npm run build:desktop`, which stages that runtime
before the Rust build. `RUNTIME_SCRIPTS` in `standalone-runtime.mjs` must hold
the full relative-import closure of the four sidecar entry points; a test in
`scripts/standalone-runtime.test.mjs` derives that closure and fails when a new
`./*.mjs` import is not packaged.

Rust resolves scripts from Tauri's platform-aware resource directory and Node
from `env::current_exe()`, then falls back to the directory-relative `scripts/`
candidates and system Node for `tauri dev` and tests. Packaged apps cannot rely
on their current working directory or a user-installed Node.

The embedded Node arrives from nodejs.org already signed and carrying
`com.apple.security.get-task-allow`, which Apple's notary rejects. Tauri
re-signs it with `src-tauri/Entitlements.plist`, dropping that key and keeping
the `allow-jit` and `allow-unsigned-executable-memory` entitlements V8 needs
under the hardened runtime. `.github/workflows/release-macos-arm64.yml` asserts
this rather than assuming it.

`scripts/verify-standalone-bundle.mjs` is the cross-platform gate that matters:
it runs the bundled Node, syntax-checks every script the manifest claims to
package, drives both sidecars to their "model API key is required" error, and
executes a real tool through the packaged runner. Run the macOS wrapper against
a local build with `npm run verify:macos:bundle`.

Linux releases contain an x86_64 AppImage and amd64 Debian package. Windows
releases contain an unsigned x64 NSIS installer; SmartScreen warnings are
expected until Windows signing is introduced. `docs/static/install.sh` and
`install.ps1` provide checksum-verified, per-user terminal installation and are
uploaded as stable release assets.

Release builds are tag-triggered (`v*`) or manual, and require these repository
secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

## Release Workflow

- When the user says `create a new release`, treat that prompt as a request to
  run the complete release procedure below. Do not create a tag immediately.
- First inspect the current version in `package.json` and recommend the next
  minor version by default (for example, recommend `v0.2.0` after `0.1.0`). Ask
  the user to confirm the exact target version unless they already supplied it.
- Never create or push a release tag until the user has confirmed its exact
  version.
- After confirmation, perform the release in this order:
  - inspect the git worktree and understand any existing changes before editing
  - update the app version consistently in `package.json`, `package-lock.json`,
    `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the Raynard package
    entry in `src-tauri/Cargo.lock`
  - identify the previous release tag and derive the release notes from the
    previous-tag-to-HEAD diff; for the first release, derive them from the
    repository history
  - create or update `release-draft.md`; its first line must be exactly
    `# Raynard v<version>`, and its contents must describe the actual shipped
    changes rather than a generic template
  - run `npm run release:validate -- v<version>`, `npm test -- --run`,
    `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, and
    `cargo check --manifest-path src-tauri/Cargo.toml`
  - commit the version and release notes with a clear release commit message
    unless the user explicitly asks not to commit
  - create an annotated `v<version>` tag on that release commit, using the
    release notes in its message when practical
  - push the release commit to the main remote branch, then push the tag
- Before pushing, verify all app version sources equal the tag without its
  leading `v`, `release-draft.md` has the exact release heading, the annotated
  tag points at the release commit, and the release workflow still validates
  the version before building.
- The pushed tag triggers `.github/workflows/release-macos-arm64.yml`. A
  successful workflow must build and verify the native macOS arm64, Linux x64,
  and Windows x64 packages; sign and notarize the macOS app; publish one
  non-draft GitHub release; and attach versioned artifacts, stable aliases, and
  SHA-256 checksums for every platform. The final publishing job must wait for
  every native job and must also attach `install.sh` and `install.ps1`.
- After pushing, report the exact release commit and tag and tell the user that
  GitHub Actions is producing the release binary. If possible, check the
  workflow run and report its final result rather than assuming it succeeded.
- If unrelated uncommitted changes make the release risky, stop and ask how to
  proceed instead of including them in the release.

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
├── generated-plugins/
└── scheduled-tasks/tasks.json
```

`chat-history/index.json` is the persistent sidebar index, not a conversation.
Conversation snapshots are named `chat-*.json`; always exclude the index when
finding a recent chat.

Find and inspect the latest saved conversation:

```bash
APP_DATA="$HOME/Library/Application Support/ai.raynard"
LATEST_CHAT="$(find "$APP_DATA/chat-history" -maxdepth 1 -type f -name 'chat-*.json' -exec ls -1t {} + 2>/dev/null | head -1)"
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
`tool_call`, `tool_result`, `tool_error`, `build_request`, `steer_queued`,
`steer_applied`, `turn_completed`, `turn_error`, and `persist_error`.

A `steer_queued` with no matching `steer_applied` means the message reached the
sidecar's queue but the turn ended before the loop drained it; the host will have
put the text back in the composer.

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

Do not bypass, disable, replace, delete, modify, or otherwise override repository hooks or the configured hooks path without the user's explicit permission. If a hook blocks an operation, report the failure and ask how to proceed rather than working around it.

Pull requests should describe the user-facing change, list verification commands run, and include screenshots or screen recordings for visual UI changes.

### Branching and landing work

The user cannot see which branch is checked out. Keeping the worktree on a
sensible branch is therefore the agent's responsibility, and a branch problem
discovered at push time has already been a problem for a while.

- Check the branch before starting work, not when you are ready to commit.
  `git status --short`, `git rev-parse --abbrev-ref HEAD`, and
  `git log --oneline origin/main..HEAD` show where you are and what the branch
  already carries.
- Start each feature or fix on its own branch cut from an up-to-date
  `origin/main`, named after the change (`fix-extension-sample-prompts`). Do not
  pile unrelated work onto whatever branch happens to be checked out, and do not
  commit directly onto a local `main`.
- Name the branch in your reply whenever you create one, switch to one, or
  commit to one. That line is the user's only visibility into where the work
  went.
- When the work is finished and verified, **ask how to land it**: open a pull
  request, or merge into `main` and push directly. Both are normal in this
  repository and the choice is the user's, so ask rather than assuming one.
- For a pull request: open it with `gh pr create`, describe the user-facing
  change, list the verification commands run, then merge it yourself once checks
  pass and the change is good. Report the PR number and its final state.
- For a direct merge: merge the branch into `main`, push, and report the
  resulting commit.
- After landing, switch back to `main` and pull, so the next task does not begin
  on a stale, already-merged branch.
- If a branch has drifted — it carries unrelated commits, or work landed
  somewhere it should not have — say so plainly and propose a correction instead
  of quietly building on top of it.

## Security & Configuration Tips

Do not commit `.env` or API keys. `.env.example` documents expected variables. API keys entered through `/models` are stored in the operating system keychain via Rust `keyring`; app config should store preferences only, not secrets.

All secrets — provider credentials and plugin API keys — live in a single
keychain item (service `ai.raynard`, account `secrets`) holding a JSON map from
the old per-secret account name to its value. macOS authorizes per item, so one
item is one password prompt per app run however many secrets are stored. A
secret still under its own legacy item is folded into the map on first read and
the legacy item is deleted. Reads and writes go through `read_keychain_account`,
`write_keychain_account`, and `delete_keychain_account`; nothing else should
open a keyring `Entry`.

Prompts cannot be eliminated in `tauri dev`: cargo ad-hoc-signs the binary, so
its keychain ACL is pinned to a code hash that changes on every rebuild and
"Always Allow" never applies to the next build. Signed release builds keep it.

Never print API keys while debugging sidecars. Pass credentials through the
normal Rust/keychain path. Generated plugin directories are constrained and
validated by Rust before the coding agent or tool runner is started.
