# Raynard v0.15.0

This release adds a weekdays schedule to recurring tasks and fixes a release
pipeline bug that let real test failures slip through the Windows build
unnoticed.

- Scheduled tasks now support a **Weekdays** frequency (Monday through
  Friday), shown next to Daily in the task editor's frequency picker. A
  request like "every weekday" or "Monday to Friday" now maps directly to
  this schedule instead of being approximated as Daily with a note explaining
  the substitution.
- Fixed the release workflow's Windows job silently ignoring test failures:
  its "Run deterministic tests" step ran without an explicit shell, which
  defaulted to PowerShell — PowerShell does not stop a multi-line script when
  an earlier command fails, so a failing `npm test` was masked by the passing
  `cargo test`/`cargo check` that ran after it. The step is now pinned to
  `bash`, matching the macOS and Linux jobs, so a real test failure will fail
  the build going forward.
- Fixing that surfaced two genuine Windows-only test bugs, both corrected:
  a catalog slug check that split a path on a literal forward slash (breaking
  on Windows' backslash-separated paths), and a workspace-containment test
  that compared resolved paths against hardcoded forward-slash strings
  instead of the platform's own path resolution.
