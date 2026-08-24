# Apple Silicon macOS releases

Raynard's first standalone desktop release targets Apple Silicon only. The app
bundle contains a pinned ARM64 Node.js runtime plus the main agent, plugin
builder, generated-plugin runner, plugin SDK, and their production
dependencies.

Users do not need Node.js, Homebrew, Git, Rust, or the source repository. They
still need to select a Chat/Explore model and a Coding/Build model through
`/models` and save the corresponding provider API keys.

## Runtime supply chain

`scripts/standalone-runtime.mjs` downloads the official Node.js 22.21.1 ARM64
archive and rejects it unless its SHA-256 digest matches the pinned value. It
installs the separately locked dependencies in `scripts/standalone-runtime/`,
then stages generated bundle input below `src-tauri/runtime/` and
`src-tauri/binaries/`.

The generated inputs and download cache are ignored by Git. Tauri regenerates
them through `build.beforeBuildCommand` for every desktop release build.

To prepare them directly:

```bash
npm ci
npm run runtime:prepare:macos-arm64
```

## Local unsigned smoke build

```bash
rustup target add aarch64-apple-darwin
npm run tauri:build -- --target aarch64-apple-darwin --bundles app --no-sign
npm run verify:macos:bundle
```

The verifier executes the bundled Node runtime with a restricted `PATH`,
syntax-checks every packaged sidecar, and discovers and calls a temporary
TypeScript generated plugin through the packaged plugin runner.

## Local signed and notarized DMG

The signing certificate must be a `Developer ID Application` identity visible
in `security find-identity -v -p codesigning`. The current developer identity
is:

```text
Developer ID Application: Geir Freysson (C2MPMB2GG6)
```

Export the App Store Connect API key variables and build:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Geir Freysson (C2MPMB2GG6)"
export APPLE_API_ISSUER="<issuer-id>"
export APPLE_API_KEY="<key-id>"
export APPLE_API_KEY_PATH="/absolute/path/AuthKey_<key-id>.p8"

npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg --ci
```

Do not use `--skip-stapling` for a public release. The completed download is
under `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`.

## GitHub Actions secrets

The Apple Silicon workflow reuses the same secret material as
`northfox-frontend`:

- `CSC_LINK`: base64-encoded Developer ID `.p12` certificate
- `CSC_KEY_PASSWORD`: password used when exporting the `.p12`
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect `.p8` key
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

The updater needs two more, which are not Apple's and are not
interchangeable with them:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the minisign private key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, empty if the key has none

Repository secrets can be copied to this repository, or the existing values
can be exposed as organization secrets. A pushed `v*` tag builds a signed,
notarized DMG for macOS plus the Linux and Windows packages, verifies each one,
merges the per-platform updater fragments into `latest.json`, and publishes a
non-draft GitHub release marked `--latest` with versioned assets, stable
aliases, and SHA-256 checksums. A manual workflow run builds and uploads the
artifacts without creating a release.

## Updater signing key

Update packages are signed with a minisign keypair that is entirely separate
from Apple code signing. Apple's signature says the app is not tampered with;
this one says the update came from us.

```bash
npx tauri signer generate -w ~/.tauri/raynard.key
```

The public half lives in `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey` and is not a secret. The private half is
`~/.tauri/raynard.key`.

**Keep the private key somewhere durable before the first release that uses
it.** An installed copy only accepts an update signed by the public key it was
built with, so losing the private key permanently strands every copy already in
the wild: they can never be updated again, only reinstalled by hand. It is not
recoverable from the public key or from a published release.

## Release verification

After building, run:

```bash
DMG_PATH="$(find src-tauri/target/aarch64-apple-darwin/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
MOUNT_DIR="$(mktemp -d)"
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR"
APP_PATH="$MOUNT_DIR/Raynard.app"

node scripts/verify-standalone-macos.mjs "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$DMG_PATH"
hdiutil detach "$MOUNT_DIR"
```

The final acceptance test is a browser download on a Mac without development
tools. Drag Raynard to Applications, open it normally, configure `/models`,
and verify Explore, plugin execution, Build, cancellation, chat persistence,
and plugin persistence.
