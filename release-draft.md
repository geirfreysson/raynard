# Raynard v0.14.0

This release fixes a startup delay on the Telegram channel, formats Telegram
replies more safely, and widens how much price history the Financial Modeling
Prep extension can pull in one call.

## Faster startup

The Telegram channel's keychain check and poller resume used to run
synchronously during app setup, which could delay the window's first paint
when OS keychain authorization added latency (most noticeably in `tauri dev`,
where the ad-hoc signing ACL changes on every rebuild). That check now runs on
a background thread instead, so it can no longer hold up startup.

## Safer Telegram replies

Telegram replies now use Telegram-safe HTML formatting with a persisted parse
mode, so both live and durably queued scheduled deliveries render consistently
and replies saved before this change keep their original plain-text delivery
behavior.

## Wider Financial Modeling Prep history

`fmp_price_history`'s range option topped out at one year even though the
underlying FMP endpoint already returns its full default history. It now
offers 2Y/5Y/10Y/MAX buckets as well.
