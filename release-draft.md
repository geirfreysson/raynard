# Raynard v0.3.0

Released: 2026-08-21

Raynard now runs on Linux and Windows, answers can be shared as links, and
extensions arrive from a bundled catalog instead of always being written from
scratch.

## Linux and Windows

- Added an x86_64 AppImage and an amd64 Debian package for Linux, and a per-user
  x64 NSIS installer for Windows, each carrying its own embedded Node runtime
  and verified by a cross-platform bundle gate before release.
- Added `install.sh` and `install.ps1` for checksum-verified installation from
  the terminal, published as stable assets on every release.
- The Windows installer is not code-signed yet, so SmartScreen will warn on
  first run. Choose **More info**, then **Run anyway**. Windows signing is
  planned.
- macOS remains Apple Silicon and now requires macOS 13 or later.

## Share an answer as a link

- Any finished answer can be shared. There is no server and no account: the
  whole payload rides in the URL fragment, which browsers never transmit, so
  nothing is uploaded and nothing is stored.
- Links carry the question, the answer, its cards, and its sources, but never
  your provider, model, token usage, chat, or timestamps.
- A link that would be too long is degraded in measured steps — excerpts, then
  card data, then table rows — and refused outright rather than handed over
  broken. Answer text is never truncated.
- A shared answer opens as a snapshot and says so: a follow-up question runs a
  live query, because the model only ever sees the transcript text.

## Extension catalog

- `/extensions` lists pre-approved extensions bundled with the app — Hacker
  News, Open Library, Fantasy Premier League, World Bank Data360, and D&D 5e —
  alongside the ones you have written yourself.
- Installing copies the extension into your own directory, where it becomes an
  ordinary editable extension.
- The agent can now recommend a catalog extension mid-conversation and offer to
  install it inline.
- Plugin builds now require real API source documentation up front, rather than
  starting a build on a guess.

## Steer the agent while it works

- The composer stays live during an answer. Press Enter to send a course
  correction the agent picks up at its next step, or Alt+Enter to queue a
  follow-up for when it finishes.
- Queued text waits in a strip above the composer and only becomes part of the
  conversation once the agent actually takes it. Stopping the turn hands
  anything undelivered back to you.

## Answers show their working

- When an answer draws on more than one extension, results are grouped and
  labelled by the extension that produced them.
- When several data series could have answered a question, the answer now names
  the one it used, why it won, and the closest one it rejected — with the
  identifier you need to ask for the other.
- Charts support a second Y axis, so a rate plotted against an absolute is no
  longer flattened into the noise, and line charts pick sensible scales.

## Saved answers and performance

- Answers can be bookmarked and revisited.
- Large result sets move out of the chat file and load only when a card is
  opened, so reopening a long conversation stays fast.
- Results built from a cached API response are marked **Cached**.

## Documentation

- The docs site covers all three platforms, and the homepage offers the build
  for the operating system you are reading from, with the other platforms one
  click away.
