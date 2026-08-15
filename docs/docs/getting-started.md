---
sidebar_position: 2
---

# Getting started

## Download Raynard

[Download the latest Apple Silicon macOS installer](https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-mac-arm64.dmg),
or select **Download for macOS** on the Raynard website. The link always follows
the newest published release.

## Install and run Raynard

1. Open the downloaded installer.
2. Move Raynard into your Applications folder if macOS asks you to.
3. Open Raynard from Applications.
4. If macOS displays a first-launch security prompt, confirm that you want to
   open the app.

Raynard starts with a short splash and then opens an empty conversation with
suggested questions and the message composer.

## Configure a model

Type `/models` in the composer. Chat/Explore and Coding/Build models are
configured independently. API keys entered there are stored in the operating
system keychain rather than in the app configuration file.

The supported providers are:

- OpenAI
- Claude
- Moonshot / Kimi

## Start a conversation

Choose a suggestion or enter a question. Raynard streams the answer and may
call an installed generated plugin when one matches the request.

Use the **Stop** control to cancel the active run. Runs belong to individual
chats, so another chat can continue working in the background.
