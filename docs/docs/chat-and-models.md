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

## Chat history and concurrent runs

Chats are persisted locally. Each chat owns its current main-agent or builder
run, which means:

- navigating away does not cancel the run;
- multiple chats can work concurrently;
- returning to a busy chat reconnects its live state;
- Stop affects only the selected chat.
