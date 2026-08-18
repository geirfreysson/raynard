# Raynard extensions

This directory is Raynard's bundled, pre-approved extension catalog. Each
subdirectory is one self-contained extension that ships with the desktop app.
Contributors add an extension by opening a pull request that adds one kebab-case
folder here.

The easiest route for an extension created in Raynard is its detail menu:

1. Choose **Prepare PR** and review the catalog metadata.
2. Raynard runs the mocked tests and runtime discovery, then writes a separate
   contribution bundle. The installed extension is not changed.
3. Choose **Copy harness prompt** and paste it into a coding agent with this
   repository open. The prompt tells the agent to apply the included patch,
   show the diff and validation results, and ask before it commits, pushes, or
   opens a pull request using the user's own GitHub credentials.

The bundle also contains the ready-to-copy extension folder, a Git patch,
`PR_BODY.md`, `HARNESS_PROMPT.md`, and `validation.json`. No GitHub App or
Raynard-held access token is involved. A contributor can use those same files
manually or with GitHub CLI.

Catalog folders are inert until a user installs one from `/extensions`. Install
copies the folder into the app-local `generated-plugins` directory, where it is
handled exactly like an extension created by Raynard's builder and can be edited
in place.

Every extension must contain:

- `plugin.json` with the static catalog metadata, exactly three `samplePrompts`,
  and a `contributes.tools` summary.
- `tools.ts` exporting a `defineTools({...})` registry from
  `@raynard/plugin-sdk`.
- Mocked `*.test.ts`, `*.test.js`, or `*.test.mjs` tests runnable with
  `node --test`.
- `README.md` with source documentation and an Endpoint Inventory.

The normal test suite validates every catalog manifest, runs each extension's
mocked tests, and performs runtime tool discovery. Merging a pull request is the
approval step; the merged catalog is included in the next packaged release.

Machine-local files are never catalog source. Do not submit `.runtime-tools.json`
(a host-generated discovery cache), `.env*`, `.plugin-data`, dependencies,
coverage, or build output.
