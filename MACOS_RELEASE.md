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

Repository secrets can be copied to this repository, or the existing values
can be exposed as organization secrets. A pushed `v*` tag builds a signed,
notarized DMG, verifies it, uploads it as a workflow artifact, and attaches it
to a draft GitHub release. A manual workflow run builds and uploads the
artifact without creating a release.

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
