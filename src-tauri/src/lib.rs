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
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use tauri::Manager;

const KEYRING_SERVICE: &str = "ai.raynard";

#[derive(Default)]
struct StreamCancelState {
    canceled: Mutex<HashSet<String>>,
    process_ids: Mutex<HashMap<String, u32>>,
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
    #[serde(rename = "builderRun", default)]
    builder_run: Option<bool>,
    #[serde(rename = "builderActivities", default)]
    builder_activities: Option<Value>,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginBuilderRequest {
    plugin_dir: String,
    name: String,
    description: String,
    source_urls: Option<Vec<String>>,
    prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginToolRequest {
    plugin_dir: Option<String>,
    plugin_id: Option<String>,
    tool_name: String,
    args: Value,
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
    tools: Vec<GeneratedPluginTool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeneratedPluginTool {
    name: String,
    description: String,
    parameters: Value,
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
fn read_generated_plugin(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<GeneratedPluginDetail, String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read plugin manifest: {error}"))?;
    let manifest_json: Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Could not parse plugin manifest: {error}"))?;
    let mut plugin = read_generated_plugin_manifest(&plugin_dir, &manifest_path)
        .ok_or_else(|| "Could not read generated plugin metadata.".to_string())?;
    enrich_generated_plugin_tools_from_runtime(&mut plugin, &plugin_dir);
    let code = fs::read_to_string(plugin_dir.join("index.ts")).unwrap_or_default();
    let readme = fs::read_to_string(plugin_dir.join("README.md")).unwrap_or_default();

    Ok(GeneratedPluginDetail {
        plugin,
        manifest_json,
        manifest_text,
        code,
        readme,
    })
}

#[tauri::command]
fn delete_generated_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let plugin_dir = resolve_generated_plugin_by_id(&app, &plugin_id)?;
    fs::remove_dir_all(plugin_dir).map_err(|error| format!("Could not delete plugin: {error}"))
}

#[tauri::command]
fn get_plugin_scaffold_status(
    app: tauri::AppHandle,
    name: String,
) -> Result<PluginScaffoldStatus, String> {
    let root = generated_plugins_dir(&app)?;
    ensure_dir(&root)?;
    let normalized_name = normalize_plugin_slug(&name);
    Ok(PluginScaffoldStatus {
        exists: root.join(&normalized_name).exists(),
        next_available_name: next_available_plugin_slug(&root, &normalized_name),
        normalized_name,
    })
}

#[tauri::command]
fn scaffold_plugin_capability(
    app: tauri::AppHandle,
    request: PluginScaffoldRequest,
) -> Result<GeneratedPlugin, String> {
    let slug = normalize_plugin_slug(&request.name);
    let description = normalize_plugin_description(&request.description);
    if description.is_empty() {
        return Err("Plugin description is required.".to_string());
    }

    let root = generated_plugins_dir(&app)?;
    ensure_dir(&root)?;
    let conflict_strategy = request
        .conflict_strategy
        .as_deref()
        .unwrap_or("error")
        .trim()
        .to_lowercase();
    let slug = if conflict_strategy == "rename" {
        next_available_plugin_slug(&root, &slug)
    } else {
        slug
    };
    let target_dir = root.join(&slug);
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
    let entrypoint = build_plugin_entrypoint(&slug);
    let readme = build_plugin_readme(&slug, &description, &source_urls);

    let write_result = (|| -> Result<(), String> {
        fs::write(temp_dir.join("plugin.json"), format!("{manifest}\n"))
            .map_err(|error| format!("Could not write plugin manifest: {error}"))?;
        fs::write(temp_dir.join("index.ts"), entrypoint)
            .map_err(|error| format!("Could not write plugin entrypoint: {error}"))?;
        fs::write(temp_dir.join("runtime.ts"), PLUGIN_RUNTIME_TS)
            .map_err(|error| format!("Could not write plugin runtime: {error}"))?;
        fs::write(temp_dir.join("testing.ts"), PLUGIN_TESTING_TS)
            .map_err(|error| format!("Could not write plugin test helpers: {error}"))?;
        fs::write(temp_dir.join("tools.ts"), build_plugin_tools_stub())
            .map_err(|error| format!("Could not write plugin tools stub: {error}"))?;
        fs::write(temp_dir.join("contract.test.ts"), PLUGIN_CONTRACT_TEST_TS)
            .map_err(|error| format!("Could not write plugin contract test: {error}"))?;
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
    let runner_request = json!({
        "pluginDir": plugin_dir.to_string_lossy().to_string(),
        "toolName": tool_name,
        "args": request.args
    });

    let mut child = Command::new("node")
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

#[tauri::command]
async fn run_plugin_builder_stream(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    stream_id: String,
    on_event: Channel<BuilderStreamEvent>,
    request: PluginBuilderRequest,
) -> Result<ChatReply, String> {
    let config = resolve_coding_model_config(Some(&app))?;
    if config.api_key.is_empty() {
        return Err("Save a model API key before running Build mode.".to_string());
    }

    let plugin_dir = validate_generated_plugin_dir(&app, &request.plugin_dir)?;
    let sidecar_path = resolve_plugin_builder_sidecar_path()?;
    let plugin_runner_path = resolve_plugin_tool_runner_path()?;
    let sidecar_request = json!({
        "pluginDir": plugin_dir.to_string_lossy().to_string(),
        "name": request.name,
        "description": request.description,
        "sourceUrls": normalize_source_urls(request.source_urls.unwrap_or_default()),
        "prompt": request.prompt,
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
        "apiKey": config.api_key,
        "pluginRunnerPath": plugin_runner_path.to_string_lossy().to_string()
    });

    let mut child = Command::new("node")
        .arg(sidecar_path)
        .current_dir(&plugin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start plugin builder sidecar: {error}"))?;
    register_stream_process(&cancel_state, &stream_id, child.id())?;

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
                    format!("{status}\n")
                } else {
                    format!("{status}: {tool_name}\n")
                };
                emit_builder_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "thinking_delta".to_string(),
                        delta: Some(message),
                        text: None,
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
                emit_builder_stream_event(
                    &on_event,
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        event_type: "error".to_string(),
                        delta: None,
                        text: None,
                        error: Some(error.clone()),
                        provider: Some(config.provider.clone()),
                        model: Some(config.model.clone()),
                    },
                );
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
        return Err(format!("Plugin builder exited with {status}."));
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
    if provider_preset(&provider_id).is_none() {
        return Err(format!("Unsupported provider: {provider_id}"));
    }

    if read_provider_api_key(&provider_id).is_empty() {
        return Err("Save an API key for this provider first.".to_string());
    }

    save_role_model_config(&app, &role, &provider_id, model)?;

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
    default_chat_model: &'static str,
    default_coding_model: &'static str,
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
async fn run_main_agent_stream(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, StreamCancelState>,
    stream_id: String,
    on_event: Channel<MainAgentStreamEvent>,
    messages: Vec<ChatMessage>,
    mode: String,
) -> Result<MainAgentReply, String> {
    let config = resolve_model_config(Some(&app))?;
    if config.api_key.is_empty() {
        return Err("Save a chat model API key before running the agent.".to_string());
    }

    let sidecar_path = resolve_main_agent_sidecar_path()?;
    let plugin_runner_path = resolve_plugin_tool_runner_path()?;
    let plugin_root = generated_plugins_dir(&app)?;
    ensure_dir(&plugin_root)?;
    let mut plugins = Vec::new();
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
        plugins.push(
            serde_json::to_value(plugin)
                .map_err(|error| format!("Could not serialize generated plugin: {error}"))?,
        );
    }
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
        "plugins": plugins
    });

    let mut child = Command::new("node")
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

    if let Some(mut stdin) = child.stdin.take() {
        let raw = serde_json::to_vec(&sidecar_request)
            .map_err(|error| format!("Could not serialize main agent request: {error}"))?;
        stdin
            .write_all(&raw)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("Could not send request to main agent: {error}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Main agent stdout was unavailable.".to_string())?;
    let reader = BufReader::new(stdout);
    let mut answer = String::new();
    let mut build_request = None;

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
            });
            return Ok(MainAgentReply {
                content,
                provider: config.provider,
                model: config.model,
                build_request,
            });
        }

        let line = line.map_err(|error| format!("Main agent stream failed: {error}"))?;
        let Ok(payload) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let delta = payload
            .get("delta")
            .and_then(Value::as_str)
            .map(str::to_string);
        if event_type == "delta" {
            if let Some(value) = delta.as_deref() {
                answer.push_str(value);
            }
        }
        if event_type == "done" && answer.trim().is_empty() {
            answer = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        if event_type == "build_request" {
            build_request = payload.get("buildRequest").cloned();
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
            });
            let _ = child.kill();
            clear_stream_canceled(&cancel_state, &stream_id);
            return Err(error);
        }

        let _ = on_event.send(MainAgentStreamEvent {
            stream_id: stream_id.clone(),
            event_type: event_type.to_string(),
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
        });
        return Ok(MainAgentReply {
            content,
            provider: config.provider,
            model: config.model,
            build_request,
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

fn generated_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(dir.join("generated-plugins"))
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

fn resolve_plugin_builder_sidecar_path() -> Result<PathBuf, String> {
    let current =
        env::current_dir().map_err(|error| format!("Could not read current directory: {error}"))?;
    let candidates = [
        current.join("scripts").join("plugin-builder-sidecar.mjs"),
        current
            .join("..")
            .join("scripts")
            .join("plugin-builder-sidecar.mjs"),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Could not find scripts/plugin-builder-sidecar.mjs.".to_string())
}

fn resolve_main_agent_sidecar_path() -> Result<PathBuf, String> {
    let current =
        env::current_dir().map_err(|error| format!("Could not read current directory: {error}"))?;
    let candidates = [
        current.join("scripts").join("main-agent-sidecar.mjs"),
        current
            .join("..")
            .join("scripts")
            .join("main-agent-sidecar.mjs"),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Could not find scripts/main-agent-sidecar.mjs.".to_string())
}

fn resolve_plugin_tool_runner_path() -> Result<PathBuf, String> {
    let current =
        env::current_dir().map_err(|error| format!("Could not read current directory: {error}"))?;
    let candidates = [
        current.join("scripts").join("plugin-tool-runner.mjs"),
        current
            .join("..")
            .join("scripts")
            .join("plugin-tool-runner.mjs"),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Could not find scripts/plugin-tool-runner.mjs.".to_string())
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

fn read_generated_plugin_manifest(
    plugin_dir: &Path,
    manifest_path: &Path,
) -> Option<GeneratedPlugin> {
    let raw = fs::read_to_string(manifest_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
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
    let tools = parsed
        .pointer("/contributes/tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    if let Some(name) = item.as_str() {
                        return Some(GeneratedPluginTool {
                            name: name.trim().to_string(),
                            description: String::new(),
                            parameters: json!({
                                "type": "object",
                                "properties": {}
                            }),
                        });
                    }
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
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(GeneratedPlugin {
        id,
        name,
        description,
        version,
        directory: plugin_dir.to_string_lossy().to_string(),
        entry_path: plugin_dir.join("index.ts").to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        created_at,
        status,
        tools,
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
/// when `index.ts` changes. This keeps the plugins sidebar instant after the
/// first load instead of re-spawning Node for every plugin on every open.
fn load_generated_plugin_runtime_tools_cached(plugin_dir: &Path) -> Option<Vec<GeneratedPluginTool>> {
    let source_mtime = generated_plugin_source_mtime_millis(plugin_dir);
    let cache_path = plugin_dir.join(".runtime-tools.json");

    if let (Some(source_mtime), Ok(raw)) = (source_mtime, fs::read_to_string(&cache_path)) {
        if let Ok(cache) = serde_json::from_str::<RuntimeToolsCache>(&raw) {
            if cache.source_mtime == source_mtime {
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
    let modified = fs::metadata(plugin_dir.join("index.ts")).ok()?.modified().ok()?;
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
    let mut child = Command::new("node")
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
        "status": "scaffolded",
        "createdAt": created_at,
        "capabilities": ["api-reference-tool"],
        "permissions": ["network:api"],
        "contributes": {
            "tools": [],
            "cards": ["api-reference"]
        },
        "sourceUrls": source_urls,
        "provenance": {
            "createdBy": "raynard-plugin-builder",
            "builder": "manual-scaffold"
        }
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string())
}

// Shared, pre-tested plumbing vendored into every generated plugin. The
// canonical sources live in scripts/plugin-runtime/ and are unit-tested there;
// include_str! embeds them at compile time so the scaffold can never drift from
// the tested copy.
const PLUGIN_RUNTIME_TS: &str = include_str!("../../scripts/plugin-runtime/runtime.ts");
const PLUGIN_TESTING_TS: &str = include_str!("../../scripts/plugin-runtime/testing.ts");
const PLUGIN_CONTRACT_TEST_TS: &str =
    include_str!("../../scripts/plugin-runtime/contract.test.ts.template");

fn build_plugin_tools_stub() -> String {
    // Raw literal (not format!) so the TypeScript braces need no escaping.
    r#"// Tool registry: add one entry per API tool, keyed by its exact tool name.
// Import fetch helpers from ./client.ts and shared helpers from ./runtime.ts.
//
// Example tool:
//   import { fetchThing } from './client.ts';
//   import { createApiReference } from './runtime.ts';
//   export const tools = {
//     example_get_thing: {
//       description: 'What it answers, what it fetches, limits, follow-up tools.',
//       parameters: { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: 'Record id.' } } },
//       async execute(args) {
//         const thing = await fetchThing(Number(args.id));
//         return {
//           text: `Thing ${thing.id}`,
//           references: [createApiReference({ id: String(thing.id), label: thing.name, sourceUrl: '...', quote: thing.name, payload: thing })]
//         };
//       }
//     }
//   };
import type { ApiReference } from './runtime.ts';

export type ToolResult = { text: string; references: ApiReference[] };

export type ApiTool = {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
};

// The builder replaces this empty registry with real tools.
export const tools: Record<string, ApiTool> = {};
"#
    .to_string()
}

fn build_plugin_entrypoint(slug: &str) -> String {
    format!(
        r#"// Plugin entry point. The builder fills in ./client.ts and ./tools.ts.
// Shared, pre-tested plumbing lives in ./runtime.ts (createApiReference, apiGet,
// buildQuery, requireNonEmpty, requirePositiveInt) and ./testing.ts (mockFetch).
// Both are vendored and must not be edited or re-implemented.
import {{ tools }} from './tools.ts';

export {{ tools }};
export {{ createApiReference }} from './runtime.ts';
export type {{ ApiReference }} from './runtime.ts';

export const manifest = {{
  id: 'raynard.generated.{slug}',
  name: '{name}',
  version: '0.1.0'
}};

export default {{
  manifest,
  tools
}};
"#,
        slug = slug,
        name = plugin_display_name(slug).replace('\'', "\\'")
    )
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
        "# {}\n\n{}\n\n## Status\n\nThis plugin workspace is scaffolded. The Pi coding-agent sidecar should fill in API tools here after the user confirms code-writing.\n\n## Source Documentation\n\n{}## Build Contract\n\nBuild TypeScript API tooling for Raynard explore mode. Do not build React, routes, pages, CSS, or a standalone visual explorer. The chat UI already exists; this plugin exists so the agent can call API tools and talk to returned data.\n\n## API Surface Contract\n\nTreat the source API documentation as a whole API surface, not only the latest narrow user query. Build a practical suite of small, focused tools for important endpoints/resources such as list/search, detail-by-id, user/profile/account, metadata/status, and update/history endpoints when available. If only a subset is implemented, keep an `Endpoint Inventory` in this README that records each relevant endpoint path, purpose, required and optional parameters, response shape summary, pagination/rate-limit notes, status (`Implemented`, `Planned`, or `Not applicable`), and the future tool that should expose it.\n\n## Tool Description Contract\n\nEvery exported tool must include a specific `description` and JSON `parameters` schema. Explore mode injects generated tool names, descriptions, and schemas into the prompt so the agent can choose the right tool across plugins. Avoid vague descriptions; state what user questions the tool answers, what API data it fetches, required arguments, useful optional arguments, and important limits or follow-up tools.\n\n## Explore-Mode Contract\n\nAPI tools should return concise text plus structured references with `referenceId`, `referenceLabel`, `referenceMeta`, and expanded raw payload content. Assistant answers should cite the returned references when discussing API data.\n",
        plugin_display_name(slug),
        description,
        source_block
    )
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
                builder_run: message.builder_run,
                builder_activities: message.builder_activities,
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
            default_chat_model: "gpt-4.1-mini",
            default_coding_model: "gpt-4.1-mini",
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
            default_chat_model: "claude-3-5-sonnet-latest",
            default_coding_model: "claude-3-5-sonnet-latest",
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
            default_chat_model: "kimi-k2.5",
            default_coding_model: "kimi-k3",
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
            default_chat_model: "k2p5",
            default_coding_model: "k2p5",
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

    ["openai", "claude", "moonshot"]
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
        _ => return Err("Model role must be chat or coding.".to_string()),
    }

    save_app_config(app, config)
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
        api_key: if keyring_api_key.is_empty() {
            env_api_key
        } else {
            keyring_api_key
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        generated_plugin_source_mtime_millis, load_generated_plugin_runtime_tools_cached,
        next_available_plugin_slug, normalize_plugin_slug, normalize_stored_messages, now_millis,
        BuilderStreamEvent, GeneratedPluginTool, RuntimeToolsCache, StoredChatMessage, StreamEvent,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn runtime_tools_cache_is_used_when_source_is_unchanged() {
        let plugin_dir =
            std::env::temp_dir().join(format!("raynard-runtime-cache-{}", now_millis()));
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(plugin_dir.join("index.ts"), "export const noop = true;\n")
            .expect("write index.ts");

        let source_mtime = generated_plugin_source_mtime_millis(&plugin_dir)
            .expect("read index.ts mtime");
        let cache = RuntimeToolsCache {
            source_mtime,
            tools: vec![GeneratedPluginTool {
                name: "getThing".to_string(),
                description: "Fetch a thing".to_string(),
                parameters: json!({ "type": "object", "properties": {} }),
            }],
        };
        fs::write(
            plugin_dir.join(".runtime-tools.json"),
            serde_json::to_string(&cache).expect("serialize cache"),
        )
        .expect("write cache");

        // A fresh cache short-circuits before any Node spawn; there is no
        // index.ts a runner could load, so a non-empty result proves the cache
        // was used.
        let tools = load_generated_plugin_runtime_tools_cached(&plugin_dir)
            .expect("cached tools returned");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "getThing");

        fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
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
            builder_run: Some(true),
            builder_activities: Some(activities.clone()),
        }]);

        assert_eq!(normalized[0].builder_run, Some(true));
        assert_eq!(normalized[0].builder_activities, Some(activities));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StreamCancelState::default())
        .invoke_handler(tauri::generate_handler![
            append_agent_turn_log,
            cancel_model_chat_stream,
            delete_chat_history,
            delete_generated_plugin,
            execute_generated_plugin_tool,
            get_plugin_scaffold_status,
            load_llm_env_status,
            list_generated_plugins,
            list_chat_history,
            list_model_providers,
            read_generated_plugin,
            read_chat_history,
            run_main_agent_stream,
            run_plugin_builder_stream,
            run_model_chat,
            run_model_chat_stream,
            save_chat_history,
            save_provider_api_key,
            scaffold_plugin_capability,
            set_active_model_provider,
            set_active_provider
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
