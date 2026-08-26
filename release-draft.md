# Raynard v0.8.0

Scheduling a recurring task is now far more reliable, chart results render
through the same validated card pipeline as every other tool, a long build run
in the coding agent no longer buries what's actually happening under a wall of
finished checkmarks, and the homepage shows real product screenshots.

## Scheduling reliability

Creating a scheduled task calls a single tool, `request_scheduled_task`, whose
parameter schema previously described frequency, weekday, and destination as
unions of literal constants. Some models never see the individual literal
values in that shape and can only guess — one provider burned thirteen rounds
and 175k tokens failing before giving up, on an error that named no legal
value.

The tool's arguments are now described with plain types and descriptions
instead, and its own docstring carries a concrete example. Both `name` and
`prompt` are optional, so a wider range of calls now reach execution instead
of being rejected outright: the tool repairs what it can (a weekday, "every 3
months," "7am," "monday," an unfindable destination chat) and defaults the
rest, because the very next thing the user sees is an editable confirmation
form. A schedule that genuinely can't be honored — Monday-to-Friday, anything
sub-daily — is substituted and explained above that form instead of failing
the turn. Generated plugin tools with enum-style parameters get the same fix.

## Charts as a validated tool

Chart results now go through a validated agent tool with a fixed declarative
card, the same contract every other generated-plugin result already follows,
instead of a separate rendering path.

## Calmer builder activity

A long coding-agent run used to add a new bordered "Complete" card to the
timeline for every finished tool call, so a run with dozens of file edits
scrolled the one still-running or failed call out of view under a wall of
identical green cards. Finished, successful calls now fold into a single
counter slot that stays at the position where the first one landed and grows
in place; whatever is still pending, streaming, or has failed keeps its own
full card. A `toolUse` stop reason — the ordinary way a round ends when the
model calls a tool — is no longer mislabeled as a stream anomaly.

## Real homepage screenshots

Three of the four example cards on raynard.ai now show an actual recording or
screenshot of Raynard in use — a multi-source Fed-rate answer, a cited Nvidia
valuation, and a scheduled Polymarket probability check — in place of the
placeholder graphic. The repeatable macOS capture workflow (window resize
scripts plus the `screencapture`/`sips` recipe) is documented in AGENTS.md for
future screenshots.
