mod app_updates;
mod extension_contribution;
mod scheduled_tasks;

use app_updates::{
    check_for_app_update, download_app_update, get_app_update_state, install_app_update,
    subscribe_app_updates, AppUpdateStore,
};
use extension_contribution::{
    contribution_test_files, prepare_extension_contribution_in, ContributionMetadata,
    ContributionTool, PreparedExtensionContribution,
};
use futures_util::StreamExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

const KEYRING_SERVICE: &str = "ai.raynard";
const INLINE_RESULT_DATA_LIMIT_BYTES: usize = 128 * 1024;
const CHAT_HISTORY_INDEX_VERSION: u32 = 2;
static CHAT_HISTORY_INDEX_LOCK: Mutex<()> = Mutex::new(());
static SCHEDULED_TASK_LOCK: Mutex<()> = Mutex::new(());
static BUNDLED_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Default)]
struct ScheduledTaskWakeState {
    channel: Mutex<Option<Channel<i64>>>,
}

#[derive(Default)]
struct StreamCancelState {
    canceled: Mutex<HashSet<String>>,
    process_ids: Mutex<HashMap<String, u32>>,
}

/// Share links arriving from the OS.
///
/// A cold launch delivers the URL before the webview exists, so URLs are
/// buffered until the renderer subscribes and then drained in order. The URL is
/// pushed over a `Channel` rather than the event system, so the app keeps its
/// empty capability set — nothing here is invokable from the webview except
/// `subscribe_deep_links` itself.
#[derive(Default)]
struct PendingDeepLinks {
    buffered: Mutex<Vec<String>>,
    channel: Mutex<Option<Channel<String>>>,
}

impl PendingDeepLinks {
    /// Records a URL, returning the live channel when one is already listening.
    fn push(&self, url: String) -> Option<Channel<String>> {
        let channel = self.channel.lock().unwrap().clone();
        match channel {
            Some(channel) => Some(channel),
            None => {
                self.buffered.lock().unwrap().push(url);
                None
            }
        }
    }

    /// Installs the renderer's channel and hands back anything that arrived first.
    fn subscribe(&self, channel: Channel<String>) -> Vec<String> {
        *self.channel.lock().unwrap() = Some(channel);
        std::mem::take(&mut *self.buffered.lock().unwrap())
    }
}

/// Accepts only `<scheme>://share/<base64url>`.
///
/// Everything else the OS might hand over is refused here rather than in the
/// renderer, matching how `external_url_target` guards outbound URLs. The cap is
/// a sanity bound, not the LaunchServices limit: macOS was measured delivering
/// URLs past 262 000 characters, well beyond any payload this app builds.
fn share_deep_link_payload<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    const MAX_ENCODED_LENGTH: usize = 64 * 1024;

    let trimmed = url.trim();
    let prefix = format!("{scheme}://share/");
    if trimmed.len() <= prefix.len() {
        return None;
    }
    if !trimmed[..prefix.len()].eq_ignore_ascii_case(&prefix) {
        return None;
    }

    let encoded = trimmed[prefix.len()..].trim_end_matches('/');
    if encoded.is_empty() || encoded.len() > MAX_ENCODED_LENGTH {
        return None;
    }
    if !encoded
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(encoded)
}

/// The scheme declared in `tauri.conf.json` and in `share.config.json`.
const APP_URL_SCHEME: &str = "raynard";

#[tauri::command]
fn subscribe_deep_links(
    state: tauri::State<'_, PendingDeepLinks>,
    on_url: Channel<String>,
) -> Result<(), String> {
    for url in state.subscribe(on_url.clone()) {
        on_url
            .send(url)
            .map_err(|error| format!("Could not deliver a shared link: {error}"))?;
    }
    Ok(())
}

fn deliver_deep_links(state: &PendingDeepLinks, urls: Vec<String>) {
    for url in urls {
        if share_deep_link_payload(&url, APP_URL_SCHEME).is_none() {
            continue;
        }
        if let Some(channel) = state.push(url.clone()) {
            let _ = channel.send(url);
        }
    }
}

#[derive(Default, Clone)]
struct BookmarkStoreState {
    cache: Arc<Mutex<Option<BookmarkCache>>>,
}

#[derive(Default)]
struct BookmarkCache {
    ordered: BTreeMap<String, StoredBookmark>,
    locators: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmEnvStatus {
    found: bool,
    path: Option<String>,
    keys: Vec<String>,
    provider: String,
    model: String,
    coding_provider: String,
    coding_model: String,
    configured: bool,
    coding_configured: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelProvider {
    id: String,
    name: String,
    base_url: String,
    default_chat_model: String,
    default_coding_model: String,
    chat_model: String,
    coding_model: String,
    chat_active: bool,
    coding_active: bool,
    connected: bool,
    /// "api_key" or "oauth" — decides whether the row asks for a pasted key or
    /// starts a browser sign-in.
    auth_method: String,
    /// Console page that issues keys for this provider; empty for sign-in.
    api_key_url: String,
}

#[derive(Serialize)]
struct ModelProviderList {
    providers: Vec<ModelProvider>,
}

#[derive(Deserialize, Default, Serialize)]
struct AppConfig {
    active_provider: Option<String>,
    active_model: Option<String>,
    active_coding_provider: Option<String>,
    active_coding_model: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct StoredChatMessage {
    role: String,
    text: String,
    timestamp: i64,
    thinking: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    status: Option<String>,
    error: Option<String>,
    #[serde(rename = "modeStatus", default)]
    mode_status: Option<bool>,
    #[serde(rename = "modelFailure", default)]
    model_failure: Option<Value>,
    #[serde(rename = "builderRun", default)]
    builder_run: Option<bool>,
    /// This answer arrived through a share link rather than a live turn. Kept so
    /// the "frozen snapshot" banner survives a reload, the same way builder runs
    /// keep their transcript.
    #[serde(rename = "sharedImport", default)]
    shared_import: Option<bool>,
    #[serde(rename = "builderActivities", default)]
    builder_activities: Option<Value>,
    /// Result cards captured from storable tool calls during this turn.
    /// Each entry is { toolName, template, data }; rendered beneath the message.
    #[serde(default)]
    cards: Option<Value>,
    /// Native present_chart results. Opaque passthrough; the renderer validates
    /// each ChartSpec again before mounting it.
    #[serde(default)]
    charts: Option<Value>,
    /// The API calls that fed this turn, one entry per citing tool call
    /// ({ plugin, label, sourceUrl }). Opaque passthrough so a chart copied out
    /// of a reloaded chat still names its data sources.
    #[serde(default)]
    sources: Option<Value>,
    /// A tool needed an API key the user has not stored. Opaque passthrough so
    /// the prompt card survives navigation and restart. Names only, no values.
    #[serde(rename = "credentialRequest", default)]
    credential_request: Option<Value>,
    /// An available catalog extension selected by the main agent. Persisted so
    /// its inline Install action survives chat navigation and app restarts.
    #[serde(rename = "extensionRecommendation", default)]
    extension_recommendation: Option<Value>,
    /// Pending/created host scheduling metadata. It contains no credentials.
    #[serde(rename = "scheduledTaskRequest", default)]
    scheduled_task_request: Option<Value>,
    #[serde(rename = "scheduledTaskId", default)]
    scheduled_task_id: Option<String>,
    #[serde(rename = "scheduledTaskName", default)]
    scheduled_task_name: Option<String>,
    #[serde(rename = "scheduledExecutionId", default)]
    scheduled_execution_id: Option<String>,
    /// Token counts for the turn that produced this message
    /// ({ input, output, cacheRead, cacheWrite, totalTokens, contextTokens,
    /// contextWindow }). Counts only — never text, ids, or headers.
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryPayload {
    #[serde(alias = "chat_id")]
    chat_id: String,
    name: String,
    #[serde(alias = "created_at")]
    created_at: String,
    #[serde(alias = "updated_at")]
    updated_at: String,
    messages: Vec<StoredChatMessage>,
    /// A scheduled run finished after the user last viewed this chat.
    #[serde(default)]
    unread: bool,
    /// The plugin this Build-mode chat is actively editing ({ dir, name }), so
    /// reopening the chat resumes the coding session. Opaque passthrough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_build_plugin: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryRow {
    chat_id: String,
    name: String,
    created_at: String,
    updated_at: String,
    message_count: usize,
    #[serde(default)]
    unread: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryIndex {
    version: u32,
    chats: Vec<ChatHistoryRow>,
}

#[derive(Serialize)]
struct ChatHistoryList {
    folder: String,
    chats: Vec<ChatHistoryRow>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredBookmark {
    id: String,
    message_key: String,
    chat_id: String,
    chat_name: String,
    /// Short model-written label for this bookmark. Empty for bookmarks saved
    /// before titles existed, and whenever naming failed, so readers fall back
    /// to `prompt`.
    #[serde(default)]
    title: String,
    prompt: String,
    answer: String,
    message_timestamp: i64,
    created_at: i64,
}

/// A durable fact the agent proposed remembering, always persisted only after
/// the user confirms. `scope` is `"global"` or an installed plugin's stable
/// directory slug (never its renameable display name), so a memory survives a
/// plugin rename and naturally stops being injected once that plugin is
/// removed.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredMemory {
    id: String,
    scope: String,
    content: String,
    /// The plugin's display name at the time this memory was captured/edited,
    /// so a since-renamed or removed plugin's entries still read sensibly.
    #[serde(default)]
    scope_label: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Default, Clone)]
struct MemoryStoreState {
    cache: Arc<Mutex<Option<MemoryCache>>>,
}

#[derive(Default)]
struct MemoryCache {
    by_id: BTreeMap<String, StoredMemory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkList {
    bookmarks: Vec<StoredBookmark>,
    total: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTurnLogEvent {
    chat_id: String,
    event_type: String,
    timestamp: Option<i64>,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginScaffoldRequest {
    name: String,
    description: String,
    source_urls: Option<Vec<String>>,
    conflict_strategy: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginScaffoldStatus {
    normalized_name: String,
    exists: bool,
    next_available_name: String,
    has_runtime_tools: bool,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginBuilderRequest {
    plugin_dir: String,
    name: String,
    description: String,
    source_urls: Option<Vec<String>>,
    prompt: String,
    /// AI-authored structured task classification used to select a focused
    /// coding-agent context without parsing the user's prose.
    #[serde(default)]
    task_kind: Option<String>,
    /// Exact installed tool names affected by a targeted edit.
    #[serde(default)]
    target_tools: Option<Vec<String>>,
    /// True when editing an existing plugin as an interactive coding session
    /// (read + edit real files) rather than filling a fresh scaffold.
    #[serde(default)]
    edit_mode: bool,
    /// Prior build-conversation turns, replayed so the coding agent has context
    /// for follow-ups like "now tweak that". Each item is { role, content }.
    #[serde(default)]
    messages: Option<Vec<ChatMessage>>,
    /// The credential the main agent already identified while researching the
    /// API, so the coding agent does not go looking for a sign-up page the host
    /// is already holding. Opaque passthrough: names and URLs only, no value.
    #[serde(default)]
    auth: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginToolRequest {
    plugin_dir: Option<String>,
    plugin_id: Option<String>,
    tool_name: String,
    args: Value,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PluginCacheSettings {
    enabled: bool,
    ttl_hours: u32,
}

impl Default for PluginCacheSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl_hours: 24,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPlugin {
    id: String,
    name: String,
    description: String,
    version: String,
    directory: String,
    entry_path: String,
    manifest_path: String,
    created_at: String,
    status: String,
    /// Builder-authored prompts for the empty-chat splash, read from the manifest.
    sample_prompts: Vec<String>,
    /// Credential declarations from the manifest, annotated with whether the
    /// user has stored a value. Never carries the value itself: this struct is
    /// serialized both to the renderer and into the agent sidecar request.
    credentials: Vec<PluginCredential>,
    tools: Vec<GeneratedPluginTool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginCredential {
    key: String,
    label: String,
    description: String,
    /// The page where a user signs up for this key. Required, because a prompt
    /// that cannot tell the user where to get a key is a dead end.
    signup_url: String,
    configured: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeneratedPluginTool {
    name: String,
    description: String,
    parameters: Value,
    /// Fixed result-card layout authored by the builder for every API tool.
    card: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeToolsCache {
    source_mtime: u128,
    tools: Vec<GeneratedPluginTool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPluginList {
    folder: String,
    plugins: Vec<GeneratedPlugin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPluginDetail {
    plugin: GeneratedPlugin,
    manifest_json: Value,
    manifest_text: String,
    code: String,
    readme: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CatalogExtensionTool {
    name: String,
    description: String,
    has_card: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CatalogExtension {
    slug: String,
    id: String,
    name: String,
    description: String,
    category: String,
    icon: String,
    author: String,
    homepage: String,
    version: String,
    tools: Vec<CatalogExtensionTool>,
    requires_key: bool,
    installed: bool,
    /// The version recorded inside the installed copy, which is a snapshot taken
    /// at install time and never refreshed on its own. When this differs from
    /// `version` the bundled catalog has moved on and an update is offered.
    /// Empty when the extension is not installed.
    installed_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogExtensionList {
    folder: String,
    extensions: Vec<CatalogExtension>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogExtensionDetail {
    extension: CatalogExtension,
    detail: GeneratedPluginDetail,
}

#[tauri::command]
fn load_llm_env_status(app: tauri::AppHandle) -> Result<LlmEnvStatus, String> {
    let config = resolve_model_config(Some(&app))?;
    let coding_config = resolve_coding_model_config(Some(&app))?;
    let env_path = find_env_file();
    let Some(path) = env_path else {
        return Ok(LlmEnvStatus {
            found: false,
            path: None,
            keys: Vec::new(),
            provider: config.provider,
            model: config.model,
            coding_provider: coding_config.provider,
            coding_model: coding_config.model,
            configured: !config.api_key.is_empty(),
            coding_configured: !coding_config.api_key.is_empty(),
        });
    };

    let entries = dotenvy::from_path_iter(&path)
        .map_err(|error| format!("Could not read .env: {error}"))?
        .filter_map(Result::ok)
        .collect::<BTreeMap<String, String>>();

    Ok(LlmEnvStatus {
        found: true,
        path: Some(path.to_string_lossy().to_string()),
        keys: entries.keys().cloned().collect(),
        provider: config.provider,
        model: config.model,
        coding_provider: coding_config.provider,
        coding_model: coding_config.model,
        configured: !config.api_key.is_empty(),
        coding_configured: !coding_config.api_key.is_empty(),
    })
}

#[tauri::command]
async fn list_chat_history(app: tauri::AppHandle) -> Result<ChatHistoryList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = chat_history_dir(&app)?;
        let chats = load_or_rebuild_chat_history_index_in(&dir)?;
        Ok(ChatHistoryList {
            folder: dir.to_string_lossy().to_string(),
            chats,
        })
    })
    .await
    .map_err(|error| format!("Could not join chat history listing task: {error}"))?
}

#[tauri::command]
async fn list_bookmarks(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<BookmarkList, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = bookmarks_dir(&app)?;
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock bookmarks.".to_string())?;
        if guard.is_none() {
            *guard = Some(load_bookmark_cache_in(&root)?);
        }
        let cache = guard.as_ref().expect("bookmark cache initialized");
        Ok(bookmark_page(
            cache,
            offset.unwrap_or(0),
            limit.unwrap_or(50),
        ))
    })
    .await
    .map_err(|error| format!("Could not join bookmark listing task: {error}"))?
}

fn all_bookmarks(cache: &BookmarkCache) -> Vec<StoredBookmark> {
    cache.ordered.values().cloned().collect()
}

/// The whole bookmark collection, unpaginated, for the @-mention menu: it
/// needs every bookmark available synchronously as the user types, unlike
/// `list_bookmarks`'s paginated sidebar listing.
#[tauri::command]
async fn list_bookmark_mentions(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
) -> Result<Vec<StoredBookmark>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = bookmarks_dir(&app)?;
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock bookmarks.".to_string())?;
        if guard.is_none() {
            *guard = Some(load_bookmark_cache_in(&root)?);
        }
        let cache = guard.as_ref().expect("bookmark cache initialized");
        Ok(all_bookmarks(cache))
    })
    .await
    .map_err(|error| format!("Could not join bookmark mention listing task: {error}"))?
}

fn scheduled_tasks_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("scheduled-tasks").join("tasks.json"))
}

#[tauri::command]
fn subscribe_scheduled_tasks(
    state: tauri::State<'_, ScheduledTaskWakeState>,
    on_wake: Channel<i64>,
) -> Result<(), String> {
    *state
        .channel
        .lock()
        .map_err(|_| "Could not subscribe to scheduled tasks.".to_string())? =
        Some(on_wake.clone());
    on_wake
        .send(now_millis())
        .map_err(|error| format!("Could not wake the scheduled-task runner: {error}"))
}

#[tauri::command]
async fn list_scheduled_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<scheduled_tasks::ScheduledTask>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::list(&scheduled_tasks_path(&app)?)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task listing: {error}"))?
}

fn validate_task_destination(
    app: &tauri::AppHandle,
    draft: &scheduled_tasks::ScheduledTaskDraft,
) -> Result<(), String> {
    if draft.destination_type == "existingChat" {
        let chat_id = draft.destination_chat_id.as_deref().unwrap_or_default();
        if !chat_history_path(app, chat_id)?.is_file() {
            return Err("The selected destination chat no longer exists.".to_string());
        }
    }
    Ok(())
}

fn normalize_task_destination(draft: &mut scheduled_tasks::ScheduledTaskDraft) {
    if draft.destination_type == "existingChat" {
        draft.destination_chat_id = draft.destination_chat_id.as_deref().map(normalize_chat_id);
    }
}

#[tauri::command]
async fn create_scheduled_task(
    app: tauri::AppHandle,
    mut draft: scheduled_tasks::ScheduledTaskDraft,
) -> Result<scheduled_tasks::ScheduledTask, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        normalize_task_destination(&mut draft);
        validate_task_destination(&app, &draft)?;
        scheduled_tasks::create(&scheduled_tasks_path(&app)?, draft)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task creation: {error}"))?
}

#[tauri::command]
async fn update_scheduled_task(
    app: tauri::AppHandle,
    task_id: String,
    mut draft: scheduled_tasks::ScheduledTaskDraft,
) -> Result<scheduled_tasks::ScheduledTask, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        normalize_task_destination(&mut draft);
        validate_task_destination(&app, &draft)?;
        scheduled_tasks::update(&scheduled_tasks_path(&app)?, &task_id, draft)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task update: {error}"))?
}

#[tauri::command]
async fn set_scheduled_task_enabled(
    app: tauri::AppHandle,
    task_id: String,
    enabled: bool,
) -> Result<scheduled_tasks::ScheduledTask, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::set_enabled(&scheduled_tasks_path(&app)?, &task_id, enabled)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task state update: {error}"))?
}

#[tauri::command]
async fn delete_scheduled_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::delete(&scheduled_tasks_path(&app)?, &task_id)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task deletion: {error}"))?
}

#[tauri::command]
async fn list_due_scheduled_tasks(
    app: tauri::AppHandle,
) -> Result<Vec<scheduled_tasks::ScheduledTask>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::due(&scheduled_tasks_path(&app)?)
    })
    .await
    .map_err(|error| format!("Could not join due-task listing: {error}"))?
}

#[tauri::command]
async fn claim_scheduled_task(
    app: tauri::AppHandle,
    task_id: String,
    manual: bool,
) -> Result<scheduled_tasks::ScheduledExecution, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::claim(&scheduled_tasks_path(&app)?, &task_id, manual)
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task claim: {error}"))?
}

#[tauri::command]
async fn complete_scheduled_task(
    app: tauri::AppHandle,
    task_id: String,
    execution_id: String,
    status: String,
    error: Option<String>,
    destination_chat_id: Option<String>,
) -> Result<scheduled_tasks::ScheduledTask, String> {
    let store_app = app.clone();
    let completion_status = status.clone();
    let completed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::complete(
            &scheduled_tasks_path(&store_app)?,
            &task_id,
            &execution_id,
            &status,
            error,
            destination_chat_id,
        )
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task completion: {error}"))??;

    if let Some(chat_id) = completed.destination_chat_id.clone() {
        let unread_app = app.clone();
        let unread_result = tauri::async_runtime::spawn_blocking(move || {
            set_chat_history_unread_in(&chat_history_dir(&unread_app)?, &chat_id, true)
        })
        .await
        .map_err(|error| format!("Could not join scheduled chat unread update: {error}"))
        .and_then(|result| result.map(|_| ()));
        if let Err(error) = unread_result {
            eprintln!("Could not mark scheduled chat unread: {error}");
        }
    }
    let body = if completion_status == "completed" {
        "Scheduled task finished. Open Raynard to view the result."
    } else {
        "Scheduled task needs attention. Open Raynard for details."
    };
    if let Err(error) = app
        .notification()
        .builder()
        .title(&completed.name)
        .body(body)
        .show()
    {
        eprintln!("Could not show scheduled task notification: {error}");
    }

    Ok(completed)
}

#[tauri::command]
async fn assign_scheduled_task_chat(
    app: tauri::AppHandle,
    task_id: String,
    execution_id: String,
    chat_id: String,
) -> Result<scheduled_tasks::ScheduledTask, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        scheduled_tasks::assign_destination_chat(
            &scheduled_tasks_path(&app)?,
            &task_id,
            &execution_id,
            &chat_id,
        )
    })
    .await
    .map_err(|error| format!("Could not join scheduled-task destination update: {error}"))?
}

#[tauri::command]
async fn list_chat_bookmarks(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<Vec<StoredBookmark>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = bookmarks_dir(&app)?;
        read_chat_bookmarks_in(&root, &chat_id)
    })
    .await
    .map_err(|error| format!("Could not join chat bookmark listing task: {error}"))?
}

/// Names an already-saved bookmark with the chat model, in the background.
///
/// Bookmarks used to be listed under the prompt that produced them, which reads
/// poorly: prompts are long and describe the question rather than the finding.
/// Saving deliberately does not wait for this — the bookmark is stored first and
/// shows its prompt, and this replaces the label when the model answers.
///
/// Returns the updated bookmark, or the unchanged one when it is already named.
/// A previously generated title is reused from the cache without calling the
/// model, so re-bookmarking an answer is instant and free.
#[tauri::command]
async fn name_bookmark(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
    chat_id: String,
    message_key: String,
) -> Result<StoredBookmark, String> {
    let root = bookmarks_dir(&app)?;
    let safe_chat_id = normalize_chat_id(&chat_id);
    let safe_message_key = normalize_bookmark_key(&message_key)?;
    let locator = bookmark_locator(&safe_chat_id, &safe_message_key);
    let path = bookmark_path_in(&root, &safe_chat_id, &safe_message_key);

    let read_bookmark = |path: &Path| -> Result<StoredBookmark, String> {
        let raw = fs::read_to_string(path)
            .map_err(|_| "This bookmark is no longer saved.".to_string())?;
        serde_json::from_str::<StoredBookmark>(&raw)
            .map_err(|error| format!("Could not read bookmark: {error}"))
    };

    let bookmark = read_bookmark(&path)?;
    if !bookmark.title.trim().is_empty() {
        return Ok(bookmark);
    }

    // A title generated for this answer before, possibly for a bookmark that has
    // since been removed and re-added.
    if let Some(cached) = read_cached_bookmark_title(&root, &locator) {
        return store_bookmark_title(&state, &root, &path, &locator, &cached, false);
    }

    let mut config = resolve_model_config(Some(&app))?;
    if config.auth_method == AuthMethod::OAuth {
        config.api_key = resolve_provider_access_token(&config.provider).await?;
    } else if config.api_key.is_empty() {
        return Err("Save a chat model API key before naming bookmarks.".to_string());
    }

    let sidecar_path = resolve_bookmark_title_sidecar_path()?;
    let request = json!({
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
        "apiKey": config.api_key,
        "prompt": bookmark.prompt,
        "answer": bookmark.answer,
    });

    let output = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut child = Command::new(resolve_node_command())
            .arg(sidecar_path)
            .current_dir(
                env::current_dir()
                    .map_err(|error| format!("Could not read current directory: {error}"))?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start bookmark title sidecar: {error}"))?;
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "Could not open bookmark title sidecar input.".to_string())?;
            let raw = serde_json::to_vec(&request)
                .map_err(|error| format!("Could not serialize title request: {error}"))?;
            stdin
                .write_all(&raw)
                .map_err(|error| format!("Could not send the title request: {error}"))?;
        }
        let finished = child
            .wait_with_output()
            .map_err(|error| format!("Could not read the title reply: {error}"))?;
        Ok(finished.stdout)
    })
    .await
    .map_err(|error| format!("Could not run the bookmark title sidecar: {error}"))??;

    let line = String::from_utf8_lossy(&output);
    let last = line
        .lines()
        .filter(|entry| !entry.trim().is_empty())
        .next_back()
        .unwrap_or_default();
    let parsed: Value = serde_json::from_str(last)
        .map_err(|_| "The bookmark title sidecar returned no result.".to_string())?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Could not name this bookmark.")
            .to_string());
    }
    let title = normalize_bookmark_title(parsed.get("title").and_then(Value::as_str).unwrap_or(""));
    if title.is_empty() {
        return Err("The model did not return a usable title.".to_string());
    }
    store_bookmark_title(&state, &root, &path, &locator, &title, true)
}

/// Writes a resolved title onto the stored bookmark and into the live cache.
///
/// Naming runs in the background, so the bookmark may have been removed while
/// the model was thinking. Re-reading the file here rather than trusting the
/// copy loaded earlier is what stops a late title from resurrecting a bookmark
/// the user has already deleted.
fn store_bookmark_title(
    state: &tauri::State<'_, BookmarkStoreState>,
    root: &Path,
    path: &Path,
    locator: &str,
    title: &str,
    remember: bool,
) -> Result<StoredBookmark, String> {
    // Remember the title even if the bookmark itself is gone: bookmarking the
    // same answer again should not pay for another model call.
    if remember {
        write_bookmark_title_in(root, locator, title)?;
    }
    let raw =
        fs::read_to_string(path).map_err(|_| "This bookmark is no longer saved.".to_string())?;
    let mut bookmark = serde_json::from_str::<StoredBookmark>(&raw)
        .map_err(|error| format!("Could not read bookmark: {error}"))?;
    bookmark.title = normalize_bookmark_title(title);
    write_bookmark_in(root, &bookmark)?;
    let mut guard = state
        .cache
        .lock()
        .map_err(|_| "Could not lock bookmarks.".to_string())?;
    if let Some(cache) = guard.as_mut() {
        upsert_bookmark_cache(cache, bookmark.clone());
    }
    Ok(bookmark)
}

#[tauri::command]
async fn save_bookmark(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
    bookmark: StoredBookmark,
) -> Result<StoredBookmark, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bookmark = normalize_bookmark(bookmark)?;
        if !chat_history_path(&app, &bookmark.chat_id)?.is_file() {
            return Err("The source chat must be saved before it can be bookmarked.".to_string());
        }
        let root = bookmarks_dir(&app)?;
        write_bookmark_in(&root, &bookmark)?;
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock bookmarks.".to_string())?;
        if let Some(cache) = guard.as_mut() {
            upsert_bookmark_cache(cache, bookmark.clone());
        }
        Ok(bookmark)
    })
    .await
    .map_err(|error| format!("Could not join bookmark save task: {error}"))?
}

#[tauri::command]
async fn delete_bookmark(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
    chat_id: String,
    message_key: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = bookmarks_dir(&app)?;
        let safe_chat_id = normalize_chat_id(&chat_id);
        let safe_message_key = normalize_bookmark_key(&message_key)?;
        let path = bookmark_path_in(&root, &safe_chat_id, &safe_message_key);
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not remove bookmark: {error}"))?;
        }
        if let Some(parent) = path.parent() {
            if parent.is_dir()
                && fs::read_dir(parent)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false)
            {
                fs::remove_dir(parent).ok();
            }
        }
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock bookmarks.".to_string())?;
        if let Some(cache) = guard.as_mut() {
            remove_bookmark_cache(cache, &safe_chat_id, &safe_message_key);
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Could not join bookmark delete task: {error}"))?
}

#[tauri::command]
async fn list_memories(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoryStoreState>,
) -> Result<Vec<StoredMemory>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = memories_dir(&app)?;
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock memories.".to_string())?;
        if guard.is_none() {
            *guard = Some(load_memory_cache_in(&root)?);
        }
        let cache = guard.as_ref().expect("memory cache initialized");
        Ok(cache.by_id.values().cloned().collect())
    })
    .await
    .map_err(|error| format!("Could not join memory listing task: {error}"))?
}

/// Upserts by id, so one command covers both a brand-new memory (empty `id`)
/// and an edit to an existing one — the same shape `save_bookmark` already
/// proves is enough for a record this small.
#[tauri::command]
async fn save_memory(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoryStoreState>,
    memory: StoredMemory,
) -> Result<StoredMemory, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = memories_dir(&app)?;
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock memories.".to_string())?;
        if guard.is_none() {
            *guard = Some(load_memory_cache_in(&root)?);
        }
        // An edit's created_at must survive normalization: look the previous
        // entry up before it is overwritten by a freshly generated one.
        let mut memory = memory;
        if !memory.id.trim().is_empty() {
            if let Some(cache) = guard.as_ref() {
                if let Some(previous) = cache.by_id.get(memory.id.trim()) {
                    if memory.created_at <= 0 {
                        memory.created_at = previous.created_at;
                    }
                }
            }
        }
        let memory = normalize_memory(memory)?;
        write_memory_in(&root, &memory)?;
        if let Some(cache) = guard.as_mut() {
            cache.by_id.insert(memory.id.clone(), memory.clone());
        }
        Ok(memory)
    })
    .await
    .map_err(|error| format!("Could not join memory save task: {error}"))?
}

#[tauri::command]
async fn delete_memory(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoryStoreState>,
    scope: String,
    id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = memories_dir(&app)?;
        let safe_scope = normalize_memory_scope(&scope)?;
        let safe_id = normalize_memory_id(&id)?;
        let path = memory_path_in(&root, &safe_scope, &safe_id);
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| format!("Could not remove memory: {error}"))?;
        }
        if let Some(parent) = path.parent() {
            if parent.is_dir()
                && fs::read_dir(parent)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false)
            {
                fs::remove_dir(parent).ok();
            }
        }
        let mut guard = store
            .cache
            .lock()
            .map_err(|_| "Could not lock memories.".to_string())?;
        if let Some(cache) = guard.as_mut() {
            cache.by_id.remove(&safe_id);
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Could not join memory delete task: {error}"))?
}

#[tauri::command]
async fn read_chat_history(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<ChatHistoryPayload, String> {
    tauri::async_runtime::spawn_blocking(move || read_chat_history_sync(&app, &chat_id))
        .await
        .map_err(|error| format!("Could not join chat read task: {error}"))?
}

fn read_chat_history_sync(
    app: &tauri::AppHandle,
    chat_id: &str,
) -> Result<ChatHistoryPayload, String> {
    let safe_chat_id = normalize_chat_id(&chat_id);
    let path = chat_history_path(app, &safe_chat_id)?;
    if !path.is_file() {
        return Err(format!("Chat not found: {safe_chat_id}"));
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("Could not read chat: {error}"))?;
    let mut chat: ChatHistoryPayload =
        serde_json::from_str(&raw).map_err(|error| format!("Could not parse chat: {error}"))?;
    chat.chat_id = safe_chat_id;
    chat.name = normalize_chat_name(&chat.name);
    chat.created_at = normalize_iso(&chat.created_at).unwrap_or_else(now_iso);
    chat.messages = normalize_stored_messages(chat.messages);
    let stored_updated_at = normalize_iso(&chat.updated_at).unwrap_or_else(now_iso);
    chat.updated_at = latest_chat_turn_iso(&chat.messages, &stored_updated_at);
    let artifact_dir = result_artifacts_dir(app)?;
    if externalize_large_card_data_in(&artifact_dir, &chat.chat_id, &mut chat.messages)? {
        write_chat_history_file(&path, &chat)?;
    }
    Ok(chat)
}

#[tauri::command]
async fn save_chat_history(
    app: tauri::AppHandle,
    payload: ChatHistoryPayload,
) -> Result<ChatHistoryRow, String> {
    tauri::async_runtime::spawn_blocking(move || save_chat_history_sync(&app, payload))
        .await
        .map_err(|error| format!("Could not join chat save task: {error}"))?
}

#[tauri::command]
async fn mark_chat_history_read(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<ChatHistoryRow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_chat_history_unread_in(&chat_history_dir(&app)?, &chat_id, false)
    })
    .await
    .map_err(|error| format!("Could not join chat read-state update: {error}"))?
}

fn save_chat_history_sync(
    app: &tauri::AppHandle,
    payload: ChatHistoryPayload,
) -> Result<ChatHistoryRow, String> {
    let safe_chat_id = normalize_chat_id(&payload.chat_id);
    let path = chat_history_path(app, &safe_chat_id)?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }

    let created_at = normalize_iso(&payload.created_at).unwrap_or_else(now_iso);
    let mut messages = normalize_stored_messages(payload.messages);
    let stored_updated_at = normalize_iso(&payload.updated_at).unwrap_or_else(now_iso);
    let updated_at = latest_chat_turn_iso(&messages, &stored_updated_at);
    let artifact_dir = result_artifacts_dir(app)?;
    externalize_large_card_data_in(&artifact_dir, &safe_chat_id, &mut messages)?;
    let normalized = ChatHistoryPayload {
        chat_id: safe_chat_id.clone(),
        name: normalize_chat_name(&payload.name),
        created_at,
        updated_at,
        messages,
        unread: payload.unread,
        active_build_plugin: payload.active_build_plugin,
    };
    write_chat_history_file(&path, &normalized)?;

    let row = ChatHistoryRow {
        chat_id: normalized.chat_id,
        name: normalized.name,
        created_at: normalized.created_at,
        updated_at: normalized.updated_at,
        message_count: normalized.messages.len(),
        unread: normalized.unread,
    };
    let history_dir = chat_history_dir(app)?;
    upsert_chat_history_index_in(&history_dir, row.clone())?;
    Ok(row)
}

fn write_chat_history_file(path: &Path, chat: &ChatHistoryPayload) -> Result<(), String> {
    let raw =
        serde_json::to_vec(chat).map_err(|error| format!("Could not serialize chat: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not save chat: {error}"))
}

#[tauri::command]
async fn read_result_artifact(
    app: tauri::AppHandle,
    chat_id: String,
    artifact_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = result_artifacts_dir(&app)?;
        let path = result_artifact_path_in(&root, &chat_id, &artifact_id)?;
        let raw = fs::read_to_string(path)
            .map_err(|error| format!("Could not read result artifact: {error}"))?;
        serde_json::from_str(&raw)
            .map_err(|error| format!("Could not parse result artifact: {error}"))
    })
    .await
    .map_err(|error| format!("Could not join result artifact task: {error}"))?
}

#[tauri::command]
fn append_agent_turn_log(app: tauri::AppHandle, event: AgentTurnLogEvent) -> Result<(), String> {
    let dir = agent_turn_log_dir(&app)?;
    ensure_dir(&dir)?;
    let safe_chat_id = normalize_chat_id(&event.chat_id);
    let event_type = event.event_type.trim();
    if event_type.is_empty() {
        return Err("eventType is required.".to_string());
    }
    let payload = json!({
        "chatId": safe_chat_id,
        "eventType": event_type,
        "timestamp": event.timestamp.unwrap_or_else(now_millis),
        "payload": event.payload
    });
    let raw = serde_json::to_string(&payload)
        .map_err(|error| format!("Could not serialize agent turn log event: {error}"))?;
    let path = dir.join(format!("{safe_chat_id}.jsonl"));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open agent turn log: {error}"))?;
    file.write_all(raw.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("Could not write agent turn log: {error}"))
}

/// Accepts only plain http(s) URLs. The platform opener treats a bare path as a
/// file and a leading `-` as a flag, so anything else is refused rather than
/// handed to it. No shell is involved, so there is no quoting to get wrong.
fn external_url_target(url: &str) -> Option<&str> {
    let trimmed = url.trim();
    if trimmed.starts_with('-') {
        return None;
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return None;
    }
    // Reject a bare scheme with no host.
    let rest = &trimmed[trimmed.find("//")? + 2..];
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some(trimmed)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open_url_in_browser(&url)
}

fn open_url_in_browser(url: &str) -> Result<(), String> {
    let target = external_url_target(url)
        .ok_or_else(|| "Refusing to open a link that is not a plain http(s) URL.".to_string())?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", target]);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link in a browser: {error}"))
}

#[tauri::command]
async fn delete_chat_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, BookmarkStoreState>,
    chat_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let safe_chat_id = normalize_chat_id(&chat_id);
        let _scheduled_guard = SCHEDULED_TASK_LOCK
            .lock()
            .map_err(|_| "Could not lock scheduled tasks.".to_string())?;
        let targeting =
            scheduled_tasks::tasks_targeting_chat(&scheduled_tasks_path(&app)?, &safe_chat_id)?;
        if !targeting.is_empty() {
            return Err(format!(
                "This chat is used by scheduled task{}: {}. Retarget or delete {} first.",
                if targeting.len() == 1 { "" } else { "s" },
                targeting.join(", "),
                if targeting.len() == 1 { "it" } else { "them" }
            ));
        }
        let path = chat_history_path(&app, &safe_chat_id)?;
        if path.is_file() {
            fs::remove_file(path).map_err(|error| format!("Could not delete chat: {error}"))?;
        }
        let artifact_dir = result_artifacts_dir(&app)?.join(&safe_chat_id);
        if artifact_dir.is_dir() {
            fs::remove_dir_all(artifact_dir)
                .map_err(|error| format!("Could not delete chat result artifacts: {error}"))?;
        }
        let bookmark_dir = bookmarks_dir(&app)?.join(&safe_chat_id);
        if bookmark_dir.is_dir() {
            fs::remove_dir_all(bookmark_dir)
                .map_err(|error| format!("Could not delete chat bookmarks: {error}"))?;
        }
        if let Ok(mut guard) = store.cache.lock() {
            if let Some(cache) = guard.as_mut() {
                remove_chat_bookmarks_from_cache(cache, &safe_chat_id);
            }
        }
        let history_dir = chat_history_dir(&app)?;
        remove_chat_history_index_row_in(&history_dir, &safe_chat_id)?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Could not join chat delete task: {error}"))?
}

#[tauri::command]
fn cancel_model_chat_stream(
    state: tauri::State<StreamCancelState>,
    stream_id: String,
) -> Result<(), String> {
    let stream_id = stream_id.trim();
    if stream_id.is_empty() {
        return Ok(());
    }
    state
        .canceled
        .lock()
        .map_err(|_| "Could not lock stream cancel state.".to_string())?
        .insert(stream_id.to_string());
    let process_id = state
        .process_ids
        .lock()
        .map_err(|_| "Could not lock stream process state.".to_string())?
        .get(stream_id)
        .copied();
    if let Some(process_id) = process_id {
        terminate_process(process_id);
    }
    Ok(())
}

#[tauri::command]
fn list_generated_plugins(app: tauri::AppHandle) -> Result<GeneratedPluginList, String> {
    let dir = generated_plugins_dir(&app)?;
    ensure_dir(&dir)?;
    ensure_shared_plugin_sdk(&dir)?;
    let entries =
        fs::read_dir(&dir).map_err(|error| format!("Could not read generated plugins: {error}"))?;
    let mut plugin_dirs = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read generated plugin entry: {error}"))?;
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        if plugin_dir.join("plugin.json").is_file() {
            plugin_dirs.push(plugin_dir);
        }
    }

    // Runtime tool discovery spawns Node per plugin; run them concurrently so a
    // cold load costs one Node startup, not one per plugin.
    let mut plugins: Vec<GeneratedPlugin> = std::thread::scope(|scope| {
        let handles: Vec<_> = plugin_dirs
            .iter()
            .map(|plugin_dir| {
                scope.spawn(move || {
                    let manifest_path = plugin_dir.join("plugin.json");
                    read_generated_plugin_manifest(plugin_dir, &manifest_path).map(|mut plugin| {
                        enrich_generated_plugin_tools_from_runtime(&mut plugin, plugin_dir);
                        annotate_plugin_credentials(&mut plugin);
                        plugin
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok().flatten())
            .collect()
    });

    plugins.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(GeneratedPluginList {
        folder: dir.to_string_lossy().to_string(),
        plugins,
    })
}

#[tauri::command]
fn list_catalog_extensions(app: tauri::AppHandle) -> Result<CatalogExtensionList, String> {
    let catalog_dir = catalog_extensions_dir(&app)?;
    let installed_dir = generated_plugins_dir(&app)?;
    ensure_dir(&installed_dir)?;
    let extensions = read_catalog_extensions(&catalog_dir, &installed_dir)?;
    Ok(CatalogExtensionList {
        folder: catalog_dir.to_string_lossy().to_string(),
        extensions,
    })
}

#[tauri::command]
fn install_catalog_extension(
    app: tauri::AppHandle,
    slug: String,
) -> Result<GeneratedPlugin, String> {
    let catalog_dir = catalog_extensions_dir(&app)?;
    let installed_dir = generated_plugins_dir(&app)?;
    ensure_dir(&installed_dir)?;
    ensure_shared_plugin_sdk(&installed_dir)?;

    // Resolve through the static catalog first so a caller cannot install an
    // unlisted directory even if it can guess a path under the resource root.
    let listed = read_catalog_extensions(&catalog_dir, &installed_dir)?;
    if !listed.iter().any(|extension| extension.slug == slug) {
        return Err(format!("Catalog extension not found: {}", slug.trim()));
    }

    let target_dir = install_catalog_extension_from(&catalog_dir, &installed_dir, &slug)?;
    let manifest_path = target_dir.join("plugin.json");
    let mut plugin = read_generated_plugin_manifest(&target_dir, &manifest_path)
        .ok_or_else(|| "The installed extension manifest could not be read.".to_string())?;
    enrich_generated_plugin_tools_from_runtime(&mut plugin, &target_dir);
    annotate_plugin_credentials(&mut plugin);
    Ok(plugin)
}

#[tauri::command]
fn update_catalog_extension(
    app: tauri::AppHandle,
    slug: String,
) -> Result<GeneratedPlugin, String> {
    let catalog_dir = catalog_extensions_dir(&app)?;
    let installed_dir = generated_plugins_dir(&app)?;
    ensure_dir(&installed_dir)?;
    ensure_shared_plugin_sdk(&installed_dir)?;

    // Resolve through the static catalog first, for the same reason installing
    // does: a caller must not reach a directory the catalog does not list.
    let listed = read_catalog_extensions(&catalog_dir, &installed_dir)?;
    let Some(extension) = listed.iter().find(|extension| extension.slug == slug) else {
        return Err(format!("Catalog extension not found: {}", slug.trim()));
    };
    if !extension.installed {
        return Err(format!("{} is not installed.", extension.name));
    }

    let target_dir = update_catalog_extension_from(&catalog_dir, &installed_dir, &slug)?;
    // Tool schemas and card previews are cached beside the extension; the stale
    // file describes the version that was just replaced.
    let _ = fs::remove_file(target_dir.join(".runtime-tools.json"));
    let manifest_path = target_dir.join("plugin.json");
    let mut plugin = read_generated_plugin_manifest(&target_dir, &manifest_path)
        .ok_or_else(|| "The updated extension manifest could not be read.".to_string())?;
    enrich_generated_plugin_tools_from_runtime(&mut plugin, &target_dir);
    annotate_plugin_credentials(&mut plugin);
    Ok(plugin)
}

#[tauri::command]
fn read_catalog_extension(
    app: tauri::AppHandle,
    slug: String,
) -> Result<CatalogExtensionDetail, String> {
    let catalog_dir = catalog_extensions_dir(&app)?;
    let installed_dir = generated_plugins_dir(&app)?;
    let mut result = read_catalog_extension_detail_from(&catalog_dir, &installed_dir, &slug)?;
    // Runtime discovery supplies the same schemas and card previews shown on
    // an installed extension's page, without executing any API request. Do not
    // use the installed-plugin cache here: bundled resources are read-only.
    if let Ok(tools) = read_generated_plugin_runtime_tools(&catalog_dir.join(&slug)) {
        if !tools.is_empty() {
            result.detail.plugin.tools = tools;
        }
    }
    Ok(result)
}

#[tauri::command]
fn read_generated_plugin(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<GeneratedPluginDetail, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let mut detail = read_plugin_detail_files(&plugin_dir)?;
    enrich_generated_plugin_tools_from_runtime(&mut detail.plugin, &plugin_dir);
    annotate_plugin_credentials(&mut detail.plugin);
    Ok(detail)
}

fn bounded_process_output(output: &std::process::Output) -> String {
    const LIMIT: usize = 4_000;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let trimmed = combined.trim();
    if trimmed.len() <= LIMIT {
        return trimmed.to_string();
    }
    let mut start = trimmed.len() - LIMIT;
    while !trimmed.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &trimmed[start..])
}

#[tauri::command]
fn prepare_extension_contribution(
    app: tauri::AppHandle,
    plugin_id: String,
    metadata: ContributionMetadata,
) -> Result<PreparedExtensionContribution, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let test_files = contribution_test_files(&plugin_dir)?;
    let output = Command::new(resolve_node_command())
        .arg("--test")
        .args(&test_files)
        .current_dir(&plugin_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not run extension tests: {error}"))?;
    if !output.status.success() {
        let details = bounded_process_output(&output);
        return Err(if details.is_empty() {
            format!("Extension tests failed with {}.", output.status)
        } else {
            format!("Extension tests failed.\n\n{details}")
        });
    }

    let tools = read_generated_plugin_runtime_tools(&plugin_dir)?
        .into_iter()
        .map(|tool| ContributionTool {
            name: tool.name,
            description: tool.description,
        })
        .collect();
    let output_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("extension-contributions");
    prepare_extension_contribution_in(&plugin_dir, &output_root, metadata, tools)
}

#[tauri::command]
fn open_extension_contribution_folder(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("extension-contributions");
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve contribution directory: {error}"))?;
    let folder = PathBuf::from(folder.trim())
        .canonicalize()
        .map_err(|error| format!("Could not resolve contribution folder: {error}"))?;
    if folder == root || !folder.starts_with(&root) || !folder.is_dir() {
        return Err("Only a prepared contribution folder can be opened.".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("Could not open contribution folder: {error}"))?;
    Ok(())
}

/// Mirrors `EXTENSION_NAME_MAX_LENGTH` in `src/extension-rename.ts`.
const PLUGIN_DISPLAY_NAME_MAX_LENGTH: usize = 64;

/// Collapses whitespace so two extensions cannot differ only by spacing, and so
/// a control character cannot smuggle a line break into a sidebar row.
fn normalize_plugin_display_name(raw: &str) -> String {
    raw.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Rewrites one extension's display `name` in its manifest, leaving every other
/// key and its authored order alone. Split out of the command so the rewrite and
/// its collision rules are testable without a `tauri::AppHandle`.
fn rename_generated_plugin_in(
    root: &Path,
    plugin_dir: &Path,
    raw_name: &str,
) -> Result<(), String> {
    let name = normalize_plugin_display_name(raw_name);
    if name.is_empty() {
        return Err("Enter a name for this extension.".to_string());
    }
    if name.chars().count() > PLUGIN_DISPLAY_NAME_MAX_LENGTH {
        return Err(format!(
            "Keep the name to {PLUGIN_DISPLAY_NAME_MAX_LENGTH} characters or fewer."
        ));
    }

    // resolve_generated_plugin_by_id accepts an id, a directory name, or a
    // case-insensitive display name, so a name colliding with any of those on
    // another extension makes every later lookup ambiguous rather than ugly.
    let lowered = name.to_lowercase();
    let entries =
        fs::read_dir(root).map_err(|error| format!("Could not read generated plugins: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read generated plugin entry: {error}"))?;
        let other_dir = entry.path();
        if !other_dir.is_dir() {
            continue;
        }
        if other_dir.canonicalize().ok().as_deref() == Some(plugin_dir) {
            continue;
        }
        let Some(other) =
            read_generated_plugin_manifest(&other_dir, &other_dir.join("plugin.json"))
        else {
            continue;
        };
        let dir_name = other_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if other.id.trim().to_lowercase() == lowered
            || other.name.trim().to_lowercase() == lowered
            || dir_name == lowered
        {
            return Err("Another extension already uses that name.".to_string());
        }
    }

    let manifest_path = plugin_dir.join("plugin.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read plugin manifest: {error}"))?;
    let mut manifest: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse plugin manifest: {error}"))?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "The extension manifest is not a JSON object.".to_string())?;
    object.insert("name".to_string(), Value::String(name));
    let serialized = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("Could not serialize plugin manifest: {error}"))?;
    fs::write(&manifest_path, format!("{serialized}\n"))
        .map_err(|error| format!("Could not write plugin manifest: {error}"))
}

/// Renames an extension's display name in its manifest. The directory slug is
/// deliberately untouched: it is what the agent routes on, what chats persist
/// as `activeBuildPlugin.dir`, and what plugin data and keychain accounts are
/// keyed by, so moving it would strand all three.
#[tauri::command]
fn rename_generated_plugin(
    app: tauri::AppHandle,
    plugin_id: String,
    name: String,
) -> Result<GeneratedPluginDetail, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let root = generated_plugins_dir(&app)?;
    rename_generated_plugin_in(&root, &plugin_dir, &name)?;

    let mut detail = read_plugin_detail_files(&plugin_dir)?;
    enrich_generated_plugin_tools_from_runtime(&mut detail.plugin, &plugin_dir);
    annotate_plugin_credentials(&mut detail.plugin);
    Ok(detail)
}

#[tauri::command]
fn delete_generated_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let plugin_root = generated_plugins_dir(&app)?;
    let data_dir = plugin_data_dir(&plugin_root, &plugin_dir)?;
    // Uninstalling has to take the secrets with it, or the keychain collects
    // orphaned entries no UI can reach.
    if let Some(plugin) =
        read_generated_plugin_manifest(&plugin_dir, &plugin_dir.join("plugin.json"))
    {
        for credential in &plugin.credentials {
            let _ = forget_plugin_credential(&plugin.id, &credential.key);
        }
    }
    if data_dir.exists() {
        fs::remove_dir_all(data_dir)
            .map_err(|error| format!("Could not delete plugin cache data: {error}"))?;
    }
    fs::remove_dir_all(plugin_dir).map_err(|error| format!("Could not delete plugin: {error}"))
}

#[tauri::command]
fn save_plugin_credential(
    app: tauri::AppHandle,
    plugin_id: String,
    key: String,
    value: String,
) -> Result<GeneratedPluginDetail, String> {
    let cleaned_value = value.trim();
    if cleaned_value.is_empty() {
        return Err("API key is required.".to_string());
    }
    let account = plugin_credential_account(&plugin_id, &key)?;
    write_keychain_account(&account, cleaned_value)
        .map_err(|error| format!("Could not store the API key in the OS keychain: {error}"))?;
    read_generated_plugin(app, plugin_id)
}

#[tauri::command]
fn delete_plugin_credential(
    app: tauri::AppHandle,
    plugin_id: String,
    key: String,
) -> Result<GeneratedPluginDetail, String> {
    forget_plugin_credential(&plugin_id, &key)?;
    read_generated_plugin(app, plugin_id)
}

#[tauri::command]
fn get_generated_plugin_cache_settings(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<PluginCacheSettings, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let plugin_root = generated_plugins_dir(&app)?;
    read_plugin_cache_settings(&plugin_data_dir(&plugin_root, &plugin_dir)?)
}

#[tauri::command]
fn save_generated_plugin_cache_settings(
    app: tauri::AppHandle,
    plugin_id: String,
    settings: PluginCacheSettings,
) -> Result<PluginCacheSettings, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let plugin_root = generated_plugins_dir(&app)?;
    let data_dir = plugin_data_dir(&plugin_root, &plugin_dir)?;
    save_plugin_cache_settings(&data_dir, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn clear_generated_plugin_cache(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let plugin_root = generated_plugins_dir(&app)?;
    clear_plugin_api_cache(&plugin_data_dir(&plugin_root, &plugin_dir)?)
}

#[tauri::command]
fn get_plugin_scaffold_status(
    app: tauri::AppHandle,
    name: String,
) -> Result<PluginScaffoldStatus, String> {
    let root = generated_plugins_dir(&app)?;
    ensure_dir(&root)?;
    ensure_shared_plugin_sdk(&root)?;
    let normalized_name = normalize_plugin_slug(&name);
    let plugin_dir = root.join(&normalized_name);
    let manifest_path = plugin_dir.join("plugin.json");
    let plugin = read_generated_plugin_manifest(&plugin_dir, &manifest_path);
    let status = plugin
        .as_ref()
        .map(|plugin| plugin.status.clone())
        .unwrap_or_default();
    let has_runtime_tools = plugin_dir.is_dir()
        && read_generated_plugin_runtime_tools(&plugin_dir)
            .map(|tools| !tools.is_empty())
            .unwrap_or(false);
    Ok(PluginScaffoldStatus {
        exists: plugin_dir.exists(),
        next_available_name: next_available_plugin_slug(&root, &normalized_name),
        normalized_name,
        has_runtime_tools,
        status,
    })
}

#[tauri::command]
fn scaffold_plugin_capability(
    app: tauri::AppHandle,
    request: PluginScaffoldRequest,
) -> Result<GeneratedPlugin, String> {
    let slug = normalize_plugin_slug(&request.name);
    let description = normalize_plugin_description(&request.description);

    let root = generated_plugins_dir(&app)?;
    ensure_dir(&root)?;
    ensure_shared_plugin_sdk(&root)?;
    let conflict_strategy = request
        .conflict_strategy
        .as_deref()
        .unwrap_or("error")
        .trim()
        .to_lowercase();
    // A fresh scaffold needs a description; editing an existing plugin does not.
    if description.is_empty() && conflict_strategy != "edit" {
        return Err("Plugin description is required.".to_string());
    }
    let slug = if conflict_strategy == "rename" {
        next_available_plugin_slug(&root, &slug)
    } else {
        slug
    };
    let target_dir = root.join(&slug);

    // Edit mode preserves all author files; reusable plumbing resolves through
    // the shared SDK installed above.
    if conflict_strategy == "edit" && target_dir.exists() {
        return read_generated_plugin_manifest(&target_dir, &target_dir.join("plugin.json"))
            .ok_or_else(|| "Plugin exists but could not be read for editing.".to_string());
    }

    if target_dir.exists() {
        if conflict_strategy == "replace" {
            fs::remove_dir_all(&target_dir)
                .map_err(|error| format!("Could not overwrite generated plugin: {error}"))?;
        } else if conflict_strategy != "rename" {
            return Err(format!("Generated plugin already exists: {slug}"));
        }
    }
    if target_dir.exists() {
        return Err(format!("Generated plugin already exists: {slug}"));
    }

    let temp_dir = root.join(format!(".tmp-{slug}-{}", now_millis()));
    ensure_dir(&temp_dir)?;
    let created_at = now_iso();
    let source_urls = normalize_source_urls(request.source_urls.unwrap_or_default());
    let manifest = build_plugin_manifest(&slug, &description, &created_at, &source_urls);
    let readme = build_plugin_readme(&slug, &description, &source_urls);

    let write_result = (|| -> Result<(), String> {
        fs::write(temp_dir.join("plugin.json"), format!("{manifest}\n"))
            .map_err(|error| format!("Could not write plugin manifest: {error}"))?;
        fs::write(temp_dir.join("tools.ts"), build_plugin_tools_stub())
            .map_err(|error| format!("Could not write plugin tools stub: {error}"))?;
        fs::write(temp_dir.join("README.md"), readme)
            .map_err(|error| format!("Could not write plugin README: {error}"))?;
        fs::rename(&temp_dir, &target_dir)
            .map_err(|error| format!("Could not install plugin scaffold: {error}"))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(error);
    }

    read_generated_plugin_manifest(&target_dir, &target_dir.join("plugin.json"))
        .ok_or_else(|| "Plugin scaffold was created but could not be read.".to_string())
}

#[tauri::command]
async fn execute_generated_plugin_tool(
    app: tauri::AppHandle,
    request: PluginToolRequest,
) -> Result<Value, String> {
    let plugin_root = generated_plugins_dir(&app)?;
    ensure_dir(&plugin_root)?;
    ensure_shared_plugin_sdk(&plugin_root)?;
    let tool_name = request.tool_name.trim();
    if tool_name.is_empty() {
        return Err("toolName is required.".to_string());
    }
    let plugin_dir = if let Some(plugin_dir) = request.plugin_dir.as_deref() {
        validate_generated_plugin_dir(&app, plugin_dir)?
    } else if let Some(plugin_id) = request.plugin_id.as_deref() {
        resolve_generated_plugin_by_id(&app, plugin_id)?
    } else {
        resolve_generated_plugin_by_tool(&app, tool_name)?
    };

    let runner_path = resolve_plugin_tool_runner_path()?;
    let credentials = read_generated_plugin_manifest(&plugin_dir, &plugin_dir.join("plugin.json"))
        .map(|plugin| {
            let mut values = serde_json::Map::new();
            for credential in &plugin.credentials {
                let value = read_plugin_credential(&plugin.id, &credential.key);
                if !value.is_empty() {
                    values.insert(credential.key.clone(), Value::String(value));
                }
            }
            Value::Object(values)
        })
        .unwrap_or_else(|| json!({}));
    let runner_request = json!({
        "pluginDir": plugin_dir.to_string_lossy().to_string(),
        "toolName": tool_name,
        "args": request.args,
        "credentials": credentials
    });

    let mut child = Command::new(resolve_node_command())
        .arg(runner_path)
        .current_dir(&plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start plugin tool runner: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let raw = serde_json::to_vec(&runner_request)
            .map_err(|error| format!("Could not serialize plugin tool request: {error}"))?;
        stdin
            .write_all(&raw)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("Could not send request to plugin tool runner: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read plugin tool output: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last_line = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .ok_or_else(|| "Plugin tool runner returned no output.".to_string())?;
    let payload: Value = serde_json::from_str(last_line)
        .map_err(|error| format!("Plugin tool runner returned invalid JSON: {error}"))?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Plugin tool failed.");
        return Err(error.to_string());
    }
    Ok(payload.get("result").cloned().unwrap_or_else(|| json!({})))
}

/// Last few lines the builder sidecar wrote to stderr, for appending to an
/// error the user would otherwise see with no explanation. Bounded because the
/// whole point is a readable message, not a transcript.
fn take_builder_stderr_tail(buffer: &Arc<Mutex<String>>) -> Option<String> {
    let captured = buffer.lock().ok()?;
    let tail = captured
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("; ");
    let tail = tail.trim();
    if tail.is_empty() {
        return None;
    }
    Some(tail.chars().take(400).collect())
}

#[tauri::command]
async fn run_plugin_builder_stream(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    stream_id: String,
    on_event: Channel<BuilderStreamEvent>,
    request: PluginBuilderRequest,
) -> Result<ChatReply, String> {
    let mut config = resolve_coding_model_config(Some(&app))?;
    if config.auth_method == AuthMethod::OAuth {
        config.api_key = resolve_provider_access_token(&config.provider).await?;
    } else if config.api_key.is_empty() {
        return Err("Save a model API key before running Build mode.".to_string());
    }

    let plugin_dir = validate_generated_plugin_dir(&app, &request.plugin_dir)?;
    let sidecar_path = resolve_plugin_builder_sidecar_path()?;
    let plugin_runner_path = resolve_plugin_tool_runner_path()?;
    let history: Vec<Value> = request
        .messages
        .unwrap_or_default()
        .iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let sidecar_request = json!({
        "pluginDir": plugin_dir.to_string_lossy().to_string(),
        "name": request.name,
        "description": request.description,
        "sourceUrls": normalize_source_urls(request.source_urls.unwrap_or_default()),
        "prompt": request.prompt,
        "taskKind": request.task_kind,
        "targetTools": request.target_tools.unwrap_or_default(),
        "editMode": request.edit_mode,
        "messages": history,
        "auth": request.auth,
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
        "apiKey": config.api_key,
        "pluginRunnerPath": plugin_runner_path.to_string_lossy().to_string()
    });

    let mut child = Command::new(resolve_node_command())
        .arg(sidecar_path)
        .current_dir(&plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start plugin builder sidecar: {error}"))?;
    register_stream_process(&cancel_state, &stream_id, child.id())?;

    // The sidecar writes its final diagnosis to stderr. Discarding it meant a
    // build that died on a provider error surfaced only whatever generic
    // failure was checked next. Drain it on a thread so a full pipe can never
    // block the child, and keep the tail for the error paths below.
    let builder_stderr = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sink = Arc::clone(&builder_stderr);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut buffer) = sink.lock() {
                    buffer.push_str(&line);
                    buffer.push('\n');
                }
            }
        });
    }

    if let Some(mut stdin) = child.stdin.take() {
        let raw = serde_json::to_vec(&sidecar_request)
            .map_err(|error| format!("Could not serialize builder request: {error}"))?;
        stdin
            .write_all(&raw)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("Could not send request to plugin builder: {error}"))?;
    }

    emit_builder_stream_event(
        &on_event,
        StreamEvent {
            stream_id: stream_id.clone(),
            event_type: "thinking_delta".to_string(),
            delta: Some("Starting plugin builder...\n".to_string()),
            text: None,
            error: None,
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
        },
    );

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Plugin builder stdout was unavailable.".to_string())?;
    let reader = BufReader::new(stdout);
    let mut answer = String::new();

    for line in reader.lines() {
        if is_stream_canceled(&cancel_state, &stream_id) {
            let _ = child.kill();
            clear_stream_canceled(&cancel_state, &stream_id);
            let content = if answer.trim().is_empty() {
                "Plugin builder stopped.".to_string()
            } else {
                answer
            };
            emit_builder_stream_event(
                &on_event,
                StreamEvent {
                    stream_id: stream_id.clone(),
                    event_type: "done".to_string(),
                    delta: None,
                    text: Some(content.clone()),
                    error: None,
                    provider: Some(config.provider.clone()),
                    model: Some(config.model.clone()),
                },
            );
            return Ok(ChatReply {
                content,
                provider: config.provider,
                model: config.model,
            });
        }

        let line = line.map_err(|error| format!("Plugin builder stream failed: {error}"))?;
        let Ok(payload) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "delta" => {
                let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() {
                    continue;
                }
                answer.push_str(delta);
                emit_builder_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "delta".to_string(),
                        delta: Some(delta.to_string()),
                        text: None,
                        error: None,
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                );
            }
            "thinking_delta" => {
                let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() {
                    continue;
                }
                emit_builder_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "thinking_delta".to_string(),
                        delta: Some(delta.to_string()),
                        text: None,
                        error: None,
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                );
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                let tool_call_id = payload
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let tool_name = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if tool_call_id.is_empty() || tool_name.is_empty() {
                    continue;
                }
                let event_type = event_type.to_string();
                let _ = on_event.send(BuilderStreamEvent {
                    base: StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type,
                        delta: None,
                        text: None,
                        error: None,
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                    tool_call_id: Some(tool_call_id),
                    tool_name: Some(tool_name),
                    args: payload.get("args").cloned(),
                    partial_result: payload.get("partialResult").cloned(),
                    result: payload.get("result").cloned(),
                    is_error: payload.get("isError").and_then(Value::as_bool),
                    retry: None,
                });
            }
            "retry" => {
                // The builder's own progress line, so the timeline says the model
                // stalled rather than going quiet for the length of the backoff.
                let _ = on_event.send(BuilderStreamEvent {
                    base: StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "retry".to_string(),
                        delta: None,
                        text: None,
                        error: payload
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                    tool_call_id: None,
                    tool_name: None,
                    args: None,
                    partial_result: None,
                    result: None,
                    is_error: None,
                    retry: Some(payload.clone()),
                });
            }
            "status" => {
                let tool_name = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or(event_type);
                let message = if tool_name.is_empty() {
                    status.to_string()
                } else {
                    format!("{status}: {tool_name}")
                };
                // Forwarded as its own event type rather than disguised as a
                // thinking_delta: these are host milestones, not model
                // reasoning, and folding them together put raw slugs like
                // "running_tests:tools.test.ts" inside the reasoning block and
                // into the persisted thinking field. Travels in the existing
                // `text` field, so BuilderStreamEvent is unchanged.
                emit_builder_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "status".to_string(),
                        delta: None,
                        text: Some(message),
                        error: None,
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                );
            }
            "done" => {
                let final_text = payload.get("text").and_then(Value::as_str).unwrap_or("");
                if answer.trim().is_empty() && !final_text.is_empty() {
                    answer = final_text.to_string();
                }
            }
            "error" => {
                let error = payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Plugin builder failed.")
                    .to_string();
                let _ = on_event.send(BuilderStreamEvent {
                    base: StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "error".to_string(),
                        delta: None,
                        text: None,
                        error: Some(error.clone()),
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                    tool_call_id: None,
                    tool_name: None,
                    args: None,
                    partial_result: None,
                    result: None,
                    is_error: None,
                    // Carries resumeAttempts, so the host can say the pass was
                    // retried rather than presenting a one-shot failure.
                    retry: Some(payload.clone()),
                });
                let _ = child.kill();
                clear_stream_canceled(&cancel_state, &stream_id);
                return Err(error);
            }
            _ => {}
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not read plugin builder exit status: {error}"))?;
    let was_canceled = is_stream_canceled(&cancel_state, &stream_id);
    clear_stream_canceled(&cancel_state, &stream_id);
    if was_canceled {
        let content = if answer.trim().is_empty() {
            "Plugin builder stopped.".to_string()
        } else {
            answer
        };
        emit_builder_stream_event(
            &on_event,
            StreamEvent {
                stream_id,
                event_type: "done".to_string(),
                delta: None,
                text: Some(content.clone()),
                error: None,
                provider: Some(config.provider.clone()),
                model: Some(config.model.clone()),
            },
        );
        return Ok(ChatReply {
            content,
            provider: config.provider,
            model: config.model,
        });
    }
    if !status.success() {
        // A non-zero exit with no error event on stdout means the sidecar died
        // before it could report; stderr is the only account of why.
        let detail = take_builder_stderr_tail(&builder_stderr);
        return Err(match detail {
            Some(detail) => format!("Plugin builder exited with {status}: {detail}"),
            None => format!("Plugin builder exited with {status}."),
        });
    }

    let content = if answer.trim().is_empty() {
        "Plugin builder completed.".to_string()
    } else {
        answer
    };
    emit_builder_stream_event(
        &on_event,
        StreamEvent {
            stream_id: stream_id.clone(),
            event_type: "done".to_string(),
            delta: None,
            text: Some(content.clone()),
            error: None,
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
        },
    );

    Ok(ChatReply {
        content,
        provider: config.provider,
        model: config.model,
    })
}

#[tauri::command]
fn list_model_providers(app: tauri::AppHandle) -> Result<ModelProviderList, String> {
    Ok(ModelProviderList {
        providers: provider_presets(&app)?,
    })
}

#[tauri::command]
fn save_provider_api_key(
    app: tauri::AppHandle,
    provider_id: String,
    api_key: String,
    role: Option<String>,
    model: Option<String>,
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    let Some(preset) = provider_preset(&provider_id) else {
        return Err(format!("Unsupported provider: {provider_id}"));
    };
    if preset.auth_method == AuthMethod::OAuth {
        return Err(format!(
            "{} is connected by signing in, not with an API key.",
            preset.name
        ));
    }

    let cleaned_key = api_key.trim();
    if cleaned_key.is_empty() {
        return Err("API key is required.".to_string());
    }

    write_provider_credential(
        &provider_id,
        &StoredCredential::ApiKey {
            key: cleaned_key.to_string(),
        },
    )?;

    save_role_model_config(
        &app,
        &role.unwrap_or_else(|| "chat".to_string()),
        &provider_id,
        model,
    )?;

    list_model_providers(app)
}

#[tauri::command]
fn set_active_provider(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<ModelProviderList, String> {
    set_active_model_provider(app, provider_id, "chat".to_string(), None)
}

#[tauri::command]
fn set_active_model_provider(
    app: tauri::AppHandle,
    provider_id: String,
    role: String,
    model: Option<String>,
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    let Some(preset) = provider_preset(&provider_id) else {
        return Err(format!("Unsupported provider: {provider_id}"));
    };

    if read_provider_credential(&provider_id).is_none() {
        return Err(match preset.auth_method {
            AuthMethod::ApiKey => "Save an API key for this provider first.".to_string(),
            AuthMethod::OAuth => format!("Sign in to {} first.", preset.name),
        });
    }

    save_role_model_config(&app, &role, &provider_id, model)?;

    list_model_providers(app)
}

/// The token endpoint behind one OAuth provider.
///
/// Only the refresh half lives in Rust. The login half needs a local callback
/// server and PKCE, which the Node sidecar already gets from pi.
struct OAuthEndpoints {
    token_url: &'static str,
    client_id: &'static str,
}

fn oauth_endpoints(provider_id: &str) -> Option<OAuthEndpoints> {
    match provider_id {
        "openai-codex" => Some(OAuthEndpoints {
            token_url: "https://auth.openai.com/oauth/token",
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }),
        _ => None,
    }
}

/// Refresh an access token this far before it expires.
///
/// A turn can outlive a token that was valid when it started, and the stream is
/// already mid-flight by then. Five minutes is what pi uses.
const OAUTH_REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

fn oauth_needs_refresh(expires: i64, now_ms: i64) -> bool {
    expires <= now_ms + OAUTH_REFRESH_MARGIN_MS
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// Serializes token refreshes across concurrent chats.
///
/// Refreshing rotates the refresh token, which invalidates the old one. Two
/// chats starting a turn at the same moment would otherwise both refresh, and
/// the loser would persist a token the server has already retired.
static OAUTH_REFRESH_LOCK: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> =
    std::sync::OnceLock::new();

fn oauth_refresh_lock() -> &'static tauri::async_runtime::Mutex<()> {
    OAUTH_REFRESH_LOCK.get_or_init(Default::default)
}

/// The access token to send for one OAuth provider, refreshing it if needed.
async fn resolve_provider_access_token(provider_id: &str) -> Result<String, String> {
    let signed_out = || {
        let name = provider_preset(provider_id)
            .map(|preset| preset.name.to_string())
            .unwrap_or_else(|| provider_id.to_string());
        format!("Sign in to {name} before running the agent.")
    };

    let Some(StoredCredential::OAuth {
        access, expires, ..
    }) = read_provider_credential(provider_id)
    else {
        return Err(signed_out());
    };
    if !oauth_needs_refresh(expires, now_ms()) {
        return Ok(access);
    }

    let _guard = oauth_refresh_lock().lock().await;

    // Re-read under the lock: another chat's turn may have just refreshed, in
    // which case our refresh token is already dead and this one is valid.
    let Some(StoredCredential::OAuth {
        access,
        refresh,
        expires,
        account_id,
    }) = read_provider_credential(provider_id)
    else {
        return Err(signed_out());
    };
    if !oauth_needs_refresh(expires, now_ms()) {
        return Ok(access);
    }

    let endpoints = oauth_endpoints(provider_id)
        .ok_or_else(|| format!("{provider_id} cannot be refreshed."))?;
    let response = reqwest::Client::new()
        .post(endpoints.token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", endpoints.client_id),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach the sign-in service: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        // 400 is the server saying this refresh token is gone for good. Any
        // other status — 429, 5xx, a captive portal — may well work next turn,
        // so the credential stays put.
        if status == reqwest::StatusCode::BAD_REQUEST {
            let _ = forget_provider_credential(provider_id);
            return Err(format!(
                "Your {} sign-in expired. Sign in again from /models.",
                provider_preset(provider_id)
                    .map(|preset| preset.name.to_string())
                    .unwrap_or_else(|| provider_id.to_string())
            ));
        }
        return Err(format!(
            "Could not refresh the sign-in ({}). Try again in a moment.",
            status.as_u16()
        ));
    }

    // Deliberately not quoting the body on failure: it carries the tokens.
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "The sign-in service returned an unreadable response.".to_string())?;
    let new_access = payload
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let new_refresh = payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or(refresh.as_str())
        .to_string();
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if new_access.is_empty() || expires_in <= 0 {
        return Err("The sign-in service returned an incomplete token.".to_string());
    }

    // Persisted before it is used: the old refresh token is dead either way, so
    // losing this write would lock the user out until they sign in again.
    write_provider_credential(
        provider_id,
        &StoredCredential::OAuth {
            access: new_access.clone(),
            refresh: new_refresh,
            expires: now_ms() + expires_in * 1000,
            account_id,
        },
    )?;
    Ok(new_access)
}

/// Live sign-in flows, so a pasted code can reach the sidecar's stdin.
#[derive(Default)]
struct OAuthLoginState {
    stdin: Mutex<HashMap<String, std::process::ChildStdin>>,
}

/// Live main-agent runs, so a message typed while the agent works can reach it.
#[derive(Default)]
struct AgentSteerState {
    stdin: Mutex<HashMap<String, std::process::ChildStdin>>,
}

/// Drops a run's stdin handle however `run_main_agent_stream` returns.
///
/// That command leaves through cancellation, a stream error, a non-zero exit,
/// or success. Hand-placing cleanup on each is how a dead sidecar's pipe ends up
/// parked in the map, making a later turn look steerable when it is gone.
struct SteerHandleGuard<'a> {
    state: &'a AgentSteerState,
    stream_id: String,
}

impl Drop for SteerHandleGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut handles) = self.state.stdin.lock() {
            handles.remove(&self.stream_id);
        }
    }
}

const STEER_RUN_ENDED: &str = "That turn is no longer running.";

/// Anything that is not an explicit follow-up steers.
fn steer_command_type(delivery: &str) -> &'static str {
    let delivery = delivery.trim();
    if delivery.eq_ignore_ascii_case("follow_up") || delivery.eq_ignore_ascii_case("followup") {
        "follow_up"
    } else {
        "steer"
    }
}

/// Hands a message typed mid-run to the working main agent.
///
/// The sidecar keeps reading stdin for the life of the turn, so this arrives as
/// a queued steering or follow-up message rather than as a new turn. Pi injects
/// a steering message at the next tool-round boundary; a follow-up waits until
/// the agent would otherwise stop.
#[tauri::command]
fn steer_main_agent_stream(
    steer_state: tauri::State<'_, AgentSteerState>,
    stream_id: String,
    text: String,
    delivery: String,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Type a message before sending it to the agent.".to_string());
    }
    let stream_id = stream_id.trim();
    if stream_id.is_empty() {
        return Err(STEER_RUN_ENDED.to_string());
    }
    let command_type = steer_command_type(&delivery);
    let mut handles = steer_state
        .stdin
        .lock()
        .map_err(|_| "Could not reach the running agent.".to_string())?;
    let stdin = handles
        .get_mut(stream_id)
        .ok_or_else(|| STEER_RUN_ENDED.to_string())?;
    let raw = serde_json::to_vec(&json!({ "type": command_type, "text": text }))
        .map_err(|error| format!("Could not serialize the message: {error}"))?;
    stdin
        .write_all(&raw)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Could not send the message to the agent: {error}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthLoginEvent {
    stream_id: String,
    event_type: String,
    url: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

/// Signs in to a provider and stores the credential.
///
/// Cancellation reuses `cancel_model_chat_stream`: the sidecar is registered
/// under `stream_id` like any other stream, and killing it releases the
/// callback port.
#[tauri::command]
async fn run_provider_oauth_login(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    login_state: tauri::State<'_, OAuthLoginState>,
    stream_id: String,
    on_event: Channel<OAuthLoginEvent>,
    provider_id: String,
    role: Option<String>,
    model: Option<String>,
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    let Some(preset) = provider_preset(&provider_id) else {
        return Err(format!("Unsupported provider: {provider_id}"));
    };
    if preset.auth_method != AuthMethod::OAuth {
        return Err(format!("{} uses an API key, not a sign-in.", preset.name));
    }

    let sidecar_path = resolve_oauth_login_sidecar_path()?;
    let mut child = Command::new(resolve_node_command())
        .arg(sidecar_path)
        .current_dir(
            env::current_dir()
                .map_err(|error| format!("Could not read current directory: {error}"))?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start the sign-in helper: {error}"))?;
    register_stream_process(&cancel_state, &stream_id, child.id())?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Sign-in helper stdin was unavailable.".to_string())?;
    let request = json!({ "provider": provider_id });
    let raw = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not serialize the sign-in request: {error}"))?;
    stdin
        .write_all(&raw)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Could not send the sign-in request: {error}"))?;
    if let Ok(mut handles) = login_state.stdin.lock() {
        handles.insert(stream_id.clone(), stdin);
    }

    let emit = |event_type: &str, url: Option<String>, message: Option<String>| {
        let _ = on_event.send(OAuthLoginEvent {
            stream_id: stream_id.clone(),
            event_type: event_type.to_string(),
            url,
            message,
            error: None,
        });
    };
    let finish = |login_state: &tauri::State<'_, OAuthLoginState>| {
        if let Ok(mut handles) = login_state.stdin.lock() {
            handles.remove(&stream_id);
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sign-in helper stdout was unavailable.".to_string())?;
    let mut credential: Option<StoredCredential> = None;
    let mut failure: Option<String> = None;

    for line in BufReader::new(stdout).lines() {
        if is_stream_canceled(&cancel_state, &stream_id) {
            let _ = child.kill();
            let _ = child.wait();
            clear_stream_canceled(&cancel_state, &stream_id);
            finish(&login_state);
            return Err("Sign-in canceled.".to_string());
        }
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "auth_url" => {
                let url = event
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // Opening it here rather than in the renderer keeps the URL on
                // the same allow-list as every other outbound link.
                if let Err(error) = open_url_in_browser(&url) {
                    emit("progress", None, Some(error));
                }
                emit("auth_url", Some(url), None);
            }
            "progress" => emit(
                "progress",
                None,
                Some(
                    event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                ),
            ),
            "done" => {
                let payload = event.get("credential").cloned().unwrap_or(Value::Null);
                credential = Some(StoredCredential::OAuth {
                    access: payload
                        .get("access")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    refresh: payload
                        .get("refresh")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    expires: payload
                        .get("expires")
                        .and_then(Value::as_i64)
                        .unwrap_or_default(),
                    account_id: payload
                        .get("accountId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
            "error" => {
                failure = Some(
                    event
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Sign-in failed.")
                        .to_string(),
                );
            }
            _ => {}
        }
    }

    let _ = child.wait();
    finish(&login_state);

    // A cancel that lands while the read above is blocked kills the helper
    // outright, so the loop ends at EOF rather than through the branch inside.
    if is_stream_canceled(&cancel_state, &stream_id) {
        clear_stream_canceled(&cancel_state, &stream_id);
        return Err("Sign-in canceled.".to_string());
    }
    if let Some(error) = failure {
        return Err(error);
    }
    let Some(credential) = credential else {
        return Err("Sign-in did not complete.".to_string());
    };
    let StoredCredential::OAuth {
        ref access,
        ref refresh,
        ..
    } = credential
    else {
        return Err("Sign-in returned an unexpected credential.".to_string());
    };
    if access.is_empty() || refresh.is_empty() {
        return Err("Sign-in returned an incomplete credential.".to_string());
    }

    write_provider_credential(&provider_id, &credential)?;
    save_role_model_config(
        &app,
        &role.unwrap_or_else(|| "chat".to_string()),
        &provider_id,
        model,
    )?;
    list_model_providers(app)
}

/// Hands a hand-pasted authorization code to a running sign-in.
///
/// Needed whenever pi's callback server cannot bind its port — most often
/// because the Codex CLI is already holding it.
#[tauri::command]
fn submit_provider_oauth_code(
    login_state: tauri::State<'_, OAuthLoginState>,
    stream_id: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("Paste the code from the browser first.".to_string());
    }
    let mut handles = login_state
        .stdin
        .lock()
        .map_err(|_| "Could not reach the sign-in helper.".to_string())?;
    let stdin = handles
        .get_mut(&stream_id)
        .ok_or_else(|| "That sign-in is no longer running.".to_string())?;
    let raw = serde_json::to_vec(&json!({ "type": "manual_code", "code": code }))
        .map_err(|error| format!("Could not serialize the code: {error}"))?;
    stdin
        .write_all(&raw)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Could not send the code to the sign-in helper: {error}"))
}

#[tauri::command]
fn sign_out_provider(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    if provider_preset(&provider_id).is_none() {
        return Err(format!("Unsupported provider: {provider_id}"));
    }
    forget_provider_credential(&provider_id)?;
    list_model_providers(app)
}

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatReply {
    content: String,
    provider: String,
    model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MainAgentReply {
    content: String,
    provider: String,
    model: String,
    build_request: Option<Value>,
    scheduled_task_request: Option<Value>,
    /// Structured terminal outcome such as an available-extension
    /// recommendation. Opaque JSON decoded defensively by the renderer.
    result: Option<Value>,
    /// The turn's summed token usage. Delivered on the reply rather than only on
    /// the stream channel because `startAgentTurn` ignores channel events that
    /// land after the promise settles, and this has to reach the saved message.
    usage: Option<Value>,
}

#[derive(Serialize, Clone)]
struct StreamEvent {
    stream_id: String,
    event_type: String,
    delta: Option<String>,
    text: Option<String>,
    error: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Serialize, Clone)]
struct BuilderStreamEvent {
    #[serde(flatten)]
    base: StreamEvent,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    args: Option<Value>,
    partial_result: Option<Value>,
    result: Option<Value>,
    is_error: Option<bool>,
    /// Sidecar `retry` payload, passed through untouched so the renderer can say
    /// which attempt is running and why.
    retry: Option<Value>,
}

#[derive(Serialize, Clone)]
struct MainAgentStreamEvent {
    stream_id: String,
    event_type: String,
    delta: Option<String>,
    text: Option<String>,
    error: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    tool_name: Option<String>,
    args: Option<Value>,
    result: Option<Value>,
    build_request: Option<Value>,
    scheduled_task_request: Option<Value>,
    /// Sidecar `retry` payload, passed through untouched so the renderer can say
    /// which attempt is running and why.
    retry: Option<Value>,
    /// Token usage for the whole turn, summed over its rounds by the sidecar and
    /// present only on `done`. The renderer persists it onto the assistant
    /// message so `/status` can report the conversation's context fill.
    usage: Option<Value>,
}

/// Accumulate live preview deltas, then replace them with the sidecar's
/// authoritative final assistant message when the turn completes.
fn apply_main_agent_text_event(
    answer: &mut String,
    event_type: &str,
    delta: Option<&str>,
    final_text: Option<&str>,
) {
    if event_type == "delta" {
        if let Some(value) = delta {
            answer.push_str(value);
        }
    }
    if event_type == "done" {
        if let Some(value) = final_text {
            // The deltas are a live activity preview spanning every Pi tool
            // round. `done.text` is deliberately only the final assistant
            // message and must win whenever the sidecar supplied it.
            if !value.trim().is_empty() || answer.trim().is_empty() {
                *answer = value.to_string();
            }
        }
    }
}

#[derive(Clone)]
struct ModelConfig {
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
    auth_method: AuthMethod,
}

/// How a provider proves who the user is.
///
/// `ApiKey` providers store a key the user pastes; `OAuth` providers store a
/// rotating token pair obtained by signing in, and have no key to paste.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AuthMethod {
    ApiKey,
    OAuth,
}

impl AuthMethod {
    fn as_str(self) -> &'static str {
        match self {
            AuthMethod::ApiKey => "api_key",
            AuthMethod::OAuth => "oauth",
        }
    }
}

#[derive(Clone)]
struct ProviderPreset {
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    default_chat_model: &'static str,
    default_coding_model: &'static str,
    api_key_names: &'static [&'static str],
    auth_method: AuthMethod,
    /// Where this provider hands out API keys. Shown as a link next to the key
    /// field so nobody has to go hunting for the right console page. Empty for
    /// providers that authenticate by signing in.
    api_key_url: &'static str,
}

#[tauri::command]
async fn run_model_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let config = resolve_model_config(Some(&app))?;
    if config.api_key.is_empty() {
        return Ok(ChatReply {
            content: "Hello world. Add MOONSHOT_API_KEY to .env to call Kimi through Moonshot."
                .to_string(),
            provider: config.provider,
            model: config.model,
        });
    }

    if config.provider == "claude" {
        return run_claude_chat(config, messages).await;
    }

    let upstream_messages = build_upstream_messages(messages)?;
    let payload = json!({
        "model": config.model,
        "messages": upstream_messages,
        "stream": false
    });

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to reach model API: {error}"))?;

    let status = response.status();
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("Model API returned invalid JSON: {error}"))?;

    if !status.is_success() {
        let message = data
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Model request failed.");
        return Err(format!("{message} ({status})"));
    }

    let content = data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(extract_chat_text)
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(ChatReply {
        content: if content.is_empty() {
            "The model returned an empty response.".to_string()
        } else {
            content
        },
        provider: config.provider,
        model: config.model,
    })
}

#[tauri::command]
async fn run_main_agent_stream(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    steer_state: tauri::State<'_, AgentSteerState>,
    stream_id: String,
    chat_id: Option<String>,
    on_event: Channel<MainAgentStreamEvent>,
    messages: Vec<ChatMessage>,
    mode: String,
    scheduled_execution: Option<bool>,
    scheduler_context: Option<Value>,
) -> Result<MainAgentReply, String> {
    let mut config = resolve_model_config(Some(&app))?;
    if config.auth_method == AuthMethod::OAuth {
        config.api_key = resolve_provider_access_token(&config.provider).await?;
    } else if config.api_key.is_empty() {
        return Err("Save a chat model API key before running the agent.".to_string());
    }

    let sidecar_path = resolve_main_agent_sidecar_path()?;
    let plugin_runner_path = resolve_plugin_tool_runner_path()?;
    let plugin_root = generated_plugins_dir(&app)?;
    ensure_dir(&plugin_root)?;
    ensure_shared_plugin_sdk(&plugin_root)?;
    let mut plugins = Vec::new();
    let mut installed_plugin_slugs = Vec::new();
    for entry in fs::read_dir(&plugin_root)
        .map_err(|error| format!("Could not read generated plugins: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read generated plugin entry: {error}"))?;
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let manifest_path = plugin_dir.join("plugin.json");
        let Some(mut plugin) = read_generated_plugin_manifest(&plugin_dir, &manifest_path) else {
            continue;
        };
        enrich_generated_plugin_tools_from_runtime(&mut plugin, &plugin_dir);
        let mut serialized = serde_json::to_value(&plugin)
            .map_err(|error| format!("Could not serialize generated plugin: {error}"))?;
        // Resolved secrets are attached here, never on GeneratedPlugin itself:
        // that struct is also what list_generated_plugins hands the renderer.
        attach_plugin_credential_values(&mut serialized, &plugin);
        plugins.push(serialized);
        installed_plugin_slugs.push(
            plugin_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        );
    }
    let catalog_dir = catalog_extensions_dir(&app)?;
    let available_extensions = read_catalog_extensions(&catalog_dir, &plugin_root)?
        .into_iter()
        .filter(|extension| !extension.installed)
        .collect::<Vec<_>>();
    let chats = load_or_rebuild_chat_history_index_in(&chat_history_dir(&app)?)?;
    // Recomputed fresh every turn, like `plugins` above: a memory edited or
    // deleted a moment ago must never be stale in the very next turn.
    let all_memories: Vec<StoredMemory> = load_memory_cache_in(&memories_dir(&app)?)?
        .by_id
        .into_values()
        .collect();
    let selected_memories =
        select_memories_for_turn(&all_memories, &installed_plugin_slugs, 10, 5, 20);
    let sidecar_request = json!({
        "messages": messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content }))
            .collect::<Vec<_>>(),
        "mode": if mode.trim().eq_ignore_ascii_case("build") { "build" } else { "explore" },
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
        "apiKey": config.api_key,
        "pluginRunnerPath": plugin_runner_path.to_string_lossy().to_string(),
        "plugins": plugins,
        "memories": selected_memories,
        // Kept out of the system prompt. The sidecar exposes this catalog only
        // after the model calls its on-demand missing-capability search tool.
        "availableExtensions": available_extensions,
        "scheduledExecution": scheduled_execution.unwrap_or(false),
        "schedulerContext": scheduler_context.unwrap_or_else(|| json!({ "timeZone": "UTC" })),
        "chats": chats.iter().take(100).map(|chat| json!({ "id": chat.chat_id, "name": chat.name })).collect::<Vec<_>>(),
        "currentChatId": chat_id
    });

    let mut child = Command::new(resolve_node_command())
        .arg(sidecar_path)
        .current_dir(
            env::current_dir()
                .map_err(|error| format!("Could not read current directory: {error}"))?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start main agent sidecar: {error}"))?;
    register_stream_process(&cancel_state, &stream_id, child.id())?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Main agent stdin was unavailable.".to_string())?;
    let raw = serde_json::to_vec(&sidecar_request)
        .map_err(|error| format!("Could not serialize main agent request: {error}"))?;
    stdin
        .write_all(&raw)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Could not send request to main agent: {error}"))?;
    // Deliberately NOT dropped here: the sidecar keeps reading this pipe, and it
    // is how a message typed mid-run reaches the agent. The guard below closes
    // it on every exit path.
    if let Ok(mut handles) = steer_state.stdin.lock() {
        handles.insert(stream_id.clone(), stdin);
    }
    let _steer_handle = SteerHandleGuard {
        state: &steer_state,
        stream_id: stream_id.clone(),
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Main agent stdout was unavailable.".to_string())?;
    let reader = BufReader::new(stdout);
    let mut answer = String::new();
    let mut build_request = None;
    let mut scheduled_task_request = None;
    let mut turn_result = None;
    let mut turn_usage: Option<Value> = None;
    let artifact_root = result_artifacts_dir(&app)?;
    let artifact_chat_id = chat_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_chat_id)
        .unwrap_or_else(|| normalize_chat_id(&stream_id));
    let mut result_artifact_index = 0usize;

    for line in reader.lines() {
        if is_stream_canceled(&cancel_state, &stream_id) {
            let _ = child.kill();
            clear_stream_canceled(&cancel_state, &stream_id);
            let content = if answer.trim().is_empty() {
                "Stopped.".to_string()
            } else {
                answer
            };
            let _ = on_event.send(MainAgentStreamEvent {
                stream_id: stream_id.clone(),
                event_type: "done".to_string(),
                delta: None,
                text: Some(content.clone()),
                error: None,
                provider: Some(config.provider.clone()),
                model: Some(config.model.clone()),
                tool_name: None,
                args: None,
                result: None,
                build_request: None,
                scheduled_task_request: None,
                retry: None,
                usage: None,
            });
            return Ok(MainAgentReply {
                content,
                provider: config.provider,
                model: config.model,
                build_request,
                scheduled_task_request,
                result: turn_result,
                usage: turn_usage,
            });
        }

        let line = line.map_err(|error| format!("Main agent stream failed: {error}"))?;
        let Ok(mut payload) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if event_type == "tool_result" {
            if let Some(result) = payload.get_mut("result") {
                let artifact_id =
                    format!("{}-{result_artifact_index}", normalize_chat_id(&stream_id));
                if externalize_result_data_in(
                    &artifact_root,
                    &artifact_chat_id,
                    &artifact_id,
                    result,
                )?
                .is_some()
                {
                    result_artifact_index += 1;
                }
            }
        }
        let delta = payload
            .get("delta")
            .and_then(Value::as_str)
            .map(str::to_string);
        apply_main_agent_text_event(
            &mut answer,
            &event_type,
            delta.as_deref(),
            payload.get("text").and_then(Value::as_str),
        );
        if event_type == "build_request" {
            build_request = payload.get("buildRequest").cloned();
        }
        if event_type == "scheduled_task_request" {
            scheduled_task_request = payload.get("scheduledTaskRequest").cloned();
        }
        if event_type == "done" {
            turn_result = payload.get("result").cloned();
        }
        // Both terminal events carry the turn's summed usage; a failed turn was
        // still billed for what it burned before it stopped. Recorded here
        // rather than after the loop so the `error` branch below, which returns
        // early, still counts against the all-time totals.
        if event_type == "done" || event_type == "error" {
            turn_usage = payload.get("usage").cloned();
            if let Some(usage) = turn_usage.as_ref() {
                // A failed totals write must never fail a completed turn.
                let _ = record_turn_usage(&app, &config.provider, &config.model, usage);
            }
        }
        if event_type == "error" {
            let error = payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Main agent failed.")
                .to_string();
            let _ = on_event.send(MainAgentStreamEvent {
                stream_id: stream_id.clone(),
                event_type: "error".to_string(),
                delta: None,
                text: None,
                error: Some(error.clone()),
                provider: Some(config.provider.clone()),
                model: Some(config.model.clone()),
                tool_name: None,
                args: None,
                result: None,
                build_request: None,
                scheduled_task_request: None,
                // Carries resumeAttempts, so the host can say the turn was
                // retried rather than presenting a one-shot failure.
                retry: Some(payload.clone()),
                usage: None,
            });
            let _ = child.kill();
            clear_stream_canceled(&cancel_state, &stream_id);
            return Err(error);
        }

        let _ = on_event.send(MainAgentStreamEvent {
            stream_id: stream_id.clone(),
            event_type: event_type.clone(),
            delta,
            text: payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            error: payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
            tool_name: payload
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::to_string),
            args: payload.get("args").cloned(),
            result: payload.get("result").cloned(),
            build_request: payload.get("buildRequest").cloned(),
            scheduled_task_request: payload.get("scheduledTaskRequest").cloned(),
            // `retry` events reach the channel through this generic relay; the
            // whole payload rides along so the renderer needs no new columns.
            retry: if event_type == "retry" {
                Some(payload.clone())
            } else {
                None
            },
            usage: turn_usage.clone(),
        });
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not read main agent exit status: {error}"))?;
    let was_canceled = is_stream_canceled(&cancel_state, &stream_id);
    clear_stream_canceled(&cancel_state, &stream_id);
    if was_canceled {
        let content = if answer.trim().is_empty() {
            "Stopped.".to_string()
        } else {
            answer
        };
        let _ = on_event.send(MainAgentStreamEvent {
            stream_id,
            event_type: "done".to_string(),
            delta: None,
            text: Some(content.clone()),
            error: None,
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
            tool_name: None,
            args: None,
            result: None,
            build_request: None,
            scheduled_task_request: None,
            retry: None,
            usage: None,
        });
        return Ok(MainAgentReply {
            content,
            provider: config.provider,
            model: config.model,
            build_request,
            scheduled_task_request,
            result: turn_result,
            usage: turn_usage,
        });
    }
    if !status.success() {
        return Err(format!("Main agent exited with {status}."));
    }

    Ok(MainAgentReply {
        content: answer,
        provider: config.provider,
        model: config.model,
        build_request,
        scheduled_task_request,
        result: turn_result,
        usage: turn_usage,
    })
}

#[tauri::command]
async fn run_model_chat_stream(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    stream_id: String,
    on_event: Channel<StreamEvent>,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let config = resolve_model_config(Some(&app))?;
    if config.api_key.is_empty() {
        let content = "Hello world. Add MOONSHOT_API_KEY to .env to stream Kimi through Moonshot."
            .to_string();
        emit_stream_event(
            &on_event,
            StreamEvent {
                stream_id: stream_id.clone(),
                event_type: "delta".to_string(),
                delta: Some(content.clone()),
                text: None,
                error: None,
                provider: Some(config.provider.clone()),
                model: Some(config.model.clone()),
            },
        );
        emit_stream_event(
            &on_event,
            StreamEvent {
                stream_id,
                event_type: "done".to_string(),
                delta: None,
                text: Some(content.clone()),
                error: None,
                provider: Some(config.provider.clone()),
                model: Some(config.model.clone()),
            },
        );
        return Ok(ChatReply {
            content,
            provider: config.provider,
            model: config.model,
        });
    }

    if config.provider == "claude" {
        return run_claude_chat_stream(config, cancel_state, stream_id, on_event, messages).await;
    }

    let upstream_messages = build_upstream_messages(messages)?;
    let payload = json!({
        "model": config.model,
        "messages": upstream_messages,
        "stream": true,
        "stream_options": {
            "include_usage": true
        }
    });

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to reach model API: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let message = data
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Model request failed.")
            .to_string();
        emit_stream_event(
            &on_event,
            StreamEvent {
                stream_id,
                event_type: "error".to_string(),
                delta: None,
                text: None,
                error: Some(format!("{message} ({status})")),
                provider: Some(config.provider),
                model: Some(config.model),
            },
        );
        return Err(format!("{message} ({status})"));
    }

    let mut answer = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(next) = stream.next().await {
        if is_stream_canceled(&cancel_state, &stream_id) {
            clear_stream_canceled(&cancel_state, &stream_id);
            let content = if answer.trim().is_empty() {
                "Stopped.".to_string()
            } else {
                answer
            };
            emit_stream_event(
                &on_event,
                StreamEvent {
                    stream_id,
                    event_type: "done".to_string(),
                    delta: None,
                    text: Some(content.clone()),
                    error: None,
                    provider: Some(config.provider.clone()),
                    model: Some(config.model.clone()),
                },
            );
            return Ok(ChatReply {
                content,
                provider: config.provider,
                model: config.model,
            });
        }
        let chunk = next.map_err(|error| format!("Model stream failed: {error}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));

        while let Some(index) = buffer.find("\n\n") {
            let raw_event = buffer[..index].to_string();
            buffer = buffer[index + 2..].to_string();
            if raw_event.trim().is_empty() {
                continue;
            }

            for line in raw_event.lines() {
                let Some(raw_data) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let raw_data = raw_data.trim();
                if raw_data.is_empty() || raw_data == "[DONE]" {
                    continue;
                }

                let Ok(payload) = serde_json::from_str::<Value>(raw_data) else {
                    continue;
                };

                if let Some(delta) = extract_stream_delta(&payload, "content") {
                    answer.push_str(delta);
                    emit_stream_event(
                        &on_event,
                        StreamEvent {
                            stream_id: stream_id.clone(),
                            event_type: "delta".to_string(),
                            delta: Some(delta.to_string()),
                            text: None,
                            error: None,
                            provider: Some(config.provider.clone()),
                            model: Some(config.model.clone()),
                        },
                    );
                }

                if let Some(delta) = extract_reasoning_delta(&payload) {
                    emit_stream_event(
                        &on_event,
                        StreamEvent {
                            stream_id: stream_id.clone(),
                            event_type: "thinking_delta".to_string(),
                            delta: Some(delta.to_string()),
                            text: None,
                            error: None,
                            provider: Some(config.provider.clone()),
                            model: Some(config.model.clone()),
                        },
                    );
                }
            }
        }
    }

    let content = if answer.trim().is_empty() {
        "The model returned an empty response.".to_string()
    } else {
        answer
    };

    emit_stream_event(
        &on_event,
        StreamEvent {
            stream_id: stream_id.clone(),
            event_type: "done".to_string(),
            delta: None,
            text: Some(content.clone()),
            error: None,
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
        },
    );
    clear_stream_canceled(&cancel_state, &stream_id);

    Ok(ChatReply {
        content,
        provider: config.provider,
        model: config.model,
    })
}

fn emit_stream_event(channel: &Channel<StreamEvent>, event: StreamEvent) {
    let _ = channel.send(event);
}

fn emit_builder_stream_event(channel: &Channel<BuilderStreamEvent>, event: StreamEvent) {
    let _ = channel.send(BuilderStreamEvent {
        base: event,
        tool_call_id: None,
        tool_name: None,
        args: None,
        partial_result: None,
        result: None,
        is_error: None,
        retry: None,
    });
}

fn is_stream_canceled(state: &tauri::State<'_, StreamCancelState>, stream_id: &str) -> bool {
    state
        .canceled
        .lock()
        .map(|canceled| canceled.contains(stream_id))
        .unwrap_or(false)
}

fn register_stream_process(
    state: &tauri::State<'_, StreamCancelState>,
    stream_id: &str,
    process_id: u32,
) -> Result<(), String> {
    state
        .process_ids
        .lock()
        .map_err(|_| "Could not lock stream process state.".to_string())?
        .insert(stream_id.to_string(), process_id);
    Ok(())
}

fn terminate_process(process_id: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(process_id.to_string())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .status();
    }
}

fn clear_stream_canceled(state: &tauri::State<'_, StreamCancelState>, stream_id: &str) {
    if let Ok(mut canceled) = state.canceled.lock() {
        canceled.remove(stream_id);
    }
    if let Ok(mut process_ids) = state.process_ids.lock() {
        process_ids.remove(stream_id);
    }
}

async fn run_claude_chat(
    config: ModelConfig,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let upstream_messages = build_anthropic_messages(messages)?;
    let payload = json!({
        "model": config.model,
        "max_tokens": 4096,
        "messages": upstream_messages
    });
    let url = format!("{}/messages", config.base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to reach Claude API: {error}"))?;

    let status = response.status();
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("Claude API returned invalid JSON: {error}"))?;

    if !status.is_success() {
        let message = data
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Claude request failed.");
        return Err(format!("{message} ({status})"));
    }

    let content = extract_anthropic_response_text(&data).trim().to_string();
    Ok(ChatReply {
        content: if content.is_empty() {
            "The model returned an empty response.".to_string()
        } else {
            content
        },
        provider: config.provider,
        model: config.model,
    })
}

async fn run_claude_chat_stream(
    config: ModelConfig,
    cancel_state: tauri::State<'_, StreamCancelState>,
    stream_id: String,
    on_event: Channel<StreamEvent>,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let upstream_messages = build_anthropic_messages(messages)?;
    let payload = json!({
        "model": config.model,
        "max_tokens": 4096,
        "messages": upstream_messages,
        "stream": true
    });
    let url = format!("{}/messages", config.base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Failed to reach Claude API: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let message = data
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Claude request failed.")
            .to_string();
        return Err(format!("{message} ({status})"));
    }

    let mut answer = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(next) = stream.next().await {
        if is_stream_canceled(&cancel_state, &stream_id) {
            clear_stream_canceled(&cancel_state, &stream_id);
            let content = if answer.trim().is_empty() {
                "Stopped.".to_string()
            } else {
                answer
            };
            emit_stream_event(
                &on_event,
                StreamEvent {
                    stream_id,
                    event_type: "done".to_string(),
                    delta: None,
                    text: Some(content.clone()),
                    error: None,
                    provider: Some(config.provider.clone()),
                    model: Some(config.model.clone()),
                },
            );
            return Ok(ChatReply {
                content,
                provider: config.provider,
                model: config.model,
            });
        }
        let chunk = next.map_err(|error| format!("Claude stream failed: {error}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));

        while let Some(index) = buffer.find("\n\n") {
            let raw_event = buffer[..index].to_string();
            buffer = buffer[index + 2..].to_string();
            for line in raw_event.lines() {
                let Some(raw_data) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let raw_data = raw_data.trim();
                if raw_data.is_empty() {
                    continue;
                }
                let Ok(payload) = serde_json::from_str::<Value>(raw_data) else {
                    continue;
                };
                let delta = payload
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if delta.is_empty() {
                    continue;
                }
                answer.push_str(delta);
                emit_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "delta".to_string(),
                        delta: Some(delta.to_string()),
                        text: None,
                        error: None,
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                );
            }
        }
    }

    let content = if answer.trim().is_empty() {
        "The model returned an empty response.".to_string()
    } else {
        answer
    };
    emit_stream_event(
        &on_event,
        StreamEvent {
            stream_id: stream_id.clone(),
            event_type: "done".to_string(),
            delta: None,
            text: Some(content.clone()),
            error: None,
            provider: Some(config.provider.clone()),
            model: Some(config.model.clone()),
        },
    );
    clear_stream_canceled(&cancel_state, &stream_id);

    Ok(ChatReply {
        content,
        provider: config.provider,
        model: config.model,
    })
}

fn build_upstream_messages(messages: Vec<ChatMessage>) -> Result<Vec<Value>, String> {
    let upstream_messages: Vec<Value> = messages
        .into_iter()
        .filter_map(|message| {
            let role = match message.role.trim() {
                "assistant" => "assistant",
                "system" => "system",
                _ => "user",
            };
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(json!({ "role": role, "content": content }))
        })
        .collect();

    if upstream_messages.is_empty() {
        return Err("Message content is required.".to_string());
    }

    Ok(upstream_messages)
}

fn build_anthropic_messages(messages: Vec<ChatMessage>) -> Result<Vec<Value>, String> {
    let upstream_messages: Vec<Value> = messages
        .into_iter()
        .filter_map(|message| {
            let role = match message.role.trim() {
                "assistant" => "assistant",
                "system" => return None,
                _ => "user",
            };
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(json!({ "role": role, "content": content }))
        })
        .collect();

    if upstream_messages.is_empty() {
        return Err("Message content is required.".to_string());
    }

    Ok(upstream_messages)
}

fn extract_anthropic_response_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_stream_delta<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get(key))
        .and_then(extract_chat_text)
        .filter(|text| !text.is_empty())
}

fn extract_reasoning_delta(payload: &Value) -> Option<&str> {
    extract_stream_delta(payload, "reasoning_content")
        .or_else(|| extract_stream_delta(payload, "reasoningContent"))
        .or_else(|| extract_stream_delta(payload, "reasoning"))
        .or_else(|| extract_stream_delta(payload, "thinking"))
}

fn extract_chat_text(value: &Value) -> Option<&str> {
    if let Some(text) = value.as_str() {
        return Some(text);
    }
    value.as_array()?.iter().find_map(|part| {
        part.get("text")
            .and_then(Value::as_str)
            .or_else(|| part.get("content").and_then(Value::as_str))
    })
}

fn find_env_file() -> Option<PathBuf> {
    let current = env::current_dir().ok()?;
    let candidates = [
        current.join(".env"),
        current.join("..").join(".env"),
        current.join("..").join("..").join(".env"),
    ];

    candidates.into_iter().find(|path| path.is_file())
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("Could not create directory: {error}"))
}

fn chat_history_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("chat-history"))
}

fn chat_history_index_path_in(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn sort_chat_history_rows(chats: &mut [ChatHistoryRow]) {
    chats.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
}

fn write_chat_history_index_in(dir: &Path, chats: &[ChatHistoryRow]) -> Result<(), String> {
    ensure_dir(dir)?;
    let payload = ChatHistoryIndex {
        version: CHAT_HISTORY_INDEX_VERSION,
        chats: chats.to_vec(),
    };
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not serialize chat history index: {error}"))?;
    fs::write(chat_history_index_path_in(dir), raw)
        .map_err(|error| format!("Could not save chat history index: {error}"))
}

fn read_chat_history_index_in(dir: &Path) -> Option<Vec<ChatHistoryRow>> {
    let raw = fs::read_to_string(chat_history_index_path_in(dir)).ok()?;
    let mut index = serde_json::from_str::<ChatHistoryIndex>(&raw).ok()?;
    if index.version != CHAT_HISTORY_INDEX_VERSION {
        return None;
    }
    sort_chat_history_rows(&mut index.chats);
    Some(index.chats)
}

fn rebuild_chat_history_index_in(dir: &Path) -> Result<Vec<ChatHistoryRow>, String> {
    ensure_dir(dir)?;
    let mut chats = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|error| format!("Could not read chat history: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read chat history entry: {error}"))?;
        let path = entry.path();
        if !path.is_file()
            || path.file_name().and_then(|value| value.to_str()) == Some("index.json")
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let chat_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(normalize_chat_id)
            .unwrap_or_else(|| format!("chat-{}", now_millis()));
        let metadata = fs::metadata(&path).ok();
        let fallback_time = metadata
            .and_then(|meta| meta.modified().ok())
            .and_then(system_time_to_iso)
            .unwrap_or_else(now_iso);
        let parsed = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ChatHistoryPayload>(&raw).ok());
        let row = if let Some(chat) = parsed {
            let messages = normalize_stored_messages(chat.messages);
            let stored_updated_at =
                normalize_iso(&chat.updated_at).unwrap_or_else(|| fallback_time.clone());
            ChatHistoryRow {
                chat_id,
                name: normalize_chat_name(&chat.name),
                created_at: normalize_iso(&chat.created_at)
                    .unwrap_or_else(|| fallback_time.clone()),
                updated_at: latest_chat_turn_iso(&messages, &stored_updated_at),
                message_count: messages.len(),
                unread: chat.unread,
            }
        } else {
            ChatHistoryRow {
                chat_id,
                name: "Untitled chat".to_string(),
                created_at: fallback_time.clone(),
                updated_at: fallback_time,
                message_count: 0,
                unread: false,
            }
        };
        chats.push(row);
    }
    sort_chat_history_rows(&mut chats);
    write_chat_history_index_in(dir, &chats)?;
    Ok(chats)
}

fn load_or_rebuild_chat_history_index_unlocked(dir: &Path) -> Result<Vec<ChatHistoryRow>, String> {
    if let Some(chats) = read_chat_history_index_in(dir) {
        return Ok(chats);
    }
    rebuild_chat_history_index_in(dir)
}

fn load_or_rebuild_chat_history_index_in(dir: &Path) -> Result<Vec<ChatHistoryRow>, String> {
    let _guard = CHAT_HISTORY_INDEX_LOCK
        .lock()
        .map_err(|_| "Could not lock chat history index.".to_string())?;
    load_or_rebuild_chat_history_index_unlocked(dir)
}

fn upsert_chat_history_index_in(dir: &Path, row: ChatHistoryRow) -> Result<(), String> {
    let _guard = CHAT_HISTORY_INDEX_LOCK
        .lock()
        .map_err(|_| "Could not lock chat history index.".to_string())?;
    let mut chats = load_or_rebuild_chat_history_index_unlocked(dir)?;
    if let Some(existing) = chats.iter_mut().find(|chat| chat.chat_id == row.chat_id) {
        *existing = row;
    } else {
        chats.push(row);
    }
    sort_chat_history_rows(&mut chats);
    write_chat_history_index_in(dir, &chats)
}

fn set_chat_history_unread_in(
    dir: &Path,
    chat_id: &str,
    unread: bool,
) -> Result<ChatHistoryRow, String> {
    let safe_chat_id = normalize_chat_id(chat_id);
    let path = dir.join(format!("{safe_chat_id}.json"));
    if !path.is_file() {
        return Err(format!("Chat not found: {safe_chat_id}"));
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("Could not read chat: {error}"))?;
    let mut chat: ChatHistoryPayload =
        serde_json::from_str(&raw).map_err(|error| format!("Could not parse chat: {error}"))?;
    chat.chat_id = safe_chat_id;
    chat.unread = unread;
    let messages = normalize_stored_messages(chat.messages.clone());
    let stored_updated_at = normalize_iso(&chat.updated_at).unwrap_or_else(now_iso);
    chat.updated_at = latest_chat_turn_iso(&messages, &stored_updated_at);
    write_chat_history_file(&path, &chat)?;

    let row = ChatHistoryRow {
        chat_id: chat.chat_id,
        name: normalize_chat_name(&chat.name),
        created_at: normalize_iso(&chat.created_at).unwrap_or_else(now_iso),
        updated_at: chat.updated_at,
        message_count: messages.len(),
        unread,
    };
    upsert_chat_history_index_in(dir, row.clone())?;
    Ok(row)
}

fn remove_chat_history_index_row_in(dir: &Path, chat_id: &str) -> Result<(), String> {
    let _guard = CHAT_HISTORY_INDEX_LOCK
        .lock()
        .map_err(|_| "Could not lock chat history index.".to_string())?;
    let mut chats = load_or_rebuild_chat_history_index_unlocked(dir)?;
    let safe_chat_id = normalize_chat_id(chat_id);
    chats.retain(|chat| chat.chat_id != safe_chat_id);
    write_chat_history_index_in(dir, &chats)
}

fn bookmarks_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("bookmarks"))
}

fn memories_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("memories"))
}

/// Same FNV-1a used by the renderer's bookmark slugs (`src/bookmarks.ts`), so a
/// memory id is deterministic given its content and capture time rather than
/// needing a new random-id dependency.
fn stable_text_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:x}")
}

fn generate_memory_id(content: &str) -> String {
    format!("mem-{}-{}", now_millis(), stable_text_hash(content))
}

fn normalize_memory_scope(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() {
        "global"
    } else {
        trimmed
    };
    if value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Memory scope is invalid.".to_string());
    }
    Ok(value.to_string())
}

fn normalize_memory_id(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Memory id is invalid.".to_string());
    }
    Ok(value.to_string())
}

/// Validates and fills in a memory before it is written: a non-empty `id` is
/// treated as an edit to that entry, an empty one mints a new id (so
/// create and edit share one upsert-by-id path, like `save_bookmark`).
fn normalize_memory(mut memory: StoredMemory) -> Result<StoredMemory, String> {
    memory.content = memory.content.trim().to_string();
    if memory.content.is_empty() {
        return Err("A memory requires non-empty content.".to_string());
    }
    memory.scope = normalize_memory_scope(&memory.scope)?;
    memory.scope_label = memory.scope_label.trim().to_string();
    let now = now_millis();
    memory.id = if memory.id.trim().is_empty() {
        memory.created_at = now;
        generate_memory_id(&memory.content)
    } else {
        let id = normalize_memory_id(&memory.id)?;
        if memory.created_at <= 0 {
            memory.created_at = now;
        }
        id
    };
    memory.updated_at = now;
    Ok(memory)
}

fn memory_path_in(root: &Path, scope: &str, id: &str) -> PathBuf {
    root.join(scope).join(format!("{id}.json"))
}

fn write_memory_in(root: &Path, memory: &StoredMemory) -> Result<(), String> {
    let scope_dir = root.join(&memory.scope);
    ensure_dir(&scope_dir)?;
    let path = memory_path_in(root, &memory.scope, &memory.id);
    let raw = serde_json::to_vec(memory)
        .map_err(|error| format!("Could not serialize memory: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not save memory: {error}"))
}

fn load_memory_cache_in(root: &Path) -> Result<MemoryCache, String> {
    ensure_dir(root)?;
    let mut cache = MemoryCache::default();
    let scope_dirs =
        fs::read_dir(root).map_err(|error| format!("Could not read memories: {error}"))?;
    for scope_dir in scope_dirs.flatten() {
        let path = scope_dir.path();
        if !path.is_dir() {
            continue;
        }
        let entries =
            fs::read_dir(&path).map_err(|error| format!("Could not read memory scope: {error}"))?;
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&entry_path) else {
                continue;
            };
            let Ok(memory) = serde_json::from_str::<StoredMemory>(&raw) else {
                continue;
            };
            cache.by_id.insert(memory.id.clone(), memory);
        }
    }
    Ok(cache)
}

/// Selects which memories are worth a turn's system-prompt space: a capped set
/// of global entries plus a capped-per-plugin, capped-in-total set scoped to
/// plugins that are actually installed right now, both newest-edited first.
/// A memory scoped to a since-removed plugin is naturally excluded — no
/// explicit cleanup needed.
fn select_memories_for_turn(
    all: &[StoredMemory],
    active_plugin_slugs: &[String],
    global_cap: usize,
    per_plugin_cap: usize,
    plugin_total_cap: usize,
) -> Vec<StoredMemory> {
    let mut global: Vec<&StoredMemory> = all
        .iter()
        .filter(|memory| memory.scope == "global")
        .collect();
    global.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    global.truncate(global_cap);

    let mut plugin_selected: Vec<&StoredMemory> = Vec::new();
    for slug in active_plugin_slugs {
        let mut scoped: Vec<&StoredMemory> =
            all.iter().filter(|memory| &memory.scope == slug).collect();
        scoped.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        scoped.truncate(per_plugin_cap);
        plugin_selected.extend(scoped);
    }
    plugin_selected.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    plugin_selected.truncate(plugin_total_cap);

    global.into_iter().chain(plugin_selected).cloned().collect()
}

/// Model-written titles, kept alive after the bookmark that produced them.
///
/// Naming costs a model call, so bookmarking, unbookmarking, and bookmarking the
/// same answer again must not pay for it three times. The cache is keyed by the
/// bookmark locator and outlives the bookmark file itself, which is the whole
/// point: the second bookmark of an answer is named instantly and for free.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct BookmarkTitleEntry {
    title: String,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct BookmarkTitleCache {
    #[serde(default)]
    titles: BTreeMap<String, BookmarkTitleEntry>,
}

/// Titles live beside the per-chat bookmark directories. `load_bookmark_cache_in`
/// descends only into directories, so this file is invisible to it.
fn bookmark_titles_path(root: &Path) -> PathBuf {
    root.join("titles.json")
}

/// A cache miss is never an error: an unreadable or half-written cache should
/// cost a model call, not the bookmark.
fn read_bookmark_titles_in(root: &Path) -> BookmarkTitleCache {
    fs::read_to_string(bookmark_titles_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<BookmarkTitleCache>(&raw).ok())
        .unwrap_or_default()
}

/// Newest titles to keep. Bookmarks are re-opened for a long time, so this is
/// generous; it exists only to stop the file growing without bound.
const BOOKMARK_TITLE_CACHE_LIMIT: usize = 2000;

fn write_bookmark_title_in(root: &Path, locator: &str, title: &str) -> Result<(), String> {
    ensure_dir(root)?;
    let mut cache = read_bookmark_titles_in(root);
    cache.titles.insert(
        locator.to_string(),
        BookmarkTitleEntry {
            title: title.to_string(),
            updated_at: now_millis(),
        },
    );
    if cache.titles.len() > BOOKMARK_TITLE_CACHE_LIMIT {
        let mut entries = cache.titles.into_iter().collect::<Vec<_>>();
        entries.sort_by(|left, right| right.1.updated_at.cmp(&left.1.updated_at));
        entries.truncate(BOOKMARK_TITLE_CACHE_LIMIT);
        cache = BookmarkTitleCache {
            titles: entries.into_iter().collect(),
        };
    }
    let raw = serde_json::to_vec(&cache)
        .map_err(|error| format!("Could not serialize bookmark titles: {error}"))?;
    fs::write(bookmark_titles_path(root), raw)
        .map_err(|error| format!("Could not save bookmark titles: {error}"))
}

fn read_cached_bookmark_title(root: &Path, locator: &str) -> Option<String> {
    read_bookmark_titles_in(root)
        .titles
        .get(locator)
        .map(|entry| normalize_bookmark_title(&entry.title))
        .filter(|title| !title.is_empty())
}

fn normalize_bookmark_key(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Bookmark message key is invalid.".to_string());
    }
    Ok(value.to_string())
}

fn normalize_bookmark(mut bookmark: StoredBookmark) -> Result<StoredBookmark, String> {
    if bookmark.chat_id.trim().is_empty() || bookmark.message_timestamp <= 0 {
        return Err("Bookmark source identity is required.".to_string());
    }
    bookmark.chat_id = normalize_chat_id(&bookmark.chat_id);
    bookmark.message_key = normalize_bookmark_key(&bookmark.message_key)?;
    bookmark.id = format!("{}:{}", bookmark.chat_id, bookmark.message_key);
    bookmark.chat_name = normalize_chat_name(&bookmark.chat_name);
    // A title is optional: naming is a convenience, and a bookmark whose title
    // could not be generated still has to save.
    bookmark.title = normalize_bookmark_title(&bookmark.title);
    bookmark.prompt = bookmark.prompt.trim().to_string();
    bookmark.answer = bookmark.answer.trim().to_string();
    bookmark.created_at = if bookmark.created_at > 0 {
        bookmark.created_at
    } else {
        now_millis()
    };
    if bookmark.prompt.is_empty() || bookmark.answer.is_empty() {
        return Err("A bookmark requires both a prompt and an answer.".to_string());
    }
    Ok(bookmark)
}

fn bookmark_locator(chat_id: &str, message_key: &str) -> String {
    format!("{chat_id}:{message_key}")
}

fn bookmark_sort_key(bookmark: &StoredBookmark) -> String {
    let reverse_time = u64::MAX - bookmark.created_at.max(0) as u64;
    format!("{reverse_time:020}-{}", bookmark.id)
}

fn bookmark_path_in(root: &Path, chat_id: &str, message_key: &str) -> PathBuf {
    root.join(chat_id).join(format!("{message_key}.json"))
}

fn write_bookmark_in(root: &Path, bookmark: &StoredBookmark) -> Result<(), String> {
    let chat_dir = root.join(&bookmark.chat_id);
    ensure_dir(&chat_dir)?;
    let path = bookmark_path_in(root, &bookmark.chat_id, &bookmark.message_key);
    let raw = serde_json::to_vec(bookmark)
        .map_err(|error| format!("Could not serialize bookmark: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not save bookmark: {error}"))
}

fn read_chat_bookmarks_in(root: &Path, chat_id: &str) -> Result<Vec<StoredBookmark>, String> {
    if chat_id.trim().is_empty() {
        return Ok(Vec::new());
    }
    let safe_chat_id = normalize_chat_id(chat_id);
    let dir = root.join(&safe_chat_id);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut bookmarks = Vec::new();
    let entries =
        fs::read_dir(&dir).map_err(|error| format!("Could not read chat bookmarks: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(bookmark) = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoredBookmark>(&raw).ok())
            .and_then(|bookmark| normalize_bookmark(bookmark).ok())
        else {
            continue;
        };
        if bookmark.chat_id == safe_chat_id {
            bookmarks.push(bookmark);
        }
    }
    bookmarks.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(bookmarks)
}

fn load_bookmark_cache_in(root: &Path) -> Result<BookmarkCache, String> {
    ensure_dir(root)?;
    let mut cache = BookmarkCache::default();
    let chat_dirs =
        fs::read_dir(root).map_err(|error| format!("Could not read bookmarks: {error}"))?;
    for chat_dir in chat_dirs.flatten() {
        if !chat_dir.path().is_dir() {
            continue;
        }
        let chat_id = chat_dir.file_name().to_string_lossy().to_string();
        for bookmark in read_chat_bookmarks_in(root, &chat_id)? {
            upsert_bookmark_cache(&mut cache, bookmark);
        }
    }
    Ok(cache)
}

fn upsert_bookmark_cache(cache: &mut BookmarkCache, bookmark: StoredBookmark) {
    let locator = bookmark_locator(&bookmark.chat_id, &bookmark.message_key);
    if let Some(previous_sort_key) = cache.locators.remove(&locator) {
        cache.ordered.remove(&previous_sort_key);
    }
    let sort_key = bookmark_sort_key(&bookmark);
    cache.locators.insert(locator, sort_key.clone());
    cache.ordered.insert(sort_key, bookmark);
}

fn remove_bookmark_cache(cache: &mut BookmarkCache, chat_id: &str, message_key: &str) {
    let locator = bookmark_locator(chat_id, message_key);
    if let Some(sort_key) = cache.locators.remove(&locator) {
        cache.ordered.remove(&sort_key);
    }
}

fn remove_chat_bookmarks_from_cache(cache: &mut BookmarkCache, chat_id: &str) {
    let locators = cache
        .locators
        .keys()
        .filter(|locator| locator.starts_with(&format!("{chat_id}:")))
        .cloned()
        .collect::<Vec<_>>();
    for locator in locators {
        if let Some(sort_key) = cache.locators.remove(&locator) {
            cache.ordered.remove(&sort_key);
        }
    }
}

fn bookmark_page(cache: &BookmarkCache, offset: usize, limit: usize) -> BookmarkList {
    let limit = limit.clamp(1, 100);
    BookmarkList {
        bookmarks: cache
            .ordered
            .values()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect(),
        total: cache.ordered.len(),
    }
}

fn chat_history_path(app: &tauri::AppHandle, chat_id: &str) -> Result<PathBuf, String> {
    let dir = chat_history_dir(app)?;
    let safe_chat_id = normalize_chat_id(chat_id);
    let path = dir.join(format!("{safe_chat_id}.json"));
    let resolved_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let resolved_parent = path
        .parent()
        .unwrap_or(&dir)
        .canonicalize()
        .unwrap_or_else(|_| dir.clone());
    if resolved_parent != resolved_dir {
        return Err("Chat path is invalid.".to_string());
    }
    Ok(path)
}

fn agent_turn_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("agent-turn-logs"))
}

fn result_artifacts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("result-artifacts"))
}

fn result_artifact_path_in(
    root: &Path,
    chat_id: &str,
    artifact_id: &str,
) -> Result<PathBuf, String> {
    let safe_chat_id = normalize_chat_id(chat_id);
    let safe_artifact_id = normalize_chat_id(artifact_id);
    if chat_id.trim().is_empty() || artifact_id.trim().is_empty() {
        return Err("Result artifact identity is required.".to_string());
    }
    Ok(root
        .join(safe_chat_id)
        .join(format!("{safe_artifact_id}.json")))
}

fn write_result_artifact_in(
    root: &Path,
    chat_id: &str,
    artifact_id: &str,
    raw: &[u8],
) -> Result<Value, String> {
    let safe_chat_id = normalize_chat_id(chat_id);
    let safe_artifact_id = normalize_chat_id(artifact_id);
    let path = result_artifact_path_in(root, &safe_chat_id, &safe_artifact_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Result artifact path is invalid.".to_string())?;
    ensure_dir(parent)?;
    fs::write(path, raw).map_err(|error| format!("Could not save result artifact: {error}"))?;
    Ok(json!({
        "chatId": safe_chat_id,
        "artifactId": safe_artifact_id,
        "byteCount": raw.len()
    }))
}

fn externalize_result_data_in(
    root: &Path,
    chat_id: &str,
    artifact_id: &str,
    result: &mut Value,
) -> Result<Option<Value>, String> {
    let Some(result_object) = result.as_object_mut() else {
        return Ok(None);
    };
    let Some(data) = result_object.get("data") else {
        return Ok(None);
    };
    let raw = serde_json::to_vec(data)
        .map_err(|error| format!("Could not serialize result artifact: {error}"))?;
    if raw.len() <= INLINE_RESULT_DATA_LIMIT_BYTES {
        return Ok(None);
    }
    let reference = write_result_artifact_in(root, chat_id, artifact_id, &raw)?;
    result_object.insert("data".to_string(), json!({}));
    result_object.insert("dataArtifact".to_string(), reference.clone());
    Ok(Some(reference))
}

fn externalize_large_card_data_in(
    root: &Path,
    chat_id: &str,
    messages: &mut [StoredChatMessage],
) -> Result<bool, String> {
    let mut changed = false;
    for (message_index, message) in messages.iter_mut().enumerate() {
        let Some(cards) = message.cards.as_mut().and_then(Value::as_array_mut) else {
            continue;
        };
        for (card_index, card) in cards.iter_mut().enumerate() {
            let Some(card_object) = card.as_object_mut() else {
                continue;
            };
            if card_object.get("artifact").is_some() {
                continue;
            }
            let Some(data) = card_object.get("data") else {
                continue;
            };
            let raw = serde_json::to_vec(data)
                .map_err(|error| format!("Could not serialize card artifact: {error}"))?;
            if raw.len() <= INLINE_RESULT_DATA_LIMIT_BYTES {
                continue;
            }
            let artifact_id = format!("message-{message_index}-card-{card_index}");
            let reference = write_result_artifact_in(root, chat_id, &artifact_id, &raw)?;
            card_object.insert("data".to_string(), json!({}));
            card_object.insert("artifact".to_string(), reference);
            changed = true;
        }
    }
    Ok(changed)
}

fn generated_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("generated-plugins"))
}

fn catalog_extensions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve app resource directory: {error}"))?
        .join("extensions");
    if packaged.is_dir() {
        return Ok(packaged);
    }

    // `tauri dev` does not copy bundle resources before starting the app.
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extensions");
    if development.is_dir() {
        return Ok(development);
    }
    Err("Could not find the bundled extension catalog.".to_string())
}

fn is_catalog_extension_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
        && slug.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn catalog_manifest_string(manifest: &Value, field: &str, slug: &str) -> Result<String, String> {
    manifest
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Catalog extension {slug} is missing {field}."))
}

fn read_plugin_detail_files(plugin_dir: &Path) -> Result<GeneratedPluginDetail, String> {
    let manifest_path = plugin_dir.join("plugin.json");
    let raw_manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read plugin manifest: {error}"))?;
    let mut manifest_json: Value = serde_json::from_str(&raw_manifest_text)
        .map_err(|error| format!("Could not parse plugin manifest: {error}"))?;
    if let Some(manifest) = manifest_json.as_object_mut() {
        manifest.remove("samplePrompts");
    }
    let manifest_text =
        serde_json::to_string_pretty(&manifest_json).unwrap_or_else(|_| raw_manifest_text.clone());
    let plugin = read_generated_plugin_manifest(plugin_dir, &manifest_path)
        .ok_or_else(|| "Could not read extension metadata.".to_string())?;
    let code = fs::read_to_string(plugin_dir.join("tools.ts")).unwrap_or_default();
    let readme = fs::read_to_string(plugin_dir.join("README.md")).unwrap_or_default();
    Ok(GeneratedPluginDetail {
        plugin,
        manifest_json,
        manifest_text,
        code,
        readme,
    })
}

fn read_catalog_extension_detail_from(
    catalog_dir: &Path,
    installed_dir: &Path,
    slug: &str,
) -> Result<CatalogExtensionDetail, String> {
    let slug = slug.trim();
    if !is_catalog_extension_slug(slug) {
        return Err("Invalid catalog extension name.".to_string());
    }
    let extension = read_catalog_extensions(catalog_dir, installed_dir)?
        .into_iter()
        .find(|extension| extension.slug == slug)
        .ok_or_else(|| format!("Catalog extension not found: {slug}"))?;
    if extension.installed {
        return Err(format!("{} is already installed.", extension.name));
    }
    let detail = read_plugin_detail_files(&catalog_dir.join(slug))?;
    Ok(CatalogExtensionDetail { extension, detail })
}

/// Reads the version an installed copy reports for itself.
///
/// A missing or unreadable manifest is reported as an empty version rather than
/// an error: the catalog listing must still render for every other extension,
/// and an unreadable copy is exactly the case an update should be offered for.
fn installed_manifest_version(installed_extension_dir: &Path) -> String {
    fs::read_to_string(installed_extension_dir.join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|manifest| {
            manifest
                .get("version")
                .and_then(Value::as_str)
                .map(|version| version.trim().to_string())
        })
        .unwrap_or_default()
}

fn read_catalog_extensions(
    catalog_dir: &Path,
    installed_dir: &Path,
) -> Result<Vec<CatalogExtension>, String> {
    let entries = fs::read_dir(catalog_dir)
        .map_err(|error| format!("Could not read bundled extension catalog: {error}"))?;
    let mut extensions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read catalog entry: {error}"))?;
        let extension_dir = entry.path();
        if !extension_dir.is_dir() || !extension_dir.join("plugin.json").is_file() {
            continue;
        }
        let slug = extension_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        if !is_catalog_extension_slug(&slug) {
            return Err(format!(
                "Catalog extension has an invalid directory name: {slug}"
            ));
        }
        let raw = fs::read_to_string(extension_dir.join("plugin.json"))
            .map_err(|error| format!("Could not read catalog manifest for {slug}: {error}"))?;
        let manifest: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("Could not parse catalog manifest for {slug}: {error}"))?;
        if manifest.get("sdkVersion").and_then(Value::as_u64) != Some(1) {
            return Err(format!(
                "Catalog extension {slug} does not use SDK version 1."
            ));
        }
        let tools = manifest
            .get("contributes")
            .and_then(|value| value.get("tools"))
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Catalog extension {slug} is missing contributes.tools."))?
            .iter()
            .map(|tool| {
                Ok(CatalogExtensionTool {
                    name: catalog_manifest_string(tool, "name", &slug)?,
                    description: catalog_manifest_string(tool, "description", &slug)?,
                    has_card: tool
                        .get("hasCard")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if tools.is_empty() || tools.iter().any(|tool| !tool.has_card) {
            return Err(format!(
                "Catalog extension {slug} must declare at least one card-backed tool."
            ));
        }
        extensions.push(CatalogExtension {
            slug: slug.clone(),
            id: catalog_manifest_string(&manifest, "id", &slug)?,
            name: catalog_manifest_string(&manifest, "name", &slug)?,
            description: catalog_manifest_string(&manifest, "description", &slug)?,
            category: catalog_manifest_string(&manifest, "category", &slug)?,
            icon: manifest
                .get("icon")
                .and_then(Value::as_str)
                .unwrap_or("plug")
                .trim()
                .to_string(),
            author: manifest
                .get("author")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            homepage: manifest
                .get("homepage")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            version: catalog_manifest_string(&manifest, "version", &slug)?,
            requires_key: !read_plugin_credentials(&manifest).is_empty(),
            installed: installed_dir.join(&slug).is_dir(),
            installed_version: installed_manifest_version(&installed_dir.join(&slug)),
            tools,
        });
    }
    extensions.sort_by(|left, right| {
        left.category
            .to_lowercase()
            .cmp(&right.category.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(extensions)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    ensure_dir(target)?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read extension directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not read extension file: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect extension file: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Bundled extensions cannot contain symbolic links: {}",
                entry.path().display()
            ));
        }
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &destination).map_err(|error| {
                format!(
                    "Could not copy bundled extension file {}: {error}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

fn install_catalog_extension_from(
    catalog_dir: &Path,
    installed_dir: &Path,
    raw_slug: &str,
) -> Result<PathBuf, String> {
    let slug = raw_slug.trim();
    if !is_catalog_extension_slug(slug) {
        return Err("Catalog extension id is invalid.".to_string());
    }
    let source = catalog_dir.join(slug);
    if !source.is_dir() || !source.join("plugin.json").is_file() {
        return Err(format!("Catalog extension not found: {slug}"));
    }
    let target = installed_dir.join(slug);
    if target.exists() {
        return Err(format!("Extension is already installed: {slug}"));
    }
    let temporary = installed_dir.join(format!(".tmp-catalog-{slug}-{}", now_millis()));
    if temporary.exists() {
        return Err("Could not allocate a temporary extension directory.".to_string());
    }
    let result = (|| -> Result<(), String> {
        copy_dir_recursive(&source, &temporary)?;
        fs::rename(&temporary, &target)
            .map_err(|error| format!("Could not finish installing {slug}: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    Ok(target)
}

/// Replaces an installed catalog extension with the bundled catalog copy.
///
/// This is the upgrade path a new app release needs: the bundled catalog ships
/// updated files, but an installed copy is a snapshot taken at install time and
/// nothing else refreshes it. Uninstall-then-install would work except that
/// `delete_generated_plugin` deliberately forgets the extension's keychain
/// credentials, so every extension change would make the user re-enter their API
/// key. Replacing the directory in place leaves both the keychain entry (keyed
/// by plugin id, not path) and the sibling `.plugin-data` cache untouched.
///
/// The new copy is staged beside the target and swapped in, so a failure part
/// way through leaves the working extension in place rather than a half-written
/// directory.
fn update_catalog_extension_from(
    catalog_dir: &Path,
    installed_dir: &Path,
    raw_slug: &str,
) -> Result<PathBuf, String> {
    let slug = raw_slug.trim();
    if !is_catalog_extension_slug(slug) {
        return Err("Catalog extension id is invalid.".to_string());
    }
    let source = catalog_dir.join(slug);
    if !source.is_dir() || !source.join("plugin.json").is_file() {
        return Err(format!("Catalog extension not found: {slug}"));
    }
    let target = installed_dir.join(slug);
    if !target.is_dir() {
        return Err(format!("Extension is not installed: {slug}"));
    }
    let staged = installed_dir.join(format!(".tmp-update-{slug}-{}", now_millis()));
    let replaced = installed_dir.join(format!(".old-update-{slug}-{}", now_millis()));
    if staged.exists() || replaced.exists() {
        return Err("Could not allocate a temporary extension directory.".to_string());
    }
    let result = (|| -> Result<(), String> {
        copy_dir_recursive(&source, &staged)?;
        fs::rename(&target, &replaced)
            .map_err(|error| format!("Could not replace {slug}: {error}"))?;
        if let Err(error) = fs::rename(&staged, &target) {
            // Put the working copy back before reporting the failure.
            let _ = fs::rename(&replaced, &target);
            return Err(format!("Could not finish updating {slug}: {error}"));
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&replaced);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }
    Ok(target)
}

fn plugin_data_dir(plugin_root: &Path, plugin_dir: &Path) -> Result<PathBuf, String> {
    let plugin_slug = plugin_dir
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| "Could not resolve plugin data directory.".to_string())?;
    Ok(plugin_root.join(".plugin-data").join(plugin_slug))
}

fn read_plugin_cache_settings(data_dir: &Path) -> Result<PluginCacheSettings, String> {
    let settings_path = data_dir.join("cache-settings.json");
    if !settings_path.is_file() {
        return Ok(PluginCacheSettings::default());
    }
    let raw = fs::read_to_string(&settings_path)
        .map_err(|error| format!("Could not read plugin cache settings: {error}"))?;
    let settings: PluginCacheSettings = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse plugin cache settings: {error}"))?;
    validate_plugin_cache_settings(&settings)?;
    Ok(settings)
}

fn save_plugin_cache_settings(
    data_dir: &Path,
    settings: &PluginCacheSettings,
) -> Result<(), String> {
    validate_plugin_cache_settings(settings)?;
    ensure_dir(data_dir)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize plugin cache settings: {error}"))?;
    fs::write(data_dir.join("cache-settings.json"), format!("{raw}\n"))
        .map_err(|error| format!("Could not save plugin cache settings: {error}"))
}

fn validate_plugin_cache_settings(settings: &PluginCacheSettings) -> Result<(), String> {
    if !(1..=8_760).contains(&settings.ttl_hours) {
        return Err("Cache duration must be between 1 and 8760 hours.".to_string());
    }
    Ok(())
}

fn clear_plugin_api_cache(data_dir: &Path) -> Result<(), String> {
    let cache_dir = data_dir.join("api-cache");
    if cache_dir.exists() {
        fs::remove_dir_all(cache_dir)
            .map_err(|error| format!("Could not clear plugin cache: {error}"))?;
    }
    Ok(())
}

fn validate_generated_plugin_dir(
    app: &tauri::AppHandle,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let plugin_dir = PathBuf::from(raw_path.trim());
    if plugin_dir.as_os_str().is_empty() {
        return Err("Plugin directory is required.".to_string());
    }
    if !plugin_dir.is_dir() {
        return Err("Plugin directory does not exist.".to_string());
    }
    let root = generated_plugins_dir(app)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve generated plugin root: {error}"))?;
    let plugin_dir = plugin_dir
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin directory: {error}"))?;
    if !plugin_dir.starts_with(&root) || plugin_dir == root {
        return Err("Plugin builder can only run inside a generated plugin workspace.".to_string());
    }
    if !plugin_dir.join("plugin.json").is_file() {
        return Err("Plugin workspace is missing plugin.json.".to_string());
    }
    Ok(plugin_dir)
}

fn resolve_generated_plugin_by_id(app: &tauri::AppHandle, raw_id: &str) -> Result<PathBuf, String> {
    let target = raw_id.trim();
    if target.is_empty() {
        return Err("Plugin id is required.".to_string());
    }
    let root = generated_plugins_dir(app)?;
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Could not read generated plugins: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read generated plugin entry: {error}"))?;
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let manifest_path = plugin_dir.join("plugin.json");
        let Some(plugin) = read_generated_plugin_manifest(&plugin_dir, &manifest_path) else {
            continue;
        };
        let dir_name_matches = plugin_dir
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value == target)
            .unwrap_or(false);
        if plugin.id == target || plugin.name.eq_ignore_ascii_case(target) || dir_name_matches {
            return validate_generated_plugin_dir(app, &plugin_dir.to_string_lossy());
        }
    }
    Err(format!("Generated plugin not found: {target}"))
}

fn resolve_generated_plugin_by_tool(
    app: &tauri::AppHandle,
    tool_name: &str,
) -> Result<PathBuf, String> {
    let root = generated_plugins_dir(app)?;
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Could not read generated plugins: {error}"))?;
    let mut matches = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read generated plugin entry: {error}"))?;
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let manifest_path = plugin_dir.join("plugin.json");
        let Some(plugin) = read_generated_plugin_manifest(&plugin_dir, &manifest_path) else {
            continue;
        };
        if plugin.tools.iter().any(|tool| tool.name == tool_name) {
            matches.push(plugin_dir);
        }
    }
    if matches.len() == 1 {
        return validate_generated_plugin_dir(app, &matches[0].to_string_lossy());
    }
    if matches.is_empty() {
        return Err(format!("No generated plugin provides tool: {tool_name}"));
    }
    Err(format!(
        "Multiple generated plugins provide tool: {tool_name}"
    ))
}

/// Where `scripts/standalone-runtime.mjs` lands inside every Tauri bundle.
/// Tauri owns the platform-specific resource root; the relative mapping in
/// `tauri.conf.json` is the same on macOS, Linux, and Windows.
fn packaged_runtime_scripts_dir_for(resource_dir: &Path) -> PathBuf {
    resource_dir.join("agent-runtime").join("scripts")
}

/// The embedded Node executable is bundled as an external binary, so Tauri
/// drops it next to the app executable with its target-triple suffix removed.
fn packaged_node_path_for(executable: &Path, node_name: &str) -> Option<PathBuf> {
    Some(executable.parent()?.join(node_name))
}

fn select_runtime_script_path(
    current_dir: &Path,
    resource_dir: Option<&Path>,
    script_name: &str,
    prefer_development_sources: bool,
) -> Option<PathBuf> {
    let development = [
        current_dir.join("scripts").join(script_name),
        current_dir.join("..").join("scripts").join(script_name),
    ];
    let packaged = resource_dir
        .map(packaged_runtime_scripts_dir_for)
        .map(|scripts| scripts.join(script_name));

    if prefer_development_sources {
        development
            .into_iter()
            .chain(packaged)
            .find(|path| path.is_file())
    } else {
        packaged
            .into_iter()
            .chain(development)
            .find(|path| path.is_file())
    }
}

/// Development must execute the repository scripts directly: Tauri also copies
/// the gitignored staged runtime into `target/debug`, and that copy can be older
/// than a sidecar edited during `tauri dev`. Release builds invert the order so
/// a packaged app never depends on its working directory or developer files.
fn resolve_runtime_script_path(script_name: &str) -> Result<PathBuf, String> {
    let current =
        env::current_dir().map_err(|error| format!("Could not read current directory: {error}"))?;
    select_runtime_script_path(
        &current,
        BUNDLED_RESOURCE_DIR.get().map(PathBuf::as_path),
        script_name,
        cfg!(debug_assertions),
    )
    .ok_or_else(|| format!("Could not find scripts/{script_name}."))
}

/// Node is only on `PATH` for developer machines. A packaged app must use the
/// embedded executable, otherwise every agent turn depends on what the person
/// who downloaded the app happens to have installed.
fn resolve_node_command() -> PathBuf {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    env::current_exe()
        .ok()
        .and_then(|executable| packaged_node_path_for(&executable, node_name))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn resolve_plugin_builder_sidecar_path() -> Result<PathBuf, String> {
    resolve_runtime_script_path("plugin-builder-sidecar.mjs")
}

fn resolve_main_agent_sidecar_path() -> Result<PathBuf, String> {
    resolve_runtime_script_path("main-agent-sidecar.mjs")
}

fn resolve_oauth_login_sidecar_path() -> Result<PathBuf, String> {
    resolve_runtime_script_path("oauth-login-sidecar.mjs")
}

fn resolve_bookmark_title_sidecar_path() -> Result<PathBuf, String> {
    resolve_runtime_script_path("bookmark-title-sidecar.mjs")
}

fn resolve_plugin_tool_runner_path() -> Result<PathBuf, String> {
    resolve_runtime_script_path("plugin-tool-runner.mjs")
}

fn normalize_chat_id(raw: &str) -> String {
    let mut output = String::new();
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            output.push(ch);
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    let output = output.trim_matches('-').to_string();
    if output.is_empty() {
        format!("chat-{}", now_millis())
    } else {
        output
    }
}

fn normalize_plugin_slug(raw: &str) -> String {
    let mut output = String::new();
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
        } else if (ch == '-' || ch == '_' || ch == '.' || ch.is_whitespace())
            && !output.ends_with('-')
        {
            output.push('-');
        }
    }
    let output = output.trim_matches('-').to_string();
    if output.is_empty() {
        format!("generated-capability-{}", now_millis())
    } else {
        output.chars().take(64).collect()
    }
}

fn next_available_plugin_slug(root: &Path, slug: &str) -> String {
    if !root.join(slug).exists() {
        return slug.to_string();
    }
    for index in 2..1000 {
        let candidate = format!("{slug}-{index}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{slug}-{}", now_millis())
}

fn normalize_plugin_description(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

fn normalize_source_urls(urls: Vec<String>) -> Vec<String> {
    let mut seen = BTreeMap::new();
    for url in urls {
        let cleaned = url.trim().trim_end_matches(['.', ',', ';']).to_string();
        if cleaned.starts_with("https://") || cleaned.starts_with("http://") {
            seen.insert(cleaned.clone(), cleaned);
        }
    }
    seen.into_values().take(8).collect()
}

fn plugin_display_name(slug: &str) -> String {
    slug.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_plugin_sample_prompts(prompts: Vec<String>) -> Vec<String> {
    if prompts.len() != 3 {
        return Vec::new();
    }
    let mut normalized = Vec::new();
    for prompt in prompts {
        let prompt = prompt.trim().chars().take(240).collect::<String>();
        if prompt.is_empty() || normalized.contains(&prompt) {
            return Vec::new();
        }
        normalized.push(prompt);
    }
    normalized
}

fn read_plugin_sample_prompts(manifest: &Value) -> Vec<String> {
    let manifest_prompts = manifest
        .get("samplePrompts")
        .and_then(Value::as_array)
        .map(|prompts| {
            prompts
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    normalize_plugin_sample_prompts(manifest_prompts)
}

/// Credential names double as keychain account components, so they are held to
/// a strict shape rather than trusted from a generated manifest.
fn is_valid_credential_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == '_')
}

fn read_plugin_credentials(manifest: &Value) -> Vec<PluginCredential> {
    let Some(entries) = manifest
        .get("auth")
        .and_then(|auth| auth.get("credentials"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    let mut credentials: Vec<PluginCredential> = Vec::new();
    for entry in entries {
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let signup_url = entry
            .get("signupUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        // A malformed declaration is dropped rather than failing the whole
        // plugin: the remaining tools stay usable.
        if !is_valid_credential_key(&key) {
            continue;
        }
        if !signup_url.starts_with("https://") && !signup_url.starts_with("http://") {
            continue;
        }
        if credentials.iter().any(|existing| existing.key == key) {
            continue;
        }
        let label = entry
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&key)
            .chars()
            .take(120)
            .collect::<String>();
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .chars()
            .take(240)
            .collect::<String>();
        credentials.push(PluginCredential {
            key,
            label,
            description,
            signup_url,
            configured: false,
        });
        if credentials.len() == 8 {
            break;
        }
    }
    credentials
}

fn read_generated_plugin_manifest(
    plugin_dir: &Path,
    manifest_path: &Path,
) -> Option<GeneratedPlugin> {
    let raw = fs::read_to_string(manifest_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("sdkVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let id = parsed.get("id").and_then(Value::as_str)?.trim().to_string();
    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&id)
        .to_string();
    let description = parsed
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let version = parsed
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.1.0")
        .trim()
        .to_string();
    let created_at = parsed
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("scaffolded")
        .trim()
        .to_string();
    Some(GeneratedPlugin {
        id,
        name,
        description,
        version,
        directory: plugin_dir.to_string_lossy().to_string(),
        entry_path: plugin_dir.join("tools.ts").to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        created_at,
        status,
        sample_prompts: read_plugin_sample_prompts(&parsed),
        credentials: read_plugin_credentials(&parsed),
        tools: Vec::new(),
    })
}

fn enrich_generated_plugin_tools_from_runtime(plugin: &mut GeneratedPlugin, plugin_dir: &Path) {
    let Some(runtime_tools) = load_generated_plugin_runtime_tools_cached(plugin_dir) else {
        return;
    };
    if runtime_tools.is_empty() {
        return;
    }
    plugin.tools = runtime_tools;
}

/// Runtime tool discovery spawns a Node process that transpiles the plugin
/// (~0.3s each), so we cache the result next to the plugin and only re-run it
/// when plugin TypeScript changes. This keeps the plugins sidebar instant after the
/// first load instead of re-spawning Node for every plugin on every open.
fn load_generated_plugin_runtime_tools_cached(
    plugin_dir: &Path,
) -> Option<Vec<GeneratedPluginTool>> {
    let source_mtime = generated_plugin_source_mtime_millis(plugin_dir);
    let cache_path = plugin_dir.join(".runtime-tools.json");

    if let (Some(source_mtime), Ok(raw)) = (source_mtime, fs::read_to_string(&cache_path)) {
        if let Ok(cache) = serde_json::from_str::<RuntimeToolsCache>(&raw) {
            if cache.source_mtime == source_mtime
                && cache.tools.iter().all(|tool| tool.card.is_object())
            {
                return Some(cache.tools);
            }
        }
    }

    let tools = read_generated_plugin_runtime_tools(plugin_dir).ok()?;
    if let Some(source_mtime) = source_mtime {
        let cache = RuntimeToolsCache {
            source_mtime,
            tools: tools.clone(),
        };
        if let Ok(serialized) = serde_json::to_string(&cache) {
            let _ = fs::write(&cache_path, serialized);
        }
    }
    Some(tools)
}

fn generated_plugin_source_mtime_millis(plugin_dir: &Path) -> Option<u128> {
    // Key the cache on the newest TypeScript source in the plugin. Shared SDK
    // upgrades preserve the tool metadata shape and do not need per-plugin
    // cache invalidation.
    let mut latest: Option<std::time::SystemTime> = None;
    if let Ok(entries) = fs::read_dir(plugin_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("ts") {
                continue;
            }
            if let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) {
                latest = match latest {
                    Some(current) if current >= modified => Some(current),
                    _ => Some(modified),
                };
            }
        }
    }
    let modified = match latest {
        Some(modified) => modified,
        None => return None,
    };
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis())
}

fn read_generated_plugin_runtime_tools(
    plugin_dir: &Path,
) -> Result<Vec<GeneratedPluginTool>, String> {
    let runner_path = resolve_plugin_tool_runner_path()?;
    let runner_request = json!({
        "pluginDir": plugin_dir.to_string_lossy().to_string(),
        "listTools": true
    });
    let mut child = Command::new(resolve_node_command())
        .arg(runner_path)
        .current_dir(plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start plugin tool runner: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let raw = serde_json::to_vec(&runner_request)
            .map_err(|error| format!("Could not serialize plugin tool list request: {error}"))?;
        stdin
            .write_all(&raw)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("Could not send request to plugin tool runner: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read plugin tool list output: {error}"))?;
    if !output.status.success() {
        return Err(format!("Plugin tool runner exited with {}.", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last_line = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .ok_or_else(|| "Plugin tool runner returned no output.".to_string())?;
    let payload: Value = serde_json::from_str(last_line)
        .map_err(|error| format!("Plugin tool runner returned invalid JSON: {error}"))?;
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Plugin tool list failed.");
        return Err(error.to_string());
    }

    Ok(payload
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    Some(GeneratedPluginTool {
                        name,
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        parameters: item.get("parameters").cloned().unwrap_or_else(|| {
                            json!({
                                "type": "object",
                                "properties": {}
                            })
                        }),
                        card: item.get("card").filter(|value| value.is_object())?.clone(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

fn build_plugin_manifest(
    slug: &str,
    description: &str,
    created_at: &str,
    source_urls: &[String],
) -> String {
    let manifest = json!({
        "id": format!("raynard.generated.{slug}"),
        "name": plugin_display_name(slug),
        "description": description,
        "version": "0.1.0",
        "sdkVersion": 1,
        "status": "scaffolded",
        "createdAt": created_at,
        "samplePrompts": [],
        "sourceUrls": source_urls,
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string())
}

// The SDK is embedded in the desktop binary and installed once under
// generated-plugins/node_modules.
const PLUGIN_SDK_PACKAGE_JSON: &str = include_str!("../../scripts/plugin-sdk/package.json");
const PLUGIN_SDK_INDEX_JS: &str = include_str!("../../scripts/plugin-sdk/index.js");
const PLUGIN_SDK_INDEX_D_TS: &str = include_str!("../../scripts/plugin-sdk/index.d.ts");
const PLUGIN_SDK_TESTING_JS: &str = include_str!("../../scripts/plugin-sdk/testing.js");
const PLUGIN_SDK_TESTING_D_TS: &str = include_str!("../../scripts/plugin-sdk/testing.d.ts");
const GENERATED_PLUGINS_PACKAGE_JSON: &str = "{\n  \"private\": true,\n  \"type\": \"module\"\n}\n";

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    fs::write(path, content).map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn ensure_shared_plugin_sdk(root: &Path) -> Result<(), String> {
    write_if_changed(&root.join("package.json"), GENERATED_PLUGINS_PACKAGE_JSON)?;
    let sdk_dir = root.join("node_modules/@raynard/plugin-sdk");
    ensure_dir(&sdk_dir)?;
    for (name, content) in [
        ("package.json", PLUGIN_SDK_PACKAGE_JSON),
        ("index.js", PLUGIN_SDK_INDEX_JS),
        ("index.d.ts", PLUGIN_SDK_INDEX_D_TS),
        ("testing.js", PLUGIN_SDK_TESTING_JS),
        ("testing.d.ts", PLUGIN_SDK_TESTING_D_TS),
    ] {
        write_if_changed(&sdk_dir.join(name), content)?;
    }
    Ok(())
}

fn build_plugin_tools_stub() -> String {
    r#"// The host supplies this SDK once for every generated plugin.
import { defineTools } from '@raynard/plugin-sdk';

// Add one focused API tool per registry entry.
export const tools = defineTools({});
"#
    .to_string()
}

fn build_plugin_readme(slug: &str, description: &str, source_urls: &[String]) -> String {
    let source_block = if source_urls.is_empty() {
        "- No source documentation URL was captured.\n".to_string()
    } else {
        source_urls
            .iter()
            .map(|url| format!("- {url}\n"))
            .collect::<String>()
    };
    format!(
        "# {}\n\n{}\n\n## Source documentation\n\n{}## Development\n\nRuntime helpers, tool types, citations, cards, and test helpers come from the host-supplied `@raynard/plugin-sdk`. Keep this workspace focused on API-specific client code, tools, behavior tests, and this documentation.\n\nEvery tool returns concise text, source references, and structured data matching its fixed declarative card. List and search results use bounded cards and preserve useful empty-result data.\n\n## Tools\n\nThe builder documents the implemented tool names and intended routing here.\n\n## Endpoint Inventory\n\n| Endpoint | Status | Parameters and response shape | Tool or future tool |\n| --- | --- | --- | --- |\n| _Builder: replace with documented API endpoints_ | Planned | _Describe parameters, pagination, limits, and response shape_ | _Proposed tool name_ |\n",
        plugin_display_name(slug),
        description,
        source_block
    )
}

/// Collapses a bookmark title to one bounded line, or to empty when absent.
///
/// The sidecar already strips the decoration a model tends to add, but a title
/// can also arrive from an older client or a hand-edited store, so the length
/// and shape are enforced again here rather than trusted.
fn normalize_bookmark_title(raw: &str) -> String {
    let value = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    value.chars().take(120).collect()
}

fn normalize_chat_name(raw: &str) -> String {
    let value = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        "Untitled chat".to_string()
    } else {
        value.chars().take(120).collect()
    }
}

fn normalize_stored_messages(messages: Vec<StoredChatMessage>) -> Vec<StoredChatMessage> {
    messages
        .into_iter()
        .filter_map(|message| {
            let role = match message.role.trim() {
                "assistant" => "assistant",
                "user" => "user",
                _ => return None,
            };
            let text = message.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(StoredChatMessage {
                role: role.to_string(),
                text,
                timestamp: if message.timestamp > 0 {
                    message.timestamp
                } else {
                    now_millis()
                },
                thinking: message
                    .thinking
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                provider: message
                    .provider
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                model: message
                    .model
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                status: message
                    .status
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                error: message
                    .error
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                mode_status: message.mode_status,
                model_failure: message.model_failure,
                builder_run: message.builder_run,
                shared_import: message.shared_import,
                builder_activities: message.builder_activities,
                cards: message.cards,
                charts: message.charts,
                sources: message.sources,
                credential_request: message.credential_request,
                extension_recommendation: message.extension_recommendation,
                scheduled_task_request: message.scheduled_task_request,
                scheduled_task_id: message.scheduled_task_id,
                scheduled_task_name: message.scheduled_task_name,
                scheduled_execution_id: message.scheduled_execution_id,
                usage: message.usage,
            })
        })
        .collect()
}

fn normalize_iso(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn latest_chat_turn_iso(messages: &[StoredChatMessage], fallback: &str) -> String {
    messages
        .iter()
        .filter_map(|message| chrono::DateTime::from_timestamp_millis(message.timestamp))
        .max()
        .map(|datetime| datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| fallback.to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn system_time_to_iso(time: SystemTime) -> Option<String> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| chrono::DateTime::from_timestamp_millis(duration.as_millis() as i64))
        .map(|datetime| datetime.to_rfc3339())
}

fn provider_preset(provider_id: &str) -> Option<ProviderPreset> {
    match provider_id {
        "openai" => Some(ProviderPreset {
            id: "openai",
            name: "OpenAI API",
            base_url: "https://api.openai.com/v1",
            default_chat_model: "gpt-4.1-mini",
            default_coding_model: "gpt-4.1-mini",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_OPENAI_API_KEY",
                "OPENAI_API_KEY",
            ],
            auth_method: AuthMethod::ApiKey,
            api_key_url: "https://platform.openai.com/api-keys",
        }),
        // A ChatGPT subscription, not an API account: different host, different
        // wire format, and its own model list. Kept as a separate provider for
        // the same reason pi keeps it separate — nothing about it overlaps the
        // api.openai.com entry above except the vendor name.
        "openai-codex" => Some(ProviderPreset {
            id: "openai-codex",
            name: "ChatGPT",
            base_url: "https://chatgpt.com/backend-api",
            // The catalog lists older ids too, but a ChatGPT account is only
            // entitled to the current ones — asking for gpt-5.2 comes back as
            // "not supported when using Codex with a ChatGPT account". This is
            // the default pi ships for the same provider.
            default_chat_model: "gpt-5.5",
            default_coding_model: "gpt-5.5",
            api_key_names: &[],
            auth_method: AuthMethod::OAuth,
            api_key_url: "",
        }),
        "claude" => Some(ProviderPreset {
            id: "claude",
            name: "Claude",
            base_url: "https://api.anthropic.com/v1",
            default_chat_model: "claude-3-5-sonnet-latest",
            default_coding_model: "claude-3-5-sonnet-latest",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_CLAUDE_API_KEY",
                "ANTHROPIC_API_KEY",
            ],
            auth_method: AuthMethod::ApiKey,
            api_key_url: "https://console.anthropic.com/settings/keys",
        }),
        "moonshot" => Some(ProviderPreset {
            id: "moonshot",
            name: "Kimi",
            base_url: "https://api.moonshot.ai/v1",
            default_chat_model: "kimi-k2.6",
            default_coding_model: "kimi-k3",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_MOONSHOT_API_KEY",
                "MOONSHOT_API_KEY",
            ],
            auth_method: AuthMethod::ApiKey,
            api_key_url: "https://platform.moonshot.ai/console/api-keys",
        }),
        "kimi" => provider_preset("moonshot"),
        "kimi-coding" => Some(ProviderPreset {
            id: "kimi-coding",
            name: "Kimi Coding",
            base_url: "https://api.kimi.com/coding/",
            default_chat_model: "k2p5",
            default_coding_model: "k2p5",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_KIMI_API_KEY",
                "KIMI_API_KEY",
            ],
            auth_method: AuthMethod::ApiKey,
            api_key_url: "https://platform.moonshot.ai/console/api-keys",
        }),
        _ => None,
    }
}

fn canonical_provider_id(provider_id: &str) -> String {
    match provider_id.trim().to_lowercase().as_str() {
        "kimi" => "moonshot".to_string(),
        "anthropic" => "claude".to_string(),
        "openai" => "openai".to_string(),
        // Without this arm the catch-all below would quietly turn a signed-in
        // ChatGPT user into a Moonshot user.
        "openai-codex" => "openai-codex".to_string(),
        "claude" => "claude".to_string(),
        "moonshot" => "moonshot".to_string(),
        "kimi-coding" => "kimi-coding".to_string(),
        _ => "moonshot".to_string(),
    }
}

fn provider_presets(app: &tauri::AppHandle) -> Result<Vec<ModelProvider>, String> {
    let config = load_app_config(app)?;
    let entries = read_env_file()?;
    let active_chat_provider = config
        .active_provider
        .as_deref()
        .map(canonical_provider_id)
        .unwrap_or_else(|| "moonshot".to_string());
    let active_coding_provider = config
        .active_coding_provider
        .as_deref()
        .map(canonical_provider_id)
        .unwrap_or_else(|| active_chat_provider.clone());

    // ChatGPT first: it is the only entry that connects without the user
    // leaving to fetch a key, and the key-based OpenAI account trails the list
    // because the UI keeps it behind a secondary link.
    ["openai-codex", "claude", "moonshot", "openai"]
        .iter()
        .map(|provider_id| {
            let preset = provider_preset(provider_id).expect("static provider should exist");
            let chat_model = if active_chat_provider == preset.id {
                config
                    .active_model
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(preset.default_chat_model)
            } else {
                preset.default_chat_model
            };
            let coding_model = if active_coding_provider == preset.id {
                config
                    .active_coding_model
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(preset.default_coding_model)
            } else {
                preset.default_coding_model
            };
            Ok(ModelProvider {
                id: preset.id.to_string(),
                name: preset.name.to_string(),
                base_url: preset.base_url.to_string(),
                default_chat_model: preset.default_chat_model.to_string(),
                default_coding_model: preset.default_coding_model.to_string(),
                chat_model: chat_model.to_string(),
                coding_model: coding_model.to_string(),
                chat_active: active_chat_provider == preset.id,
                coding_active: active_coding_provider == preset.id,
                // Any stored credential counts, whichever kind it is. The .env
                // fallback only applies to key providers — there is no
                // environment variable that can stand in for a sign-in.
                connected: read_provider_credential(preset.id).is_some()
                    || !first_env_value(&entries, preset.api_key_names).is_empty(),
                auth_method: preset.auth_method.as_str().to_string(),
                api_key_url: preset.api_key_url.to_string(),
            })
        })
        .collect()
}

fn app_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("config.json"))
}

/// Moonshot discontinued `kimi-k2.5` on 2026-08-31 in favor of `kimi-k2.6`; a
/// config saved before that date can still carry the dead id, and Moonshot's
/// API now 404s on every turn until the user notices and reselects a model.
fn migrate_deprecated_model_id(model: Option<String>) -> Option<String> {
    match model.as_deref() {
        Some("kimi-k2.5") => Some("kimi-k2.6".to_string()),
        _ => model,
    }
}

fn load_app_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = app_config_path(app)?;
    if !path.is_file() {
        return Ok(AppConfig::default());
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("Could not read app config: {error}"))?;
    let mut config: AppConfig = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse app config: {error}"))?;
    config.active_model = migrate_deprecated_model_id(config.active_model);
    config.active_coding_model = migrate_deprecated_model_id(config.active_coding_model);
    Ok(config)
}

fn save_app_config(app: &tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let path = app_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create app data directory: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize app config: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not write app config: {error}"))
}

// ---------------------------------------------------------------------------
// All-time token totals
//
// An odometer, not an invoice. Kept in its own aggregate file rather than
// recomputed from chat history because a stored message carries `cards` and
// `sources` — the latter holding real API response payloads — so summing four
// integers would mean parsing the entire corpus on the UI's critical path,
// growing without bound. A lost write here is cosmetic.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct UsageTotalsRow {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    total_tokens: i64,
    turns: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct UsageTotals {
    /// Versioned so a future "rebuild from history" migration is possible
    /// without having to guess what wrote the file.
    schema_version: u32,
    updated_at: i64,
    /// Keyed by "provider/model".
    totals: BTreeMap<String, UsageTotalsRow>,
}

impl Default for UsageTotals {
    fn default() -> Self {
        Self {
            schema_version: 1,
            updated_at: 0,
            totals: BTreeMap::new(),
        }
    }
}

fn usage_number(usage: &Value, key: &str) -> i64 {
    usage
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as i64)
        .unwrap_or_default()
}

/// Fold one turn's usage into the totals. Pure, so it is testable without an
/// AppHandle — the same split `normalize_stored_messages` uses.
fn merge_turn_usage(totals: &mut UsageTotals, key: &str, usage: &Value) {
    let row = totals.totals.entry(key.to_string()).or_default();
    row.input += usage_number(usage, "input");
    row.output += usage_number(usage, "output");
    row.cache_read += usage_number(usage, "cacheRead");
    row.cache_write += usage_number(usage, "cacheWrite");
    row.total_tokens += usage_number(usage, "totalTokens");
    row.turns += 1;
}

fn usage_totals_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("usage-totals.json"))
}

fn load_usage_totals(app: &tauri::AppHandle) -> Result<UsageTotals, String> {
    let path = usage_totals_path(app)?;
    if !path.is_file() {
        return Ok(UsageTotals::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read usage totals: {error}"))?;
    // A corrupt odometer is not worth failing /status over.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn record_turn_usage(
    app: &tauri::AppHandle,
    provider: &str,
    model: &str,
    usage: &Value,
) -> Result<(), String> {
    let mut totals = load_usage_totals(app)?;
    merge_turn_usage(&mut totals, &format!("{provider}/{model}"), usage);
    totals.updated_at = now_ms();
    let path = usage_totals_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create app data directory: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(&totals)
        .map_err(|error| format!("Could not serialize usage totals: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not write usage totals: {error}"))
}

#[tauri::command]
fn read_usage_totals(app: tauri::AppHandle) -> Result<UsageTotals, String> {
    load_usage_totals(&app)
}

// ---------------------------------------------------------------------------
// Provider quota
//
// Only two providers can answer "what is left": ChatGPT reports rolling quota
// windows, and Kimi reports a dollar balance. Anthropic and api.openai.com have
// no balance endpoint for an ordinary key — the admin cost report needs a
// different credential — so they get an honest "unavailable" and a billing link
// rather than a number invented from local token counts.
//
// Credentials never leave this file: the command takes no token argument and
// returns percentages and dollars only.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct QuotaWindow {
    label: String,
    used_percent: f64,
    /// Epoch milliseconds, converted at this boundary so the renderer only ever
    /// deals in ms — ChatGPT reports seconds.
    resets_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProviderQuota {
    provider_id: String,
    provider_name: String,
    /// "windows" | "balance" | "unavailable"
    kind: String,
    message: Option<String>,
    console_url: Option<String>,
    plan: Option<String>,
    balance_usd: Option<f64>,
    voucher_balance_usd: Option<f64>,
    cash_balance_usd: Option<f64>,
    windows: Vec<QuotaWindow>,
    fetched_at: i64,
}

impl ProviderQuota {
    /// An empty `message` is deliberate silence: the section renders with its
    /// console link and no explanatory line.
    fn unavailable(provider_id: &str, message: &str) -> Self {
        let name = provider_preset(provider_id)
            .map(|preset| preset.name.to_string())
            .unwrap_or_else(|| provider_id.to_string());
        Self {
            provider_id: provider_id.to_string(),
            provider_name: name,
            kind: "unavailable".to_string(),
            message: Some(message.to_string()).filter(|text| !text.is_empty()),
            console_url: provider_billing_url(provider_id).map(str::to_string),
            plan: None,
            balance_usd: None,
            voucher_balance_usd: None,
            cash_balance_usd: None,
            windows: Vec::new(),
            fetched_at: now_ms(),
        }
    }
}

/// Where a user tops up or inspects spend. Deliberately not `api_key_url`, which
/// points at key management — a different page from billing.
fn provider_billing_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "claude" => Some("https://console.anthropic.com/settings/billing"),
        "openai" => Some("https://platform.openai.com/settings/organization/billing/overview"),
        "moonshot" | "kimi" => Some("https://platform.moonshot.ai/console/pay"),
        "openai-codex" => Some("https://chatgpt.com/codex/settings/usage"),
        _ => None,
    }
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => continue,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// The ChatGPT account id carried inside the access token.
///
/// The stored credential's `accountId` depends on what the login helper returned
/// and is often absent; pi's own Codex provider reads it out of the JWT for the
/// same reason. Without it the usage endpoint answers 401.
fn account_id_from_access_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64url_decode(payload)?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn format_quota_window(seconds: i64) -> String {
    match seconds {
        s if s <= 0 => "Current window".to_string(),
        s if s % 604_800 == 0 && s / 604_800 == 1 => "Weekly".to_string(),
        s if s % 86_400 == 0 => {
            let days = s / 86_400;
            format!("{days} day{}", if days == 1 { "" } else { "s" })
        }
        s if s % 3_600 == 0 => {
            let hours = s / 3_600;
            format!("{hours} hour{}", if hours == 1 { "" } else { "s" })
        }
        s => format!("{} minutes", s / 60),
    }
}

fn parse_quota_window(value: &Value, fallback_label: &str) -> Option<QuotaWindow> {
    // No synthesized zeros: a meter reading 0% because the field moved is worse
    // than saying the number is unavailable, because the user would act on it.
    let used_percent = value.get("used_percent").and_then(Value::as_f64)?;
    let resets_at = value
        .get("reset_at")
        .and_then(Value::as_i64)
        // ChatGPT reports unix seconds; the renderer only handles ms.
        .map(|seconds| seconds * 1000)
        .or_else(|| {
            // The streamed form gives a relative offset instead of an instant.
            value
                .get("reset_after_seconds")
                .and_then(Value::as_i64)
                .map(|seconds| now_ms() + seconds * 1000)
        });
    // `window_minutes` is what the live wire format uses (10080 == weekly);
    // `limit_window_seconds` appears in the REST shape. Accept either.
    let label = value
        .get("window_minutes")
        .and_then(Value::as_i64)
        .map(|minutes| minutes.saturating_mul(60))
        .or_else(|| value.get("limit_window_seconds").and_then(Value::as_i64))
        .map(format_quota_window)
        .unwrap_or_else(|| fallback_label.to_string());
    Some(QuotaWindow {
        label,
        used_percent,
        resets_at,
    })
}

/// ChatGPT's quota report.
///
/// Two shapes are accepted deliberately. The `codex.rate_limits` event pi
/// receives on the chat stream nests the numbers under `rate_limits.primary` /
/// `.secondary` and names the window `window_minutes`; the REST usage endpoint
/// reports them at the top level with `limit_window_seconds`. Neither is a
/// documented API, so parsing both is what keeps this working when one moves.
fn parse_chatgpt_usage(payload: &Value) -> Option<ProviderQuota> {
    let limits = payload.get("rate_limits").unwrap_or(payload);
    let mut windows = Vec::new();

    let primary = limits.get("primary").unwrap_or(limits);
    if let Some(window) = parse_quota_window(primary, "Current window") {
        windows.push(window);
    }
    if let Some(window) = limits
        .get("secondary")
        .and_then(|value| parse_quota_window(value, "Weekly"))
    {
        windows.push(window);
    }
    for extra in payload
        .get("additional_rate_limits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if let Some(window) = parse_quota_window(extra, "Additional limit") {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return None;
    }

    // `credits.balance` arrives as a string.
    let credits = payload
        .get("credits")
        .filter(|credits| {
            credits
                .get("has_credits")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|credits| credits.get("balance"))
        .and_then(|balance| {
            balance
                .as_f64()
                .or_else(|| balance.as_str().and_then(|raw| raw.parse::<f64>().ok()))
        });

    Some(ProviderQuota {
        provider_id: "openai-codex".to_string(),
        provider_name: "ChatGPT".to_string(),
        kind: "windows".to_string(),
        message: None,
        console_url: provider_billing_url("openai-codex").map(str::to_string),
        plan: payload
            .get("plan_type")
            .or_else(|| payload.get("plan"))
            .and_then(Value::as_str)
            .map(str::to_string),
        balance_usd: credits,
        voucher_balance_usd: None,
        cash_balance_usd: None,
        windows,
        fetched_at: now_ms(),
    })
}

fn parse_moonshot_balance(payload: &Value) -> Option<ProviderQuota> {
    if payload.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return None;
    }
    let data = payload.get("data")?;
    let available = data.get("available_balance").and_then(Value::as_f64)?;
    Some(ProviderQuota {
        provider_id: "moonshot".to_string(),
        provider_name: "Kimi".to_string(),
        kind: "balance".to_string(),
        message: None,
        console_url: provider_billing_url("moonshot").map(str::to_string),
        plan: None,
        balance_usd: Some(available),
        voucher_balance_usd: data.get("voucher_balance").and_then(Value::as_f64),
        cash_balance_usd: data.get("cash_balance").and_then(Value::as_f64),
        windows: Vec::new(),
        fetched_at: now_ms(),
    })
}

/// In-memory only. A shape change self-heals on the next launch instead of
/// persisting a bad parse to disk.
#[derive(Default)]
struct ProviderQuotaCache(Mutex<HashMap<String, ProviderQuota>>);

const QUOTA_CACHE_MS: i64 = 60_000;
// A failed lookup expires sooner so a user who just reconnected is not made to
// wait out a full minute.
const QUOTA_CACHE_FAILURE_MS: i64 = 15_000;

async fn fetch_chatgpt_quota() -> ProviderQuota {
    let unavailable = |message: &str| ProviderQuota::unavailable("openai-codex", message);
    let Ok(token) = resolve_provider_access_token("openai-codex").await else {
        return unavailable("Sign in to ChatGPT to see your usage.");
    };
    let account_id = match read_provider_credential("openai-codex") {
        Some(StoredCredential::OAuth {
            account_id: Some(id),
            ..
        }) if !id.is_empty() => id,
        _ => match account_id_from_access_token(&token) {
            Some(id) => id,
            None => return unavailable("Usage is unavailable for this account."),
        },
    };
    let base_url = provider_preset("openai-codex")
        .map(|preset| preset.base_url.to_string())
        .unwrap_or_default();
    let response = reqwest::Client::new()
        .get(format!("{base_url}/wham/usage"))
        .bearer_auth(&token)
        .header("chatgpt-account-id", account_id)
        .header("originator", "raynard")
        .send()
        .await;
    // Deliberately not quoting any response body: it carries account metadata
    // and an error body may echo the bearer.
    let Ok(response) = response else {
        return unavailable("Could not reach ChatGPT to read your usage.");
    };
    if !response.status().is_success() {
        // Silent: the endpoint is undocumented and may simply not answer for
        // this account. The console link is more use than a line of apology.
        return unavailable("");
    }
    let Ok(payload) = response.json::<Value>().await else {
        return unavailable("ChatGPT returned an unreadable usage response.");
    };
    parse_chatgpt_usage(&payload).unwrap_or_else(|| unavailable(""))
}

async fn fetch_moonshot_quota(api_key: &str) -> ProviderQuota {
    let unavailable = |message: &str| ProviderQuota::unavailable("moonshot", message);
    if api_key.is_empty() {
        return unavailable("Add a Kimi API key to see your balance.");
    }
    let base_url = provider_preset("moonshot")
        .map(|preset| preset.base_url.to_string())
        .unwrap_or_default();
    let response = reqwest::Client::new()
        .get(format!("{base_url}/users/me/balance"))
        .bearer_auth(api_key)
        .send()
        .await;
    let Ok(response) = response else {
        return unavailable("Could not reach Kimi to read your balance.");
    };
    if !response.status().is_success() {
        return unavailable("Kimi did not report a balance for this key.");
    }
    let Ok(payload) = response.json::<Value>().await else {
        return unavailable("Kimi returned an unreadable balance response.");
    };
    parse_moonshot_balance(&payload)
        .unwrap_or_else(|| unavailable("Kimi did not report a balance for this key."))
}

#[tauri::command]
async fn read_provider_quota(
    app: tauri::AppHandle,
    cache: tauri::State<'_, ProviderQuotaCache>,
) -> Result<ProviderQuota, String> {
    // The active provider is resolved here rather than passed in: naming one
    // would be an extra argument to validate and a way to probe providers the
    // user is not using.
    let config = resolve_model_config(Some(&app))?;
    let provider_id = config.provider.clone();

    if let Ok(entry) = cache.0.lock() {
        if let Some(hit) = entry.get(&provider_id) {
            let ttl = if hit.kind == "unavailable" {
                QUOTA_CACHE_FAILURE_MS
            } else {
                QUOTA_CACHE_MS
            };
            if now_ms() - hit.fetched_at < ttl {
                return Ok(hit.clone());
            }
        }
    }

    let quota = match provider_id.as_str() {
        "openai-codex" => fetch_chatgpt_quota().await,
        "moonshot" | "kimi" => fetch_moonshot_quota(&config.api_key).await,
        other => ProviderQuota::unavailable(
            other,
            "This provider does not publish a balance through its API.",
        ),
    };

    if let Ok(mut entry) = cache.0.lock() {
        entry.insert(provider_id, quota.clone());
    }
    Ok(quota)
}

fn save_role_model_config(
    app: &tauri::AppHandle,
    role: &str,
    provider_id: &str,
    model: Option<String>,
) -> Result<(), String> {
    let mut config = load_app_config(app)?;
    let preset = provider_preset(provider_id)
        .ok_or_else(|| format!("Unsupported provider: {provider_id}"))?;
    let cleaned_model = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    match role.trim().to_lowercase().as_str() {
        // One provider serves the whole app. The two config fields stay split
        // so a future release can separate the roles again without a migration,
        // but nothing in the UI writes them apart any more.
        "both" | "all" => {
            config.active_provider = Some(provider_id.to_string());
            config.active_model = Some(
                cleaned_model
                    .clone()
                    .unwrap_or_else(|| preset.default_chat_model.to_string()),
            );
            config.active_coding_provider = Some(provider_id.to_string());
            config.active_coding_model =
                Some(cleaned_model.unwrap_or_else(|| preset.default_coding_model.to_string()));
        }
        "coding" | "build" => {
            config.active_coding_provider = Some(provider_id.to_string());
            config.active_coding_model =
                Some(cleaned_model.unwrap_or_else(|| preset.default_coding_model.to_string()));
        }
        "chat" | "explore" => {
            config.active_provider = Some(provider_id.to_string());
            config.active_model =
                Some(cleaned_model.unwrap_or_else(|| preset.default_chat_model.to_string()));
        }
        _ => return Err("Model role must be chat, coding, or both.".to_string()),
    }

    save_app_config(app, config)
}

fn keyring_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("Could not open OS keychain entry: {error}"))
}

/// The one keychain item that holds every secret this app stores.
///
/// macOS authorizes per item, per app: with a keychain item per provider and
/// per plugin credential, a cold run cost one password prompt per stored
/// secret — three here, more as plugins with keys are added — and no amount of
/// caching afterwards could bring that below one prompt each. One item is one
/// prompt, whatever the user has configured.
const KEYCHAIN_ACCOUNT: &str = "secrets";

/// Every secret, keyed by the account name it used to have its own item under.
///
/// Loaded whole on the first read and kept for the run. Writes update it and
/// persist the whole item, so the cache is never dropped and never stale — the
/// value written is the value cached. A secret changed outside the app —
/// directly in Keychain Access — is picked up on next launch.
///
/// The key space is shared between providers and plugins, which is safe because
/// `plugin_credential_account` forces a `plugin:` prefix that no provider id can
/// produce.
static KEYCHAIN_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The whole vault, reading and migrating it at most once per run.
fn load_keychain_vault() -> HashMap<String, String> {
    if let Ok(cache) = KEYCHAIN_CACHE.lock() {
        if let Some(entries) = cache.as_ref() {
            return entries.clone();
        }
    }

    let raw = keyring_entry(KEYCHAIN_ACCOUNT)
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|error| format!("Could not read OS keychain entry: {error}"))
        })
        .unwrap_or_default();
    let entries: HashMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();

    if let Ok(mut cache) = KEYCHAIN_CACHE.lock() {
        *cache = Some(entries.clone());
    }
    entries
}

/// Persist the vault and keep the in-memory copy in step.
fn store_keychain_vault(entries: HashMap<String, String>) -> Result<(), String> {
    let serialized = serde_json::to_string(&entries)
        .map_err(|error| format!("Could not serialize the stored credentials: {error}"))?;
    keyring_entry(KEYCHAIN_ACCOUNT)
        .and_then(|entry| {
            entry
                .set_password(&serialized)
                .map_err(|error| format!("Could not write the OS keychain entry: {error}"))
        })
        .map_err(|error| format!("Could not store the credential in the OS keychain: {error}"))?;
    if let Ok(mut cache) = KEYCHAIN_CACHE.lock() {
        *cache = Some(entries);
    }
    Ok(())
}

/// Read one secret. Costs at most one prompt per app run, for the first read.
fn read_keychain_account(account: &str) -> String {
    let vault = load_keychain_vault();
    if let Some(hit) = vault.get(account) {
        return hit.clone();
    }
    migrate_legacy_keychain_account(account)
}

/// Folds a secret still stored under its own item into the vault.
///
/// Each of these costs the one prompt its own item always did, once, and then
/// the item is removed so nothing reads it again. Leaving it behind would mean
/// a signed-out provider's key survived in the keychain.
fn migrate_legacy_keychain_account(account: &str) -> String {
    let Ok(entry) = keyring_entry(account) else {
        return String::new();
    };
    let value = entry.get_password().unwrap_or_default().trim().to_string();
    if value.is_empty() {
        // Cache the miss: "not configured" badges re-read exactly these
        // accounts on every render, and a missing item is still a lookup.
        let mut vault = load_keychain_vault();
        vault.insert(account.to_string(), String::new());
        if let Ok(mut cache) = KEYCHAIN_CACHE.lock() {
            *cache = Some(vault);
        }
        return String::new();
    }

    let mut vault = load_keychain_vault();
    vault.insert(account.to_string(), value.clone());
    if store_keychain_vault(vault).is_ok() {
        let _ = entry.delete_credential();
    }
    value
}

/// Store one secret, replacing whatever was there.
fn write_keychain_account(account: &str, value: &str) -> Result<(), String> {
    let mut vault = load_keychain_vault();
    vault.insert(account.to_string(), value.to_string());
    store_keychain_vault(vault)
}

/// Remove one secret, including a copy still under its own legacy item.
fn delete_keychain_account(account: &str) -> Result<(), String> {
    let mut vault = load_keychain_vault();
    vault.insert(account.to_string(), String::new());
    store_keychain_vault(vault)?;
    if let Ok(entry) = keyring_entry(account) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// What one provider account holds in the keychain.
///
/// API keys have always been stored as the bare key string. OAuth needs three
/// values that rotate together, so it is stored as a tagged JSON object under
/// the same account. Anything that does not parse as that object is a key the
/// user pasted before this existed, which is why there is no migration step.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum StoredCredential {
    #[serde(rename = "api_key")]
    ApiKey { key: String },
    #[serde(rename = "oauth", rename_all = "camelCase")]
    OAuth {
        access: String,
        refresh: String,
        /// Access-token expiry, milliseconds since the epoch.
        expires: i64,
        #[serde(default)]
        account_id: Option<String>,
    },
}

fn parse_stored_credential(raw: &str) -> Option<StoredCredential> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with('{') {
        return serde_json::from_str(raw).ok();
    }
    Some(StoredCredential::ApiKey {
        key: raw.to_string(),
    })
}

fn read_provider_credential(provider_id: &str) -> Option<StoredCredential> {
    parse_stored_credential(&read_keychain_account(provider_id))
}

fn write_provider_credential(
    provider_id: &str,
    credential: &StoredCredential,
) -> Result<(), String> {
    let serialized = match credential {
        // Kept as a bare string so a downgrade, or Keychain Access, still shows
        // the key the user pasted.
        StoredCredential::ApiKey { key } => key.clone(),
        StoredCredential::OAuth { .. } => serde_json::to_string(credential)
            .map_err(|error| format!("Could not serialize the stored credential: {error}"))?,
    };
    write_keychain_account(provider_id, &serialized)
}

fn forget_provider_credential(provider_id: &str) -> Result<(), String> {
    delete_keychain_account(provider_id)
}

/// The pasteable API key for a provider, or "" when there is none.
///
/// An OAuth credential deliberately yields "": its access token rotates and is
/// resolved per turn by `resolve_provider_access_token`, and returning the JSON
/// envelope here would send a blob of JSON as a bearer token.
fn read_provider_api_key(provider_id: &str) -> String {
    match read_provider_credential(provider_id) {
        Some(StoredCredential::ApiKey { key }) => key,
        _ => String::new(),
    }
}

/// Builds the keychain account for one plugin credential.
///
/// The keychain service is shared with the model providers, whose accounts are
/// bare ids like "openai". Namespacing plus rejecting ':' in either component
/// makes it impossible for a generated manifest to address — and so overwrite
/// or delete — the user's model API key.
fn plugin_credential_account(plugin_id: &str, key: &str) -> Result<String, String> {
    let plugin_id = plugin_id.trim();
    let key = key.trim();
    if plugin_id.is_empty() {
        return Err("Plugin id is required.".to_string());
    }
    if plugin_id.len() > 128 || plugin_id.contains(':') || plugin_id.contains(char::is_whitespace) {
        return Err(format!("Invalid plugin id for a credential: {plugin_id}"));
    }
    if !is_valid_credential_key(key) {
        return Err(format!(
            "Invalid credential key: {key}. Use uppercase letters, digits, and underscores."
        ));
    }
    Ok(format!("plugin:{plugin_id}:{key}"))
}

fn read_plugin_credential(plugin_id: &str, key: &str) -> String {
    let Ok(account) = plugin_credential_account(plugin_id, key) else {
        return String::new();
    };
    read_keychain_account(&account)
}

/// Adds resolved credential values, and the declarations still missing one, to
/// an already-serialized plugin bound for an agent sidecar.
///
/// This deliberately mutates the JSON rather than living on `GeneratedPlugin`:
/// the same struct is serialized to the webview, so a field there would leak
/// every secret into the renderer on plugin-sidebar load.
fn attach_plugin_credential_values(serialized: &mut Value, plugin: &GeneratedPlugin) {
    let Some(object) = serialized.as_object_mut() else {
        return;
    };
    let mut values = serde_json::Map::new();
    let mut missing = Vec::new();
    for credential in &plugin.credentials {
        let value = read_plugin_credential(&plugin.id, &credential.key);
        if value.is_empty() {
            missing.push(json!({
                "key": credential.key,
                "label": credential.label,
                "description": credential.description,
                "signupUrl": credential.signup_url,
            }));
        } else {
            values.insert(credential.key.clone(), Value::String(value));
        }
    }
    object.insert("credentialValues".to_string(), Value::Object(values));
    object.insert("missingCredentials".to_string(), Value::Array(missing));
}

fn forget_plugin_credential(plugin_id: &str, key: &str) -> Result<(), String> {
    let account = plugin_credential_account(plugin_id, key)?;
    delete_keychain_account(&account)
        .map_err(|error| format!("Could not remove the API key from the OS keychain: {error}"))
}

/// Fills in which declared credentials the user has actually stored. Reads the
/// keychain, so it is called on the paths that serve the UI rather than inside
/// the manifest parser.
fn annotate_plugin_credentials(plugin: &mut GeneratedPlugin) {
    let plugin_id = plugin.id.clone();
    for credential in &mut plugin.credentials {
        credential.configured = !read_plugin_credential(&plugin_id, &credential.key).is_empty();
    }
}

fn read_env_file() -> Result<BTreeMap<String, String>, String> {
    let Some(path) = find_env_file() else {
        return Ok(BTreeMap::new());
    };

    let entries = dotenvy::from_path_iter(path)
        .map_err(|error| format!("Could not read .env: {error}"))?
        .filter_map(Result::ok)
        .collect::<BTreeMap<String, String>>();

    Ok(entries)
}

fn env_value(entries: &BTreeMap<String, String>, key: &str) -> String {
    entries
        .get(key)
        .cloned()
        .or_else(|| env::var(key).ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn first_env_value(entries: &BTreeMap<String, String>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| env_value(entries, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn resolve_model_config(app: Option<&tauri::AppHandle>) -> Result<ModelConfig, String> {
    resolve_model_config_for_role(app, "chat")
}

fn resolve_coding_model_config(app: Option<&tauri::AppHandle>) -> Result<ModelConfig, String> {
    resolve_model_config_for_role(app, "coding")
}

fn resolve_model_config_for_role(
    app: Option<&tauri::AppHandle>,
    role: &str,
) -> Result<ModelConfig, String> {
    let entries = read_env_file()?;
    let is_coding = matches!(role, "coding" | "build");
    let env_provider = if is_coding {
        first_env_value(
            &entries,
            &[
                "STOCKBOT_CODING_PROVIDER",
                "STOCKBOT_BUILD_PROVIDER",
                "STOCKBOT_DEFAULT_PROVIDER",
                "STOCKBOT_MODEL_PROVIDER",
            ],
        )
    } else {
        first_env_value(
            &entries,
            &["STOCKBOT_DEFAULT_PROVIDER", "STOCKBOT_MODEL_PROVIDER"],
        )
    };
    let app_config = app.and_then(|handle| load_app_config(handle).ok());
    let app_provider = app_config.as_ref().and_then(|config| {
        if is_coding {
            config
                .active_coding_provider
                .clone()
                .or_else(|| config.active_provider.clone())
        } else {
            config.active_provider.clone()
        }
    });
    let configured_provider = app_provider.clone().unwrap_or(env_provider);
    let provider = canonical_provider_id(&configured_provider);
    let preset = provider_preset(&provider)
        .unwrap_or_else(|| provider_preset("moonshot").expect("moonshot preset"));
    let keyring_api_key = read_provider_api_key(preset.id);
    let env_api_key = first_env_value(&entries, preset.api_key_names);

    let configured_base_url = if is_coding {
        first_env_value(
            &entries,
            &[
                "STOCKBOT_CODING_BASE_URL",
                "STOCKBOT_BUILD_BASE_URL",
                "STOCKBOT_MODEL_BASE_URL",
            ],
        )
    } else {
        first_env_value(&entries, &["STOCKBOT_MODEL_BASE_URL"])
    };
    let provider_model_keys = match preset.id {
        "openai" => &["OPENAI_MODEL"][..],
        "claude" => &["ANTHROPIC_MODEL", "CLAUDE_MODEL"][..],
        "moonshot" => &["MOONSHOT_MODEL", "KIMI_MODEL"][..],
        _ => &[][..],
    };
    let configured_model = app_config
        .as_ref()
        .and_then(|config| {
            if is_coding {
                config.active_coding_model.clone()
            } else {
                config.active_model.clone()
            }
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if is_coding {
                first_env_value(
                    &entries,
                    &[
                        "STOCKBOT_CODING_MODEL",
                        "STOCKBOT_BUILD_MODEL",
                        "KIMI_CODING_MODEL",
                    ],
                )
            } else {
                first_env_value(&entries, provider_model_keys)
            }
        });
    let legacy_configured_model = if app_provider.is_some() {
        String::new()
    } else if is_coding {
        first_env_value(&entries, &["STOCKBOT_CODING_MODEL", "STOCKBOT_BUILD_MODEL"])
    } else {
        first_env_value(&entries, &["STOCKBOT_DEFAULT_MODEL"])
    };
    let configured_model = if configured_model.is_empty() {
        legacy_configured_model
    } else {
        configured_model
    };

    Ok(ModelConfig {
        provider: preset.id.to_string(),
        base_url: if configured_base_url.is_empty() {
            preset.base_url.to_string()
        } else {
            configured_base_url.trim_end_matches('/').to_string()
        },
        model: if configured_model.is_empty() {
            if is_coding {
                preset.default_coding_model.to_string()
            } else {
                preset.default_chat_model.to_string()
            }
        } else {
            configured_model
        },
        // An OAuth provider has no key here: its access token rotates, so the
        // stream commands fill this in per turn via
        // `resolve_provider_access_token`.
        api_key: if keyring_api_key.is_empty() {
            env_api_key
        } else {
            keyring_api_key
        },
        auth_method: preset.auth_method,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        account_id_from_access_token, all_bookmarks, bookmark_page, bookmark_titles_path,
        build_plugin_tools_stub, canonical_provider_id, clear_plugin_api_cache,
        ensure_shared_plugin_sdk, external_url_target, externalize_large_card_data_in,
        externalize_result_data_in, format_quota_window, generated_plugin_source_mtime_millis,
        install_catalog_extension_from, installed_manifest_version, load_bookmark_cache_in,
        load_generated_plugin_runtime_tools_cached, load_or_rebuild_chat_history_index_in,
        memory_path_in, merge_turn_usage, migrate_deprecated_model_id, next_available_plugin_slug,
        normalize_bookmark, normalize_bookmark_title, normalize_memory, normalize_memory_scope,
        normalize_plugin_display_name, normalize_plugin_slug, normalize_stored_messages,
        now_millis, oauth_needs_refresh, packaged_node_path_for, packaged_runtime_scripts_dir_for,
        parse_chatgpt_usage, parse_moonshot_balance, parse_stored_credential,
        plugin_credential_account, provider_preset, read_bookmark_titles_in,
        read_cached_bookmark_title, read_catalog_extension_detail_from, read_catalog_extensions,
        read_generated_plugin_manifest, read_keychain_account, read_plugin_cache_settings,
        rebuild_chat_history_index_in, remove_chat_history_index_row_in,
        rename_generated_plugin_in, save_plugin_cache_settings, select_memories_for_turn,
        select_runtime_script_path, set_chat_history_unread_in, share_deep_link_payload,
        steer_command_type, update_catalog_extension_from, upsert_bookmark_cache,
        upsert_chat_history_index_in, write_bookmark_in, write_bookmark_title_in, AuthMethod,
        BookmarkCache, BuilderStreamEvent, ChatHistoryRow, GeneratedPluginTool,
        PluginBuilderRequest, PluginCacheSettings, ProviderQuota, RuntimeToolsCache,
        StoredBookmark, StoredChatMessage, StoredCredential, StoredMemory, StreamEvent,
        UsageTotals, APP_URL_SCHEME, BOOKMARK_TITLE_CACHE_LIMIT, KEYCHAIN_CACHE,
        OAUTH_REFRESH_MARGIN_MS,
    };
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    #[test]
    fn terminal_main_agent_text_replaces_intermediate_tool_round_narration() {
        let mut answer = String::new();
        super::apply_main_agent_text_event(
            &mut answer,
            "delta",
            Some("Let me search for an OECD source:"),
            None,
        );
        super::apply_main_agent_text_event(
            &mut answer,
            "done",
            None,
            Some("```chart\n{\"type\":\"bar\"}\n```"),
        );

        assert_eq!(answer, "```chart\n{\"type\":\"bar\"}\n```");
    }

    /// A channel that records what it was sent, so buffering can be observed.
    fn recording_channel() -> (tauri::ipc::Channel<String>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(raw) = body {
                if let Ok(value) = serde_json::from_str::<String>(&raw) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        (channel, seen)
    }

    #[test]
    fn deep_links_buffer_until_the_renderer_subscribes() {
        let state = super::PendingDeepLinks::default();

        // Nothing is listening yet: a cold-launch URL has to survive the wait.
        assert!(state.push("raynard://share/AAA".to_string()).is_none());
        assert!(state.push("raynard://share/BBB".to_string()).is_none());

        let (channel, _seen) = recording_channel();
        let drained = state.subscribe(channel);
        assert_eq!(drained, vec!["raynard://share/AAA", "raynard://share/BBB"]);
    }

    #[test]
    fn deep_links_go_straight_out_once_subscribed() {
        let state = super::PendingDeepLinks::default();
        let (channel, seen) = recording_channel();
        assert!(state.subscribe(channel).is_empty());

        let live = state.push("raynard://share/CCC".to_string());
        assert!(
            live.is_some(),
            "a subscribed channel must be returned, not buffered"
        );
        live.unwrap()
            .send("raynard://share/CCC".to_string())
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec!["raynard://share/CCC"]);
    }

    #[test]
    fn subscribing_again_replaces_the_channel_without_replaying() {
        let state = super::PendingDeepLinks::default();
        state.push("raynard://share/AAA".to_string());

        let (first, _first_seen) = recording_channel();
        assert_eq!(state.subscribe(first).len(), 1);

        // A reload must not receive the link a second time.
        let (second, _second_seen) = recording_channel();
        assert!(state.subscribe(second).is_empty());
    }

    #[test]
    fn share_deep_links_accept_only_the_canonical_form() {
        assert_eq!(
            share_deep_link_payload("raynard://share/AbC-_123", APP_URL_SCHEME),
            Some("AbC-_123")
        );
        // Handlers routinely lowercase the scheme and host.
        assert_eq!(
            share_deep_link_payload("Raynard://Share/AbC", APP_URL_SCHEME),
            Some("AbC")
        );
        assert_eq!(
            share_deep_link_payload("  raynard://share/AbC/  ", APP_URL_SCHEME),
            Some("AbC")
        );
    }

    #[test]
    fn share_deep_links_refuse_anything_else() {
        for url in [
            "https://raynard.ai/s#AbC",
            "raynard://open/AbC",
            "raynard://share/",
            "raynard://share/AbC+def=",
            "raynard://share/../../etc/passwd",
            "raynard://share/AbC?x=1",
            "",
            "raynard://",
        ] {
            assert!(
                share_deep_link_payload(url, APP_URL_SCHEME).is_none(),
                "should have refused {url}"
            );
        }

        let huge = format!("raynard://share/{}", "A".repeat(70_000));
        assert!(share_deep_link_payload(&huge, APP_URL_SCHEME).is_none());
    }

    #[test]
    fn share_deep_links_accept_a_payload_far_larger_than_the_url_budget() {
        // macOS was measured delivering 262 000+ character URLs, and the share
        // budget is 8192, so the guard must not be the binding constraint.
        let url = format!("raynard://share/{}", "A".repeat(32_768));
        assert!(share_deep_link_payload(&url, APP_URL_SCHEME).is_some());
    }

    #[test]
    fn packaged_paths_match_platform_bundle_layouts() {
        let executable = Path::new("/Applications/Raynard.app/Contents/MacOS/raynard");
        let resource_dir = Path::new("/Applications/Raynard.app/Contents/Resources");

        assert_eq!(
            packaged_runtime_scripts_dir_for(resource_dir),
            PathBuf::from("/Applications/Raynard.app/Contents/Resources/agent-runtime/scripts")
        );
        assert_eq!(
            packaged_node_path_for(executable, "node"),
            Some(PathBuf::from(
                "/Applications/Raynard.app/Contents/MacOS/node"
            ))
        );
        assert_eq!(
            packaged_runtime_scripts_dir_for(Path::new("C:/Users/example/AppData/Local/Raynard")),
            PathBuf::from("C:/Users/example/AppData/Local/Raynard/agent-runtime/scripts")
        );
        assert_eq!(
            packaged_node_path_for(
                Path::new("C:/Program Files/Raynard/raynard.exe"),
                "node.exe",
            ),
            Some(PathBuf::from("C:/Program Files/Raynard/node.exe"))
        );
    }

    #[test]
    fn packaged_paths_are_absent_for_a_rootless_executable() {
        assert_eq!(
            packaged_node_path_for(Path::new("raynard"), "node"),
            Some(PathBuf::from("node"))
        );
    }

    #[test]
    fn development_prefers_live_sidecars_while_release_prefers_bundled_copies() {
        let root = std::env::temp_dir().join(format!(
            "raynard-sidecar-resolution-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let current = root.join("project");
        let live = current.join("scripts").join("main-agent-sidecar.mjs");
        let resources = root.join("resources");
        let bundled = packaged_runtime_scripts_dir_for(&resources).join("main-agent-sidecar.mjs");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&live, "// live").unwrap();
        fs::write(&bundled, "// stale staged copy").unwrap();

        assert_eq!(
            select_runtime_script_path(&current, Some(&resources), "main-agent-sidecar.mjs", true,),
            Some(live.clone())
        );
        assert_eq!(
            select_runtime_script_path(&current, Some(&resources), "main-agent-sidecar.mjs", false,),
            Some(bundled)
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn large_stream_result_data_moves_to_an_artifact() {
        let root = std::env::temp_dir().join(format!(
            "raynard-result-artifact-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let mut result = json!({
            "text": "A bounded summary",
            "data": { "rows": [{ "payload": "x".repeat(140_000) }] }
        });

        let reference = externalize_result_data_in(&root, "chat-one", "stream-one-0", &mut result)
            .expect("large data should be externalized")
            .expect("large data should return an artifact reference");

        assert_eq!(result["data"], json!({}));
        assert_eq!(result["dataArtifact"], reference);
        let artifact_path = root.join("chat-one").join("stream-one-0.json");
        let stored: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(artifact_path).expect("artifact should be written"),
        )
        .expect("artifact should contain JSON");
        assert_eq!(
            stored["rows"][0]["payload"].as_str().unwrap().len(),
            140_000
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn saving_a_legacy_chat_externalizes_large_inline_card_data() {
        let root = std::env::temp_dir().join(format!(
            "raynard-legacy-artifact-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let mut messages = vec![StoredChatMessage {
            role: "assistant".to_string(),
            text: "Answer".to_string(),
            timestamp: 7,
            thinking: None,
            provider: None,
            model: None,
            status: Some("completed".to_string()),
            error: None,
            mode_status: None,
            model_failure: None,
            builder_run: None,
            shared_import: None,
            builder_activities: None,
            cards: Some(json!([{
                "toolName": "large_tool",
                "template": { "name": { "singular": "row", "plural": "rows" }, "layout": [] },
                "data": { "rows": [{ "payload": "x".repeat(140_000) }] }
            }])),
            charts: None,
            sources: None,
            credential_request: None,
            extension_recommendation: None,
            scheduled_task_request: None,
            scheduled_task_id: None,
            scheduled_task_name: None,
            scheduled_execution_id: None,
            usage: None,
        }];

        assert!(
            externalize_large_card_data_in(&root, "chat-one", &mut messages)
                .expect("legacy cards should migrate")
        );
        let card = &messages[0].cards.as_ref().unwrap()[0];
        assert_eq!(card["data"], json!({}));
        assert_eq!(card["artifact"]["chatId"], "chat-one");
        assert!(root
            .join("chat-one")
            .join("message-0-card-0.json")
            .is_file());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn chat_history_index_rebuilds_once_then_avoids_reopening_chat_files() {
        let dir = std::env::temp_dir().join(format!(
            "raynard-chat-index-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        let chat_path = dir.join("chat-one.json");
        fs::write(
            &chat_path,
            json!({
                "chatId": "chat-one",
                "name": "Indexed chat",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-02T00:00:00Z",
                "messages": [{ "role": "user", "text": "Hello", "timestamp": 1 }]
            })
            .to_string(),
        )
        .unwrap();

        let first = load_or_rebuild_chat_history_index_in(&dir).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].name, "Indexed chat");
        assert_eq!(first[0].message_count, 1);
        assert!(dir.join("index.json").is_file());

        // Once the index exists, listing no longer needs to deserialize the
        // individual chat. A damaged file is left for open-chat error handling.
        fs::write(&chat_path, "not valid json").unwrap();
        let indexed = load_or_rebuild_chat_history_index_in(&dir).unwrap();
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].chat_id, "chat-one");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn chat_history_index_upserts_sorts_and_removes_rows() {
        let dir = std::env::temp_dir().join(format!(
            "raynard-chat-index-update-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        let row = |chat_id: &str, updated_at: &str, message_count: usize| ChatHistoryRow {
            chat_id: chat_id.to_string(),
            name: chat_id.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
            message_count,
            unread: false,
        };

        upsert_chat_history_index_in(&dir, row("older", "2026-01-02T00:00:00Z", 1)).unwrap();
        upsert_chat_history_index_in(&dir, row("newer", "2026-01-03T00:00:00Z", 2)).unwrap();
        upsert_chat_history_index_in(&dir, row("older", "2026-01-04T00:00:00Z", 3)).unwrap();

        let rows = load_or_rebuild_chat_history_index_in(&dir).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].chat_id, "older");
        assert_eq!(rows[0].message_count, 3);

        remove_chat_history_index_row_in(&dir, "older").unwrap();
        let rows = load_or_rebuild_chat_history_index_in(&dir).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chat_id, "newer");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unread_state_does_not_change_latest_turn_order() {
        let dir = std::env::temp_dir().join(format!(
            "raynard-chat-unread-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        for (chat_id, updated_at, timestamp) in [
            ("older", "2099-01-02T00:00:00Z", 1_767_312_000_000_i64),
            ("newer", "2099-01-03T00:00:00Z", 1_767_398_400_000_i64),
        ] {
            fs::write(
                dir.join(format!("{chat_id}.json")),
                json!({
                    "chatId": chat_id,
                    "name": chat_id,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": updated_at,
                    "messages": [{ "role": "assistant", "text": "Result", "timestamp": timestamp }]
                })
                .to_string(),
            )
            .unwrap();
        }

        rebuild_chat_history_index_in(&dir).unwrap();
        let unread = set_chat_history_unread_in(&dir, "older", true).unwrap();
        assert!(unread.unread);
        assert_eq!(unread.updated_at, "2026-01-02T00:00:00.000Z");

        let rows = load_or_rebuild_chat_history_index_in(&dir).unwrap();
        assert_eq!(rows[0].chat_id, "newer");
        assert!(rows[1].unread);

        let read = set_chat_history_unread_in(&dir, "older", false).unwrap();
        assert!(!read.unread);
        let stored: Value = serde_json::from_str(
            &fs::read_to_string(dir.join("older.json")).expect("chat should remain stored"),
        )
        .unwrap();
        assert_eq!(stored["unread"], false);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bookmark_store_is_lazy_ordered_and_paged() {
        let dir = std::env::temp_dir().join(format!(
            "raynard-bookmarks-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let bookmark = |chat_id: &str, key: &str, created_at: i64| StoredBookmark {
            id: format!("{chat_id}:{key}"),
            message_key: key.to_string(),
            chat_id: chat_id.to_string(),
            chat_name: format!("Chat {chat_id}"),
            title: format!("Title {key}"),
            prompt: format!("Prompt {key}"),
            answer: format!("Answer {key}"),
            message_timestamp: created_at - 10,
            created_at,
        };

        write_bookmark_in(&dir, &bookmark("chat-one", "old", 100)).unwrap();
        write_bookmark_in(&dir, &bookmark("chat-two", "new", 300)).unwrap();
        write_bookmark_in(&dir, &bookmark("chat-one", "middle", 200)).unwrap();

        let cache = load_bookmark_cache_in(&dir).unwrap();
        let first = bookmark_page(&cache, 0, 2);
        assert_eq!(first.total, 3);
        assert_eq!(first.bookmarks.len(), 2);
        assert_eq!(first.bookmarks[0].message_key, "new");
        assert_eq!(first.bookmarks[1].message_key, "middle");

        let second = bookmark_page(&cache, 2, 2);
        assert_eq!(second.bookmarks.len(), 1);
        assert_eq!(second.bookmarks[0].message_key, "old");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bookmark_titles_are_cached_beyond_the_bookmark_that_produced_them() {
        let root = std::env::temp_dir().join(format!("raynard-bookmark-titles-{}", now_millis()));
        fs::create_dir_all(&root).expect("create bookmarks root");

        assert_eq!(read_cached_bookmark_title(&root, "chat-one:key"), None);
        write_bookmark_title_in(&root, "chat-one:key", "Apple FY2024 margins").unwrap();
        assert_eq!(
            read_cached_bookmark_title(&root, "chat-one:key"),
            Some("Apple FY2024 margins".to_string())
        );
        assert_eq!(read_cached_bookmark_title(&root, "chat-one:other"), None);

        // The cache sits beside the per-chat directories and must stay invisible
        // to the loader that scans them.
        fs::create_dir_all(root.join("chat-one")).expect("create chat dir");
        let cache = load_bookmark_cache_in(&root).expect("load bookmarks");
        assert_eq!(bookmark_page(&cache, 0, 10).total, 0);

        // A corrupt cache costs a model call, never the bookmark.
        fs::write(bookmark_titles_path(&root), "{ not json").unwrap();
        assert_eq!(read_cached_bookmark_title(&root, "chat-one:key"), None);
        write_bookmark_title_in(&root, "chat-one:key", "Recovered title").unwrap();
        assert_eq!(
            read_cached_bookmark_title(&root, "chat-one:key"),
            Some("Recovered title".to_string())
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bookmark_title_cache_stays_bounded() {
        let root =
            std::env::temp_dir().join(format!("raynard-bookmark-title-cap-{}", now_millis()));
        fs::create_dir_all(&root).expect("create bookmarks root");
        for index in 0..(BOOKMARK_TITLE_CACHE_LIMIT + 25) {
            write_bookmark_title_in(&root, &format!("chat:{index}"), &format!("Title {index}"))
                .unwrap();
        }
        let cache = read_bookmark_titles_in(&root);
        assert_eq!(cache.titles.len(), BOOKMARK_TITLE_CACHE_LIMIT);
        let newest = format!("chat:{}", BOOKMARK_TITLE_CACHE_LIMIT + 24);
        assert!(cache.titles.contains_key(&newest));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bookmarks_saved_before_titles_still_load_and_normalize() {
        // Titles arrived after bookmarks did, so a stored file from an earlier
        // build has no `title` key at all. It must still deserialize.
        let stored: StoredBookmark = serde_json::from_value(json!({
            "id": "chat-one:key",
            "messageKey": "key",
            "chatId": "chat-one",
            "chatName": "Chat one",
            "prompt": "What are Apple margins?",
            "answer": "46.2% in FY2024.",
            "messageTimestamp": 10,
            "createdAt": 20
        }))
        .expect("deserialize a pre-title bookmark");
        assert_eq!(stored.title, "");
        assert_eq!(normalize_bookmark(stored).unwrap().title, "");

        assert_eq!(
            normalize_bookmark_title("  Apple   FY2024\n margins "),
            "Apple FY2024 margins"
        );
        assert_eq!(normalize_bookmark_title("   "), "");
        assert_eq!(
            normalize_bookmark_title(&"x".repeat(300)).chars().count(),
            120
        );
    }

    #[test]
    fn bookmark_pages_stay_bounded_for_large_collections() {
        let mut cache = BookmarkCache::default();
        for index in 0..10_000 {
            upsert_bookmark_cache(
                &mut cache,
                StoredBookmark {
                    id: format!("chat-one:key-{index}"),
                    message_key: format!("key-{index}"),
                    chat_id: "chat-one".to_string(),
                    chat_name: "Large chat".to_string(),
                    title: format!("Title {index}"),
                    prompt: format!("Prompt {index}"),
                    answer: format!("Answer {index}"),
                    message_timestamp: index + 1,
                    created_at: index + 1,
                },
            );
        }

        let page = bookmark_page(&cache, 0, 50);
        assert_eq!(page.total, 10_000);
        assert_eq!(page.bookmarks.len(), 50);
        assert_eq!(page.bookmarks[0].message_key, "key-9999");
    }

    #[test]
    fn bookmark_mention_list_returns_full_cache_unpaginated() {
        let mut cache = BookmarkCache::default();
        for index in 0..250 {
            upsert_bookmark_cache(
                &mut cache,
                StoredBookmark {
                    id: format!("chat-one:key-{index}"),
                    message_key: format!("key-{index}"),
                    chat_id: "chat-one".to_string(),
                    chat_name: "Large chat".to_string(),
                    title: format!("Title {index}"),
                    prompt: format!("Prompt {index}"),
                    answer: format!("Answer {index}"),
                    message_timestamp: index + 1,
                    created_at: index + 1,
                },
            );
        }

        // Unlike `bookmark_page`, which clamps `limit` to 100, the @-mention
        // listing must return every bookmark so client-side filtering has the
        // full collection to search as the user types.
        let all = all_bookmarks(&cache);
        assert_eq!(all.len(), 250);
    }

    fn draft_memory(content: &str, scope: &str) -> StoredMemory {
        StoredMemory {
            id: String::new(),
            scope: scope.to_string(),
            content: content.to_string(),
            scope_label: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn normalize_memory_rejects_empty_content() {
        let error = normalize_memory(draft_memory("   ", "global")).unwrap_err();
        assert!(error.contains("non-empty content"));
    }

    #[test]
    fn normalize_memory_trims_and_generates_id() {
        let memory = normalize_memory(draft_memory("  Prefers concise answers.  ", "")).unwrap();
        assert_eq!(memory.content, "Prefers concise answers.");
        // An empty scope falls back to global rather than being rejected.
        assert_eq!(memory.scope, "global");
        assert!(!memory.id.trim().is_empty());
        assert!(memory.created_at > 0);
        assert!(memory.updated_at > 0);
    }

    #[test]
    fn normalize_memory_scope_rejects_unsafe_characters() {
        assert!(normalize_memory_scope("world bank!").is_err());
        assert!(normalize_memory_scope("world-bank_api").is_ok());
    }

    #[test]
    fn memory_path_rejects_unsafe_scope_or_id() {
        // memory_path_in itself does not validate; normalize_memory_scope and
        // normalize_memory_id are the gate, exercised the same way
        // normalize_bookmark_key gates bookmark paths.
        assert!(normalize_memory_scope("../etc").is_err());
        let root = Path::new("/tmp/memories");
        let path = memory_path_in(root, "global", "mem-1-abc");
        assert_eq!(path, root.join("global").join("mem-1-abc.json"));
    }

    #[test]
    fn select_memories_for_turn_respects_global_and_per_plugin_caps() {
        let mut all = Vec::new();
        for index in 0..20 {
            let mut memory = draft_memory(&format!("global fact {index}"), "global");
            memory.id = format!("g{index}");
            memory.updated_at = index;
            all.push(memory);
        }
        for index in 0..10 {
            let mut memory = draft_memory(&format!("plugin fact {index}"), "world-bank");
            memory.id = format!("p{index}");
            memory.updated_at = index;
            all.push(memory);
        }

        let selected = select_memories_for_turn(&all, &["world-bank".to_string()], 10, 5, 20);
        let global_count = selected
            .iter()
            .filter(|memory| memory.scope == "global")
            .count();
        let plugin_count = selected
            .iter()
            .filter(|memory| memory.scope == "world-bank")
            .count();
        assert_eq!(global_count, 10);
        assert_eq!(plugin_count, 5);
    }

    #[test]
    fn select_memories_for_turn_orders_by_updated_at_desc() {
        let mut older = draft_memory("older", "global");
        older.id = "older".to_string();
        older.updated_at = 1;
        let mut newer = draft_memory("newer", "global");
        newer.id = "newer".to_string();
        newer.updated_at = 2;

        let selected = select_memories_for_turn(&[older, newer], &[], 10, 5, 20);
        assert_eq!(selected[0].id, "newer");
        assert_eq!(selected[1].id, "older");
    }

    #[test]
    fn select_memories_for_turn_excludes_scopes_not_currently_installed() {
        let mut memory = draft_memory("stale plugin fact", "removed-plugin");
        memory.id = "stale".to_string();
        memory.updated_at = 5;

        // "removed-plugin" is not in the active slug list, so it is excluded —
        // a memory scoped to an uninstalled plugin is never injected.
        let selected =
            select_memories_for_turn(&[memory], &["other-plugin".to_string()], 10, 5, 20);
        assert!(selected.is_empty());
    }

    #[test]
    fn external_url_target_accepts_only_plain_http_urls() {
        assert_eq!(
            external_url_target("https://data360api.worldbank.org/data360/data?REF_AREA=GBR"),
            Some("https://data360api.worldbank.org/data360/data?REF_AREA=GBR")
        );
        assert_eq!(
            external_url_target("  http://example.com/page  "),
            Some("http://example.com/page")
        );
        assert_eq!(
            external_url_target("HTTPS://example.com"),
            Some("HTTPS://example.com")
        );

        for rejected in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "/relative/path",
            "#section",
            "",
            "   ",
            "-flag",
            "https://example.com --background",
            "https://",
            "http:///no-host",
        ] {
            assert_eq!(
                external_url_target(rejected),
                None,
                "expected {rejected:?} to be refused"
            );
        }
    }

    #[test]
    fn plugin_builder_request_accepts_structured_card_edit_metadata() {
        let request: PluginBuilderRequest = serde_json::from_value(json!({
            "pluginDir": "/plugins/dnd-5e-api",
            "name": "dnd-5e-api",
            "description": "Move the monster image to the right.",
            "sourceUrls": [],
            "prompt": "Put the image on the right at 25% width.",
            "taskKind": "card-edit",
            "targetTools": ["dnd_get_monster"],
            "editMode": true,
            "messages": []
        }))
        .expect("deserialize builder request");

        assert_eq!(request.task_kind.as_deref(), Some("card-edit"));
        assert_eq!(
            request.target_tools,
            Some(vec!["dnd_get_monster".to_string()])
        );
    }

    #[test]
    fn runtime_tools_cache_is_used_when_source_is_unchanged() {
        let plugin_dir =
            std::env::temp_dir().join(format!("raynard-runtime-cache-{}", now_millis()));
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(plugin_dir.join("tools.ts"), "export const tools = {};\n")
            .expect("write tools.ts");

        let source_mtime =
            generated_plugin_source_mtime_millis(&plugin_dir).expect("read tools.ts mtime");
        let cache = RuntimeToolsCache {
            source_mtime,
            tools: vec![GeneratedPluginTool {
                name: "getThing".to_string(),
                description: "Fetch a thing".to_string(),
                parameters: json!({ "type": "object", "properties": {} }),
                card: json!({
                    "name": { "singular": "thing", "plural": "things" },
                    "layout": [{ "component": "Json" }]
                }),
            }],
        };
        fs::write(
            plugin_dir.join(".runtime-tools.json"),
            serde_json::to_string(&cache).expect("serialize cache"),
        )
        .expect("write cache");

        // A fresh cache short-circuits before any Node spawn, so a non-empty
        // result proves the cache was used.
        let tools =
            load_generated_plugin_runtime_tools_cached(&plugin_dir).expect("cached tools returned");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "getThing");

        fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
    }

    #[test]
    fn shared_plugin_sdk_is_installed_once_above_plugin_workspaces() {
        let root = std::env::temp_dir().join(format!("raynard-shared-sdk-{}", now_millis()));
        fs::create_dir_all(&root).expect("create generated plugin root");

        ensure_shared_plugin_sdk(&root).expect("install shared sdk");
        let sdk = root.join("node_modules/@raynard/plugin-sdk");
        assert!(root.join("package.json").is_file());
        assert!(sdk.join("package.json").is_file());
        assert!(sdk.join("index.js").is_file());
        assert!(sdk.join("index.d.ts").is_file());
        assert!(sdk.join("testing.js").is_file());
        assert!(sdk.join("testing.d.ts").is_file());

        fs::remove_dir_all(&root).expect("remove generated plugin root");
    }

    #[test]
    fn plugin_cache_settings_default_to_enabled_for_twenty_four_hours() {
        let data_dir =
            std::env::temp_dir().join(format!("raynard-plugin-cache-default-{}", now_millis()));
        let settings = read_plugin_cache_settings(&data_dir).expect("read default settings");
        assert_eq!(
            settings,
            PluginCacheSettings {
                enabled: true,
                ttl_hours: 24,
            }
        );
    }

    #[test]
    fn plugin_cache_settings_round_trip_and_clear_only_cached_responses() {
        let data_dir =
            std::env::temp_dir().join(format!("raynard-plugin-cache-roundtrip-{}", now_millis()));
        let settings = PluginCacheSettings {
            enabled: false,
            ttl_hours: 72,
        };
        save_plugin_cache_settings(&data_dir, &settings).expect("save settings");
        assert_eq!(
            read_plugin_cache_settings(&data_dir).expect("read settings"),
            settings
        );

        let cache_dir = data_dir.join("api-cache");
        fs::create_dir_all(&cache_dir).expect("create cache dir");
        fs::write(cache_dir.join("entry.json"), "{}").expect("write cache entry");
        clear_plugin_api_cache(&data_dir).expect("clear cache");

        assert!(!cache_dir.exists());
        assert!(data_dir.join("cache-settings.json").is_file());
        fs::remove_dir_all(&data_dir).expect("remove plugin data dir");
    }

    #[test]
    fn plugin_cache_settings_reject_invalid_ttls() {
        let data_dir =
            std::env::temp_dir().join(format!("raynard-plugin-cache-invalid-{}", now_millis()));
        for ttl_hours in [0, 8_761] {
            let result = save_plugin_cache_settings(
                &data_dir,
                &PluginCacheSettings {
                    enabled: true,
                    ttl_hours,
                },
            );
            assert!(result.is_err());
        }
        assert!(!data_dir.exists());
    }

    #[test]
    fn compact_tools_scaffold_imports_the_shared_sdk() {
        let tools = build_plugin_tools_stub();
        assert!(tools.contains("@raynard/plugin-sdk"));
        assert!(tools.contains("defineTools"));
        assert!(!tools.contains("./runtime.ts"));
    }

    /// Every secret lives in one keychain item so a run costs one prompt, not
    /// one per stored secret. What must hold is that a second, different
    /// account is served from the vault already in memory rather than sending
    /// anyone back to the OS. Seeded directly rather than through the keyring,
    /// which would prompt in CI.
    #[test]
    fn one_loaded_vault_serves_every_account() {
        let stamp = now_millis();
        let provider = format!("test-provider-{stamp}");
        let plugin = format!("plugin:test.generated.plugin-{stamp}:API_KEY");

        {
            let mut cache = KEYCHAIN_CACHE.lock().expect("lock keychain cache");
            let vault = cache.get_or_insert_with(std::collections::HashMap::new);
            vault.insert(provider.clone(), "provider-secret".to_string());
            vault.insert(plugin.clone(), "plugin-secret".to_string());
            // A miss is cached too: the "not configured" badges re-read exactly
            // these accounts on every render.
            vault.insert(format!("{provider}-missing"), String::new());
        }

        assert_eq!(read_keychain_account(&provider), "provider-secret");
        assert_eq!(read_keychain_account(&plugin), "plugin-secret");
        assert_eq!(read_keychain_account(&format!("{provider}-missing")), "");
    }

    /// The vault is one JSON string in one item, so anything a provider or a
    /// plugin can hand us has to survive the round trip — an OAuth envelope is
    /// itself JSON, and pasted keys are not always tidy.
    #[test]
    fn the_vault_round_trips_secrets_that_are_themselves_json() {
        let mut vault = std::collections::HashMap::new();
        vault.insert(
            "openai-codex".to_string(),
            json!({ "type": "oauth", "access": "a\"b", "refresh": "r\nr" }).to_string(),
        );
        vault.insert("claude".to_string(), "sk-ant-\"quoted\"".to_string());

        let serialized = serde_json::to_string(&vault).expect("serialize vault");
        let restored: std::collections::HashMap<String, String> =
            serde_json::from_str(&serialized).expect("parse vault");
        assert_eq!(restored, vault);

        // A keychain item that predates the vault holds a bare key, not JSON.
        // It must read as "no vault" so migration takes over, never as a panic.
        let legacy: std::collections::HashMap<String, String> =
            serde_json::from_str("sk-legacy-key").unwrap_or_default();
        assert!(legacy.is_empty());
    }

    #[test]
    fn plugin_slug_and_conflict_name_are_deterministic() {
        assert_eq!(
            normalize_plugin_slug(" Hacker News API "),
            "hacker-news-api"
        );

        let root = std::env::temp_dir().join(format!("raynard-plugin-status-{}", now_millis()));
        fs::create_dir_all(root.join("hacker-news")).expect("create first plugin");
        fs::create_dir_all(root.join("hacker-news-2")).expect("create second plugin");
        assert_eq!(
            next_available_plugin_slug(&root, "hacker-news"),
            "hacker-news-3"
        );
        fs::remove_dir_all(root).expect("remove test plugin root");
    }

    #[test]
    fn catalog_listing_reads_manifests_without_executing_extension_code() {
        let root = std::env::temp_dir().join(format!("raynard-catalog-list-{}", now_millis()));
        let catalog = root.join("catalog");
        let installed = root.join("installed");
        let extension = catalog.join("open-library");
        fs::create_dir_all(&extension).expect("create catalog extension");
        fs::create_dir_all(installed.join("open-library")).expect("mark extension installed");
        fs::write(
            extension.join("tools.ts"),
            "throw new Error('must not execute');\n",
        )
        .expect("write inert source");
        fs::write(extension.join("README.md"), "# Open Library\n").expect("write catalog readme");
        fs::write(
            extension.join("plugin.json"),
            serde_json::to_string(&json!({
                "id": "raynard.catalog.open-library",
                "name": "Open Library",
                "description": "Search books.",
                "category": "Reference",
                "icon": "book-open",
                "version": "1.0.0",
                "sdkVersion": 1,
                "auth": {
                    "credentials": [{
                        "key": "OPEN_LIBRARY_API_KEY",
                        "label": "Open Library API key",
                        "signupUrl": "https://example.com/keys"
                    }]
                },
                "contributes": {
                    "tools": [{
                        "name": "open_library_search",
                        "description": "Search Open Library by title or author.",
                        "hasCard": true
                    }]
                }
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");

        let extensions = read_catalog_extensions(&catalog, &installed).expect("read catalog");
        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].slug, "open-library");
        assert_eq!(extensions[0].category, "Reference");
        assert_eq!(extensions[0].tools.len(), 1);
        assert!(extensions[0].requires_key);
        assert!(extensions[0].installed);

        fs::remove_dir_all(installed.join("open-library")).expect("mark extension available");
        let detail = read_catalog_extension_detail_from(&catalog, &installed, "open-library")
            .expect("read available extension detail");
        assert_eq!(detail.extension.slug, "open-library");
        assert_eq!(detail.detail.plugin.name, "Open Library");
        assert_eq!(detail.detail.readme, "# Open Library\n");
        assert!(
            read_catalog_extension_detail_from(&catalog, &installed, "../open-library").is_err()
        );

        fs::remove_dir_all(root).expect("remove catalog fixture");
    }

    #[test]
    fn catalog_install_copies_nested_author_files_and_rejects_unsafe_targets() {
        let root = std::env::temp_dir().join(format!("raynard-catalog-install-{}", now_millis()));
        let catalog = root.join("catalog");
        let installed = root.join("installed");
        let extension = catalog.join("open-library");
        fs::create_dir_all(extension.join("lib")).expect("create nested source");
        fs::create_dir_all(&installed).expect("create installed root");
        fs::write(extension.join("plugin.json"), "{}\n").expect("write manifest");
        fs::write(extension.join("tools.ts"), "export const tools = {};\n").expect("write tools");
        fs::write(extension.join("lib/client.ts"), "export const value = 1;\n")
            .expect("write nested module");

        let target = install_catalog_extension_from(&catalog, &installed, "open-library")
            .expect("install extension");
        assert_eq!(target, installed.join("open-library"));
        assert!(target.join("plugin.json").is_file());
        assert!(target.join("lib/client.ts").is_file());
        assert!(install_catalog_extension_from(&catalog, &installed, "open-library").is_err());
        assert!(install_catalog_extension_from(&catalog, &installed, "../open-library").is_err());

        fs::remove_dir_all(root).expect("remove install fixture");
    }

    #[test]
    fn catalog_update_replaces_installed_files_and_keeps_plugin_data() {
        let root = std::env::temp_dir().join(format!("raynard-catalog-update-{}", now_millis()));
        let catalog = root.join("catalog");
        let installed = root.join("installed");
        let extension = catalog.join("open-library");
        fs::create_dir_all(&extension).expect("create catalog extension");
        fs::create_dir_all(&installed).expect("create installed root");
        fs::write(extension.join("plugin.json"), "{\"version\":\"1.0.0\"}\n")
            .expect("write manifest");
        fs::write(extension.join("tools.ts"), "export const tools = {};\n").expect("write tools");

        let target = install_catalog_extension_from(&catalog, &installed, "open-library")
            .expect("install extension");
        assert_eq!(installed_manifest_version(&target), "1.0.0");

        // The cache lives beside the extension, not inside it, so an update must
        // leave it alone.
        let data_dir = installed.join(".plugin-data").join("open-library");
        fs::create_dir_all(&data_dir).expect("create plugin data");
        fs::write(data_dir.join("cache-settings.json"), "{}\n").expect("write plugin data");
        // A stale schema cache from the replaced version.
        fs::write(target.join(".runtime-tools.json"), "[]\n").expect("write runtime cache");

        fs::write(extension.join("plugin.json"), "{\"version\":\"2.0.0\"}\n")
            .expect("publish newer manifest");
        fs::write(
            extension.join("tools.ts"),
            "export const tools = { next: 1 };\n",
        )
        .expect("publish newer tools");
        fs::write(extension.join("client.ts"), "export const added = true;\n")
            .expect("publish added file");

        let updated = update_catalog_extension_from(&catalog, &installed, "open-library")
            .expect("update extension");
        assert_eq!(updated, target);
        assert_eq!(installed_manifest_version(&updated), "2.0.0");
        assert_eq!(
            fs::read_to_string(updated.join("tools.ts")).expect("read updated tools"),
            "export const tools = { next: 1 };\n"
        );
        assert!(updated.join("client.ts").is_file());
        assert!(data_dir.join("cache-settings.json").is_file());
        // Staging directories must not survive a successful update.
        let leftovers = fs::read_dir(&installed)
            .expect("read installed root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".tmp-update-") || name.starts_with(".old-update-")
            })
            .count();
        assert_eq!(leftovers, 0);

        assert!(update_catalog_extension_from(&catalog, &installed, "../open-library").is_err());
        assert!(update_catalog_extension_from(&catalog, &installed, "missing").is_err());
        fs::remove_dir_all(installed.join("open-library")).expect("uninstall extension");
        assert!(update_catalog_extension_from(&catalog, &installed, "open-library").is_err());

        fs::remove_dir_all(root).expect("remove update fixture");
    }

    #[test]
    fn generated_plugin_reads_three_manifest_sample_prompts() {
        let plugin_dir =
            std::env::temp_dir().join(format!("raynard-plugin-prompts-{}", now_millis()));
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string(&json!({
                "id": "raynard.generated.hacker-news",
                "name": "Hacker News",
                "sdkVersion": 1,
                "samplePrompts": [
                    "Who wrote the top story today?",
                    "Show me the three most discussed stories.",
                    "What is the newest story?"
                ]
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");
        let plugin = read_generated_plugin_manifest(&plugin_dir, &plugin_dir.join("plugin.json"))
            .expect("read generated plugin");
        assert_eq!(plugin.sample_prompts.len(), 3);
        assert_eq!(plugin.sample_prompts[0], "Who wrote the top story today?");

        fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
    }

    #[test]
    fn plugin_display_names_collapse_whitespace_and_control_characters() {
        assert_eq!(
            normalize_plugin_display_name("  Hacker\t\tNews \n"),
            "Hacker News"
        );
        assert_eq!(normalize_plugin_display_name("D&D"), "D&D");
        assert_eq!(normalize_plugin_display_name("   "), "");
    }

    fn write_rename_fixture(root: &Path, slug: &str, id: &str, name: &str) -> PathBuf {
        let plugin_dir = root.join(slug);
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            plugin_dir.join("plugin.json"),
            format!(
                "{{\n  \"id\": \"{id}\",\n  \"sdkVersion\": 1,\n  \"name\": \"{name}\",\n  \"description\": \"Fixture\",\n  \"version\": \"0.1.0\"\n}}\n"
            ),
        )
        .expect("write manifest");
        plugin_dir.canonicalize().expect("canonicalize plugin dir")
    }

    #[test]
    fn renaming_an_extension_rewrites_only_the_name_and_keeps_the_authored_key_order() {
        let root = std::env::temp_dir().join(format!("raynard-rename-{}", now_millis()));
        fs::create_dir_all(&root).expect("create root");
        let plugin_dir = write_rename_fixture(&root, "dnd-5e-api", "raynard.generated.dnd", "D&D");

        rename_generated_plugin_in(&root, &plugin_dir, "  Dungeons &   Dragons ")
            .expect("rename plugin");

        let raw = fs::read_to_string(plugin_dir.join("plugin.json")).expect("read manifest");
        let manifest: Value = serde_json::from_str(&raw).expect("parse manifest");
        let keys: Vec<_> = manifest
            .as_object()
            .expect("manifest object")
            .keys()
            .cloned()
            .collect();
        // preserve_order is what stops the rewrite alphabetizing an author's file.
        assert_eq!(
            keys,
            vec!["id", "sdkVersion", "name", "description", "version"]
        );
        assert_eq!(
            manifest.get("name").and_then(Value::as_str),
            Some("Dungeons & Dragons")
        );
        assert_eq!(
            manifest.get("description").and_then(Value::as_str),
            Some("Fixture")
        );
        // The slug the agent routes on must survive a display-name change.
        assert!(plugin_dir.is_dir());
        assert_eq!(
            manifest.get("id").and_then(Value::as_str),
            Some("raynard.generated.dnd")
        );

        fs::remove_dir_all(&root).expect("remove root");
    }

    #[test]
    fn renaming_an_extension_refuses_a_name_that_another_extension_already_resolves_by() {
        let root = std::env::temp_dir().join(format!("raynard-rename-clash-{}", now_millis()));
        fs::create_dir_all(&root).expect("create root");
        let plugin_dir = write_rename_fixture(&root, "dnd-5e-api", "raynard.generated.dnd", "D&D");
        write_rename_fixture(&root, "news-reader", "hacker-news", "Hacker News");

        for clash in ["hacker news", "HACKER-NEWS", "News-Reader"] {
            assert_eq!(
                rename_generated_plugin_in(&root, &plugin_dir, clash),
                Err("Another extension already uses that name.".to_string()),
                "expected {clash} to be refused"
            );
        }
        assert!(rename_generated_plugin_in(&root, &plugin_dir, "   ").is_err());
        assert!(rename_generated_plugin_in(&root, &plugin_dir, &"x".repeat(65)).is_err());
        // Its own current name is not a clash with itself.
        assert!(rename_generated_plugin_in(&root, &plugin_dir, "D&D").is_ok());

        fs::remove_dir_all(&root).expect("remove root");
    }

    #[test]
    fn generated_plugin_rejects_a_manifest_without_the_current_sdk_version() {
        let plugin_dir = std::env::temp_dir().join(format!("raynard-old-plugin-{}", now_millis()));
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string(&json!({
                "id": "raynard.generated.old-plugin",
                "name": "Old Plugin"
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");

        assert!(
            read_generated_plugin_manifest(&plugin_dir, &plugin_dir.join("plugin.json")).is_none()
        );

        fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
    }

    #[test]
    fn builder_events_serialize_native_pi_tool_fields() {
        let value = serde_json::to_value(BuilderStreamEvent {
            base: StreamEvent {
                stream_id: "builder-1".to_string(),
                event_type: "tool_execution_start".to_string(),
                delta: None,
                text: None,
                error: None,
                provider: Some("moonshot".to_string()),
                model: Some("kimi-k3".to_string()),
            },
            tool_call_id: Some("call-1".to_string()),
            tool_name: Some("write".to_string()),
            args: Some(json!({ "path": "src/index.ts" })),
            partial_result: None,
            result: None,
            is_error: None,
            retry: None,
        })
        .expect("serialize builder stream event");

        assert_eq!(value["stream_id"], "builder-1");
        assert_eq!(value["tool_call_id"], "call-1");
        assert_eq!(value["tool_name"], "write");
        assert_eq!(value["args"]["path"], "src/index.ts");
    }

    #[test]
    fn chat_normalization_preserves_builder_activity() {
        let activities = json!([{
            "toolCallId": "call-1",
            "toolName": "write",
            "args": { "path": "src/index.ts" },
            "status": "complete",
            "output": "Wrote file",
            "isError": false
        }]);
        let normalized = normalize_stored_messages(vec![StoredChatMessage {
            role: "assistant".to_string(),
            text: "Plugin built.".to_string(),
            timestamp: 1,
            thinking: None,
            provider: None,
            model: None,
            status: Some("completed".to_string()),
            error: None,
            mode_status: None,
            model_failure: None,
            builder_run: Some(true),
            shared_import: None,
            builder_activities: Some(activities.clone()),
            cards: None,
            charts: None,
            sources: None,
            credential_request: None,
            extension_recommendation: None,
            scheduled_task_request: None,
            scheduled_task_id: None,
            scheduled_task_name: None,
            scheduled_execution_id: None,
            usage: None,
        }]);

        assert_eq!(normalized[0].builder_run, Some(true));
        assert_eq!(normalized[0].builder_activities, Some(activities));
    }

    #[test]
    fn plugin_credential_account_namespaces_and_rejects_collisions() {
        assert_eq!(
            plugin_credential_account("open-weather", "OPENWEATHER_API_KEY"),
            Ok("plugin:open-weather:OPENWEATHER_API_KEY".to_string())
        );

        // The keychain service is shared with the model providers, whose
        // accounts are bare ids. No input may produce one.
        for (plugin_id, key) in [
            ("open:weather", "A_KEY"),
            ("open-weather", "A:KEY"),
            ("", "A_KEY"),
            ("open-weather", ""),
            ("open weather", "A_KEY"),
            ("open-weather", "lower_case"),
            ("open-weather", "9LEADING_DIGIT"),
            ("open-weather", "HAS-DASH"),
        ] {
            assert!(
                plugin_credential_account(plugin_id, key).is_err(),
                "expected rejection for ({plugin_id}, {key})"
            );
        }

        for provider in ["openai", "openai-codex", "claude", "moonshot"] {
            let account = plugin_credential_account("open-weather", "OPENWEATHER_API_KEY").unwrap();
            assert_ne!(account, provider);
            assert!(account.starts_with("plugin:"));
        }
    }

    #[test]
    fn keys_stored_before_oauth_existed_still_parse() {
        // Every key already in a user's keychain is a bare string. Reading one
        // as anything but an API key would sign them out on upgrade.
        let legacy = parse_stored_credential("sk-abc123").expect("a bare key is a credential");
        match legacy {
            StoredCredential::ApiKey { key } => assert_eq!(key, "sk-abc123"),
            StoredCredential::OAuth { .. } => panic!("a bare key must not parse as OAuth"),
        }

        assert!(parse_stored_credential("   ").is_none());
        assert!(parse_stored_credential("").is_none());
    }

    #[test]
    fn oauth_credentials_round_trip_and_never_pose_as_an_api_key() {
        let credential = StoredCredential::OAuth {
            access: "access-token".to_string(),
            refresh: "refresh-token".to_string(),
            expires: 1_700_000_000_000,
            account_id: Some("acct_1".to_string()),
        };
        let serialized = serde_json::to_string(&credential).unwrap();
        let parsed = parse_stored_credential(&serialized).expect("stored OAuth JSON parses back");

        match parsed {
            StoredCredential::OAuth {
                access,
                refresh,
                expires,
                account_id,
            } => {
                assert_eq!(access, "access-token");
                assert_eq!(refresh, "refresh-token");
                assert_eq!(expires, 1_700_000_000_000);
                assert_eq!(account_id.as_deref(), Some("acct_1"));
            }
            StoredCredential::ApiKey { .. } => panic!("OAuth JSON must not parse as an API key"),
        }

        // The envelope must never reach a provider as a bearer token.
        assert!(serialized.starts_with('{'));
        assert!(serialized.contains("\"type\":\"oauth\""));
    }

    #[test]
    fn access_tokens_refresh_before_they_expire_mid_turn() {
        let now = 1_700_000_000_000;
        assert!(oauth_needs_refresh(now - 1, now), "already expired");
        assert!(
            oauth_needs_refresh(now + 60_000, now),
            "a minute of validity cannot outlast a turn"
        );
        assert!(oauth_needs_refresh(now + OAUTH_REFRESH_MARGIN_MS, now));
        assert!(!oauth_needs_refresh(now + OAUTH_REFRESH_MARGIN_MS + 1, now));
        assert!(!oauth_needs_refresh(now + 30 * 60_000, now));
    }

    #[test]
    fn the_chatgpt_provider_is_its_own_provider_and_survives_normalization() {
        // canonical_provider_id falls back to "moonshot" for unknown ids, so a
        // missing arm here would silently sign a ChatGPT user into Moonshot.
        assert_eq!(canonical_provider_id("openai-codex"), "openai-codex");
        assert_eq!(canonical_provider_id("  OpenAI-Codex "), "openai-codex");
        assert_eq!(canonical_provider_id("openai"), "openai");

        let preset = provider_preset("openai-codex").expect("the ChatGPT preset exists");
        assert_eq!(preset.base_url, "https://chatgpt.com/backend-api");
        assert!(preset.auth_method == AuthMethod::OAuth);
        // No environment variable can stand in for a sign-in.
        assert!(preset.api_key_names.is_empty());

        let openai = provider_preset("openai").expect("the API-key preset exists");
        assert!(openai.auth_method == AuthMethod::ApiKey);
        assert_ne!(openai.base_url, preset.base_url);
        // The two OpenAI entries share a vendor and must not share a name: one
        // row is the sign-in the onboarding pushes, the other is the key path
        // hidden behind it.
        assert_eq!(preset.name, "ChatGPT");
        assert_ne!(openai.name, preset.name);
    }

    #[test]
    fn every_key_provider_can_say_where_to_get_a_key() {
        // The key form links straight to the issuing console; a provider with no
        // link leaves the user hunting for the right settings page.
        for provider_id in ["openai", "claude", "moonshot"] {
            let preset = provider_preset(provider_id).expect("static provider should exist");
            assert!(
                preset.api_key_url.starts_with("https://"),
                "{provider_id} has no API key page"
            );
        }
        // A sign-in provider has no key page to offer.
        let chatgpt = provider_preset("openai-codex").expect("the ChatGPT preset exists");
        assert!(chatgpt.api_key_url.is_empty());
    }

    #[test]
    fn manifest_auth_declarations_are_parsed_and_cleaned() {
        let dir = std::env::temp_dir().join(format!("raynard-auth-manifest-{}", now_millis()));
        fs::create_dir_all(&dir).unwrap();
        let manifest_path = dir.join("plugin.json");
        fs::write(
            &manifest_path,
            json!({
                "id": "raynard.generated.open-weather",
                "name": "Open Weather",
                "sdkVersion": 1,
                "auth": { "credentials": [
                    {
                        "key": "OPENWEATHER_API_KEY",
                        "label": "OpenWeather API key",
                        "description": "Free tier.",
                        "signupUrl": "https://openweathermap.org/api"
                    },
                    // Dropped: no sign-up page means the prompt cannot send the
                    // user anywhere.
                    { "key": "NO_SIGNUP_KEY", "label": "No signup" },
                    // Dropped: not a valid keychain account component.
                    { "key": "lower", "label": "Lower", "signupUrl": "https://example.com" },
                    // Dropped: duplicate.
                    {
                        "key": "OPENWEATHER_API_KEY",
                        "label": "Duplicate",
                        "signupUrl": "https://example.com"
                    }
                ]}
            })
            .to_string(),
        )
        .unwrap();

        let plugin = read_generated_plugin_manifest(&dir, &manifest_path).unwrap();
        assert_eq!(plugin.credentials.len(), 1);
        assert_eq!(plugin.credentials[0].key, "OPENWEATHER_API_KEY");
        assert_eq!(
            plugin.credentials[0].signup_url,
            "https://openweathermap.org/api"
        );
        // Never assumed configured from the manifest alone.
        assert!(!plugin.credentials[0].configured);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_without_auth_declares_no_credentials() {
        let dir = std::env::temp_dir().join(format!("raynard-noauth-manifest-{}", now_millis()));
        fs::create_dir_all(&dir).unwrap();
        let manifest_path = dir.join("plugin.json");
        fs::write(
            &manifest_path,
            json!({ "id": "raynard.generated.hacker-news", "sdkVersion": 1 }).to_string(),
        )
        .unwrap();

        let plugin = read_generated_plugin_manifest(&dir, &manifest_path).unwrap();
        assert!(plugin.credentials.is_empty());

        // The sdkVersion gate still applies.
        fs::write(
            &manifest_path,
            json!({ "id": "x", "sdkVersion": 2, "auth": { "credentials": [] } }).to_string(),
        )
        .unwrap();
        assert!(read_generated_plugin_manifest(&dir, &manifest_path).is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stored_usage_survives_normalization() {
        // normalize_stored_messages rebuilds every field by hand, so a field
        // added to the struct but not copied here is silently dropped on the
        // first save. That failure is invisible until /status reports zero.
        let usage = json!({
            "input": 1200,
            "output": 340,
            "cacheRead": 80,
            "cacheWrite": 0,
            "totalTokens": 1620,
            "contextTokens": 1620,
            "contextWindow": 200000
        });
        let normalized = normalize_stored_messages(vec![StoredChatMessage {
            role: "assistant".to_string(),
            text: "Answered.".to_string(),
            timestamp: 1,
            thinking: None,
            provider: Some("claude".to_string()),
            model: Some("claude-3-5-sonnet-latest".to_string()),
            status: Some("completed".to_string()),
            error: None,
            mode_status: None,
            model_failure: None,
            builder_run: None,
            shared_import: None,
            builder_activities: None,
            cards: None,
            charts: None,
            sources: None,
            credential_request: None,
            extension_recommendation: None,
            scheduled_task_request: None,
            scheduled_task_id: None,
            scheduled_task_name: None,
            scheduled_execution_id: None,
            usage: Some(usage.clone()),
        }]);

        assert_eq!(normalized[0].usage, Some(usage));
    }

    #[test]
    fn bookmark_eligibility_fields_survive_chat_normalization() {
        let failure = json!({ "title": "Provider failed", "detail": "Unavailable" });
        let normalized = normalize_stored_messages(vec![StoredChatMessage {
            role: "assistant".to_string(),
            text: "Build mode is active.".to_string(),
            timestamp: 1,
            thinking: None,
            provider: None,
            model: None,
            status: Some("completed".to_string()),
            error: None,
            mode_status: Some(true),
            model_failure: Some(failure.clone()),
            builder_run: None,
            shared_import: None,
            builder_activities: None,
            cards: None,
            charts: None,
            sources: None,
            credential_request: None,
            extension_recommendation: None,
            scheduled_task_request: None,
            scheduled_task_id: None,
            scheduled_task_name: None,
            scheduled_execution_id: None,
            usage: None,
        }]);

        assert_eq!(normalized[0].mode_status, Some(true));
        assert_eq!(normalized[0].model_failure, Some(failure));
    }

    #[test]
    fn a_chat_saved_before_token_counting_still_loads() {
        let raw = r#"{"role":"assistant","text":"Older answer","timestamp":7}"#;
        let message: StoredChatMessage = serde_json::from_str(raw).expect("older chat must load");
        assert_eq!(message.usage, None);
        assert_eq!(message.mode_status, None);
        assert_eq!(message.model_failure, None);
    }

    #[test]
    fn structured_charts_survive_chat_normalization() {
        let chart = json!({
            "type": "bar",
            "x": "event",
            "series": [{ "key": "probability", "label": "Probability" }],
            "rows": [{ "event": "Referendum", "probability": 54 }]
        });
        let raw = json!({
            "role": "assistant",
            "text": "The referendum is narrowly favored.",
            "timestamp": 7,
            "charts": [chart.clone()]
        });
        let message: StoredChatMessage =
            serde_json::from_value(raw).expect("structured chart message must load");
        let normalized = normalize_stored_messages(vec![message]);

        assert_eq!(normalized[0].charts, Some(json!([chart])));
    }

    #[test]
    fn turn_usage_accumulates_per_provider_and_model() {
        let mut totals = UsageTotals::default();
        let usage = json!({ "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 1, "totalTokens": 126 });
        merge_turn_usage(&mut totals, "claude/sonnet", &usage);
        merge_turn_usage(&mut totals, "claude/sonnet", &usage);
        merge_turn_usage(&mut totals, "moonshot/kimi-k2.5", &usage);

        let row = &totals.totals["claude/sonnet"];
        assert_eq!(row.input, 200);
        assert_eq!(row.total_tokens, 252);
        assert_eq!(row.turns, 2);
        assert_eq!(totals.totals["moonshot/kimi-k2.5"].turns, 1);
    }

    #[test]
    fn turn_usage_ignores_missing_and_negative_counts() {
        let mut totals = UsageTotals::default();
        merge_turn_usage(&mut totals, "claude/sonnet", &json!({}));
        merge_turn_usage(
            &mut totals,
            "claude/sonnet",
            &json!({ "input": -5, "output": "many", "totalTokens": 10 }),
        );

        let row = &totals.totals["claude/sonnet"];
        assert_eq!(row.input, 0);
        assert_eq!(row.output, 0);
        assert_eq!(row.total_tokens, 10);
        assert_eq!(row.turns, 2);
    }

    #[test]
    fn chatgpt_usage_reports_each_window_in_milliseconds() {
        let payload = json!({
            "used_percent": 42.5,
            "reset_at": 1_700_000_000_i64,
            "limit_window_seconds": 18000,
            "plan": "plus",
            "secondary": {
                "used_percent": 7.0,
                "reset_at": 1_700_500_000_i64,
                "limit_window_seconds": 604800
            }
        });

        let quota = parse_chatgpt_usage(&payload).expect("usage must parse");
        assert_eq!(quota.kind, "windows");
        assert_eq!(quota.plan.as_deref(), Some("plus"));
        assert_eq!(quota.windows.len(), 2);
        assert_eq!(quota.windows[0].label, "5 hours");
        assert_eq!(quota.windows[0].used_percent, 42.5);
        // Seconds are converted at the Rust boundary; the renderer sees only ms.
        assert_eq!(quota.windows[0].resets_at, Some(1_700_000_000_000));
        assert_eq!(quota.windows[1].label, "Weekly");
    }

    #[test]
    fn chatgpt_usage_parses_the_streamed_rate_limits_shape() {
        // Verbatim from pi's own openai-codex-stream test fixture: the live
        // wire format nests under rate_limits.primary and measures the window
        // in minutes, unlike the REST shape handled above.
        let payload = json!({
            "type": "codex.rate_limits",
            "plan_type": "plus",
            "rate_limits": {
                "allowed": true,
                "limit_reached": false,
                "primary": {
                    "used_percent": 7,
                    "window_minutes": 10080,
                    "reset_after_seconds": 556112,
                    "reset_at": 1_785_269_351_i64
                },
                "secondary": null
            },
            "code_review_rate_limits": null,
            "additional_rate_limits": null,
            "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
            "promo": null
        });

        let quota = parse_chatgpt_usage(&payload).expect("streamed shape must parse");
        assert_eq!(quota.windows.len(), 1);
        assert_eq!(quota.windows[0].used_percent, 7.0);
        // 10080 minutes is the weekly window.
        assert_eq!(quota.windows[0].label, "Weekly");
        assert_eq!(quota.windows[0].resets_at, Some(1_785_269_351_000));
        assert_eq!(quota.plan.as_deref(), Some("plus"));
        // has_credits is false, so no balance is claimed.
        assert_eq!(quota.balance_usd, None);
    }

    #[test]
    fn chatgpt_credits_are_read_from_a_string_balance() {
        let payload = json!({
            "plan_type": "pro",
            "rate_limits": { "primary": { "used_percent": 3, "window_minutes": 300 } },
            "credits": { "has_credits": true, "balance": "12.50" }
        });

        let quota = parse_chatgpt_usage(&payload).expect("must parse");
        assert_eq!(quota.balance_usd, Some(12.5));
        assert_eq!(quota.windows[0].label, "5 hours");
    }

    #[test]
    fn an_unrecognized_chatgpt_shape_reports_nothing_rather_than_zero() {
        // A meter reading 0% because the field moved is worse than "unavailable",
        // because the user would act on it.
        assert!(parse_chatgpt_usage(&json!({})).is_none());
        assert!(parse_chatgpt_usage(&json!({ "detail": "Not Found" })).is_none());
        assert!(parse_chatgpt_usage(&json!({ "used_percent": "42" })).is_none());
    }

    #[test]
    fn migrate_deprecated_model_id_remaps_only_the_dead_kimi_slug() {
        assert_eq!(
            migrate_deprecated_model_id(Some("kimi-k2.5".to_string())),
            Some("kimi-k2.6".to_string())
        );
        assert_eq!(
            migrate_deprecated_model_id(Some("kimi-k3".to_string())),
            Some("kimi-k3".to_string())
        );
        assert_eq!(migrate_deprecated_model_id(None), None);
    }

    #[test]
    fn moonshot_balance_parses_and_rejects_an_error_code() {
        let payload = json!({
            "code": 0,
            "data": { "available_balance": 49.58894, "voucher_balance": 46.58893, "cash_balance": 3.00001 },
            "status": true
        });

        let quota = parse_moonshot_balance(&payload).expect("balance must parse");
        assert_eq!(quota.kind, "balance");
        assert_eq!(quota.balance_usd, Some(49.58894));
        assert_eq!(quota.cash_balance_usd, Some(3.00001));

        assert!(parse_moonshot_balance(&json!({ "code": 1, "data": {} })).is_none());
        assert!(parse_moonshot_balance(&json!({ "code": 0, "data": {} })).is_none());
    }

    #[test]
    fn quota_windows_are_labelled_in_human_units() {
        assert_eq!(format_quota_window(18000), "5 hours");
        assert_eq!(format_quota_window(3600), "1 hour");
        assert_eq!(format_quota_window(604_800), "Weekly");
        assert_eq!(format_quota_window(0), "Current window");
    }

    #[test]
    fn the_chatgpt_account_id_is_recovered_from_the_access_token() {
        // The stored accountId is often absent, so the usage call falls back to
        // the JWT claim exactly as pi's own Codex provider does.
        let claims = json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct-123" } });
        let encoded = base64url_encode_for_test(&serde_json::to_vec(&claims).unwrap());
        let token = format!("header.{encoded}.signature");

        assert_eq!(
            account_id_from_access_token(&token),
            Some("acct-123".to_string())
        );
        assert_eq!(account_id_from_access_token("not-a-jwt"), None);

        let without_claim = base64url_encode_for_test(b"{\"sub\":\"x\"}");
        assert_eq!(
            account_id_from_access_token(&format!("header.{without_claim}.sig")),
            None
        );
    }

    /// Minimal unpadded base64url encoder, test-only: the crate decodes JWTs but
    /// never needs to write one outside this assertion.
    fn base64url_encode_for_test(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            let indices = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63];
            for (i, index) in indices.iter().enumerate() {
                if i <= chunk.len() {
                    out.push(ALPHABET[*index as usize] as char);
                }
            }
        }
        out
    }

    #[test]
    fn providers_without_a_balance_api_point_at_billing_not_key_management() {
        let quota = ProviderQuota::unavailable("claude", "no balance");
        assert_eq!(quota.kind, "unavailable");
        assert_eq!(quota.provider_name, "Claude");
        assert_eq!(
            quota.console_url.as_deref(),
            Some("https://console.anthropic.com/settings/billing")
        );
        assert!(quota.windows.is_empty());
        assert_eq!(quota.balance_usd, None);
    }

    #[test]
    fn stored_credential_request_round_trips_and_empty_text_is_still_dropped() {
        let request = json!({
            "pluginId": "open-weather",
            "pluginName": "Open Weather",
            "credentials": [{ "key": "OPENWEATHER_API_KEY", "label": "OpenWeather API key" }]
        });
        let recommendation = json!({
            "slug": "open-library",
            "name": "Open Library",
            "description": "Search books and authors.",
            "answer": "Open Library can answer that."
        });

        let normalized = normalize_stored_messages(vec![
            StoredChatMessage {
                role: "assistant".to_string(),
                text: "Open Weather needs an API key".to_string(),
                timestamp: 1,
                thinking: None,
                provider: None,
                model: None,
                status: Some("completed".to_string()),
                error: None,
                mode_status: None,
                model_failure: None,
                builder_run: None,
                shared_import: None,
                builder_activities: None,
                cards: None,
                charts: None,
                sources: None,
                credential_request: Some(request.clone()),
                extension_recommendation: Some(recommendation.clone()),
                scheduled_task_request: None,
                scheduled_task_id: None,
                scheduled_task_name: None,
                scheduled_execution_id: None,
                usage: None,
            },
            StoredChatMessage {
                role: "assistant".to_string(),
                text: "   ".to_string(),
                timestamp: 2,
                thinking: None,
                provider: None,
                model: None,
                status: None,
                error: None,
                mode_status: None,
                model_failure: None,
                builder_run: None,
                shared_import: None,
                builder_activities: None,
                cards: None,
                charts: None,
                sources: None,
                credential_request: Some(request.clone()),
                extension_recommendation: Some(recommendation.clone()),
                scheduled_task_request: None,
                scheduled_task_id: None,
                scheduled_task_name: None,
                scheduled_execution_id: None,
                usage: None,
            },
        ]);

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].credential_request, Some(request));
        assert_eq!(normalized[0].extension_recommendation, Some(recommendation));
    }

    #[test]
    fn steer_command_type_defaults_to_steering() {
        assert_eq!(steer_command_type("follow_up"), "follow_up");
        assert_eq!(steer_command_type("  followUp "), "follow_up");
        assert_eq!(steer_command_type("steer"), "steer");
        // An unknown delivery must still reach the agent rather than be dropped.
        assert_eq!(steer_command_type(""), "steer");
        assert_eq!(steer_command_type("later"), "steer");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StreamCancelState::default())
        .manage(OAuthLoginState::default())
        .manage(AgentSteerState::default())
        .manage(ProviderQuotaCache::default())
        .manage(BookmarkStoreState::default())
        .manage(MemoryStoreState::default())
        .manage(ScheduledTaskWakeState::default())
        .manage(PendingDeepLinks::default())
        .manage(AppUpdateStore::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;

            // Commands do not all receive an AppHandle, so capture Tauri's
            // platform-aware resource directory once for sidecar resolution.
            if let Ok(resource_dir) = app.path().resource_dir() {
                let _ = BUNDLED_RESOURCE_DIR.set(resource_dir);
            }

            if let Ok(path) = scheduled_tasks_path(app.handle()) {
                let _guard = SCHEDULED_TASK_LOCK.lock().ok();
                let _ = scheduled_tasks::recover_interrupted(&path);
            }
            let scheduled_handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(std::time::Duration::from_secs(30));
                let channel = scheduled_handle
                    .state::<ScheduledTaskWakeState>()
                    .channel
                    .lock()
                    .ok()
                    .and_then(|channel| channel.clone());
                if let Some(channel) = channel {
                    let _ = channel.send(now_millis());
                }
            });

            app_updates::spawn_background_checks(app.handle());

            // A cold launch has already consumed its URL by the time the plugin
            // is up, so it is read back explicitly; everything after arrives
            // through `on_open_url`. Both land in the same buffer.
            let handle = app.handle().clone();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                deliver_deep_links(
                    &handle.state::<PendingDeepLinks>(),
                    urls.into_iter().map(|url| url.to_string()).collect(),
                );
            }
            app.deep_link().on_open_url(move |event| {
                deliver_deep_links(
                    &handle.state::<PendingDeepLinks>(),
                    event
                        .urls()
                        .into_iter()
                        .map(|url| url.to_string())
                        .collect(),
                );
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            append_agent_turn_log,
            assign_scheduled_task_chat,
            cancel_model_chat_stream,
            check_for_app_update,
            claim_scheduled_task,
            complete_scheduled_task,
            create_scheduled_task,
            steer_main_agent_stream,
            clear_generated_plugin_cache,
            delete_bookmark,
            delete_memory,
            download_app_update,
            delete_chat_history,
            delete_generated_plugin,
            delete_scheduled_task,
            save_plugin_credential,
            delete_plugin_credential,
            execute_generated_plugin_tool,
            get_app_update_state,
            get_generated_plugin_cache_settings,
            get_plugin_scaffold_status,
            load_llm_env_status,
            open_external_url,
            install_app_update,
            install_catalog_extension,
            update_catalog_extension,
            list_catalog_extensions,
            list_bookmarks,
            list_bookmark_mentions,
            list_chat_bookmarks,
            list_generated_plugins,
            list_chat_history,
            list_memories,
            list_model_providers,
            list_due_scheduled_tasks,
            list_scheduled_tasks,
            mark_chat_history_read,
            open_extension_contribution_folder,
            read_catalog_extension,
            read_generated_plugin,
            rename_generated_plugin,
            read_chat_history,
            read_result_artifact,
            read_provider_quota,
            read_usage_totals,
            prepare_extension_contribution,
            run_main_agent_stream,
            run_plugin_builder_stream,
            run_provider_oauth_login,
            save_bookmark,
            save_memory,
            name_bookmark,
            run_model_chat,
            run_model_chat_stream,
            save_chat_history,
            save_generated_plugin_cache_settings,
            save_provider_api_key,
            scaffold_plugin_capability,
            set_active_model_provider,
            set_active_provider,
            set_scheduled_task_enabled,
            sign_out_provider,
            submit_provider_oauth_code,
            subscribe_app_updates,
            subscribe_deep_links,
            subscribe_scheduled_tasks,
            update_scheduled_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
