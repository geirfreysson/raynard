# Bundled extension authoring

Keep each extension inside one kebab-case directory. Do not import application
internals or vendor the SDK; import `@raynard/plugin-sdk`. Local TypeScript ESM
imports must include the `.ts` extension.

Every exported tool needs a specific routing description, an object JSON schema,
a fixed declarative card, and an async `execute(args)` returning non-empty text,
at least one source reference, and structured `data` matching the card on every
successful path. Tests must mock network calls and run with `node --test`.

Keep `plugin.json` static and complete so the host can list the catalog without
executing extension code. Add exactly three useful sample prompts and keep the
README Endpoint Inventory synchronized with the implemented tools.
