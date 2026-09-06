use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{multipart, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;

const STORE_VERSION: u32 = 1;
const PAIRING_TTL_MS: i64 = 60 * 60 * 1000;
const COMPLETED_EVENT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const COMPLETED_EVENT_LIMIT: usize = 500;
const TELEGRAM_API_ROOT: &str = "https://api.telegram.org";
const TELEGRAM_TEXT_LIMIT: usize = 4_000;
const TELEGRAM_RICH_TEXT_LIMIT: usize = 32_768;
const TELEGRAM_PHOTO_LIMIT_BYTES: usize = 10 * 1024 * 1024;
const TELEGRAM_DELIVERY_PART_LIMIT: usize = 64;

#[derive(Default, Clone)]
pub struct TelegramRuntimeState {
    pub generation: Arc<AtomicU64>,
    pub store_lock: Arc<Mutex<()>>,
    live: Arc<Mutex<TelegramLiveState>>,
    subscriber: Arc<Mutex<Option<Channel<TelegramChannelEvent>>>>,
}

#[derive(Default, Clone)]
struct TelegramLiveState {
    phase: String,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotIdentity {
    pub id: i64,
    pub username: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOwner {
    pub user_id: i64,
    pub username: Option<String>,
    pub name: String,
    pub approved_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPairingRequest {
    pub id: String,
    pub user_id: i64,
    pub chat_id: i64,
    pub username: Option<String>,
    pub name: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TelegramInboundKind {
    Message,
    NewChat,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TelegramInboundStatus {
    Pending,
    Running,
    Answered,
    Delivered,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TelegramDeliveryPart {
    Text {
        text: String,
        #[serde(default)]
        parse_mode: Option<String>,
    },
    Rich {
        html: String,
        fallback_text: String,
        #[serde(default)]
        fallback_parse_mode: Option<String>,
    },
    Photo {
        data_base64: String,
        filename: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramInboundEvent {
    pub id: String,
    pub update_id: i64,
    pub message_id: i64,
    pub remote_chat_id: i64,
    pub sender: TelegramOwner,
    pub text: String,
    pub received_at: i64,
    pub kind: TelegramInboundKind,
    pub status: TelegramInboundStatus,
    pub local_chat_id: Option<String>,
    #[serde(default)]
    pub reply_chunks: Vec<String>,
    /** Absent on replies persisted before rich Telegram formatting shipped. */
    #[serde(default)]
    pub reply_parse_mode: Option<String>,
    /** Preferred ordered delivery units; absent on older text-only replies. */
    #[serde(default)]
    pub reply_parts: Vec<TelegramDeliveryPart>,
    #[serde(default)]
    pub delivered_chunks: usize,
    #[serde(default)]
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramScheduledDelivery {
    pub id: String,
    pub task_id: String,
    pub execution_id: String,
    pub recipient_user_id: i64,
    pub chunks: Vec<String>,
    /** Absent on queued deliveries created by an older Raynard build. */
    #[serde(default)]
    pub parse_mode: Option<String>,
    /** Preferred ordered delivery units; absent on older text-only alerts. */
    #[serde(default)]
    pub parts: Vec<TelegramDeliveryPart>,
    pub delivered_chunks: usize,
    pub status: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramStore {
    version: u32,
    enabled: bool,
    bot: Option<TelegramBotIdentity>,
    owner: Option<TelegramOwner>,
    active_chat_id: Option<String>,
    next_offset: Option<i64>,
    #[serde(default)]
    pairing_requests: Vec<TelegramPairingRequest>,
    #[serde(default)]
    events: Vec<TelegramInboundEvent>,
    #[serde(default)]
    scheduled_deliveries: Vec<TelegramScheduledDelivery>,
}

impl Default for TelegramStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            enabled: false,
            bot: None,
            owner: None,
            active_chat_id: None,
            next_offset: None,
            pairing_requests: Vec::new(),
            events: Vec::new(),
            scheduled_deliveries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannelState {
    pub status: String,
    pub configured: bool,
    pub enabled: bool,
    pub bot: Option<TelegramBotIdentity>,
    pub owner: Option<TelegramOwner>,
    pub active_chat_id: Option<String>,
    pub pairing_requests: Vec<TelegramPairingRequest>,
    pub pending_count: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannelEvent {
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDeliveryResult {
    pub delivered: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramScheduledDeliveryResult {
    pub delivery_id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug)]
struct TelegramApiError {
    status: StatusCode,
    description: String,
    retry_after: Option<u64>,
}

impl std::fmt::Display for TelegramApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.description)
    }
}

fn normalize_html_mode(value: Option<String>) -> Result<Option<String>, String> {
    match value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => Ok(None),
        Some(value) if value.eq_ignore_ascii_case("html") => Ok(Some("HTML".to_string())),
        Some(_) => Err("Telegram delivery text supports only HTML parse mode.".to_string()),
    }
}

fn safe_photo_filename(value: &str) -> String {
    let trimmed = value.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 100
        && trimmed.ends_with(".png")
        && trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        trimmed.to_string()
    } else {
        "raynard-chart.png".to_string()
    }
}

/** Validate untrusted renderer payloads before they become durable retries. */
pub fn normalize_delivery_parts(
    parts: Vec<TelegramDeliveryPart>,
) -> Result<Vec<TelegramDeliveryPart>, String> {
    if parts.is_empty() || parts.len() > TELEGRAM_DELIVERY_PART_LIMIT {
        return Err("Telegram deliveries must contain 1-64 parts.".to_string());
    }
    let mut normalized = Vec::with_capacity(parts.len());
    let mut has_readable_text = false;
    for part in parts {
        match part {
            TelegramDeliveryPart::Text { text, parse_mode } => {
                let text = text.trim().to_string();
                if text.is_empty() || text.chars().count() > TELEGRAM_TEXT_LIMIT {
                    return Err("Telegram text parts must contain 1-4000 characters.".to_string());
                }
                has_readable_text = true;
                normalized.push(TelegramDeliveryPart::Text {
                    text,
                    parse_mode: normalize_html_mode(parse_mode)?,
                });
            }
            TelegramDeliveryPart::Rich {
                html,
                fallback_text,
                fallback_parse_mode,
            } => {
                let html = html.trim().to_string();
                let fallback_text = fallback_text.trim().to_string();
                if html.is_empty() || html.chars().count() > TELEGRAM_RICH_TEXT_LIMIT {
                    return Err(
                        "Telegram rich-message parts must contain 1-32768 characters.".to_string(),
                    );
                }
                if fallback_text.is_empty() || fallback_text.chars().count() > TELEGRAM_TEXT_LIMIT {
                    return Err(
                        "Telegram rich-message fallbacks must contain 1-4000 characters."
                            .to_string(),
                    );
                }
                has_readable_text = true;
                normalized.push(TelegramDeliveryPart::Rich {
                    html,
                    fallback_text,
                    fallback_parse_mode: normalize_html_mode(fallback_parse_mode)?,
                });
            }
            TelegramDeliveryPart::Photo {
                data_base64,
                filename,
            } => {
                if data_base64.len() > (TELEGRAM_PHOTO_LIMIT_BYTES * 4 / 3) + 4 {
                    return Err("Telegram chart images must not exceed 10 MB.".to_string());
                }
                let bytes = BASE64
                    .decode(data_base64.trim())
                    .map_err(|_| "Telegram chart image data is not valid base64.".to_string())?;
                if bytes.is_empty() || bytes.len() > TELEGRAM_PHOTO_LIMIT_BYTES {
                    return Err("Telegram chart images must contain 1 byte to 10 MB.".to_string());
                }
                if !bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
                    return Err("Telegram chart images must be PNG files.".to_string());
                }
                normalized.push(TelegramDeliveryPart::Photo {
                    data_base64: data_base64.trim().to_string(),
                    filename: safe_photo_filename(&filename),
                });
            }
        }
    }
    if !has_readable_text {
        return Err("Telegram deliveries cannot contain images without readable text.".to_string());
    }
    Ok(normalized)
}

fn legacy_text_parts(chunks: &[String], parse_mode: Option<&str>) -> Vec<TelegramDeliveryPart> {
    chunks
        .iter()
        .map(|text| TelegramDeliveryPart::Text {
            text: text.clone(),
            parse_mode: parse_mode.map(str::to_string),
        })
        .collect()
}

fn discard_delivered_photo_bytes(parts: &mut [TelegramDeliveryPart], delivered: usize) {
    for part in parts.iter_mut().take(delivered) {
        if let TelegramDeliveryPart::Photo { data_base64, .. } = part {
            data_base64.clear();
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn state_path(root: &Path) -> PathBuf {
    root.join("telegram.json")
}

fn read_store(root: &Path) -> TelegramStore {
    fs::read_to_string(state_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<TelegramStore>(&raw).ok())
        .filter(|store| store.version == STORE_VERSION)
        .unwrap_or_default()
}

fn write_store(root: &Path, store: &TelegramStore) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create Telegram state directory: {error}"))?;
    let path = state_path(root);
    let temporary = root.join("telegram.json.tmp");
    let raw = serde_json::to_vec(store)
        .map_err(|error| format!("Could not serialize Telegram state: {error}"))?;
    fs::write(&temporary, raw)
        .map_err(|error| format!("Could not write Telegram state: {error}"))?;
    match fs::rename(&temporary, &path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            // Unix replaces atomically above. Windows needs the destination
            // removed first, so keep that less-atomic fallback platform-local.
            fs::remove_file(&path)
                .map_err(|error| format!("Could not replace Telegram state: {error}"))?;
            fs::rename(&temporary, &path)
                .map_err(|error| format!("Could not commit Telegram state: {error}"))
        }
        Err(error) => Err(format!("Could not commit Telegram state: {error}")),
    }
}

fn display_name(from: &Value) -> String {
    let first = from
        .get("first_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let last = from
        .get("last_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let combined = format!("{first} {last}").trim().to_string();
    if combined.is_empty() {
        from.get("username")
            .and_then(Value::as_str)
            .unwrap_or("Telegram user")
            .to_string()
    } else {
        combined
    }
}

fn fresh_pairing_id(user_id: i64, update_id: i64) -> String {
    format!("tg-{user_id:x}-{update_id:x}-{:x}", now_millis())
}

fn prune_store(store: &mut TelegramStore, now: i64) {
    store
        .pairing_requests
        .retain(|request| request.expires_at > now);
    store.events.retain(|event| {
        event.status != TelegramInboundStatus::Delivered
            || event.received_at >= now.saturating_sub(COMPLETED_EVENT_TTL_MS)
    });
    let mut delivered = store
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.status == TelegramInboundStatus::Delivered)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if delivered.len() > COMPLETED_EVENT_LIMIT {
        delivered.truncate(delivered.len() - COMPLETED_EVENT_LIMIT);
        for index in delivered.into_iter().rev() {
            store.events.remove(index);
        }
    }
    for delivery in &mut store.scheduled_deliveries {
        if delivery.status == "queued" && delivery.expires_at <= now {
            delivery.status = "blocked".to_string();
            delivery.last_error =
                Some("The Telegram alert expired before it could be sent.".to_string());
        }
    }
    store.scheduled_deliveries.retain(|delivery| {
        !matches!(delivery.status.as_str(), "sent" | "blocked")
            || delivery.created_at >= now.saturating_sub(COMPLETED_EVENT_TTL_MS)
    });
}

fn block_queued_scheduled_deliveries(store: &mut TelegramStore, message: &str) {
    for delivery in &mut store.scheduled_deliveries {
        if delivery.status == "queued" {
            delivery.status = "blocked".to_string();
            delivery.last_error = Some(message.to_string());
        }
    }
}

fn snapshot(
    store: &TelegramStore,
    live: &TelegramLiveState,
    configured: bool,
) -> TelegramChannelState {
    let delivery_error = store
        .events
        .iter()
        .rev()
        .find(|event| event.status == TelegramInboundStatus::Answered)
        .and_then(|event| event.last_error.clone());
    let error = live.error.clone().or(delivery_error);
    let status = if !configured || !store.enabled {
        "disconnected"
    } else if error.is_some() {
        "error"
    } else if live.phase == "connecting" {
        "connecting"
    } else if store.owner.is_none() {
        "awaitingPairing"
    } else {
        "connected"
    };
    TelegramChannelState {
        status: status.to_string(),
        configured,
        enabled: store.enabled,
        bot: store.bot.clone(),
        owner: store.owner.clone(),
        active_chat_id: store.active_chat_id.clone(),
        pairing_requests: store.pairing_requests.clone(),
        pending_count: store
            .events
            .iter()
            .filter(|event| event.status != TelegramInboundStatus::Delivered)
            .count()
            + store
                .scheduled_deliveries
                .iter()
                .filter(|delivery| delivery.status == "queued")
                .count(),
        error,
    }
}

pub fn get_state(
    root: &Path,
    runtime: &TelegramRuntimeState,
    configured: bool,
) -> Result<TelegramChannelState, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    prune_store(&mut store, now_millis());
    let live = runtime
        .live
        .lock()
        .map_err(|_| "Could not read Telegram connection state.".to_string())?
        .clone();
    Ok(snapshot(&store, &live, configured))
}

pub fn subscribe(
    runtime: &TelegramRuntimeState,
    channel: Channel<TelegramChannelEvent>,
) -> Result<(), String> {
    *runtime
        .subscriber
        .lock()
        .map_err(|_| "Could not subscribe to Telegram events.".to_string())? =
        Some(channel.clone());
    channel
        .send(TelegramChannelEvent {
            kind: "state".to_string(),
        })
        .map_err(|error| format!("Could not publish Telegram state: {error}"))
}

fn notify(runtime: &TelegramRuntimeState, kind: &str) {
    let channel = runtime
        .subscriber
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let Some(channel) = channel {
        let _ = channel.send(TelegramChannelEvent {
            kind: kind.to_string(),
        });
    }
}

fn set_live(runtime: &TelegramRuntimeState, phase: &str, error: Option<String>) {
    if let Ok(mut live) = runtime.live.lock() {
        live.phase = phase.to_string();
        live.error = error;
    }
    notify(runtime, "state");
}

async fn call_api(
    client: &Client,
    token: &str,
    method: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<Value, TelegramApiError> {
    let url = format!("{TELEGRAM_API_ROOT}/bot{token}/{method}");
    let response = client
        .post(url)
        .timeout(timeout)
        .json(payload)
        .send()
        .await
        .map_err(|error| TelegramApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            // reqwest's Display output may contain the request URL. Telegram
            // embeds the bot token in that URL, so never surface it here.
            description: if error.is_timeout() {
                "The Telegram request timed out.".to_string()
            } else {
                "Could not reach Telegram.".to_string()
            },
            retry_after: None,
        })?;
    telegram_response(response).await
}

async fn telegram_response(response: reqwest::Response) -> Result<Value, TelegramApiError> {
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if status.is_success() && body.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(body.get("result").cloned().unwrap_or(Value::Null));
    }
    Err(TelegramApiError {
        status,
        description: body
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Telegram rejected the request.")
            .to_string(),
        retry_after: body
            .pointer("/parameters/retry_after")
            .and_then(Value::as_u64),
    })
}

async fn call_multipart_api(
    client: &Client,
    token: &str,
    method: &str,
    form: multipart::Form,
    timeout: Duration,
) -> Result<Value, TelegramApiError> {
    let url = format!("{TELEGRAM_API_ROOT}/bot{token}/{method}");
    let response = client
        .post(url)
        .timeout(timeout)
        .multipart(form)
        .send()
        .await
        .map_err(|error| TelegramApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            description: if error.is_timeout() {
                "The Telegram media upload timed out.".to_string()
            } else {
                "Could not reach Telegram for the media upload.".to_string()
            },
            retry_after: None,
        })?;
    telegram_response(response).await
}

pub async fn validate_token(token: &str) -> Result<TelegramBotIdentity, String> {
    let client = Client::new();
    let result = call_api(&client, token, "getMe", &json!({}), Duration::from_secs(15))
        .await
        .map_err(|error| format!("Telegram rejected this bot token: {error}"))?;
    let id = result
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Telegram returned a bot without an id.".to_string())?;
    let username = result
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(TelegramBotIdentity {
        id,
        username,
        name: display_name(&result),
    })
}

pub async fn prepare_polling(token: &str) -> Result<(), String> {
    call_api(
        &Client::new(),
        token,
        "deleteWebhook",
        &json!({ "drop_pending_updates": false }),
        Duration::from_secs(15),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("Could not switch the Telegram bot to polling: {error}"))
}

pub fn configure(
    root: &Path,
    runtime: &TelegramRuntimeState,
    bot: TelegramBotIdentity,
) -> Result<(), String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    if store.bot.as_ref().map(|existing| existing.id) != Some(bot.id) {
        store.owner = None;
        store.active_chat_id = None;
        store.pairing_requests.clear();
        store
            .events
            .retain(|event| event.status == TelegramInboundStatus::Delivered);
        block_queued_scheduled_deliveries(
            &mut store,
            "The Telegram bot changed before this alert could be sent.",
        );
        store.next_offset = None;
    }
    store.enabled = true;
    store.bot = Some(bot);
    write_store(root, &store)
}

pub fn disconnect(root: &Path, runtime: &TelegramRuntimeState) -> Result<(), String> {
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    store.enabled = false;
    store.bot = None;
    store.owner = None;
    store.active_chat_id = None;
    store.next_offset = None;
    store.pairing_requests.clear();
    store
        .events
        .retain(|event| event.status == TelegramInboundStatus::Delivered);
    block_queued_scheduled_deliveries(
        &mut store,
        "Telegram was disconnected before this alert could be sent.",
    );
    write_store(root, &store)?;
    set_live(runtime, "disconnected", None);
    Ok(())
}

pub fn forget_owner(root: &Path, runtime: &TelegramRuntimeState) -> Result<(), String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    store.owner = None;
    store.active_chat_id = None;
    store.pairing_requests.clear();
    block_queued_scheduled_deliveries(
        &mut store,
        "The paired Telegram account was removed before this alert could be sent.",
    );
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "state");
    Ok(())
}

pub fn approve_pairing(
    root: &Path,
    runtime: &TelegramRuntimeState,
    request_id: &str,
) -> Result<TelegramPairingRequest, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    prune_store(&mut store, now_millis());
    let request = store
        .pairing_requests
        .iter()
        .find(|request| request.id == request_id)
        .cloned()
        .ok_or_else(|| "That Telegram pairing request has expired.".to_string())?;
    store.owner = Some(TelegramOwner {
        user_id: request.user_id,
        username: request.username.clone(),
        name: request.name.clone(),
        approved_at: now_millis(),
    });
    store.pairing_requests.clear();
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "state");
    Ok(request)
}

pub fn reject_pairing(
    root: &Path,
    runtime: &TelegramRuntimeState,
    request_id: &str,
) -> Result<(), String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let before = store.pairing_requests.len();
    store
        .pairing_requests
        .retain(|request| request.id != request_id);
    if before == store.pairing_requests.len() {
        return Err("Telegram pairing request not found.".to_string());
    }
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "state");
    Ok(())
}

pub fn claim_next(
    root: &Path,
    runtime: &TelegramRuntimeState,
) -> Result<Option<TelegramInboundEvent>, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let active_chat_id = store.active_chat_id.clone();
    let Some(event) = store
        .events
        .iter_mut()
        .find(|event| event.status == TelegramInboundStatus::Pending)
    else {
        return Ok(None);
    };
    event.status = TelegramInboundStatus::Running;
    event.attempts = event.attempts.saturating_add(1);
    if event.kind != TelegramInboundKind::NewChat && event.local_chat_id.is_none() {
        event.local_chat_id = active_chat_id;
    }
    let claimed = event.clone();
    write_store(root, &store)?;
    Ok(Some(claimed))
}

pub fn release_event(
    root: &Path,
    runtime: &TelegramRuntimeState,
    event_id: &str,
    error: Option<String>,
) -> Result<(), String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let event = store
        .events
        .iter_mut()
        .find(|event| event.id == event_id)
        .ok_or_else(|| "Telegram event not found.".to_string())?;
    event.status = TelegramInboundStatus::Pending;
    event.last_error = error;
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "inbound");
    Ok(())
}

pub fn record_answer(
    root: &Path,
    runtime: &TelegramRuntimeState,
    event_id: &str,
    local_chat_id: &str,
    reply_parts: Vec<TelegramDeliveryPart>,
) -> Result<TelegramInboundEvent, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let event = store
        .events
        .iter_mut()
        .find(|event| event.id == event_id)
        .ok_or_else(|| "Telegram event not found.".to_string())?;
    event.status = TelegramInboundStatus::Answered;
    event.local_chat_id = Some(local_chat_id.to_string());
    event.reply_chunks.clear();
    event.reply_parse_mode = None;
    event.reply_parts = reply_parts;
    event.delivered_chunks = 0;
    event.last_error = None;
    let answered = event.clone();
    store.active_chat_id = Some(local_chat_id.to_string());
    write_store(root, &store)?;
    Ok(answered)
}

fn update_delivery_progress(
    root: &Path,
    runtime: &TelegramRuntimeState,
    event_id: &str,
    delivered_chunks: usize,
    error: Option<String>,
) -> Result<(), String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let event = store
        .events
        .iter_mut()
        .find(|event| event.id == event_id)
        .ok_or_else(|| "Telegram event not found.".to_string())?;
    event.delivered_chunks = delivered_chunks;
    event.last_error = error;
    discard_delivered_photo_bytes(&mut event.reply_parts, delivered_chunks);
    let total = if event.reply_parts.is_empty() {
        event.reply_chunks.len()
    } else {
        event.reply_parts.len()
    };
    if event.delivered_chunks >= total {
        event.status = TelegramInboundStatus::Delivered;
    }
    write_store(root, &store)
}

fn send_message_body(chat_id: i64, text: &str, parse_mode: Option<&str>) -> Value {
    let mut body = json!({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": true
    });
    if let Some(parse_mode) = parse_mode {
        body["parse_mode"] = json!(parse_mode);
    }
    body
}

async fn send_text(
    client: &Client,
    token: &str,
    chat_id: i64,
    text: &str,
    parse_mode: Option<&str>,
) -> Result<(), TelegramApiError> {
    let body = send_message_body(chat_id, text, parse_mode);
    call_api(client, token, "sendMessage", &body, Duration::from_secs(30))
        .await
        .map(|_| ())
}

async fn send_rich_html(
    client: &Client,
    token: &str,
    chat_id: i64,
    html: &str,
) -> Result<(), TelegramApiError> {
    call_api(
        client,
        token,
        "sendRichMessage",
        &json!({
            "chat_id": chat_id,
            "rich_message": { "html": html }
        }),
        Duration::from_secs(30),
    )
    .await
    .map(|_| ())
}

async fn send_photo(
    client: &Client,
    token: &str,
    chat_id: i64,
    data_base64: &str,
    filename: &str,
) -> Result<(), TelegramApiError> {
    let bytes = BASE64.decode(data_base64).map_err(|_| TelegramApiError {
        status: StatusCode::BAD_REQUEST,
        description: "The queued Telegram chart image is invalid.".to_string(),
        retry_after: None,
    })?;
    let photo = multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str("image/png")
        .map_err(|_| TelegramApiError {
            status: StatusCode::BAD_REQUEST,
            description: "The queued Telegram chart image has an invalid media type.".to_string(),
            retry_after: None,
        })?;
    let form = multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("photo", photo);
    call_multipart_api(client, token, "sendPhoto", form, Duration::from_secs(60))
        .await
        .map(|_| ())
}

async fn send_delivery_part(
    client: &Client,
    token: &str,
    chat_id: i64,
    part: &TelegramDeliveryPart,
) -> Result<(), TelegramApiError> {
    match part {
        TelegramDeliveryPart::Text { text, parse_mode } => {
            send_text(client, token, chat_id, text, parse_mode.as_deref()).await
        }
        TelegramDeliveryPart::Rich {
            html,
            fallback_text,
            fallback_parse_mode,
        } => match send_rich_html(client, token, chat_id, html).await {
            Ok(()) => Ok(()),
            // Rich messages are new. An older or rejecting Telegram endpoint
            // still receives the durable labelled-row representation.
            Err(error)
                if matches!(
                    error.status,
                    StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
                ) =>
            {
                send_text(
                    client,
                    token,
                    chat_id,
                    fallback_text,
                    fallback_parse_mode.as_deref(),
                )
                .await
            }
            Err(error) => Err(error),
        },
        TelegramDeliveryPart::Photo {
            data_base64,
            filename,
        } => send_photo(client, token, chat_id, data_base64, filename).await,
    }
}

pub fn enqueue_scheduled_delivery(
    root: &Path,
    runtime: &TelegramRuntimeState,
    task_id: &str,
    execution_id: &str,
    recipient_user_id: i64,
    parts: Vec<TelegramDeliveryPart>,
    expires_at: i64,
) -> Result<TelegramScheduledDelivery, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    if !store.enabled {
        return Err("Telegram is disconnected.".to_string());
    }
    if store.owner.as_ref().map(|owner| owner.user_id) != Some(recipient_user_id) {
        return Err("The task's Telegram recipient is no longer paired.".to_string());
    }
    let id = format!("scheduled-{execution_id}");
    if let Some(existing) = store
        .scheduled_deliveries
        .iter()
        .find(|delivery| delivery.id == id)
        .cloned()
    {
        return Ok(existing);
    }
    let delivery = TelegramScheduledDelivery {
        id,
        task_id: task_id.to_string(),
        execution_id: execution_id.to_string(),
        recipient_user_id,
        chunks: Vec::new(),
        parse_mode: None,
        parts,
        delivered_chunks: 0,
        status: "queued".to_string(),
        created_at: now_millis(),
        expires_at,
        last_error: None,
    };
    store.scheduled_deliveries.push(delivery.clone());
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "delivery");
    Ok(delivery)
}

fn update_scheduled_delivery_progress(
    root: &Path,
    runtime: &TelegramRuntimeState,
    delivery_id: &str,
    delivered_chunks: usize,
    status: &str,
    error: Option<String>,
) -> Result<TelegramScheduledDelivery, String> {
    let _guard = runtime
        .store_lock
        .lock()
        .map_err(|_| "Could not lock Telegram state.".to_string())?;
    let mut store = read_store(root);
    let delivery = store
        .scheduled_deliveries
        .iter_mut()
        .find(|delivery| delivery.id == delivery_id)
        .ok_or_else(|| "Telegram delivery not found.".to_string())?;
    delivery.delivered_chunks = delivered_chunks;
    delivery.status = status.to_string();
    delivery.last_error = error;
    discard_delivered_photo_bytes(&mut delivery.parts, delivered_chunks);
    let result = delivery.clone();
    write_store(root, &store)?;
    drop(_guard);
    notify(runtime, "delivery");
    Ok(result)
}

pub fn scheduled_delivery_status(
    root: &Path,
    runtime: &TelegramRuntimeState,
    delivery_id: &str,
) -> Option<TelegramScheduledDeliveryResult> {
    let _guard = runtime.store_lock.lock().ok()?;
    let mut store = read_store(root);
    prune_store(&mut store, now_millis());
    let result = store
        .scheduled_deliveries
        .iter()
        .find(|delivery| delivery.id == delivery_id)
        .map(|delivery| TelegramScheduledDeliveryResult {
            delivery_id: delivery.id.clone(),
            status: delivery.status.clone(),
            error: delivery.last_error.clone(),
        });
    let _ = write_store(root, &store);
    result
}

pub async fn deliver_scheduled_delivery(
    root: &Path,
    runtime: &TelegramRuntimeState,
    token: &str,
    delivery_id: &str,
) -> Result<TelegramScheduledDeliveryResult, String> {
    let delivery = {
        let _guard = runtime
            .store_lock
            .lock()
            .map_err(|_| "Could not lock Telegram state.".to_string())?;
        let mut store = read_store(root);
        prune_store(&mut store, now_millis());
        let delivery = store
            .scheduled_deliveries
            .iter()
            .find(|delivery| delivery.id == delivery_id)
            .cloned()
            .ok_or_else(|| "Telegram delivery not found.".to_string())?;
        if store.owner.as_ref().map(|owner| owner.user_id) != Some(delivery.recipient_user_id) {
            drop(_guard);
            let blocked = update_scheduled_delivery_progress(
                root,
                runtime,
                delivery_id,
                delivery.delivered_chunks,
                "blocked",
                Some("The task's Telegram recipient is no longer paired.".to_string()),
            )?;
            return Ok(TelegramScheduledDeliveryResult {
                delivery_id: blocked.id,
                status: blocked.status,
                error: blocked.last_error,
            });
        }
        delivery
    };
    if delivery.status != "queued" {
        return Ok(TelegramScheduledDeliveryResult {
            delivery_id: delivery.id,
            status: delivery.status,
            error: delivery.last_error,
        });
    }
    let client = Client::new();
    let parts = if delivery.parts.is_empty() {
        legacy_text_parts(&delivery.chunks, delivery.parse_mode.as_deref())
    } else {
        delivery.parts.clone()
    };
    let mut delivered = delivery.delivered_chunks;
    for part in parts.iter().skip(delivered) {
        match send_delivery_part(&client, token, delivery.recipient_user_id, part).await {
            Ok(()) => {
                delivered += 1;
                update_scheduled_delivery_progress(
                    root,
                    runtime,
                    delivery_id,
                    delivered,
                    if delivered == parts.len() {
                        "sent"
                    } else {
                        "queued"
                    },
                    None,
                )?;
            }
            Err(error) => {
                let message = error.to_string();
                update_scheduled_delivery_progress(
                    root,
                    runtime,
                    delivery_id,
                    delivered,
                    "queued",
                    Some(message.clone()),
                )?;
                return Ok(TelegramScheduledDeliveryResult {
                    delivery_id: delivery.id,
                    status: "queued".to_string(),
                    error: Some(message),
                });
            }
        }
    }
    Ok(TelegramScheduledDeliveryResult {
        delivery_id: delivery.id,
        status: "sent".to_string(),
        error: None,
    })
}

async fn deliver_scheduled_deliveries(root: &Path, runtime: &TelegramRuntimeState, token: &str) {
    let ids = {
        let Ok(_guard) = runtime.store_lock.lock() else {
            return;
        };
        let mut store = read_store(root);
        prune_store(&mut store, now_millis());
        let _ = write_store(root, &store);
        store
            .scheduled_deliveries
            .iter()
            .filter(|delivery| delivery.status == "queued")
            .map(|delivery| delivery.id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        let _ = deliver_scheduled_delivery(root, runtime, token, &id).await;
    }
}

pub async fn send_pairing_approved(token: &str, chat_id: i64) {
    let _ = send_text(
        &Client::new(),
        token,
        chat_id,
        "Connected to Raynard. Send me a message, or /new to start a fresh Raynard chat.",
        None,
    )
    .await;
}

pub async fn send_typing(
    root: &Path,
    runtime: &TelegramRuntimeState,
    token: &str,
    event_id: &str,
) -> Result<(), String> {
    let chat_id = {
        let _guard = runtime
            .store_lock
            .lock()
            .map_err(|_| "Could not lock Telegram state.".to_string())?;
        read_store(root)
            .events
            .iter()
            .find(|event| event.id == event_id)
            .map(|event| event.remote_chat_id)
            .ok_or_else(|| "Telegram event not found.".to_string())?
    };
    call_api(
        &Client::new(),
        token,
        "sendChatAction",
        &json!({ "chat_id": chat_id, "action": "typing" }),
        Duration::from_secs(10),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("Could not send Telegram typing status: {error}"))
}

pub async fn deliver_event(
    root: &Path,
    runtime: &TelegramRuntimeState,
    token: &str,
    event_id: &str,
) -> Result<TelegramDeliveryResult, String> {
    let event = {
        let _guard = runtime
            .store_lock
            .lock()
            .map_err(|_| "Could not lock Telegram state.".to_string())?;
        read_store(root)
            .events
            .into_iter()
            .find(|event| event.id == event_id)
            .ok_or_else(|| "Telegram event not found.".to_string())?
    };
    let client = Client::new();
    let parts = if event.reply_parts.is_empty() {
        legacy_text_parts(&event.reply_chunks, event.reply_parse_mode.as_deref())
    } else {
        event.reply_parts.clone()
    };
    let mut delivered = event.delivered_chunks;
    for part in parts.iter().skip(delivered) {
        match send_delivery_part(&client, token, event.remote_chat_id, part).await {
            Ok(()) => {
                delivered += 1;
                update_delivery_progress(root, runtime, event_id, delivered, None)?;
            }
            Err(error) => {
                let message = error.to_string();
                update_delivery_progress(
                    root,
                    runtime,
                    event_id,
                    delivered,
                    Some(message.clone()),
                )?;
                notify(runtime, "state");
                return Ok(TelegramDeliveryResult {
                    delivered: false,
                    error: Some(message),
                });
            }
        }
    }
    notify(runtime, "state");
    Ok(TelegramDeliveryResult {
        delivered: true,
        error: None,
    })
}

fn ingest_update(store: &mut TelegramStore, update: &Value, now: i64) -> Option<(i64, String)> {
    let update_id = update.get("update_id")?.as_i64()?;
    store.next_offset = Some(update_id.saturating_add(1));
    let message = update.get("message")?;
    let message_id = message.get("message_id")?.as_i64()?;
    let chat = message.get("chat")?;
    if chat.get("type").and_then(Value::as_str) != Some("private") {
        return None;
    }
    let chat_id = chat.get("id")?.as_i64()?;
    let from = message.get("from")?;
    if from.get("is_bot").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let user_id = from.get("id")?.as_i64()?;
    let text = message.get("text").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let username = from
        .get("username")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = display_name(from);

    if store.owner.is_none() {
        let existing = store
            .pairing_requests
            .iter()
            .find(|request| request.user_id == user_id && request.expires_at > now)
            .cloned();
        if existing.is_none() {
            store.pairing_requests.push(TelegramPairingRequest {
                id: fresh_pairing_id(user_id, update_id),
                user_id,
                chat_id,
                username,
                name,
                created_at: now,
                expires_at: now + PAIRING_TTL_MS,
            });
        }
        return Some((chat_id, "Open Raynard Settings to approve this Telegram account. The request expires in one hour.".to_string()));
    }

    let owner = store.owner.clone()?;
    if owner.user_id != user_id {
        return Some((
            chat_id,
            "This Raynard bot is paired with another Telegram account.".to_string(),
        ));
    }
    if text == "/start" {
        return Some((
            chat_id,
            "Raynard is connected. Send a text request, or /new to start a fresh Raynard chat."
                .to_string(),
        ));
    }
    let event_id = format!("telegram-{update_id}");
    if store.events.iter().any(|event| event.id == event_id) {
        return None;
    }
    store.events.push(TelegramInboundEvent {
        id: event_id,
        update_id,
        message_id,
        remote_chat_id: chat_id,
        sender: owner,
        text: text.to_string(),
        received_at: now,
        kind: if text == "/new" {
            TelegramInboundKind::NewChat
        } else {
            TelegramInboundKind::Message
        },
        status: TelegramInboundStatus::Pending,
        // Bind when the event is claimed, not when it arrives. This preserves
        // queue order when /new and a follow-up land in the same getUpdates
        // batch: completing /new changes the active chat before the follow-up
        // is claimed.
        local_chat_id: None,
        reply_chunks: Vec::new(),
        reply_parse_mode: None,
        reply_parts: Vec::new(),
        delivered_chunks: 0,
        attempts: 0,
        last_error: None,
    });
    None
}

async fn deliver_answered_events(root: &Path, runtime: &TelegramRuntimeState, token: &str) {
    let ids = {
        let Ok(_guard) = runtime.store_lock.lock() else {
            return;
        };
        read_store(root)
            .events
            .iter()
            .filter(|event| event.status == TelegramInboundStatus::Answered)
            .map(|event| event.id.clone())
            .collect::<Vec<_>>()
    };
    for id in ids {
        let _ = deliver_event(root, runtime, token, &id).await;
    }
}

pub fn start_poller(root: PathBuf, runtime: &TelegramRuntimeState, token: String) {
    if let Ok(_guard) = runtime.store_lock.lock() {
        let mut store = read_store(&root);
        let mut changed = false;
        for event in &mut store.events {
            if event.status == TelegramInboundStatus::Running {
                event.status = TelegramInboundStatus::Pending;
                event.last_error =
                    Some("Raynard restarted before this turn completed.".to_string());
                changed = true;
            }
        }
        if changed {
            let _ = write_store(&root, &store);
        }
    }
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_live(runtime, "connecting", None);
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let client = Client::new();
        let mut backoff_seconds = 1u64;
        loop {
            if runtime.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            deliver_answered_events(&root, &runtime, &token).await;
            deliver_scheduled_deliveries(&root, &runtime, &token).await;
            let offset = {
                let Ok(_guard) = runtime.store_lock.lock() else {
                    break;
                };
                let store = read_store(&root);
                if !store.enabled {
                    break;
                }
                store.next_offset
            };
            let mut payload = json!({
                "timeout": 25,
                "allowed_updates": ["message"]
            });
            if let Some(offset) = offset {
                payload["offset"] = json!(offset);
            }
            let result = call_api(
                &client,
                &token,
                "getUpdates",
                &payload,
                Duration::from_secs(35),
            )
            .await;
            match result {
                Ok(Value::Array(updates)) => {
                    set_live(&runtime, "polling", None);
                    backoff_seconds = 1;
                    for update in updates {
                        let canned_reply = {
                            let Ok(_guard) = runtime.store_lock.lock() else {
                                break;
                            };
                            let mut store = read_store(&root);
                            prune_store(&mut store, now_millis());
                            let reply = ingest_update(&mut store, &update, now_millis());
                            if write_store(&root, &store).is_err() {
                                set_live(
                                    &runtime,
                                    "error",
                                    Some(
                                        "Could not persist an incoming Telegram message."
                                            .to_string(),
                                    ),
                                );
                                break;
                            }
                            reply
                        };
                        notify(&runtime, "inbound");
                        if let Some((chat_id, reply)) = canned_reply {
                            let _ = send_text(&client, &token, chat_id, &reply, None).await;
                        }
                    }
                }
                Ok(_) => {
                    set_live(
                        &runtime,
                        "error",
                        Some("Telegram returned an invalid update list.".to_string()),
                    );
                }
                Err(error) => {
                    if error.status == StatusCode::UNAUTHORIZED {
                        set_live(
                            &runtime,
                            "error",
                            Some("Telegram rejected the saved bot token.".to_string()),
                        );
                        break;
                    }
                    let wait = error.retry_after.unwrap_or(backoff_seconds).min(30);
                    set_live(&runtime, "error", Some(error.to_string()));
                    tokio_sleep(Duration::from_secs(wait)).await;
                    backoff_seconds = (backoff_seconds * 2).min(30);
                }
            }
        }
    });
}

async fn tokio_sleep(duration: Duration) {
    // Tauri re-exports an async runtime but not its timer. A short blocking sleep
    // runs on its worker pool and occurs only on transport backoff.
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_part(text: &str) -> TelegramDeliveryPart {
        TelegramDeliveryPart::Text {
            text: text.to_string(),
            parse_mode: Some("HTML".to_string()),
        }
    }

    fn update(update_id: i64, user_id: i64, text: &str) -> Value {
        json!({
            "update_id": update_id,
            "message": {
                "message_id": update_id + 100,
                "chat": { "id": user_id, "type": "private" },
                "from": { "id": user_id, "is_bot": false, "first_name": "Ada", "username": "ada" },
                "text": text
            }
        })
    }

    #[test]
    fn send_message_body_adds_parse_mode_only_for_formatted_replies() {
        let rich = send_message_body(42, "<b>Answer</b>", Some("HTML"));
        assert_eq!(rich["parse_mode"], "HTML");
        assert_eq!(rich["disable_web_page_preview"], true);

        let plain = send_message_body(42, "Connected", None);
        assert!(plain.get("parse_mode").is_none());
    }

    #[test]
    fn persisted_legacy_deliveries_default_to_plain_text() {
        let event: TelegramInboundEvent = serde_json::from_value(json!({
            "id": "telegram-1",
            "updateId": 1,
            "messageId": 101,
            "remoteChatId": 42,
            "sender": {
                "userId": 42,
                "username": "ada",
                "name": "Ada",
                "approvedAt": 1
            },
            "text": "hello",
            "receivedAt": 2,
            "kind": "message",
            "status": "answered",
            "localChatId": "chat-one",
            "replyChunks": ["Old <plain> text"],
            "deliveredChunks": 0,
            "attempts": 1,
            "lastError": null
        }))
        .unwrap();

        assert_eq!(event.reply_parse_mode, None);
        assert!(event.reply_parts.is_empty());

        let delivery: TelegramScheduledDelivery = serde_json::from_value(json!({
            "id": "scheduled-execution-one",
            "taskId": "task-one",
            "executionId": "execution-one",
            "recipientUserId": 42,
            "chunks": ["Old scheduled <plain> text"],
            "deliveredChunks": 0,
            "status": "queued",
            "createdAt": 1,
            "expiresAt": 2,
            "lastError": null
        }))
        .unwrap();

        assert_eq!(delivery.parse_mode, None);
        assert!(delivery.parts.is_empty());
    }

    #[test]
    fn delivery_parts_require_text_and_validate_png_media() {
        let png = BASE64.encode([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]);
        let mut normalized = normalize_delivery_parts(vec![
            text_part("Summary first"),
            TelegramDeliveryPart::Photo {
                data_base64: png.clone(),
                filename: "chart.png".into(),
            },
        ])
        .unwrap();
        assert_eq!(normalized.len(), 2);
        discard_delivered_photo_bytes(&mut normalized, 2);
        assert!(matches!(
            &normalized[1],
            TelegramDeliveryPart::Photo { data_base64, .. } if data_base64.is_empty()
        ));

        assert!(normalize_delivery_parts(vec![TelegramDeliveryPart::Photo {
            data_base64: png,
            filename: "chart.png".into(),
        }])
        .unwrap_err()
        .contains("without readable text"));
        assert!(normalize_delivery_parts(vec![
            text_part("Summary"),
            TelegramDeliveryPart::Photo {
                data_base64: BASE64.encode(b"not a png"),
                filename: "chart.png".into(),
            },
        ])
        .unwrap_err()
        .contains("PNG"));
    }

    #[test]
    fn rich_tables_keep_a_valid_labelled_fallback() {
        let parts = normalize_delivery_parts(vec![TelegramDeliveryPart::Rich {
            html: "<table><tr><th>Name</th></tr><tr><td>Adobe</td></tr></table>".into(),
            fallback_text: "<b>Name:</b> Adobe".into(),
            fallback_parse_mode: Some("html".into()),
        }])
        .unwrap();

        assert!(matches!(
            &parts[0],
            TelegramDeliveryPart::Rich { fallback_parse_mode: Some(mode), .. } if mode == "HTML"
        ));
        let encoded = serde_json::to_value(&parts[0]).unwrap();
        assert_eq!(encoded["kind"], "rich");
        assert_eq!(encoded["fallbackText"], "<b>Name:</b> Adobe");
        assert_eq!(encoded["fallbackParseMode"], "HTML");
    }

    #[test]
    fn first_private_sender_creates_pairing_without_agent_event() {
        let mut store = TelegramStore::default();
        let reply = ingest_update(&mut store, &update(1, 42, "hello"), 100).unwrap();
        assert_eq!(reply.0, 42);
        assert_eq!(store.next_offset, Some(2));
        assert_eq!(store.pairing_requests.len(), 1);
        assert!(store.events.is_empty());
    }

    #[test]
    fn approved_owner_creates_one_deduplicated_event() {
        let mut store = TelegramStore {
            owner: Some(TelegramOwner {
                user_id: 42,
                username: Some("ada".into()),
                name: "Ada".into(),
                approved_at: 1,
            }),
            active_chat_id: Some("chat-one".into()),
            ..TelegramStore::default()
        };
        assert!(ingest_update(&mut store, &update(2, 42, "research this"), 100).is_none());
        assert_eq!(store.events.len(), 1);
        assert_eq!(store.events[0].local_chat_id, None);
        assert!(ingest_update(&mut store, &update(2, 42, "research this"), 101).is_none());
        assert_eq!(store.events.len(), 1);
    }

    #[test]
    fn other_sender_and_groups_never_create_agent_events() {
        let mut store = TelegramStore {
            owner: Some(TelegramOwner {
                user_id: 42,
                username: None,
                name: "Ada".into(),
                approved_at: 1,
            }),
            ..TelegramStore::default()
        };
        assert!(ingest_update(&mut store, &update(3, 7, "hello"), 100).is_some());
        let group = json!({
            "update_id": 4,
            "message": {
                "message_id": 9,
                "chat": { "id": -1, "type": "group" },
                "from": { "id": 42, "is_bot": false },
                "text": "hello"
            }
        });
        assert!(ingest_update(&mut store, &group, 100).is_none());
        assert!(store.events.is_empty());
        assert_eq!(store.next_offset, Some(5));
    }

    #[test]
    fn new_command_forces_a_new_binding() {
        let mut store = TelegramStore {
            owner: Some(TelegramOwner {
                user_id: 42,
                username: None,
                name: "Ada".into(),
                approved_at: 1,
            }),
            active_chat_id: Some("old".into()),
            ..TelegramStore::default()
        };
        ingest_update(&mut store, &update(5, 42, "/new"), 100);
        assert_eq!(store.events[0].kind, TelegramInboundKind::NewChat);
        assert_eq!(store.events[0].local_chat_id, None);
    }

    #[test]
    fn follow_up_after_new_binds_when_claimed() {
        let root = std::env::temp_dir().join(format!(
            "raynard-telegram-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = TelegramRuntimeState::default();
        let mut store = TelegramStore {
            enabled: true,
            owner: Some(TelegramOwner {
                user_id: 42,
                username: None,
                name: "Ada".into(),
                approved_at: 1,
            }),
            active_chat_id: Some("old".into()),
            ..TelegramStore::default()
        };
        ingest_update(&mut store, &update(5, 42, "/new"), 100);
        ingest_update(&mut store, &update(6, 42, "continue here"), 101);
        write_store(&root, &store).unwrap();

        let new_event = claim_next(&root, &runtime).unwrap().unwrap();
        assert_eq!(new_event.kind, TelegramInboundKind::NewChat);
        assert_eq!(new_event.local_chat_id, None);
        record_answer(
            &root,
            &runtime,
            &new_event.id,
            "new-chat",
            vec![text_part("Started")],
        )
        .unwrap();

        let recorded = read_store(&root);
        assert!(recorded.events[0].reply_chunks.is_empty());
        assert!(matches!(
            &recorded.events[0].reply_parts[0],
            TelegramDeliveryPart::Text { parse_mode: Some(mode), .. } if mode == "HTML"
        ));

        let follow_up = claim_next(&root, &runtime).unwrap().unwrap();
        assert_eq!(follow_up.local_chat_id.as_deref(), Some("new-chat"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn disconnect_clears_bot_pairing_and_pending_work() {
        let root = std::env::temp_dir().join(format!(
            "raynard-telegram-disconnect-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = TelegramRuntimeState::default();
        let mut store = TelegramStore {
            enabled: true,
            bot: Some(TelegramBotIdentity {
                id: 7,
                username: "raynard_bot".into(),
                name: "Raynard".into(),
            }),
            owner: Some(TelegramOwner {
                user_id: 42,
                username: None,
                name: "Ada".into(),
                approved_at: 1,
            }),
            active_chat_id: Some("chat-one".into()),
            ..TelegramStore::default()
        };
        ingest_update(&mut store, &update(7, 42, "pending"), 100);
        write_store(&root, &store).unwrap();

        disconnect(&root, &runtime).unwrap();

        let disconnected = read_store(&root);
        assert!(!disconnected.enabled);
        assert_eq!(disconnected.bot, None);
        assert_eq!(disconnected.owner, None);
        assert_eq!(disconnected.active_chat_id, None);
        assert!(disconnected.events.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scheduled_delivery_is_durable_deduplicated_and_bound_to_owner() {
        let root = std::env::temp_dir().join(format!(
            "raynard-telegram-scheduled-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = TelegramRuntimeState::default();
        let store = TelegramStore {
            enabled: true,
            owner: Some(TelegramOwner {
                user_id: 42,
                username: Some("ada".into()),
                name: "Ada".into(),
                approved_at: 1,
            }),
            ..TelegramStore::default()
        };
        write_store(&root, &store).unwrap();

        let first = enqueue_scheduled_delivery(
            &root,
            &runtime,
            "task-one",
            "execution-one",
            42,
            vec![text_part("The condition matched.")],
            now_millis() + 60_000,
        )
        .unwrap();
        let duplicate = enqueue_scheduled_delivery(
            &root,
            &runtime,
            "task-one",
            "execution-one",
            42,
            vec![text_part("A different retry body must not replace it.")],
            now_millis() + 60_000,
        )
        .unwrap();

        assert_eq!(first.id, duplicate.id);
        assert_eq!(read_store(&root).scheduled_deliveries.len(), 1);
        assert!(duplicate.chunks.is_empty());
        assert!(matches!(
            &duplicate.parts[0],
            TelegramDeliveryPart::Text { text, parse_mode: Some(mode) }
                if text == "The condition matched." && mode == "HTML"
        ));
        assert!(enqueue_scheduled_delivery(
            &root,
            &runtime,
            "task-one",
            "execution-two",
            7,
            vec![text_part("Wrong account")],
            now_millis() + 60_000,
        )
        .unwrap_err()
        .contains("no longer paired"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn disconnect_blocks_queued_scheduled_alerts() {
        let root = std::env::temp_dir().join(format!(
            "raynard-telegram-scheduled-disconnect-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let runtime = TelegramRuntimeState::default();
        let store = TelegramStore {
            enabled: true,
            owner: Some(TelegramOwner {
                user_id: 42,
                username: None,
                name: "Ada".into(),
                approved_at: 1,
            }),
            scheduled_deliveries: vec![TelegramScheduledDelivery {
                id: "scheduled-execution-one".into(),
                task_id: "task-one".into(),
                execution_id: "execution-one".into(),
                recipient_user_id: 42,
                chunks: vec!["Alert".into()],
                parse_mode: None,
                parts: Vec::new(),
                delivered_chunks: 0,
                status: "queued".into(),
                created_at: now_millis(),
                expires_at: now_millis() + 60_000,
                last_error: None,
            }],
            ..TelegramStore::default()
        };
        write_store(&root, &store).unwrap();

        disconnect(&root, &runtime).unwrap();

        let disconnected = read_store(&root);
        assert_eq!(disconnected.scheduled_deliveries[0].status, "blocked");
        assert!(disconnected.scheduled_deliveries[0]
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("disconnected"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn expired_scheduled_alerts_fail_closed() {
        let mut store = TelegramStore {
            scheduled_deliveries: vec![TelegramScheduledDelivery {
                id: "scheduled-expired".into(),
                task_id: "task-one".into(),
                execution_id: "execution-one".into(),
                recipient_user_id: 42,
                chunks: vec!["Stale alert".into()],
                parse_mode: None,
                parts: Vec::new(),
                delivered_chunks: 0,
                status: "queued".into(),
                created_at: 100,
                expires_at: 199,
                last_error: None,
            }],
            ..TelegramStore::default()
        };

        prune_store(&mut store, 200);

        assert_eq!(store.scheduled_deliveries[0].status, "blocked");
        assert!(store.scheduled_deliveries[0]
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("expired"));
    }
}
