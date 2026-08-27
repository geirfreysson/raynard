---
sidebar_position: 2
---

import DownloadLink from '@site/src/components/DownloadLink';

# Getting started

## Install Raynard

### macOS

<DownloadLink platform="macos" url="https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-mac-arm64.dmg">Download the Apple Silicon DMG</DownloadLink>,
open it, and move Raynard into Applications.

### Linux

The recommended installation is rootless and takes one command:

```sh
curl -fsSL https://github.com/geirfreysson/raynard/releases/latest/download/install.sh | sh
```

The script verifies the downloaded AppImage, installs it for your user, adds
Raynard to the application menu, creates the `raynard` terminal command, and
launches the app.

For a manual or package-managed installation, use the
<DownloadLink platform="linux" url="https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-linux-x86_64.AppImage">x86_64 AppImage</DownloadLink>
or <DownloadLink platform="debian" url="https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-linux-amd64.deb">amd64 Debian package</DownloadLink>.
Make an AppImage executable with `chmod +x Raynard-linux-x86_64.AppImage`, or
install the Debian package with `sudo apt install ./Raynard-linux-amd64.deb`.

### Windows

<DownloadLink platform="windows" url="https://github.com/geirfreysson/raynard/releases/latest/download/Raynard-windows-x64-setup.exe">Download the x64 installer</DownloadLink>
and open it, or install and launch Raynard from PowerShell:

```powershell
irm https://github.com/geirfreysson/raynard/releases/latest/download/install.ps1 | iex
```

Windows may show a warning because this preview has not been signed yet. That
does not necessarily mean anything is wrong with the app—it means Windows is
asking you to confirm that you trust the download. If you downloaded Raynard
from the official link above, choose **More info**, then **Run anyway** to
continue. Windows signing is planned for a future release.

Raynard starts with a short splash and then opens an empty conversation with
suggested questions and the message composer.

## Configure a model

On your first run, Raynard asks you to connect a provider. Sign in with ChatGPT,
or choose **Other** to connect a provider with an API key. You can change the
provider later by typing `/models` in the composer.

One provider powers both Explore and Build. Raynard uses that provider's
default model, so there is no separate model to choose for each mode. API keys
are stored securely in the operating system credential store.

The main provider choices are:

- ChatGPT
- Claude
- Kimi

If you already use an OpenAI API key, that option is also available from the
provider screen.

## Start a conversation

Choose a suggestion or enter a question. Raynard streams the answer and may
use an installed extension when one matches the request.

Use **Stop** to cancel the current answer. Other chats can continue working in
the background.
