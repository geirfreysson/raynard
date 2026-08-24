# Raynard v0.5.0

Raynard can now update itself, and the project is open source under the MIT
License.

## Updating from 0.4.0 is manual, once

This is the first release that contains an updater, so 0.4.0 cannot receive it —
a copy built without the updater has no way to check for one. **Download 0.5.0
by hand this time.** From 0.5.0 onwards, Raynard offers new versions inside the
app and you will not have to do this again.

## In-app updates

Raynard checks its own GitHub releases five seconds after launch and every six
hours after that. It never downloads anything on its own: when a release is
available a dot appears on the new Settings gear, and downloading and installing
are each a separate press.

Update packages are signed, and each copy verifies that signature against a key
compiled into it before replacing itself — so an update has to come from us, not
merely from a server claiming to be us.

Debian installs and development builds cannot replace themselves in place. They
say so and link the right download instead of failing in a confusing way.

## Settings

A gear at the foot of the sidebar rail, or `/settings`, opens a new Settings
page showing the installed version and everything about updating it.

## Scheduled tasks

The scheduled task screen has been redesigned, with clearer schedule summaries,
run status, and pause, resume, run-now, and delete actions on the detail view.

## Open source

Raynard is now MIT licensed. The README has been rewritten to describe what the
app actually does — including connecting to private and internal APIs, where
credentials live in your OS keychain and are scoped per extension — and
`CONTRIBUTING.md` now sets out the contribution terms. Documentation is
published to GitHub Pages.

## Downloads

macOS builds are signed and notarized and require macOS 13 or later. Windows
installers are not yet signed, so SmartScreen will warn on first run. Every
asset ships with a SHA-256 checksum.
