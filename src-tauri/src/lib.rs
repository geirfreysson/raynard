use futures_util::StreamExt;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use tauri::Manager;

const KEYRING_SERVICE: &str = "ai.raynard";

#[derive(Serialize)]
struct LlmEnvStatus {
    found: bool,
    path: Option<String>,
    keys: Vec<String>,
    provider: String,
    model: String,
    configured: bool,
}

#[derive(Serialize, Clone)]
struct ModelProvider {
    id: String,
    name: String,
    base_url: String,
    default_model: String,
    active: bool,
    connected: bool,
}

#[derive(Serialize)]
struct ModelProviderList {
    providers: Vec<ModelProvider>,
}

#[derive(Deserialize, Default, Serialize)]
struct AppConfig {
    active_provider: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct StoredChatMessage {
    role: String,
    text: String,
    timestamp: i64,
    thinking: Option<String>,
    provider: Option<String>,
    model: Option<String>,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryRow {
    chat_id: String,
    name: String,
    created_at: String,
    updated_at: String,
    message_count: usize,
}

#[derive(Serialize)]
struct ChatHistoryList {
    folder: String,
    chats: Vec<ChatHistoryRow>,
}

#[tauri::command]
fn load_llm_env_status(app: tauri::AppHandle) -> Result<LlmEnvStatus, String> {
    let config = resolve_model_config(Some(&app))?;
    let env_path = find_env_file();
    let Some(path) = env_path else {
        return Ok(LlmEnvStatus {
            found: false,
            path: None,
            keys: Vec::new(),
            provider: config.provider,
            model: config.model,
            configured: !config.api_key.is_empty(),
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
        configured: !config.api_key.is_empty(),
    })
}

#[tauri::command]
fn list_chat_history(app: tauri::AppHandle) -> Result<ChatHistoryList, String> {
    let dir = chat_history_dir(&app)?;
    ensure_dir(&dir)?;
    let mut chats = Vec::new();

    let entries =
        fs::read_dir(&dir).map_err(|error| format!("Could not read chat history: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read chat history entry: {error}"))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
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
            ChatHistoryRow {
                chat_id,
                name: normalize_chat_name(&chat.name),
                created_at: normalize_iso(&chat.created_at)
                    .unwrap_or_else(|| fallback_time.clone()),
                updated_at: normalize_iso(&chat.updated_at)
                    .unwrap_or_else(|| fallback_time.clone()),
                message_count: normalize_stored_messages(chat.messages).len(),
            }
        } else {
            ChatHistoryRow {
                chat_id,
                name: "Untitled chat".to_string(),
                created_at: fallback_time.clone(),
                updated_at: fallback_time,
                message_count: 0,
            }
        };
        chats.push(row);
    }

    chats.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    Ok(ChatHistoryList {
        folder: dir.to_string_lossy().to_string(),
        chats,
    })
}

#[tauri::command]
fn read_chat_history(app: tauri::AppHandle, chat_id: String) -> Result<ChatHistoryPayload, String> {
    let safe_chat_id = normalize_chat_id(&chat_id);
    let path = chat_history_path(&app, &safe_chat_id)?;
    if !path.is_file() {
        return Err(format!("Chat not found: {safe_chat_id}"));
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("Could not read chat: {error}"))?;
    let mut chat: ChatHistoryPayload =
        serde_json::from_str(&raw).map_err(|error| format!("Could not parse chat: {error}"))?;
    chat.chat_id = safe_chat_id;
    chat.name = normalize_chat_name(&chat.name);
    chat.created_at = normalize_iso(&chat.created_at).unwrap_or_else(now_iso);
    chat.updated_at = normalize_iso(&chat.updated_at).unwrap_or_else(now_iso);
    chat.messages = normalize_stored_messages(chat.messages);
    Ok(chat)
}

#[tauri::command]
fn save_chat_history(
    app: tauri::AppHandle,
    payload: ChatHistoryPayload,
) -> Result<ChatHistoryRow, String> {
    let safe_chat_id = normalize_chat_id(&payload.chat_id);
    let path = chat_history_path(&app, &safe_chat_id)?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }

    let existing_created_at = if path.is_file() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ChatHistoryPayload>(&raw).ok())
            .and_then(|chat| normalize_iso(&chat.created_at))
    } else {
        None
    };
    let created_at = normalize_iso(&payload.created_at)
        .or(existing_created_at)
        .unwrap_or_else(now_iso);
    let updated_at = normalize_iso(&payload.updated_at).unwrap_or_else(now_iso);
    let messages = normalize_stored_messages(payload.messages);
    let normalized = ChatHistoryPayload {
        chat_id: safe_chat_id.clone(),
        name: normalize_chat_name(&payload.name),
        created_at,
        updated_at,
        messages,
    };
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Could not serialize chat: {error}"))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("Could not save chat: {error}"))?;

    Ok(ChatHistoryRow {
        chat_id: normalized.chat_id,
        name: normalized.name,
        created_at: normalized.created_at,
        updated_at: normalized.updated_at,
        message_count: normalized.messages.len(),
    })
}

#[tauri::command]
fn delete_chat_history(app: tauri::AppHandle, chat_id: String) -> Result<(), String> {
    let safe_chat_id = normalize_chat_id(&chat_id);
    let path = chat_history_path(&app, &safe_chat_id)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| format!("Could not delete chat: {error}"))?;
    }
    Ok(())
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
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    if provider_preset(&provider_id).is_none() {
        return Err(format!("Unsupported provider: {provider_id}"));
    }

    let cleaned_key = api_key.trim();
    if cleaned_key.is_empty() {
        return Err("API key is required.".to_string());
    }

    keyring_entry(&provider_id)?
        .set_password(cleaned_key)
        .map_err(|error| format!("Could not store API key in the OS keychain: {error}"))?;

    save_app_config(
        &app,
        AppConfig {
            active_provider: Some(provider_id),
        },
    )?;

    list_model_providers(app)
}

#[tauri::command]
fn set_active_provider(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<ModelProviderList, String> {
    let provider_id = canonical_provider_id(&provider_id);
    if provider_preset(&provider_id).is_none() {
        return Err(format!("Unsupported provider: {provider_id}"));
    }

    if read_provider_api_key(&provider_id).is_empty() {
        return Err("Save an API key for this provider first.".to_string());
    }

    save_app_config(
        &app,
        AppConfig {
            active_provider: Some(provider_id),
        },
    )?;

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

#[derive(Clone)]
struct ModelConfig {
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Clone)]
struct ProviderPreset {
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    default_model: &'static str,
    api_key_names: &'static [&'static str],
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
async fn run_model_chat_stream(
    app: tauri::AppHandle,
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
        return run_claude_chat_stream(config, stream_id, on_event, messages).await;
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
            stream_id,
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

fn emit_stream_event(channel: &Channel<StreamEvent>, event: StreamEvent) {
    let _ = channel.send(event);
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
            stream_id,
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
            name: "OpenAI",
            base_url: "https://api.openai.com/v1",
            default_model: "gpt-4.1-mini",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_OPENAI_API_KEY",
                "OPENAI_API_KEY",
            ],
        }),
        "claude" => Some(ProviderPreset {
            id: "claude",
            name: "Claude",
            base_url: "https://api.anthropic.com/v1",
            default_model: "claude-3-5-sonnet-latest",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_CLAUDE_API_KEY",
                "ANTHROPIC_API_KEY",
            ],
        }),
        "moonshot" => Some(ProviderPreset {
            id: "moonshot",
            name: "Moonshot / Kimi",
            base_url: "https://api.moonshot.ai/v1",
            default_model: "kimi-k2.5",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_MOONSHOT_API_KEY",
                "MOONSHOT_API_KEY",
            ],
        }),
        "kimi" => provider_preset("moonshot"),
        "kimi-coding" => Some(ProviderPreset {
            id: "kimi-coding",
            name: "Kimi Coding",
            base_url: "https://api.kimi.com/coding/",
            default_model: "k2p5",
            api_key_names: &[
                "STOCKBOT_MODEL_API_KEY",
                "STOCKBOT_KIMI_API_KEY",
                "KIMI_API_KEY",
            ],
        }),
        _ => None,
    }
}

fn canonical_provider_id(provider_id: &str) -> String {
    match provider_id.trim().to_lowercase().as_str() {
        "kimi" => "moonshot".to_string(),
        "anthropic" => "claude".to_string(),
        "openai" => "openai".to_string(),
        "claude" => "claude".to_string(),
        "moonshot" => "moonshot".to_string(),
        "kimi-coding" => "kimi-coding".to_string(),
        _ => "moonshot".to_string(),
    }
}

fn provider_presets(app: &tauri::AppHandle) -> Result<Vec<ModelProvider>, String> {
    let config = load_app_config(app)?;
    let entries = read_env_file()?;
    let active_provider = config
        .active_provider
        .as_deref()
        .map(canonical_provider_id)
        .unwrap_or_else(|| "moonshot".to_string());

    ["openai", "claude", "moonshot"]
        .iter()
        .map(|provider_id| {
            let preset = provider_preset(provider_id).expect("static provider should exist");
            Ok(ModelProvider {
                id: preset.id.to_string(),
                name: preset.name.to_string(),
                base_url: preset.base_url.to_string(),
                default_model: preset.default_model.to_string(),
                active: active_provider == preset.id,
                connected: !read_provider_api_key(preset.id).is_empty()
                    || !first_env_value(&entries, preset.api_key_names).is_empty(),
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

fn load_app_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = app_config_path(app)?;
    if !path.is_file() {
        return Ok(AppConfig::default());
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("Could not read app config: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("Could not parse app config: {error}"))
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

fn keyring_entry(provider_id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, provider_id)
        .map_err(|error| format!("Could not open OS keychain entry: {error}"))
}

fn read_provider_api_key(provider_id: &str) -> String {
    keyring_entry(provider_id)
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|error| format!("Could not read OS keychain entry: {error}"))
        })
        .unwrap_or_default()
        .trim()
        .to_string()
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
    let entries = read_env_file()?;
    let env_provider = first_env_value(
        &entries,
        &["STOCKBOT_DEFAULT_PROVIDER", "STOCKBOT_MODEL_PROVIDER"],
    );
    let app_provider = app
        .and_then(|handle| load_app_config(handle).ok())
        .and_then(|config| config.active_provider);
    let configured_provider = app_provider.clone().unwrap_or(env_provider);
    let provider = canonical_provider_id(&configured_provider);
    let preset = provider_preset(&provider)
        .unwrap_or_else(|| provider_preset("moonshot").expect("moonshot preset"));
    let keyring_api_key = read_provider_api_key(preset.id);
    let env_api_key = first_env_value(&entries, preset.api_key_names);

    let configured_base_url = first_env_value(&entries, &["STOCKBOT_MODEL_BASE_URL"]);
    let provider_model_keys = match preset.id {
        "openai" => &["OPENAI_MODEL"][..],
        "claude" => &["ANTHROPIC_MODEL", "CLAUDE_MODEL"][..],
        "moonshot" => &["MOONSHOT_MODEL", "KIMI_MODEL"][..],
        _ => &[][..],
    };
    let configured_model = first_env_value(&entries, provider_model_keys);
    let legacy_configured_model = if app_provider.is_some() {
        String::new()
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
            preset.default_model.to_string()
        } else {
            configured_model
        },
        api_key: if keyring_api_key.is_empty() {
            env_api_key
        } else {
            keyring_api_key
        },
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            delete_chat_history,
            load_llm_env_status,
            list_chat_history,
            list_model_providers,
            read_chat_history,
            run_model_chat,
            run_model_chat_stream,
            save_chat_history,
            save_provider_api_key,
            set_active_provider
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
