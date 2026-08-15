# Raynard v0.2.0

Released: 2026-08-15

- Shipped the first complete Raynard Tauri desktop chat experience, including
  persisted chat history, Markdown answers, a folded navigation rail, generated
  plugin browsing, and guided empty-chat prompts.
- Added separate Pi-powered Explore and Build runtimes with native generated
  plugin tools, confirmed coding passes, per-chat concurrent runs, cancellation,
  recovery, context compaction, and detailed live builder activity.
- Added the shared generated-plugin SDK and isolated runner, including API-key
  requests, structured citations, declarative result cards, charts, tables, and
  copy/export affordances.
- Added ChatGPT sign-in plus key-based OpenAI, Claude, and Kimi configuration,
  consolidated OS-keychain storage, provider error recovery, and the `/status`
  view for token usage and quota state.
- Added a self-contained Apple Silicon distribution with an embedded Node
  runtime, native-module signing, hardened-runtime entitlements, notarization,
  DMG stapling, and packaged-runtime verification.
- Added a guarded prompt-driven release procedure that keeps npm, Tauri, and
  Cargo versions aligned, publishes the signed DMG with a SHA-256 checksum, and
  keeps the docs homepage download button pointed at the latest release.
