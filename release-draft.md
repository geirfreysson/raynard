# Raynard v0.15.1

This release makes Telegram answers substantially easier to read and carries
visual results into scheduled alerts and remote conversations.

- Literal and Markdown bullets now remain distinct, comfortably spaced list
  items instead of collapsing into a wall of text.
- Small, narrow Markdown tables render as native Telegram rich tables. Wider
  or longer tables keep Raynard's phone-friendly labelled-row layout, and every
  native table carries that layout as a fallback if Telegram rejects the rich
  message.
- Charts are rendered as branded PNGs and delivered after a concise standalone
  text summary, for both scheduled Telegram alerts and interactive Telegram
  replies. The text is always durable on its own, so a failed media upload never
  hides the actual result.
- Telegram's durable queue now retries ordered text, rich-table, and chart
  parts independently, validates image payloads before persistence, preserves
  older text-only queue records, and discards delivered image bytes to keep the
  local store bounded.
