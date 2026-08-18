## Summary

Describe the user-facing change and why it belongs in Raynard.

## Validation

- [ ] `npx vitest run scripts/extension-catalog.test.mjs` (extension PRs)
- [ ] `npm test -- --run`
- [ ] `npm run build`
- [ ] Relevant Rust checks (when `src-tauri` changed)

## Safety and scope

- [ ] The diff contains no API keys, `.env*`, `.runtime-tools.json`, caches, dependencies, or build output.
- [ ] The change is focused and preserves unrelated work.
- [ ] Screenshots or a recording are attached for visible UI changes, or are not applicable.
