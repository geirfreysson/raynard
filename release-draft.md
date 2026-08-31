# Raynard v0.12.0

A bugfix release: Kimi conversations work again after Moonshot decommissioned
the `kimi-k2.5` model.

## Kimi chats stopped working when Moonshot retired kimi-k2.5

Moonshot discontinued `kimi-k2.5` on 2026-08-31 in favor of `kimi-k2.6`. Every
Kimi turn immediately failed with a 404 from Moonshot's API, since Raynard's
Moonshot provider defaulted to and stored the now-dead model id.

The provider preset's default chat model now points at `kimi-k2.6`. An
install that already had `kimi-k2.5` saved as its active chat or coding model
is migrated automatically the next time its config loads — no need to notice
the failure and reselect a model in `/models`.

`kimi-k3`, the default coding model, is unaffected and unchanged.
