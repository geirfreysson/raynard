# Contributing to Raynard

Thanks for helping improve Raynard. Keep pull requests focused, explain the
user-facing change, and do not include credentials or machine-local files.

## Extension contributions

Extensions belong in one new kebab-case folder under `extensions/`. If the
extension was created in Raynard, open its detail menu and choose **Prepare PR**.
Raynard produces a reviewable bundle and a prompt for your own coding harness;
it does not request or store GitHub credentials.

Before opening the pull request, run:

```bash
npx vitest run scripts/extension-catalog.test.mjs
npm test -- --run
npm run build
```

The extension must follow [the catalog contract](extensions/README.md). In
particular, include mocked tests and an Endpoint Inventory, and exclude API
keys, `.env*`, `.runtime-tools.json`, caches, dependencies, and generated build
output.

## Pull requests

- Start from the current `main` branch and use a focused branch.
- Preserve unrelated work and avoid drive-by formatting changes.
- Describe the user-facing behavior and list the commands you ran.
- Add screenshots or a short recording for visible UI changes.
- Let the pull-request checks finish before requesting review.

## License prerequisite

This repository does not currently declare a project license. The maintainer
must choose and add a `LICENSE` before inviting or accepting public
contributions, then update this section with the contribution licensing terms.
