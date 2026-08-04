use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, env, path::PathBuf};
use tauri::ipc::Channel;

#[derive(Serialize)]
struct LlmEnvStatus {
    found: bool,
    path: Option<String>,
    keys: Vec<String>,
    provider: String,
    model: String,
    configured: bool,
}

#[tauri::command]
fn load_llm_env_status() -> Result<LlmEnvStatus, String> {
    let config = resolve_model_config()?;
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

#[tauri::command]
async fn run_model_chat(messages: Vec<ChatMessage>) -> Result<ChatReply, String> {
    let config = resolve_model_config()?;
    if config.api_key.is_empty() {
        return Ok(ChatReply {
            content: "Hello world. Add MOONSHOT_API_KEY to .env to call Kimi through Moonshot."
                .to_string(),
            provider: config.provider,
            model: config.model,
        });
    }

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
    stream_id: String,
    on_event: Channel<StreamEvent>,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let config = resolve_model_config()?;
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

fn resolve_model_config() -> Result<ModelConfig, String> {
    let entries = read_env_file()?;
    let provider = first_env_value(
        &entries,
        &["STOCKBOT_DEFAULT_PROVIDER", "STOCKBOT_MODEL_PROVIDER"],
    )
    .to_lowercase();
    let provider = match provider.as_str() {
        "openai" | "moonshot" | "kimi-coding" => provider,
        _ => "moonshot".to_string(),
    };

    let (base_url, default_model, api_key) = match provider.as_str() {
        "openai" => (
            "https://api.openai.com/v1",
            "gpt-4.1-mini",
            first_env_value(
                &entries,
                &[
                    "STOCKBOT_MODEL_API_KEY",
                    "STOCKBOT_OPENAI_API_KEY",
                    "OPENAI_API_KEY",
                ],
            ),
        ),
        "kimi-coding" => (
            "https://api.kimi.com/coding/",
            "k2p5",
            first_env_value(
                &entries,
                &[
                    "STOCKBOT_MODEL_API_KEY",
                    "STOCKBOT_KIMI_API_KEY",
                    "KIMI_API_KEY",
                ],
            ),
        ),
        _ => (
            "https://api.moonshot.ai/v1",
            "kimi-k2.5",
            first_env_value(
                &entries,
                &[
                    "STOCKBOT_MODEL_API_KEY",
                    "STOCKBOT_MOONSHOT_API_KEY",
                    "MOONSHOT_API_KEY",
                ],
            ),
        ),
    };

    let configured_base_url = first_env_value(&entries, &["STOCKBOT_MODEL_BASE_URL"]);
    let configured_model = first_env_value(&entries, &["STOCKBOT_DEFAULT_MODEL", "OPENAI_MODEL"]);

    Ok(ModelConfig {
        provider,
        base_url: if configured_base_url.is_empty() {
            base_url.to_string()
        } else {
            configured_base_url.trim_end_matches('/').to_string()
        },
        model: if configured_model.is_empty() {
            default_model.to_string()
        } else {
            configured_model
        },
        api_key,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_llm_env_status,
            run_model_chat,
            run_model_chat_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
