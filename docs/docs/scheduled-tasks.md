---
sidebar_position: 4
---

# Scheduled tasks

Raynard can repeat an Explore request on a daily, weekly, monthly, quarterly,
or yearly schedule. Each run is saved as an ordinary conversation, so you can
inspect the answer, its result cards, and its sources later.

## Create a scheduled task

Ask for recurring work in the composer. Include the subject and timing in the
same message, for example:

- “Every weekday at 07:00, show what is trending on X in London and New
  York.”
- “On the first day of every month at 09:00, compare Icelandic inflation with
  the OECD.”
- “At 09:00 on January 1 and every quarter after that, check how my fantasy
  football team is performing.”

Raynard recognizes the recurring request and shows an editable confirmation.
It does not run the research immediately. Before saving, review:

- **Name** — the label shown in Scheduled tasks.
- **Prompt** — the work Raynard will perform on every run.
- **Destination** — a dedicated task chat or one of your existing chats.
- **Repeats** — daily, weekly, monthly, quarterly, or yearly.
- **Time and calendar fields** — the local time, weekday, day, or anchor month
  required by the selected frequency.

The confirmation displays the time zone Raynard will use. Recurring times stay
at the selected wall-clock time through daylight-saving changes. A monthly run
on a day that does not exist in a shorter month runs on that month's final day.

## Choose where results go

The default destination is a dedicated task chat. Raynard creates it on the
first run and adds later results to the same conversation. This keeps routine
reports together without filling an unrelated chat.

You can instead select an existing chat during confirmation or while editing
the task. Scheduled messages are labelled with the task name so they remain
distinguishable from messages you typed yourself.

If the destination chat is already running another turn, the scheduled run
waits until that chat is available.

## Manage scheduled tasks

Open **Scheduled tasks** from the timer icon in the left rail. Select a task to:

- edit its name, prompt, destination, and timing;
- pause or resume future runs;
- choose **Run now** without moving the next recurring run;
- open its destination chat;
- inspect the last run status and error, if any;
- delete the schedule.

A task cannot be edited or deleted while it is running.

## What happens during a run

A scheduled run uses Explore mode, your currently selected provider, and your
installed extensions. It can produce the same answers, citations, and result
cards as an ordinary Explore message.

Scheduled runs cannot approve extension development on your behalf. If a run
needs a missing extension or a credential, open its destination chat and
complete that step yourself. A later scheduled run can then use the extension
or credential normally.

Raynard must be open for a task to start at its scheduled time. If Raynard was
closed, an overdue task runs once after you next open the app and connect a
model; it does not replay every occurrence that was missed. A run interrupted
because Raynard closed is recorded as interrupted rather than being left in a
running state.
