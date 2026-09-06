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
- “Every day, check Apple's price and let me know on Telegram when it goes
  below $150.”

Raynard recognizes the recurring request and shows an editable confirmation.
It does not run the research immediately. Before saving, review:

- **Name** — the label shown in Scheduled tasks.
- **Prompt** — the work Raynard will perform on every run.
- **Notification** — desktop or your paired Telegram account, after every run
  or only when a condition matches.
- **History** — a dedicated task chat or one of your existing chats. Every run
  is saved here, including checks that do not send a notification.
- **Repeats** — daily, weekly, monthly, quarterly, or yearly.
- **Time and calendar fields** — the local time, weekday, day, or anchor month
  required by the selected frequency.

If you request an unsupported cadence, such as hourly or Monday-to-Friday,
Raynard chooses the closest supported frequency and explains the substitution.
Review the form before saving.

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

## Send results to Telegram

First [connect and pair a Telegram bot](./telegram.md). Then choose
**Telegram** under Notification when creating or editing the task. The task is
bound to the paired account's numeric Telegram ID. If you later replace that
pairing, Raynard does not silently redirect existing alerts to the new account;
edit and save the task to confirm the new recipient.

Choose when Raynard should send the notification:

- **After every run** sends every successful result.
- **Every time the condition matches** checks the condition on every run and
  sends each matching result.
- **Once when the condition starts matching** sends on the first match, stays
  quiet while it remains true, and rearms after a later non-match.

For a conditional notification, keep the recurring work in **Prompt** and put
the trigger in **Condition**. For example, use `Get Apple's current share
price` as the prompt and `Apple's current share price is below USD 150` as the
condition.

The agent must record an explicit `matched`, `not matched`, or `could not
determine` outcome from fresh evidence. A missing value, tool error, stale
answer, or empty response never counts as a match. Non-matches stay in the
Raynard history but send nothing. If the condition cannot be determined,
Raynard surfaces the task as needing attention instead of sending a possibly
wrong alert.

Telegram delivery is stored before Raynard sends it. A temporary Telegram
transport failure is retried while Raynard remains open, until the earlier of
the next scheduled run or 24 hours. Disconnecting the bot, changing bots, or
forgetting the paired account blocks queued alerts so they cannot go to a
different recipient.

## Manage scheduled tasks

Open **Scheduled tasks** from the timer icon in the left rail. Select a task to:

- edit its name, prompt, notification, history destination, and timing;
- pause or resume future runs;
- choose **Run now** without moving the next recurring run;
- open its destination chat;
- inspect the last run and notification status, including a false condition,
  an already-sent transition, a queued Telegram message, or an error;
- delete the schedule.

A task cannot be edited or deleted while it is running.

## What happens during a run

A scheduled run uses Explore mode, your currently selected provider, and your
installed extensions. Its full result, citations, and result cards are saved in
the history chat. Telegram receives a concise plain-text version with source
links; result cards remain in Raynard.

Scheduled runs cannot approve extension development on your behalf. If a run
needs a missing extension or a credential, open its destination chat and
complete that step yourself. A later scheduled run can then use the extension
or credential normally.

Raynard must be open for a task to start at its scheduled time. If Raynard was
closed, an overdue task runs once after you next open the app and connect a
model; it does not replay every occurrence that was missed. A run interrupted
because Raynard closed is recorded as interrupted rather than being left in a
running state.
