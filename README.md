# Raynard

A desktop AI agent that builds the tools it needs.

Raynard is a chat app for questions that need real data. Ask it something, and
it answers from services it can already reach. Ask it something it has no way to
reach, and instead of guessing it tells you what connection is missing and
offers to write one — you approve, it codes and tests the extension, and then it
answers the original question.

Runs on macOS, Linux, and Windows. Bring your own model provider.

## What it does

**Answers from live data, with its sources.** Replies carry citations and
structured result cards, so a claim can be checked rather than taken on trust.

**Writes its own extensions.** When a capability is missing, Raynard asks
permission to build it. A separate coding agent then writes a TypeScript
extension — client, tests, README, and result cards — inside its own directory.
Nothing ships until it passes mocked tests *and* one real call against the live
API, because mocked tests alone can be green while every endpoint is wrong.

**Two visible modes.** Ordinary questions run in **Explore**. Only the
build confirmation moves the app into **Build**, and the next message returns to
Explore. You always know which one you are in, and extension changes never
happen behind your back.

**Steerable mid-answer.** You do not have to wait for a turn to finish. `Enter`
queues a correction the agent picks up at its next tool-call boundary;
`Alt+Enter` queues a follow-up for when it would otherwise stop. Queued text
sits above the composer until the agent actually takes it.

**Work on a schedule.** Recurring Explore tasks run daily, weekly, monthly,
quarterly, or yearly in your time zone, writing results into a dedicated chat or
an existing one. Scheduled runs can never enter Build on their own.

**Shareable answers, with no server.** Sharing an answer builds a link that
carries the whole payload in the URL fragment — which browsers never transmit.
Nothing is uploaded, nothing is stored, and nothing identifies the sender.

**Concurrent chats.** Several conversations can be working at once. Navigating
away does not cancel a run, and coming back reconnects to it live.

Also: bookmarks, a bundled catalog of pre-approved extensions, token and quota
reporting, and in-app updates.

## Install

Download the latest release for your platform:

| Platform | |
|---|---|
| macOS (Apple Silicon) | [`Raynard-mac-arm64.dmg`](https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-mac-arm64.dmg) |
| Linux x86_64 | [`Raynard-linux-x86_64.AppImage`](https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-linux-x86_64.AppImage) |
| Debian / Ubuntu | [`Raynard-linux-amd64.deb`](https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-linux-amd64.deb) |
| Windows x64 | [`Raynard-windows-x64-setup.exe`](https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-windows-x64-setup.exe) |

Or install from a terminal, with checksum verification:

```bash
# Linux
curl -fsSL https://github.com/geirfreysson/raynard/releases/latest/download/install.sh | sh
```

```powershell
# Windows
irm https://github.com/geirfreysson/raynard/releases/latest/download/install.ps1 | iex
```

You do not need Node.js, Rust, or Homebrew — the packaged app embeds its own
Node runtime. macOS builds are signed and notarized and require macOS 13 or
later. Windows installers are not yet signed, so SmartScreen will warn on first
run.

## Connect a model

On first launch Raynard asks for a provider before anything else. You can sign
in with ChatGPT, or use an API key from Claude or Kimi. One provider serves both
the chat and coding roles.

Type `/models` at any time to switch. API keys are stored in the operating
system keychain — the app's own config file holds preferences only, never
secrets.

## Slash commands

| | |
|---|---|
| `/models` | Connect or switch model providers |
| `/extensions` | Browse installed and bundled extensions |
| `/settings` | App version and updates |
| `/status` | Token usage and provider quota |

## Development

Requires Node.js and a Rust toolchain.

```bash
npm install
npm run tauri dev
```

Before committing:

```bash
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

The documentation site in `docs/` is a separate Docusaurus project:

```bash
cd docs && npm install && npm start
```

Layout: `src/` is the renderer, `src-tauri/` the Rust backend and Tauri
commands, `scripts/` the agent sidecars and plugin runner, and `extensions/` the
bundled extension catalog. [`AGENTS.md`](AGENTS.md) is the detailed architecture
reference — how the two agent loops fit together, how extensions are validated,
and why several non-obvious decisions were made. Read it before changing the
agent path.

Raynard's agent loops are built on [Pi](https://github.com/badlogic/pi-mono)
(`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`).

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the full
detail; the essentials:

- **Open an issue first** for anything substantial, so the approach can be
  agreed before you spend time on it. Small fixes can go straight to a pull
  request.
- **Branch from `main`** and keep the branch focused on one change. Avoid
  drive-by formatting and unrelated edits — they make a change hard to review.
- **Add tests.** Frontend tests live beside their source as `*.test.ts` and run
  under Vitest; agent and script behaviour is tested under `scripts/`. Write a
  failing test first where you can, and never use a live provider call as the
  only test.
- **Run the four checks above** and list what you ran in the pull request.
- **Describe the user-facing change**, and include a screenshot or short
  recording for anything visual.

A note on extensions: extensions you create through chat are **local to you**.
They live in your app data directory and are not candidates for the bundled
`extensions/` catalog unless you deliberately propose one — see the promotion
steps in [`AGENTS.md`](AGENTS.md).

Please do not commit `.env` files, API keys, or anything else you would not want
in a public repository.

## License

MIT — see [`LICENSE`](LICENSE). By contributing you agree that your work is
licensed under the same terms.
