// In-app updates: check GitHub Releases for a newer Raynard, download it with
// visible progress, install it over this copy, and relaunch.
//
// The updater is driven entirely from Rust. The JavaScript updater API would
// need `src-tauri/capabilities/default.json`, which this app deliberately does
// not have — creating it would change the whole webview's permission posture.
// Invoking our own commands needs no capability, so the renderer only ever
// touches the five commands below, and progress arrives over a `Channel` the
// same way share deep links do.
//
// Nothing here downloads on its own. A background check runs at launch and
// every six hours, but it only ever moves the status to `available`; the bytes
// are fetched when the user asks, and installed when the user asks again.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::now_millis;

/// Matches `APP_UPDATE_CHECK_INTERVAL_MS` in the sibling Electron app: often
/// enough that a long-running session notices a release, rare enough to be
/// invisible.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Long enough for the window to be up and the first chat to be painted, so the
/// check never competes with startup.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateStatus {
    /// Nothing has been checked yet this run.
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Downloaded,
    Installing,
    /// This build cannot update itself; the user is pointed at a download.
    ManualDownload,
    Error,
}

/// Mirrors the TypeScript `AppUpdateState` in `src/settings-view.ts`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    pub status: AppUpdateStatus,
    pub current_version: String,
    pub available_version: Option<String>,
    /// Release notes from the manifest, rendered as plain text.
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub progress_percent: u8,
    pub message: Option<String>,
    pub checked_at: Option<i64>,
    /// A key into `share.config.json`'s `downloads`, set only for
    /// `manualDownload`. The URL table stays in one place — the frontend —
    /// while the platform decision is made here, where a Debian install can
    /// actually be told apart from an AppImage one.
    pub download_target: Option<String>,
}

impl AppUpdateState {
    fn idle(current_version: String) -> Self {
        Self {
            status: AppUpdateStatus::Idle,
            current_version,
            available_version: None,
            notes: None,
            pub_date: None,
            progress_percent: 0,
            message: None,
            checked_at: None,
            download_target: None,
        }
    }
}

#[derive(Default)]
pub struct AppUpdateStore {
    state: Mutex<Option<AppUpdateState>>,
    channel: Mutex<Option<Channel<AppUpdateState>>>,
    /// The update announced by the last successful check.
    pending: Mutex<Option<Update>>,
    /// Verified bytes from a finished download, waiting to be installed.
    downloaded: Mutex<Option<Vec<u8>>>,
}

impl AppUpdateStore {
    fn read(&self, current_version: &str) -> AppUpdateState {
        let mut slot = self.state.lock().unwrap();
        slot.get_or_insert_with(|| AppUpdateState::idle(current_version.to_string()))
            .clone()
    }

    /// Applies `edit` to the stored state and pushes the result to the renderer.
    ///
    /// Every status change goes through here so a background check and a
    /// user-driven download cannot disagree about what the settings page shows.
    fn update<F: FnOnce(&mut AppUpdateState)>(
        &self,
        current_version: &str,
        edit: F,
    ) -> AppUpdateState {
        let next = {
            let mut slot = self.state.lock().unwrap();
            let state =
                slot.get_or_insert_with(|| AppUpdateState::idle(current_version.to_string()));
            edit(state);
            state.clone()
        };
        let channel = self.channel.lock().unwrap().clone();
        if let Some(channel) = channel {
            let _ = channel.send(next.clone());
        }
        next
    }
}

/// Why this build cannot install its own update, if it cannot.
///
/// Returns the user-facing reason and the `share.config.json` download key to
/// offer instead.
fn manual_download_reason() -> Option<(&'static str, &'static str)> {
    if cfg!(debug_assertions) {
        return Some((
            "Automatic updates are only available in packaged builds.",
            default_download_target(),
        ));
    }

    // A .deb install has no in-place update path that does not prompt for root,
    // and handing it the AppImage from the manifest would install the wrong
    // thing — Tauri picks the installer from the file extension. Point those
    // users at a fresh package instead. AppImage runs always set one of these.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() && std::env::var_os("APPDIR").is_none() {
        return Some((
            "This copy was installed from a package. Download the latest .deb to update.",
            "debian",
        ));
    }

    None
}

fn default_download_target() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn current_version(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// RFC 3339 straight from the manifest.
///
/// Reading `raw_json` rather than reformatting the parsed `OffsetDateTime`
/// keeps the `time` crate out of this file's dependencies and shows exactly
/// what the release published.
fn published_at(update: &Update) -> Option<String> {
    update
        .raw_json
        .get("pub_date")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

/// Runs one check and records the outcome.
///
/// Network and manifest failures are recorded as `Error` with a plain-English
/// message; the underlying error goes to stderr instead of the UI, matching how
/// provider quota failures are handled.
async fn run_check(app: &tauri::AppHandle) -> AppUpdateState {
    let version = current_version(app);
    let store = app.state::<AppUpdateStore>();

    if let Some((reason, target)) = manual_download_reason() {
        return store.update(&version, |state| {
            state.status = AppUpdateStatus::ManualDownload;
            state.message = Some(reason.to_string());
            state.download_target = Some(target.to_string());
            state.checked_at = Some(now_millis());
        });
    }

    store.update(&version, |state| {
        state.status = AppUpdateStatus::Checking;
        state.message = None;
        state.progress_percent = 0;
    });

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("app update: updater unavailable: {error}");
            return store.update(&version, |state| {
                state.status = AppUpdateStatus::Error;
                state.message = Some("Could not start the updater.".to_string());
                state.checked_at = Some(now_millis());
            });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let announced = update.version.clone();
            let notes = update.body.clone();
            let date = published_at(&update);
            *store.pending.lock().unwrap() = Some(update);
            *store.downloaded.lock().unwrap() = None;
            store.update(&version, |state| {
                state.status = AppUpdateStatus::Available;
                state.available_version = Some(announced.clone());
                state.notes = notes.clone();
                state.pub_date = date.clone();
                state.progress_percent = 0;
                state.message = None;
                state.checked_at = Some(now_millis());
            })
        }
        Ok(None) => {
            *store.pending.lock().unwrap() = None;
            *store.downloaded.lock().unwrap() = None;
            store.update(&version, |state| {
                state.status = AppUpdateStatus::UpToDate;
                state.available_version = None;
                state.notes = None;
                state.pub_date = None;
                state.progress_percent = 0;
                state.message = None;
                state.checked_at = Some(now_millis());
            })
        }
        Err(error) => {
            eprintln!("app update: check failed: {error}");
            store.update(&version, |state| {
                state.status = AppUpdateStatus::Error;
                state.message = Some("Could not reach GitHub to check for updates.".to_string());
                state.checked_at = Some(now_millis());
            })
        }
    }
}

#[tauri::command]
pub fn get_app_update_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStore>,
) -> Result<AppUpdateState, String> {
    Ok(state.read(&current_version(&app)))
}

/// Installs the renderer's channel and hands back the state it should paint now.
#[tauri::command]
pub fn subscribe_app_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStore>,
    on_state: Channel<AppUpdateState>,
) -> Result<AppUpdateState, String> {
    *state.channel.lock().unwrap() = Some(on_state);
    Ok(state.read(&current_version(&app)))
}

#[tauri::command]
pub async fn check_for_app_update(app: tauri::AppHandle) -> Result<AppUpdateState, String> {
    Ok(run_check(&app).await)
}

/// Downloads the announced update and keeps the verified bytes for `install`.
#[tauri::command]
pub async fn download_app_update(app: tauri::AppHandle) -> Result<AppUpdateState, String> {
    let version = current_version(&app);
    let update = {
        let store = app.state::<AppUpdateStore>();
        let pending = store.pending.lock().unwrap().clone();
        pending
    };
    let Some(update) = update else {
        return Err("There is no update to download. Check for updates first.".to_string());
    };

    {
        let store = app.state::<AppUpdateStore>();
        store.update(&version, |state| {
            state.status = AppUpdateStatus::Downloading;
            state.progress_percent = 0;
            state.message = None;
        });
    }

    // One channel message per whole percent. Per-chunk pushes would be hundreds
    // of IPC frames for a 76 MB DMG and would not move the bar any faster.
    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut received: u64 = 0;
    let mut last_percent: u8 = 0;
    let on_chunk = move |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        let Some(total) = total.filter(|total| *total > 0) else {
            return;
        };
        let percent = ((received.min(total) * 100) / total) as u8;
        if percent <= last_percent {
            return;
        }
        last_percent = percent;
        progress_app
            .state::<AppUpdateStore>()
            .update(&progress_version, |state| {
                state.progress_percent = percent;
            });
    };

    match update.download(on_chunk, || {}).await {
        Ok(bytes) => {
            let store = app.state::<AppUpdateStore>();
            *store.downloaded.lock().unwrap() = Some(bytes);
            Ok(store.update(&version, |state| {
                state.status = AppUpdateStatus::Downloaded;
                state.progress_percent = 100;
                state.message = None;
            }))
        }
        Err(error) => {
            eprintln!("app update: download failed: {error}");
            let store = app.state::<AppUpdateStore>();
            *store.downloaded.lock().unwrap() = None;
            Ok(store.update(&version, |state| {
                state.status = AppUpdateStatus::Error;
                state.progress_percent = 0;
                state.message = Some("The update could not be downloaded.".to_string());
            }))
        }
    }
}

/// Installs the downloaded update and relaunches.
///
/// On success this never returns: `restart` replaces the process.
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<AppUpdateState, String> {
    let version = current_version(&app);
    let (update, bytes) = {
        let store = app.state::<AppUpdateStore>();
        let update = store.pending.lock().unwrap().clone();
        let bytes = store.downloaded.lock().unwrap().clone();
        (update, bytes)
    };
    let (Some(update), Some(bytes)) = (update, bytes) else {
        return Err("There is no downloaded update to install.".to_string());
    };

    {
        let store = app.state::<AppUpdateStore>();
        store.update(&version, |state| {
            state.status = AppUpdateStatus::Installing;
            state.progress_percent = 100;
            state.message = None;
        });
    }

    if let Err(error) = update.install(bytes) {
        eprintln!("app update: install failed: {error}");
        let store = app.state::<AppUpdateStore>();
        return Ok(store.update(&version, |state| {
            state.status = AppUpdateStatus::Error;
            state.message = Some("The update could not be installed.".to_string());
        }));
    }

    app.restart();
}

/// One check shortly after launch, then every six hours for the life of the
/// process. Mirrors the scheduled-task wake thread next to it in `run()`.
pub fn spawn_background_checks(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            tauri::async_runtime::block_on(run_check(&handle));
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> AppUpdateStore {
        AppUpdateStore::default()
    }

    #[test]
    fn reads_an_idle_state_before_anything_has_been_checked() {
        let state = store().read("0.4.0");
        assert_eq!(state.status, AppUpdateStatus::Idle);
        assert_eq!(state.current_version, "0.4.0");
        assert_eq!(state.progress_percent, 0);
        assert!(state.available_version.is_none());
        assert!(state.checked_at.is_none());
    }

    #[test]
    fn update_persists_the_edit_for_the_next_read() {
        let store = store();
        store.update("0.4.0", |state| {
            state.status = AppUpdateStatus::Available;
            state.available_version = Some("0.5.0".to_string());
        });
        let state = store.read("0.4.0");
        assert_eq!(state.status, AppUpdateStatus::Available);
        assert_eq!(state.available_version.as_deref(), Some("0.5.0"));
        // The version the store was seeded with survives later edits.
        assert_eq!(state.current_version, "0.4.0");
    }

    #[test]
    fn status_serializes_as_camel_case_for_the_renderer() {
        let json = serde_json::to_string(&AppUpdateStatus::ManualDownload).unwrap();
        assert_eq!(json, "\"manualDownload\"");
        let json = serde_json::to_string(&AppUpdateStatus::UpToDate).unwrap();
        assert_eq!(json, "\"upToDate\"");
    }

    #[test]
    fn state_serializes_with_the_field_names_the_frontend_expects() {
        let value = serde_json::to_value(AppUpdateState::idle("0.4.0".to_string())).unwrap();
        for key in [
            "status",
            "currentVersion",
            "availableVersion",
            "notes",
            "pubDate",
            "progressPercent",
            "message",
            "checkedAt",
            "downloadTarget",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn debug_builds_are_told_to_download_manually() {
        // The test binary is always a debug build, so this is the dev-mode
        // guard that keeps `tauri dev` from reporting a confusing failure.
        let reason = manual_download_reason();
        assert!(reason.is_some());
        let (message, target) = reason.unwrap();
        assert!(message.contains("packaged builds"));
        assert_eq!(target, default_download_target());
    }
}
