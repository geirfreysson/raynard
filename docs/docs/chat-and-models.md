---
sidebar_position: 3
---

# Chat and models

## Explore mode

Every ordinary message starts in Explore mode. Raynard can answer directly, use
an installed extension, cite its sources, or offer to create a connection it is
missing.

The composer shows the current mode. You do not need to switch modes yourself.

## Build mode

Build mode begins only after you approve a request to create or change an
extension. Raynard then makes the requested change and shows its progress.

Once the change is finished, the next ordinary message returns to Explore. A
later extension change requires your approval again.

## Result cards

Some extensions add result cards below an answer. Cards are collapsed by
default; open one to inspect the figures, records, or other details behind the
answer.

## Sharing an answer

Hover an assistant answer and click Share to turn it into a link you can paste
into Slack, email, or a message. The link carries the question, the answer, its
result cards, and every source it cited.

Raynard does not upload or store a copy of the answer. The answer is contained
in the link itself, and sharing does not require an account or sign-in.

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

## Working across chats

Raynard saves your chats on your Mac. While an answer or extension build is in
progress:

- navigating away does not cancel the run;
- multiple chats can work concurrently;
- returning to a busy chat reconnects its live state;
- **Stop** affects only the chat you are viewing.
