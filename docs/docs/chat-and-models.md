---
sidebar_position: 3
---

# Chat and models

## Explore mode

Every ordinary message starts in Explore mode and uses the selected Chat model.
The main agent can reason, call installed plugin tools, return cited answers,
and ask to build a missing capability.

Explore and Build are host-owned states. They are displayed in the composer but
cannot be switched manually.

## Build mode

Build mode begins only after you confirm a plugin-writing request. A separate
coding agent uses the selected Coding model and is scoped to the target
generated-plugin directory.

Each confirmation authorizes one editing pass. Later ordinary messages return
to Explore mode, even when the chat remembers which plugin was edited.

## Result cards

Some plugin tools return a declarative result-card template with structured
data. Raynard renders these cards below the assistant response. Cards are
collapsed by default and use the plugin's own singular and plural labels.

## Sharing an answer

Hover an assistant answer and click Share to turn it into a link you can paste
into Slack, email, or a message. The link carries the question, the answer, its
result cards, and every source it cited.

Nothing is uploaded. The shared answer is compressed into the part of the URL
after the `#`, which browsers never send to a server — so there is no copy of
your data anywhere, and no account or sign-in involved.

Opening the link shows a short summary of what was shared and offers to open it
in Raynard, or to download Raynard if the recipient does not have it yet. The
answer itself is only visible inside the app. It arrives as a snapshot: the
numbers are frozen as you saw them, and asking a follow-up runs a fresh query
rather than re-slicing the shared table. If the answer came from an extension
the recipient does not have, Raynard offers to install it.

Very large answers are trimmed to fit a link — usually by shortening long
tables — and the share sheet always tells you exactly what it left out. An
answer too long to fit at all is never turned into a broken link; you are
offered to copy its text instead.

Anyone with the link can read the answer, so treat it like any other
unlisted URL: it is convenient, not confidential.

## Chat history and concurrent runs

Chats are persisted locally. Each chat owns its current main-agent or builder
run, which means:

- navigating away does not cancel the run;
- multiple chats can work concurrently;
- returning to a busy chat reconnects its live state;
- Stop affects only the selected chat.
