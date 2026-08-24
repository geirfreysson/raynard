# Raynard v0.7.0

Six new extensions ship in the bundled catalog, the extension detail screen has
been rebuilt around what you can actually act on, scheduled runs now tell you
when they finish, and an extension you wrote yourself can be renamed.

## Six new bundled extensions

`/extensions` now carries six more pre-approved extensions. Installing one
copies it into your own extensions directory, where it behaves exactly like an
extension Raynard built for you and can be edited in place.

- **X** — public post search, single post and conversation lookup, public user
  lookup, user timelines, and trends by location. Needs an X API bearer token.
- **Polymarket** — prediction events and markets ranked by 24-hour volume,
  full-text search, resolution wording, market-implied probabilities, and live
  CLOB midpoints. No credential required.
- **Financial Modeling Prep** — market activity, valuation ratios, multi-period
  financial statements, analyst estimates and price targets, revenue segments,
  and peer discovery. Needs an FMP API key.
- **Eurostat** — European statistics through the Eurostat dissemination API.
- **OECD** — OECD Data Explorer dataflows, dimensions, and observations.
- **IMF** — IMF SDMX 3.0 dataflows, codelists, coverage, and time series.

A market-implied probability is a price, not a forecast; the prediction and
market extensions say so in their own results.

## The extension detail screen, rebuilt

The screen used to list metadata, raw JSON, and source files in roughly the
order they sat on disk — so an extension that could not run at all without an
API key mentioned that fact somewhere below the fold.

It now reads header, manifest, API keys, tools, card previews, README, source.

- An extension that wants a key says so in a pill beside its name (**API key
  needed** / **API key added**) and offers the same Add or Replace action both
  as a header button and as the first item in its `⋯` menu. An extension with
  no credentials shows no setup section at all.
- Each tool is a fold: the summary is its name and the first sentence of what
  the model is told about it, and opening it shows the full description plus the
  parameter schema as name/type/required rows instead of raw JSON.
- The manifest is written out to be read — category, author, version, SDK,
  status, homepage, tags, documentation links — with ids, paths, and the raw
  `plugin.json` tucked behind two disclosures.
- Card previews and source files fold too, and a preview builds its card only
  once you open it.

## Rename your own extensions

An extension you authored has **Rename** in its `⋯` menu. Only the display name
changes: the folder name is what the agent routes on and what your chats and
stored keys are keyed by, so it stays put. A name already taken by another
extension — as a display name, a folder, or an id — is refused. An installed
catalog extension cannot be renamed, because reinstalling it would quietly put
the bundled name back.

## Scheduled runs tell you they are done

Every scheduled execution, **Run now** included, now sends a native macOS,
Windows, or Linux notification when it finishes or fails. The notification names
the task but keeps the answer and any error text off your lock screen. The chat
a scheduled run writes into is marked unread and carries a dot in the sidebar
until you open it.

## Also in this release

- The homepage showcase leads with examples the bundled extensions can actually
  answer, starting from Hacker News and World Bank data.
