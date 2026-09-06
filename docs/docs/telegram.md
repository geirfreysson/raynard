---
sidebar_position: 7
---

# Telegram

Connect a private Telegram bot to ask Raynard questions away from the desktop.
Telegram conversations use the same model, installed extensions, and local chat
history as Raynard, but deliberately expose a smaller set of actions.

Raynard must be open to receive Telegram messages, and it needs a connected
model provider to answer them.

## Create a bot with BotFather

Telegram's [official bot setup guide](https://core.telegram.org/bots/features#botfather)
uses **@BotFather**, Telegram's bot-management account.

1. In Telegram, open [@BotFather](https://t.me/BotFather). Check the username
   carefully before continuing.
2. Send `/newbot`.
3. Enter a display name, such as `My Raynard`.
4. Choose a unique username. Telegram bot usernames are 5–32 characters and
   must end in `bot`, for example `my_raynard_bot`.
5. BotFather returns an authentication token. Copy it; you will paste it into
   Raynard in the next section.

:::warning Keep the token private

The token controls the bot. Treat it like a password: do not paste it into a
chat, commit it to a repository, or share it with another person. Raynard stores
it in your operating system's credential store and does not display it again.

If the token is ever exposed, use `/revoke` in BotFather, then replace the token
in Raynard.

:::

You can optionally make Raynard's commands appear in Telegram's `/` menu:

1. Send `/setcommands` to BotFather and select your bot.
2. Paste these two lines:

   ```text
   start - Connect or show the bot status
   new - Start a fresh Raynard chat
   ```

No inline mode, group permissions, webhook, or server configuration is needed.

## Connect the bot to Raynard

1. Open Raynard and select the gear in the lower-left rail, or type `/settings`
   in the desktop composer.
2. Find **Messaging → Telegram**.
3. Paste the BotFather token and choose **Connect bot**.
4. Return to Telegram, open your new bot, and send `/start` or any text message.
5. Raynard shows a pairing request containing the Telegram account's name,
   username, and numeric user ID. Check the identity and choose **Approve**.
6. Telegram confirms the connection. Send a question to begin.

Pairing is explicit and limited to one Telegram account. Messages from another
account never reach the Raynard agent. To change accounts, choose **Forget
paired account**, message the bot from the new account, and approve the new
request. Pairing requests expire after one hour.

**Replace bot** validates and stores a new BotFather token. **Disconnect bot**
stops the channel, removes its saved token and pairing, and requires the setup
and approval steps again.

## Have a conversation

Send an ordinary text message just as you would in Raynard:

> Compare Iceland's latest inflation rate with the OECD average.

Raynard shows a typing indicator while it works, uses relevant installed
extensions, and replies with Telegram-safe rich text. Headings, emphasis, code,
and intentional links are formatted using Telegram's supported HTML subset.
Markdown tables are rearranged into labelled, stacked rows that remain readable
on a phone. Long answers may arrive as several consecutive Telegram messages.
Requests are handled one at a time in the order they arrive.

Research citations and source URLs are omitted from the Telegram copy. They are
still stored with the answer: open the same chat in Raynard to inspect its
clickable citations, source details, result cards, and charts.

The conversation is also saved locally as a Raynard chat named
`Telegram · <your name>`. Open that chat on the desktop to inspect its complete
history, sources, result cards, or charts, and to continue with desktop-only
actions. Telegram messages are labelled in the transcript so they remain
distinguishable from desktop messages.

Sending another Telegram message creates the next turn in the current Telegram
chat. It does not steer a response already in progress; it waits for its turn.

### Available commands

| Command | What it does |
| --- | --- |
| `/start` | Starts pairing when needed, or confirms that the bot is connected. |
| `/new` | Creates a fresh Telegram-backed chat in Raynard. Later Telegram messages continue there. |

Other Raynard slash commands—including `/models`, `/settings`, and extension or
scheduled-task controls—are desktop commands and do not run through Telegram.

## Telegram compared with the desktop app

| Capability | Telegram | Raynard desktop |
| --- | --- | --- |
| Explore questions | Uses the selected model and installed extensions | Full support |
| Conversation history | Saved into a local Telegram-labelled chat | Full chat browser and search |
| Sources | Omitted; open the saved chat in Raynard | Inline citations with source details |
| Result cards and charts | Receives a text summary; the full result stays in the desktop chat | Interactive cards and rendered charts |
| Create or edit extensions | Asks you to open the desktop chat | Review, confirm, build, and test extensions |
| Install catalog extensions | Desktop handoff only | Full catalog and installation flow |
| Enter API credentials | Desktop handoff only | Secure credential prompts and Settings |
| Scheduled tasks | Receives alerts selected for this paired account | Create, edit, run, and inspect tasks and every run's history |
| Memory changes | Desktop handoff only | Review and confirm memory changes |
| Attachments, voice, groups | Not supported; private text DMs only | Desktop text and host-rendered results |
| Steering and Stop | Later messages wait; there is no Telegram Stop command | Steer Explore turns or select **Stop** |
| Availability | Only while Raynard is running | While the app is open |

The narrower Telegram surface is intentional. Anything that changes Raynard's
configuration, installs code, stores a credential, or requires confirmation is
left for the desktop app where you can inspect it before approving it.

## Privacy and security

- Use a dedicated bot and never share its token.
- Approve only the numeric Telegram user ID you recognize.
- Only private text messages from the paired owner are sent to Raynard. Group
  messages, bot messages, media, files, and voice notes are ignored.
- Telegram messages pass through Telegram, then through your configured model
  provider and any extension API used to answer the request. The resulting chat
  history is stored locally by Raynard.
- Raynard uses long polling; it does not expose a public webhook or require you
  to run a server.

## Troubleshooting

### The pairing request does not appear

Make sure Raynard is open, the Telegram status says the bot is listening, and
you sent a text message in a private chat with the bot. Group messages and media
do not start pairing.

### The bot is connected but does not answer

Check that Raynard is still running and has a connected model provider. If the
Telegram chat is already running another turn, the new request waits. Do not use
the same bot token with another polling service at the same time.

### The saved token no longer works

Generate or revoke the token in BotFather, then use **Replace bot** in Raynard.
Replacing the bot with a different bot requires pairing again.
