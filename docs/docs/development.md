---
sidebar_position: 7
---

# Development

## Run the desktop app locally

Install the JavaScript dependencies and start the Tauri development app from
the repository root:

```bash
npm install
npm run tauri:dev
```

Local development requires Node.js 20 or newer, Rust, and the platform
prerequisites required by [Tauri v2](https://v2.tauri.app/start/prerequisites/).

## Application checks

Run these from the repository root after frontend changes:

```bash
npm test -- --run
npm run build
```

When changing the Tauri backend, also run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Agent architecture changes should include focused tests in `scripts/`. Use
deterministic mocked tests rather than relying on live provider calls.

## Documentation site

The documentation site is self-contained in this directory:

```bash
cd docs
npm install
npm start
```

Build the static site with:

```bash
npm run build
```

Docusaurus writes generated output to `docs/build/`. Do not edit that directory
by hand.
