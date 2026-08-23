# Raynard v0.4.0

Released: 2026-08-23

Raynard can now do work on a schedule, and generated plugins have to prove
themselves against the real API before a build is reported as done.

## Scheduled tasks

- Ask for recurring work — "check the top stories on Hacker News every morning
  and tell me the top one" — and Raynard saves it as a task instead of
  answering once. It runs daily, weekly, monthly, quarterly, or yearly at a
  local time in your own time zone.
- Nothing is created without you. The request first renders as an editable
  confirmation showing the name, the prompt that will run, the destination, and
  the recurrence; Dismiss creates nothing.
- Results land either in a dedicated chat, created on the first run and reused
  after, or appended to an existing chat you pick. Messages from a task are
  labelled with its name.
- The timer icon on the sidebar rail lists your tasks. A detail screen edits,
  pauses, resumes, deletes, or runs one immediately — running now does not move
  the recurring schedule.
- A scheduled run is an ordinary Explore turn with your selected model and
  installed extensions. It cannot enter Build on its own and cannot create
  another task: a missing extension or a needed credential is recorded as a
  note asking you to open the chat and handle it yourself.
- The scheduler runs only while Raynard is open. A task that came due while the
  app was closed runs once after the next launch; missed occurrences are not
  replayed one by one.

## Generated plugins are checked against the live API

A generated plugin could pass every mocked test with all of its live endpoints
broken — mocks that match on a path fragment survive a total rewrite of the API
host. Building one now ends with a real call:

- A fresh build executes the plugin's first zero-argument tool against the real
  API and requires text, at least one source reference, and a non-empty list.
  A failure gets one repair pass.
- Edit turns run the same live call. Previously an edit bypassed validation, so
  "test and fix the API" could be answered with a confident green. A still
  failing check is now reported instead of success.
- A test suite that never pins the API host as a literal absolute URL is
  rejected. Three of the five bundled extensions had this and now pin theirs.
- Plugin SDK 1.3.0: a 204, an empty body, or a non-JSON body now raises a
  message naming the URL that failed, rather than a bare parse error.

## Charts

- Clicking a legend entry now switches that series off and removes it from the
  plot, the tooltip, and the axis scale, rather than dimming it. The entry
  stays in the legend, struck through, so the series can be brought back.
- Axis number formatting follows the visible series, so switching off a large
  series no longer rounds a smaller one away to zero. Hiding the last visible
  series is refused, and a copied chart image matches what is on screen.

## Extensions

- Promoting a plugin to the bundled catalog now starts from the builder's own
  category, tags, and icon suggestions instead of fixed defaults, when those
  survive validation. Author and homepage are never taken from the model.
- Bundled extension splash prompts read as real questions.
