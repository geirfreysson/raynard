# Raynard v0.13.0

This release adds private Telegram conversations and conditional scheduled
alerts, gives chats durable memory and bookmark references, expands equity
research, and makes result charts more useful to explore.

## Telegram conversations and scheduled alerts

Connect a BotFather bot in Settings, explicitly pair one private Telegram
account, and chat with Raynard using the same selected model, installed
extensions, and locally saved history as the desktop app. Telegram supports
ordinary text questions plus `/start` and `/new`; configuration, credentials,
extension development, and other approval flows remain on the desktop.

Scheduled tasks now separate their always-saved Raynard history from their
notification channel. A task can notify the desktop or its fixed paired
Telegram recipient after every run, on every matching condition, or once when
a condition becomes true and then rearm after a non-match. Conditional checks
must finish with an explicit evidence-backed match result and fail closed when
the answer is unavailable or ambiguous. Telegram alerts are durably queued by
execution, resume at the first unsent chunk after temporary failures, and
expire before stale results can be delivered.

## Bookmark references and agent memory

Type `@` to reference saved bookmarks as well as installed extensions. A
bookmark mention supplies its complete question and answer to the model while
the chat bubble keeps a compact, clickable reading marker. Bookmark rows can be
renamed inline, show progress while Raynard generates a title, and recover from
title-generation attempts that spend their first token budget reasoning.

Raynard can also propose remembering, correcting, or forgetting a durable
fact. Every change requires in-chat confirmation, memories can be scoped to one
extension, and `/memory` provides a read-only overview. Only bounded, relevant
global and extension memories are added to a turn.

## Richer charts

Bar charts can switch between grouped, stacked, and line views where the data
permits it. Charts appear at the point in an answer where the agent presented
them instead of always collecting at the end, and the renderer improves legend
spacing, dual-axis handling, series visibility, and highlighted categories.

## Expanded Financial Modeling Prep research

The bundled Financial Modeling Prep extension adds historical price charts,
current TTM metrics, long-range valuation history, and a company screener.
Financial statements and revenue segments now accept inclusive fiscal-year
ranges and larger bounded histories, making requests such as an Apple analysis
from 2011 onward possible without manually paging periods.
