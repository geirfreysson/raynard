# Raynard v0.11.0

A `/new` slash command and a fix for wide markdown tables that were silently
falling back to unreadable raw text.

## `/new` slash command

Typing `/new` now runs the same flow as the sidebar's New Chat action:
switches to the Chats sidebar and opens a fresh conversation with the
pre-chat suggestions. It's registered in the slash menu alongside
`/extensions`, `/models`, `/settings`, and `/status`, so it's discoverable
without knowing it exists.

## Wide markdown tables render correctly

The lightweight markdown renderer capped tables at 8 columns. Any table wider
than that — a routine shape for a multi-metric comparison, e.g. several
stocks across price, valuation, and margin columns — silently fell back to
unparsed, raw pipe-delimited text instead of an HTML table, with no
indication anything had gone wrong.

The cap is now 24 columns, and a table wide enough to exceed the message
width scrolls horizontally instead of squeezing every column down to a few
unreadable pixels.
