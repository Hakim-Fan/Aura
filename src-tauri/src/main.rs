#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, Runtime, State};
use tauri_plugin_shell::ShellExt;

static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);
const APP_LOG_RETENTION_DAYS: u64 = 14;
const EDIT_TRANSACTION_SNAPSHOT_KEY_PREFIX: &str = "edit_transaction_snapshot:";
const MAX_REASONING_CHARS: usize = 100_000;
const MAX_PHASE_OUTPUT_CHARS: usize = 100_000;
const MAX_WORK_MEMORY_KIND_CHARS: usize = 80;
const MAX_WORK_MEMORY_TITLE_CHARS: usize = 160;
const MAX_WORK_MEMORY_SUMMARY_CHARS: usize = 1_200;
const MAX_WORK_MEMORY_NEXT_USE_CHARS: usize = 600;
const MAX_WORK_MEMORY_CONTENT_JSON_CHARS: usize = 8_000;
const MAX_WORK_MEMORY_SOURCE_REFS_JSON_CHARS: usize = 2_400;
const MAX_LOG_DELTA_CHARS: usize = 2_000;
const SNAPSHOT_TRUNCATION_MARKER: &str = "\n...(truncated to keep memory bounded)...\n";
const MAX_INLINE_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_RUNTIME_IMAGE_DATA_URL_BYTES: usize = 12 * 1024 * 1024;
const MAX_TERMINAL_TASK_SNAPSHOTS: usize = 64;

#[derive(Clone, Serialize, Default)]
struct AgentTaskSnapshot {
    id: String,
    status: String,
    message: Option<String>,
    #[serde(rename = "phaseOutputs")]
    phase_outputs: Vec<serde_json::Value>,
    #[serde(rename = "toolEvents")]
    tool_events: Vec<serde_json::Value>,
    #[serde(rename = "appendedInputs")]
    appended_inputs: Vec<serde_json::Value>,
    #[serde(rename = "taskTree")]
    task_tree: Vec<serde_json::Value>,
    reasoning: Vec<serde_json::Value>,
    #[serde(rename = "workMemories")]
    work_memories: Vec<serde_json::Value>,
    usage: Option<serde_json::Value>,
    #[serde(rename = "contextCompression")]
    context_compression: Option<serde_json::Value>,
    #[serde(rename = "capabilitySnapshot")]
    capability_snapshot: Option<serde_json::Value>,
    #[serde(rename = "agentMode")]
    agent_mode: Option<String>,
    #[serde(rename = "routeDecision")]
    route_decision: Option<serde_json::Value>,
    #[serde(rename = "completionState")]
    completion_state: Option<String>,
    #[serde(rename = "evidenceSummary")]
    evidence_summary: Option<serde_json::Value>,
    #[serde(rename = "deliveryNote")]
    delivery_note: Option<String>,
    #[serde(rename = "retryInfo")]
    retry_info: Option<serde_json::Value>,
    phase: Option<String>,
    #[serde(rename = "phaseStartedAt")]
    phase_started_at: Option<u64>,
    #[serde(rename = "lastHeartbeatAt")]
    last_heartbeat_at: Option<u64>,
    #[serde(rename = "lastProgressAt")]
    last_progress_at: Option<u64>,
    stalled: Option<bool>,
    #[serde(rename = "pendingApproval")]
    pending_approval: Option<serde_json::Value>,
    #[serde(rename = "pendingUserInput")]
    pending_user_input: Option<serde_json::Value>,
    error: Option<String>,
    #[serde(rename = "errorInfo")]
    error_info: Option<serde_json::Value>,
    #[serde(rename = "errorCode")]
    error_code: Option<String>,
    #[serde(rename = "errorSource")]
    error_source: Option<String>,
    #[serde(rename = "rawError")]
    raw_error: Option<String>,
}

#[derive(Clone)]
struct AgentTaskHandle {
    child: Arc<Mutex<Option<std::process::Child>>>,
    stdin: Arc<Mutex<ChildStdin>>,
    snapshot: Arc<Mutex<AgentTaskSnapshot>>,
    log_context: serde_json::Value,
}

#[derive(Clone, Deserialize)]
struct EditTransactionSnapshot {
    #[serde(rename = "transactionId")]
    transaction_id: String,
    changes: Vec<EditSnapshotChange>,
}

#[derive(Clone, Deserialize)]
struct EditSnapshotChange {
    kind: String,
    path: String,
    #[serde(rename = "destinationPath")]
    destination_path: Option<String>,
    #[serde(rename = "oldContent")]
    old_content: Option<String>,
    #[serde(rename = "newContent")]
    new_content: Option<String>,
}

#[derive(Default)]
struct AgentTaskStore {
    tasks: Mutex<HashMap<String, AgentTaskHandle>>,
}

#[derive(Clone, Serialize)]
struct WorkspaceNode {
    name: String,
    path: String,
    kind: String,
    children: Vec<WorkspaceNode>,
}

#[derive(Clone, Serialize)]
struct AuraAssetMetadata {
    id: String,
    name: String,
    description: String,
    path: String,
    #[serde(rename = "entryPath")]
    entry_path: Option<String>,
    supported: bool,
    #[serde(rename = "supportMessage")]
    support_message: Option<String>,
    readonly: bool,
}

#[derive(Clone, Serialize)]
struct AuraHomeState {
    #[serde(rename = "homeDir")]
    home_dir: String,
    #[serde(rename = "configDir")]
    config_dir: String,
    #[serde(rename = "skillsDir")]
    skills_dir: String,
    #[serde(rename = "pluginsDir")]
    plugins_dir: String,
    #[serde(rename = "mcpDir")]
    mcp_dir: String,
    #[serde(rename = "workspaceDir")]
    workspace_dir: String,
    #[serde(rename = "logsDir")]
    logs_dir: String,
    #[serde(rename = "browserDir")]
    browser_dir: String,
    #[serde(rename = "settingsPath")]
    settings_path: String,
    #[serde(rename = "sessionsPath")]
    sessions_path: String,
    #[serde(rename = "mcpServersPath")]
    mcp_servers_path: String,
    skills: Vec<AuraAssetMetadata>,
    plugins: Vec<AuraAssetMetadata>,
}

#[derive(Clone, Serialize, Deserialize)]
struct AppLogEntry {
    timestamp: String,
    #[serde(rename = "timestampMs")]
    timestamp_ms: u64,
    level: String,
    event: String,
    details: serde_json::Value,
}

#[derive(Clone, Serialize)]
struct AppLogFile {
    date: String,
    name: String,
    path: String,
    size: u64,
    #[serde(rename = "modifiedAt")]
    modified_at: Option<u64>,
}

#[derive(Clone, Serialize)]
struct LightpandaRuntimeStatusRecord {
    detected: bool,
    #[serde(rename = "executablePath")]
    executable_path: Option<String>,
    version: Option<String>,
    valid: bool,
    #[serde(rename = "lastCheckedAt")]
    last_checked_at: u64,
    error: Option<String>,
}

fn resolve_user_home() -> Result<PathBuf, String> {
    resolve_user_home_dir().ok_or_else(|| "Failed to resolve the user home directory.".to_string())
}

fn resolve_aura_home() -> Result<PathBuf, String> {
    Ok(resolve_user_home()?.join(".aura"))
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create directory {}: {error}", path.display()))
}

fn prettify_asset_name(value: &str) -> String {
    value
        .split(['-', '_'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_metadata_field(content: &str, field_name: &str) -> Option<String> {
    let needle = format!("{field_name}:");
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(&needle) {
            continue;
        }
        let raw = trimmed[needle.len()..].trim();
        let value = raw
            .trim_matches(',')
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let normalized = content.strip_prefix("\u{feff}").unwrap_or(content);
    if !normalized.starts_with("---\n") {
        return (None, normalized);
    }

    let remainder = &normalized[4..];
    if let Some(index) = remainder.find("\n---\n") {
        let frontmatter = &remainder[..index];
        let body = &remainder[index + 5..];
        return (Some(frontmatter), body);
    }

    (None, normalized)
}

fn extract_markdown_metadata_field(content: &str, field_name: &str) -> Option<String> {
    let (frontmatter, _) = split_frontmatter(content);
    if let Some(frontmatter) = frontmatter {
        if let Some(value) = extract_metadata_field(frontmatter, field_name) {
            return Some(value);
        }
    }

    extract_metadata_field(content, field_name)
}

fn extract_markdown_list_field(content: &str, field_name: &str) -> Vec<String> {
    let (frontmatter, _) = split_frontmatter(content);
    let Some(frontmatter) = frontmatter else {
        return Vec::new();
    };

    let mut values = Vec::new();
    let mut collecting = false;
    let needle = format!("{field_name}:");

    for line in frontmatter.lines() {
        let trimmed = line.trim();

        if !collecting {
            if !trimmed
                .to_ascii_lowercase()
                .starts_with(&needle.to_ascii_lowercase())
            {
                continue;
            }

            let inline_value = trimmed[needle.len()..].trim();
            if inline_value.starts_with('[') && inline_value.ends_with(']') {
                return inline_value[1..inline_value.len() - 1]
                    .split(',')
                    .map(|value| {
                        value
                            .trim()
                            .trim_matches('"')
                            .trim_matches('\'')
                            .to_string()
                    })
                    .filter(|value| !value.is_empty())
                    .collect();
            }

            collecting = true;
            continue;
        }

        if trimmed.is_empty() {
            if !values.is_empty() {
                break;
            }
            continue;
        }

        if !trimmed.starts_with("- ") {
            break;
        }

        let value = trimmed[2..]
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        if !value.is_empty() {
            values.push(value.to_string());
        }
    }

    values
}

fn normalize_tool_name(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_ascii_alphanumeric())
        .flat_map(|value| value.to_lowercase())
        .collect()
}

fn infer_skill_support(content: &str) -> (bool, Option<String>) {
    let allowed_tools = extract_markdown_list_field(content, "allowed-tools");
    if allowed_tools.is_empty() {
        return (true, None);
    }

    let supported_aliases: HashSet<String> = [
        "bash",
        "shell",
        "terminal",
        "command",
        "runshell",
        "listfiles",
        "ls",
        "files",
        "glob",
        "findfiles",
        "read",
        "readfile",
        "cat",
        "write",
        "writefile",
        "edit",
        "editfile",
        "replace",
        "multiedit",
        "multieditfile",
        "editmany",
        "search",
        "grep",
        "ripgrep",
        "searchcode",
        "todo",
        "plan",
        "tasklist",
        "todowrite",
        "recordworkmemory",
        "recordphaseartifact",
        "writeworkmemory",
        "capabilities",
        "listcapabilities",
        "auralistcapabilities",
        "readskill",
        "skillfile",
        "openskill",
        "aurareadskill",
        "enableskill",
        "disableskill",
        "auraenableskill",
        "enableplugin",
        "disableplugin",
        "auraenableplugin",
        "importskill",
        "installskill",
        "skillinstall",
        "installauraskill",
        "auraimportskill",
        "aurainstallskill",
        "importplugin",
        "installplugin",
        "auraimportplugin",
        "savemcp",
        "upsertmcp",
        "auraupsertmcpserver",
        "removemcp",
        "deletemcp",
        "auraremovemcpserver",
        "computerlistapps",
        "computergetfrontmostapp",
        "computeropenapp",
        "computercapturescreen",
        "computertypetext",
        "computerpressshortcut",
        "websearch",
        "webfetch",
        "webresearch",
        "systembrowseropen",
        "spawnsubagent",
        "subagent",
        "delegate",
    ]
    .into_iter()
    .map(normalize_tool_name)
    .collect();

    let missing_tools = allowed_tools
        .iter()
        .filter(|tool| !supported_aliases.contains(&normalize_tool_name(tool)))
        .cloned()
        .collect::<Vec<_>>();

    if missing_tools.is_empty() {
        (true, None)
    } else {
        (
            false,
            Some(format!(
                "该 skill 依赖 Aura 当前未提供的工具: {}。它会被发现，但运行时不会真的拿到这些工具。",
                missing_tools.join(", ")
            )),
        )
    }
}

fn infer_skill_description(content: &str) -> String {
    if let Some(description) = extract_markdown_metadata_field(content, "description") {
        return description;
    }

    let (_, body) = split_frontmatter(content);
    let mut in_code_block = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return trimmed.to_string();
    }
    "Aura skill".into()
}

fn infer_plugin_description(content: &str) -> String {
    extract_metadata_field(content, "description").unwrap_or_else(|| "Aura plugin".into())
}

fn parse_json_string_field(content: &str, field_name: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(content).ok()?;
    parsed
        .get(field_name)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn infer_plugin_support(entry_path: Option<&Path>, entry_content: &str) -> (bool, Option<String>) {
    let Some(entry_path) = entry_path else {
        return (
            false,
            Some("未找到可运行的插件入口文件。Aura 当前支持 .mjs / .js 工具插件入口。".into()),
        );
    };

    let extension = entry_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension != "mjs" && extension != "js" {
        return (false, Some("当前只支持 .mjs / .js 作为插件入口。".into()));
    }

    let normalized = entry_content
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect::<String>();
    let has_plugin_export = normalized.contains("exportconstplugin=")
        || normalized.contains("export{plugin}")
        || normalized.contains("module.exports={plugin")
        || normalized.contains("module.exports.plugin=")
        || normalized.contains("exports.plugin=");

    if has_plugin_export {
        return (true, None);
    }

    (
        false,
        Some(
            "已发现插件入口，但它不是 Aura 当前支持的工具插件格式。需要导出 plugin 对象及 tools。"
                .into(),
        ),
    )
}

fn resolve_plugin_entry(
    dir: &Path,
    manifest_content: Option<&str>,
) -> (Option<PathBuf>, Option<String>) {
    if let Some(manifest_content) = manifest_content {
        if let Some(main_path) = parse_json_string_field(manifest_content, "main") {
            let candidate = dir.join(&main_path);
            if candidate.exists() {
                return (Some(candidate), None);
            }

            if let Some(extension) = candidate.extension().and_then(|value| value.to_str()) {
                if extension == "js" || extension == "mjs" {
                    let ts_candidate = candidate.with_extension("ts");
                    if ts_candidate.exists() {
                        let ts_file_name = ts_candidate
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("main.ts")
                            .to_string();
                        return (
                            Some(ts_candidate),
                            Some(format!(
                                "manifest 指定的入口文件不存在：{main_path}；检测到源码入口 {}。Aura 当前不能直接运行 TypeScript 插件，请先编译为 {}，或改成 .mjs/.js 工具插件入口。",
                                ts_file_name,
                                main_path
                            )),
                        );
                    }
                }
            }

            return (
                None,
                Some(format!("manifest 指定的入口文件不存在：{main_path}")),
            );
        }
    }

    for candidate in ["main.mjs", "index.mjs", "plugin.mjs", "main.js", "index.js"] {
        let path = dir.join(candidate);
        if path.exists() {
            return (Some(path), None);
        }
    }

    (None, None)
}

fn scan_aura_assets<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dir: &Path,
    kind: &str,
) -> Result<Vec<AuraAssetMetadata>, String> {
    let mut assets = Vec::new();
    let bundled_dir = resolve_default_asset_dir(app, kind).ok();

    let entries = fs::read_dir(dir).map_err(|error| {
        format!(
            "Failed to read Aura asset directory {}: {error}",
            dir.display()
        )
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        let (id, name, description, content_path, entry_path, supported, support_message, readonly) =
            if kind == "skills" {
                if path.is_file()
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        == "md"
                {
                    let id = path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let content = fs::read_to_string(&path).unwrap_or_default();
                    let name = extract_markdown_metadata_field(&content, "name")
                        .unwrap_or_else(|| prettify_asset_name(&id));
                    let description = infer_skill_description(&content);
                    let (supported, support_message) = infer_skill_support(&content);
                    let readonly = bundled_dir
                        .as_ref()
                        .map(|bundled| bundled.join(path.file_name().unwrap()).exists())
                        .unwrap_or(false);
                    (
                        id,
                        name,
                        description,
                        path.clone(),
                        Some(path.clone()),
                        supported,
                        support_message,
                        readonly,
                    )
                } else if path.is_dir() {
                    let skill_path = path.join("SKILL.md");
                    if !skill_path.exists() {
                        continue;
                    }
                    let id = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let content = fs::read_to_string(&skill_path).unwrap_or_default();
                    let name = extract_markdown_metadata_field(&content, "name")
                        .unwrap_or_else(|| prettify_asset_name(&id));
                    let description = infer_skill_description(&content);
                    let (supported, support_message) = infer_skill_support(&content);
                    let readonly = bundled_dir
                        .as_ref()
                        .map(|bundled| bundled.join(path.file_name().unwrap()).exists())
                        .unwrap_or(false);
                    (
                        id,
                        name,
                        description,
                        skill_path.clone(),
                        Some(skill_path),
                        supported,
                        support_message,
                        readonly,
                    )
                } else {
                    continue;
                }
            } else {
                if path.is_file() {
                    let extension = path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default();
                    if extension != "mjs" && extension != "js" {
                        continue;
                    }

                    let id = path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let content = fs::read_to_string(&path).unwrap_or_default();
                    let name = extract_metadata_field(&content, "name")
                        .unwrap_or_else(|| prettify_asset_name(&id));
                    let description = infer_plugin_description(&content);
                    let (supported, support_message) = infer_plugin_support(Some(&path), &content);
                    let readonly = bundled_dir
                        .as_ref()
                        .map(|bundled| bundled.join(path.file_name().unwrap()).exists())
                        .unwrap_or(false);
                    (
                        id,
                        name,
                        description,
                        path.clone(),
                        Some(path.clone()),
                        supported,
                        support_message,
                        readonly,
                    )
                } else if path.is_dir() {
                    let manifest_path = path.join("manifest.json");
                    let manifest_content = fs::read_to_string(&manifest_path).ok();
                    let (entry_path, mut support_message) =
                        resolve_plugin_entry(&path, manifest_content.as_deref());

                    let id = manifest_content
                        .as_deref()
                        .and_then(|value| parse_json_string_field(value, "id"))
                        .unwrap_or_else(|| {
                            path.file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or_default()
                                .to_string()
                        });

                    let name = manifest_content
                        .as_deref()
                        .and_then(|value| parse_json_string_field(value, "name"))
                        .unwrap_or_else(|| prettify_asset_name(&id));

                    let preview_path = if manifest_path.exists() {
                        manifest_path
                    } else if let Some(entry_path) = &entry_path {
                        entry_path.clone()
                    } else {
                        path.clone()
                    };
                    let entry_content = entry_path
                        .as_ref()
                        .and_then(|value| fs::read_to_string(value).ok())
                        .unwrap_or_default();
                    let description = manifest_content
                        .as_deref()
                        .and_then(|value| parse_json_string_field(value, "description"))
                        .or_else(|| {
                            if entry_content.is_empty() {
                                None
                            } else {
                                Some(infer_plugin_description(&entry_content))
                            }
                        })
                        .unwrap_or_else(|| "Aura plugin".into());
                    let (supported, inferred_message) =
                        infer_plugin_support(entry_path.as_deref(), &entry_content);
                    if support_message.is_none() {
                        support_message = inferred_message;
                    }

                    let readonly = bundled_dir
                        .as_ref()
                        .map(|bundled| bundled.join(path.file_name().unwrap()).exists())
                        .unwrap_or(false);
                    (
                        id,
                        name,
                        description,
                        preview_path,
                        entry_path,
                        supported,
                        support_message,
                        readonly,
                    )
                } else {
                    continue;
                }
            };

        if id.is_empty() {
            continue;
        }

        assets.push(AuraAssetMetadata {
            id,
            name,
            description,
            path: content_path.display().to_string(),
            entry_path: entry_path.map(|value| value.display().to_string()),
            supported,
            support_message,
            readonly,
        });
    }

    assets.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(assets)
}

fn resolve_default_asset_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dir_name: &str,
) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../{dir_name}"));
        if dev_dir.exists() {
            return dev_dir.canonicalize().map_err(|error| {
                format!("Failed to canonicalize default {dir_name} directory: {error}")
            });
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource directory: {error}"))?;
    let bundled_dir = resource_dir.join(dir_name);
    if bundled_dir.exists() {
        return Ok(bundled_dir);
    }

    Err(format!("Unable to locate bundled {dir_name} directory."))
}

fn copy_path_recursively(source_path: &Path, target_path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(source_path).map_err(|error| {
        format!(
            "Failed to read asset metadata {}: {error}",
            source_path.display()
        )
    })?;

    if metadata.is_dir() {
        ensure_directory(target_path)?;
        let entries = fs::read_dir(source_path).map_err(|error| {
            format!(
                "Failed to read bundled asset directory {}: {error}",
                source_path.display()
            )
        })?;

        for entry in entries.flatten() {
            let child_source = entry.path();
            let Some(file_name) = child_source.file_name() else {
                continue;
            };
            let child_target = target_path.join(file_name);
            copy_path_recursively(&child_source, &child_target)?;
        }

        return Ok(());
    }

    if let Some(parent) = target_path.parent() {
        ensure_directory(parent)?;
    }

    fs::copy(source_path, target_path).map_err(|error| {
        format!(
            "Failed to sync bundled asset {} into {}: {error}",
            source_path.display(),
            target_path.display()
        )
    })?;

    Ok(())
}

fn seed_directory_from_defaults<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dir_name: &str,
    target_dir: &Path,
) -> Result<(), String> {
    ensure_directory(target_dir)?;
    let source_dir = match resolve_default_asset_dir(app, dir_name) {
        Ok(path) => path,
        Err(_) => return Ok(()),
    };
    let entries = fs::read_dir(&source_dir).map_err(|error| {
        format!(
            "Failed to read bundled {dir_name} directory {}: {error}",
            source_dir.display()
        )
    })?;

    for entry in entries.flatten() {
        let source_path = entry.path();
        let Some(file_name) = source_path.file_name() else {
            continue;
        };
        let target_path = target_dir.join(file_name);
        copy_path_recursively(&source_path, &target_path).map_err(|error| {
            format!(
                "Failed to seed Aura {dir_name} asset {}: {error}",
                source_path.display()
            )
        })?;
    }

    Ok(())
}

fn ensure_aura_layout<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<AuraHomeState, String> {
    let home_dir = resolve_aura_home()?;
    let config_dir = home_dir.join("config");
    let skills_dir = home_dir.join("skills");
    let plugins_dir = home_dir.join("plugins");
    let mcp_dir = home_dir.join("mcp");
    let workspace_dir = home_dir.join("workspace");
    let logs_dir = home_dir.join("logs");
    let browser_dir = home_dir.join("browser");

    for dir in [
        &home_dir,
        &config_dir,
        &skills_dir,
        &plugins_dir,
        &mcp_dir,
        &workspace_dir,
        &logs_dir,
        &browser_dir,
    ] {
        ensure_directory(dir)?;
    }

    seed_directory_from_defaults(app, "skills", &skills_dir)?;
    seed_directory_from_defaults(app, "plugins", &plugins_dir)?;

    let settings_path = config_dir.join("settings.json");
    let sessions_path = config_dir.join("sessions.json");
    let mcp_servers_path = mcp_dir.join("servers.json");

    Ok(AuraHomeState {
        home_dir: home_dir.display().to_string(),
        config_dir: config_dir.display().to_string(),
        skills_dir: skills_dir.display().to_string(),
        plugins_dir: plugins_dir.display().to_string(),
        mcp_dir: mcp_dir.display().to_string(),
        workspace_dir: workspace_dir.display().to_string(),
        logs_dir: logs_dir.display().to_string(),
        browser_dir: browser_dir.display().to_string(),
        settings_path: settings_path.display().to_string(),
        sessions_path: sessions_path.display().to_string(),
        mcp_servers_path: mcp_servers_path.display().to_string(),
        skills: scan_aura_assets(app, &skills_dir, "skills")?,
        plugins: scan_aura_assets(app, &plugins_dir, "plugins")?,
    })
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mix_u64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn create_task_id() -> String {
    let counter = NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed);
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let high_seed = (now_nanos >> 64) as u64 ^ now_nanos as u64 ^ counter;
    let low_seed = (now_nanos as u64).rotate_left(17) ^ counter.rotate_left(32) ^ pid;
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&mix_u64(high_seed).to_be_bytes());
    bytes[8..].copy_from_slice(&mix_u64(low_seed).to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn local_log_datetime(timestamp_ms: u64) -> chrono::DateTime<Local> {
    let timestamp_ms = i64::try_from(timestamp_ms).unwrap_or(i64::MAX);
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .unwrap_or_else(Local::now)
}

fn local_log_date(timestamp_ms: u64) -> String {
    local_log_datetime(timestamp_ms).format("%Y-%m-%d").to_string()
}

fn local_log_timestamp(timestamp_ms: u64) -> String {
    local_log_datetime(timestamp_ms)
        .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
        .to_string()
}

fn prune_old_app_logs(logs_dir: &Path, now_ms: u64) {
    let Ok(entries) = fs::read_dir(logs_dir) else {
        return;
    };
    let retention_ms = APP_LOG_RETENTION_DAYS * 86_400_000;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("app-")
            || (!file_name.ends_with(".log") && !file_name.ends_with(".jsonl"))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = SystemTime::now().duration_since(modified) else {
            continue;
        };
        if age.as_millis() as u64 > retention_ms && now_ms > retention_ms {
            let _ = fs::remove_file(path);
        }
    }
}

fn truncate_log_value(value: String, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value;
    }
    let mut truncated = value.chars().take(limit).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn format_log_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            let trimmed = truncate_log_value(value.clone(), 240);
            if trimmed.is_empty()
                || trimmed.chars().any(|character| {
                    character.is_whitespace() || character == '"' || character == '\''
                })
            {
                serde_json::to_string(&trimmed).unwrap_or_else(|_| "\"\"".into())
            } else {
                trimmed
            }
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            let serialized = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
            truncate_log_value(serialized, 400)
        }
    }
}

fn flatten_log_fields(
    fields: &mut Vec<String>,
    prefix: &str,
    value: &serde_json::Value,
    depth: usize,
) {
    if fields.len() >= 48 {
        return;
    }
    match value {
        serde_json::Value::Object(map) if depth < 3 => {
            for (key, child) in map {
                if fields.len() >= 48 {
                    fields.push("...".into());
                    break;
                }
                let next_prefix = if prefix.is_empty() {
                    key.to_string()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_log_fields(fields, &next_prefix, child, depth + 1);
            }
        }
        serde_json::Value::Null => {}
        _ if !prefix.is_empty() => {
            fields.push(format!("{prefix}={}", format_log_value(value)));
        }
        _ => {}
    }
}

fn format_app_log_line(
    timestamp: &str,
    level: &str,
    event: &str,
    details: &serde_json::Value,
) -> String {
    let mut fields = Vec::new();
    flatten_log_fields(&mut fields, "", details, 0);
    let suffix = if fields.is_empty() {
        "-".into()
    } else {
        fields.join(" ")
    };
    format!(
        "{timestamp} {:<5} {event} -- {suffix}",
        level.to_ascii_uppercase()
    )
}

fn append_log_line(path: PathBuf, line: &str) {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn append_app_log<R: Runtime>(
    app: &tauri::AppHandle<R>,
    level: &str,
    event: &str,
    details: serde_json::Value,
) {
    let Ok(logs_dir) = resolve_aura_home().map(|home| home.join("logs")) else {
        return;
    };
    let _ = ensure_directory(&logs_dir);
    let now_ms = current_timestamp_ms();
    prune_old_app_logs(&logs_dir, now_ms);
    let timestamp = local_log_timestamp(now_ms);
    let date = local_log_date(now_ms);
    let human_line = format_app_log_line(&timestamp, level, event, &details);
    let entry = AppLogEntry {
        timestamp,
        timestamp_ms: now_ms,
        level: level.to_string(),
        event: event.to_string(),
        details,
    };
    append_log_line(logs_dir.join(format!("app-{date}.log")), &human_line);
    if let Ok(serialized_entry) = serde_json::to_string(&entry) {
        append_log_line(logs_dir.join(format!("app-{date}.jsonl")), &serialized_entry);
    }
    let _ = app.emit("app-log-entry", entry);
}

fn normalize_app_log_level(level: Option<String>) -> &'static str {
    match level.as_deref() {
        Some("debug") => "debug",
        Some("warn") => "warn",
        Some("error") => "error",
        _ => "info",
    }
}

fn sanitize_url_for_log(value: &str) -> String {
    let without_query = value.split('?').next().unwrap_or(value);
    without_query
        .split('#')
        .next()
        .unwrap_or(without_query)
        .to_string()
}

fn insert_log_string(
    fields: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<&str>,
) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    fields.insert(key.to_string(), serde_json::Value::String(value.to_string()));
}

fn agent_log_context_details(task_id: &str, payload: &serde_json::Value) -> serde_json::Value {
    let log_context = payload
        .get("logContext")
        .unwrap_or(&serde_json::Value::Null);
    let assistant_message_id = log_context
        .get("assistantMessageId")
        .and_then(|value| value.as_str());
    let mut fields = serde_json::Map::new();
    insert_log_string(&mut fields, "taskId", Some(task_id));
    insert_log_string(
        &mut fields,
        "sessionId",
        log_context.get("sessionId").and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "userMessageId",
        log_context
            .get("userMessageId")
            .and_then(|value| value.as_str()),
    );
    insert_log_string(&mut fields, "assistantMessageId", assistant_message_id);
    insert_log_string(&mut fields, "messageId", assistant_message_id);
    serde_json::Value::Object(fields)
}

fn agent_log_details(
    context: &serde_json::Value,
    details: serde_json::Value,
) -> serde_json::Value {
    let mut fields = context.as_object().cloned().unwrap_or_default();
    if let serde_json::Value::Object(details) = details {
        for (key, value) in details {
            fields.insert(key, value);
        }
    }
    serde_json::Value::Object(fields)
}

fn agent_payload_log_details(task_id: &str, payload: &serde_json::Value) -> serde_json::Value {
    let settings = payload.get("settings").unwrap_or(&serde_json::Value::Null);
    let message_count = payload
        .get("messages")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    agent_log_details(&agent_log_context_details(task_id, payload), serde_json::json!({
        "provider": settings.get("provider").and_then(|value| value.as_str()),
        "model": settings.get("model").and_then(|value| value.as_str()),
        "baseUrl": settings
            .get("baseUrl")
            .and_then(|value| value.as_str())
            .map(sanitize_url_for_log),
        "providerProxyEnabled": settings
            .get("providerProxyEnabled")
            .and_then(|value| value.as_bool()),
        "networkProxyConfigured": settings
            .get("networkProxy")
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        "cwd": settings.get("cwd").and_then(|value| value.as_str()),
        "messageCount": message_count,
    }))
}

fn context_compression_log_details(payload: &serde_json::Value) -> serde_json::Value {
    let settings = payload.get("settings").unwrap_or(&serde_json::Value::Null);
    let log_context = payload
        .get("logContext")
        .unwrap_or(&serde_json::Value::Null);
    let message_count = payload
        .get("messages")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    let mut fields = serde_json::Map::new();
    insert_log_string(
        &mut fields,
        "sessionId",
        log_context.get("sessionId").and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "compressionId",
        log_context
            .get("compressionId")
            .and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "compressedThroughMessageId",
        log_context
            .get("compressedThroughMessageId")
            .and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "provider",
        settings.get("provider").and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "model",
        settings.get("model").and_then(|value| value.as_str()),
    );
    insert_log_string(
        &mut fields,
        "cwd",
        settings.get("cwd").and_then(|value| value.as_str()),
    );
    fields.insert(
        "baseUrl".into(),
        settings
            .get("baseUrl")
            .and_then(|value| value.as_str())
            .map(sanitize_url_for_log)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    fields.insert(
        "providerProxyEnabled".into(),
        settings
            .get("providerProxyEnabled")
            .and_then(|value| value.as_bool())
            .map(serde_json::Value::Bool)
            .unwrap_or(serde_json::Value::Null),
    );
    fields.insert(
        "networkProxyConfigured".into(),
        serde_json::Value::Bool(
            settings
                .get("networkProxy")
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        ),
    );
    fields.insert(
        "messageCount".into(),
        serde_json::Value::Number(serde_json::Number::from(message_count)),
    );
    fields.insert(
        "keepRecentCount".into(),
        payload
            .get("keepRecentCount")
            .and_then(|value| value.as_u64())
            .map(|value| serde_json::Value::Number(serde_json::Number::from(value)))
            .unwrap_or(serde_json::Value::Null),
    );
    serde_json::Value::Object(fields)
}

fn provider_action_log_details(payload: &serde_json::Value) -> serde_json::Value {
    let settings = payload.get("settings").unwrap_or(&serde_json::Value::Null);
    serde_json::json!({
        "action": payload.get("action").and_then(|value| value.as_str()),
        "provider": settings.get("provider").and_then(|value| value.as_str()),
        "model": settings.get("model").and_then(|value| value.as_str()),
        "baseUrl": settings
            .get("baseUrl")
            .and_then(|value| value.as_str())
            .map(sanitize_url_for_log),
        "providerProxyEnabled": settings
            .get("providerProxyEnabled")
            .and_then(|value| value.as_bool()),
        "networkProxyConfigured": settings
            .get("networkProxy")
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
    })
}

fn event_step_id(event: &serde_json::Value) -> Option<&str> {
    event
        .get("id")
        .and_then(|value| value.as_str())
        .or_else(|| event.get("blockId").and_then(|value| value.as_str()))
}

fn context_step_id(context: &serde_json::Value, kind: &str, suffix: &str) -> Option<String> {
    let message_id = context
        .get("messageId")
        .and_then(|value| value.as_str())
        .or_else(|| {
            context
                .get("assistantMessageId")
                .and_then(|value| value.as_str())
        })?;
    if message_id.trim().is_empty() {
        return None;
    }
    Some(format!("{message_id}-{kind}-{suffix}"))
}

fn delta_log_preview(event: &serde_json::Value) -> Option<String> {
    event
        .get("delta")
        .and_then(|value| value.as_str())
        .map(|value| truncate_snapshot_text(value, MAX_LOG_DELTA_CHARS))
}

fn delta_log_char_count(event: &serde_json::Value) -> Option<usize> {
    event
        .get("delta")
        .and_then(|value| value.as_str())
        .map(|value| value.chars().count())
}

fn event_log_details(context: &serde_json::Value, event: &serde_json::Value) -> serde_json::Value {
    let event_type = event
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    match event_type {
        "text_delta" => agent_log_details(context, serde_json::json!({
            "stepId": event_step_id(event),
            "blockId": event.get("blockId").and_then(|value| value.as_str()),
            "target": event.get("target").and_then(|value| value.as_str()),
            "order": event.get("order").and_then(|value| value.as_f64()),
            "deltaChars": delta_log_char_count(event),
            "delta": delta_log_preview(event),
        })),
        "reasoning_delta" => agent_log_details(context, serde_json::json!({
            "stepId": event_step_id(event),
            "reasoningStepId": event_step_id(event),
            "blockId": event.get("blockId").and_then(|value| value.as_str()),
            "kind": event.get("kind").and_then(|value| value.as_str()),
            "order": event.get("order").and_then(|value| value.as_f64()),
            "deltaChars": delta_log_char_count(event),
            "delta": delta_log_preview(event),
        })),
        "reasoning_discard" => agent_log_details(context, serde_json::json!({
            "stepId": event_step_id(event),
            "reasoningStepId": event_step_id(event),
            "blockId": event.get("blockId").and_then(|value| value.as_str()),
            "reason": event.get("reason").and_then(|value| value.as_str()),
            "attemptNumber": event.get("attemptNumber").and_then(|value| value.as_u64()),
            "nextAttemptNumber": event.get("nextAttemptNumber").and_then(|value| value.as_u64()),
        })),
        "runtime_status" => agent_log_details(context, serde_json::json!({
            "phase": event.get("phase").and_then(|value| value.as_str()),
            "stalled": event.get("stalled").and_then(|value| value.as_bool()),
            "lastHeartbeatAt": event.get("lastHeartbeatAt").and_then(|value| value.as_u64()),
            "lastProgressAt": event.get("lastProgressAt").and_then(|value| value.as_u64()),
        })),
        "retry_progress" => agent_log_details(context, serde_json::json!({
            "retryInfo": event.get("retryInfo").cloned().unwrap_or(serde_json::Value::Null),
        })),
        "runtime_log" => {
            let runtime_event = event.get("event").unwrap_or(&serde_json::Value::Null);
            let details = runtime_event
                .get("details")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "runtimeEvent": runtime_event.get("event").and_then(|value| value.as_str()),
                "runtimeLevel": runtime_event.get("level").and_then(|value| value.as_str()),
                "details": details,
            }))
        }
        "context_compression" => {
            let compression = event
                .get("contextCompression")
                .unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": compression.get("id").and_then(|value| value.as_str()),
                "compressionId": compression.get("id").and_then(|value| value.as_str()),
                "compressedThroughMessageId": compression
                    .get("compressedThroughMessageId")
                    .and_then(|value| value.as_str()),
                "originalTokenEstimate": compression
                    .get("originalTokenEstimate")
                    .and_then(|value| value.as_u64()),
                "compressedTokenEstimate": compression
                    .get("compressedTokenEstimate")
                    .and_then(|value| value.as_u64()),
            }))
        }
        "tool_event" => {
            let tool_event = event.get("event").unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": tool_event.get("id").and_then(|value| value.as_str()),
                "toolEventId": tool_event.get("id").and_then(|value| value.as_str()),
                "source": tool_event.get("source").and_then(|value| value.as_str()),
                "toolName": tool_event.get("name").and_then(|value| value.as_str()),
                "summary": tool_event.get("summary").and_then(|value| value.as_str()),
                "input": tool_event.get("input").and_then(|value| value.as_str()),
                "status": tool_event.get("status").and_then(|value| value.as_str()),
                "error": tool_event.get("error").and_then(|value| value.as_str()),
                "errorInfo": tool_event.get("errorInfo").cloned().unwrap_or(serde_json::Value::Null),
            }))
        }
        "task_tree" => {
            let tree = event.get("tree").unwrap_or(&serde_json::Value::Null);
            let root = tree
                .as_array()
                .and_then(|entries| entries.first())
                .unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": root.get("id").and_then(|value| value.as_str()),
                "rootTaskId": root.get("id").and_then(|value| value.as_str()),
                "rootTitle": root.get("title").and_then(|value| value.as_str()),
                "rootStatus": root.get("status").and_then(|value| value.as_str()),
                "rootSummary": root.get("summary").and_then(|value| value.as_str()),
                "tree": tree.clone(),
            }))
        }
        "route_decision" => {
            let route_decision = event
                .get("routeDecision")
                .unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": context_step_id(context, "route", "decision"),
                "answerMode": route_decision.get("answerMode").and_then(|value| value.as_str()),
                "capabilityTier": route_decision
                    .get("capabilityTier")
                    .and_then(|value| value.as_str()),
                "stopReason": route_decision.get("stopReason").and_then(|value| value.as_str()),
                "escalationCount": route_decision
                    .get("escalationCount")
                    .and_then(|value| value.as_u64()),
                "routeDecision": route_decision.clone(),
            }))
        }
        "approval_required" => {
            let request = event.get("request").unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": request.get("id").and_then(|value| value.as_str()),
                "approvalId": request.get("id").and_then(|value| value.as_str()),
                "category": request.get("category").and_then(|value| value.as_str()),
                "toolName": request.get("toolName").and_then(|value| value.as_str()),
                "summary": request.get("summary").and_then(|value| value.as_str()),
            }))
        }
        "user_input_required" => {
            let request = event.get("request").unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "stepId": request.get("id").and_then(|value| value.as_str()),
                "userInputRequestId": request.get("id").and_then(|value| value.as_str()),
                "question": request.get("question").and_then(|value| value.as_str()),
                "allowAttachments": request
                    .get("allowAttachments")
                    .and_then(|value| value.as_bool()),
            }))
        }
        "failed" => agent_log_details(context, serde_json::json!({
            "message": event.get("message").and_then(|value| value.as_str()),
            "code": event.get("code").and_then(|value| value.as_str()),
            "source": event.get("source").and_then(|value| value.as_str()),
            "rawMessage": event.get("rawMessage").and_then(|value| value.as_str()),
            "errorInfo": event.get("errorInfo").cloned().unwrap_or(serde_json::Value::Null),
            "retryInfo": event.get("retryInfo").cloned().unwrap_or(serde_json::Value::Null),
        })),
        "completed" => {
            let result = event.get("result").unwrap_or(&serde_json::Value::Null);
            agent_log_details(context, serde_json::json!({
                "status": "completed",
                "usage": result.get("usage").cloned().unwrap_or(serde_json::Value::Null),
                "agentMode": result.get("agentMode").and_then(|value| value.as_str()),
                "completionState": result.get("completionState").and_then(|value| value.as_str()),
                "toolEventCount": result
                    .get("toolEvents")
                    .and_then(|value| value.as_array())
                    .map(|value| value.len())
                    .unwrap_or(0),
            }))
        }
        _ => agent_log_details(context, serde_json::json!({
            "type": event_type,
        })),
    }
}

fn canonical_display_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn canonicalize_existing_path(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path)
        .map_err(|error| format!("Failed to canonicalize path {}: {error}", path.display()))
}

fn resolve_app_bundle_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_dir() || path.extension().and_then(|value| value.to_str()) != Some("app") {
        return None;
    }

    let executable_name = path.file_stem()?.to_str()?;
    let macos_dir = path.join("Contents").join("MacOS");
    let named_candidate = macos_dir.join(executable_name);
    if named_candidate.is_file() {
        return Some(named_candidate);
    }

    fs::read_dir(&macos_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|candidate| candidate.is_file())
}

fn resolve_executable_path(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    resolve_app_bundle_executable(path)
}

fn lightpanda_name_score(path: &Path) -> usize {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name == "lightpanda" || file_name == "lightpanda.exe" || file_name == "lightpanda.app" {
        return 3;
    }
    if file_name.contains("lightpanda") {
        return 2;
    }
    0
}

fn collect_lightpanda_install_candidates(
    dir: &Path,
    remaining_depth: usize,
    candidates: &mut Vec<PathBuf>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            if path.extension().and_then(|value| value.to_str()) == Some("app") {
                if lightpanda_name_score(&path) > 0 {
                    if let Some(executable) = resolve_app_bundle_executable(&path) {
                        candidates.push(executable);
                    }
                }
                continue;
            }

            if remaining_depth > 0 {
                collect_lightpanda_install_candidates(&path, remaining_depth - 1, candidates);
            }
            continue;
        }

        if path.is_file() && lightpanda_name_score(&path) > 0 {
            candidates.push(path);
        }
    }
}

fn detect_lightpanda_installation(dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_lightpanda_install_candidates(dir, 2, &mut candidates);
    candidates.sort_by(|left, right| {
        lightpanda_name_score(right)
            .cmp(&lightpanda_name_score(left))
            .then_with(|| left.as_os_str().cmp(right.as_os_str()))
    });
    candidates.into_iter().next()
}

fn detect_lightpanda_path() -> Option<PathBuf> {
    let finder = if cfg!(target_os = "windows") {
        ("where", vec!["lightpanda"])
    } else {
        ("which", vec!["lightpanda"])
    };

    let output = Command::new(finder.0).args(finder.1).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let candidate = stdout
        .lines()
        .map(str::trim)
        .find(|entry| !entry.is_empty())?;
    resolve_executable_path(Path::new(candidate))
}

fn read_lightpanda_version(executable_path: &Path) -> Option<String> {
    let output = Command::new(executable_path)
        .arg("--version")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Some(stderr);
    }

    None
}

fn resolve_app_db_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let aura = ensure_aura_layout(app)?;
    Ok(PathBuf::from(aura.config_dir).join("app.db"))
}

fn work_memories_has_session_fk(connection: &Connection) -> Result<bool, String> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_list(work_memories)")
        .map_err(|error| format!("Failed to inspect work_memories foreign keys: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(2))
        .map_err(|error| format!("Failed to query work_memories foreign keys: {error}"))?;

    for row in rows {
        let table = row.map_err(|error| format!("Failed to decode work_memories foreign key: {error}"))?;
        if table == "sessions" {
            return Ok(true);
        }
    }

    Ok(false)
}

fn migrate_work_memories_without_session_fk(connection: &Connection) -> Result<(), String> {
    if !work_memories_has_session_fk(connection)? {
        return Ok(());
    }

    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;

            CREATE TABLE IF NOT EXISTS work_memories_without_fk (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              task_id TEXT,
              assistant_message_id TEXT,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              status TEXT NOT NULL,
              content_json TEXT NOT NULL,
              source_refs_json TEXT NOT NULL,
              next_use TEXT,
              created_at INTEGER NOT NULL
            );

            INSERT OR REPLACE INTO work_memories_without_fk (
              id, session_id, task_id, assistant_message_id, kind, title, summary, status,
              content_json, source_refs_json, next_use, created_at
            )
            SELECT
              id, session_id, task_id, assistant_message_id, kind, title, summary, status,
              content_json, source_refs_json, next_use, created_at
            FROM work_memories;

            DROP TABLE work_memories;
            ALTER TABLE work_memories_without_fk RENAME TO work_memories;

            CREATE INDEX IF NOT EXISTS idx_work_memories_session_created
              ON work_memories(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_work_memories_session_assistant
              ON work_memories(session_id, assistant_message_id);

            PRAGMA foreign_keys = ON;
            "#,
        )
        .map_err(|error| {
            format!("Failed to migrate work_memories away from session foreign key: {error}")
        })?;

    Ok(())
}

fn open_app_db<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Connection, String> {
    let db_path = resolve_app_db_path(app)?;
    let connection = Connection::open(&db_path).map_err(|error| {
        format!(
            "Failed to open SQLite database {}: {error}",
            db_path.display()
        )
    })?;

    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS app_kv (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              provider_profile_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              model TEXT NOT NULL,
              folder_id TEXT NOT NULL DEFAULT '',
              workspace_path TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              workspace_mode TEXT NOT NULL,
              context_compression_json TEXT,
              deleted_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              linked_message_id TEXT,
              sort_index INTEGER NOT NULL,
              active_version_index INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              deleted_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS message_versions (
              id TEXT PRIMARY KEY,
              message_id TEXT NOT NULL,
              version_index INTEGER NOT NULL,
              content TEXT NOT NULL,
              parts_json TEXT NOT NULL,
              status TEXT,
              created_at INTEGER NOT NULL,
              attachments_json TEXT NOT NULL,
              reasoning_json TEXT NOT NULL,
              usage_json TEXT,
              capability_snapshot_json TEXT,
              activity_json TEXT,
              events_json TEXT NOT NULL,
              steps_json TEXT NOT NULL,
              error TEXT,
              error_info_json TEXT,
              appended_inputs_json TEXT NOT NULL,
              agent_mode TEXT,
              route_decision_json TEXT,
              completion_state TEXT,
              evidence_summary_json TEXT,
              delivery_note TEXT,
              model_info_json TEXT,
              deleted_at INTEGER NOT NULL DEFAULT 0,
              UNIQUE(message_id, version_index),
              FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_summaries (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              summary_type TEXT NOT NULL,
              content TEXT NOT NULL,
              metadata_json TEXT,
              source_message_id TEXT,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS work_memories (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              task_id TEXT,
              assistant_message_id TEXT,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              status TEXT NOT NULL,
              content_json TEXT NOT NULL,
              source_refs_json TEXT NOT NULL,
              next_use TEXT,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
              run_id TEXT PRIMARY KEY,
              session_id TEXT,
              task_id TEXT,
              assistant_message_id TEXT,
              user_message_id TEXT,
              status TEXT NOT NULL,
              architecture_mode TEXT,
              requested_architecture_mode TEXT,
              path_mode TEXT,
              provider TEXT,
              model TEXT,
              cwd TEXT,
              started_at INTEGER NOT NULL,
              finished_at INTEGER,
              updated_at INTEGER NOT NULL,
              termination_reason TEXT,
              completion_state TEXT,
              graph_state TEXT,
              checkpoint_count INTEGER,
              recovery_count INTEGER,
              tool_count INTEGER,
              input_tokens INTEGER,
              output_tokens INTEGER,
              duration_ms INTEGER,
              error_code TEXT,
              error_category TEXT,
              summary_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              checkpoint_id TEXT NOT NULL,
              graph_state TEXT,
              plan_id TEXT,
              subtask_id TEXT,
              reason TEXT,
              restored INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              details_json TEXT NOT NULL,
              UNIQUE(run_id, checkpoint_id)
            );

            CREATE TABLE IF NOT EXISTS user_memory (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL,
              memory_type TEXT NOT NULL,
              content TEXT NOT NULL,
              metadata_json TEXT,
              source_session_id TEXT,
              source_message_id TEXT,
              confidence REAL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_sort
              ON messages(session_id, sort_index);
            CREATE INDEX IF NOT EXISTS idx_message_versions_message_version
              ON message_versions(message_id, version_index);
            CREATE INDEX IF NOT EXISTS idx_work_memories_session_created
              ON work_memories(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_work_memories_session_assistant
              ON work_memories(session_id, assistant_message_id);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_session_updated
              ON agent_runs(session_id, updated_at);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_task_updated
              ON agent_runs(task_id, updated_at);
            CREATE INDEX IF NOT EXISTS idx_agent_run_checkpoints_run
              ON agent_run_checkpoints(run_id, created_at);
            "#,
        )
        .map_err(|error| format!("Failed to initialize SQLite schema: {error}"))?;

    migrate_work_memories_without_session_fk(&connection)?;

    if let Err(error) = connection.execute(
        "ALTER TABLE sessions ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!("Failed to migrate SQLite sessions table: {error}"));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE sessions ADD COLUMN context_compression_json TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite sessions context_compression_json column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE sessions ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite sessions deleted_at column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE messages ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite messages deleted_at column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN agent_mode TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions agent_mode column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN route_decision_json TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions route_decision_json column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN completion_state TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions completion_state column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN evidence_summary_json TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions evidence_summary_json column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN delivery_note TEXT",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions delivery_note column: {error}"
            ));
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE message_versions ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0",
        [],
    ) {
        let message = error.to_string();
        if !message.contains("duplicate column name") {
            return Err(format!(
                "Failed to migrate SQLite message_versions deleted_at column: {error}"
            ));
        }
    }

    connection
        .execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_messages_session_deleted_sort
              ON messages(session_id, deleted_at, sort_index);
            CREATE INDEX IF NOT EXISTS idx_message_versions_message_deleted_version
              ON message_versions(message_id, deleted_at, version_index);
            "#,
        )
        .map_err(|error| format!("Failed to initialize SQLite deleted_at indexes: {error}"))?;

    Ok(connection)
}

fn parse_json_column(raw: Option<String>) -> serde_json::Value {
    raw.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn parse_json_array_column(raw: String) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .filter(|value| value.is_array())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()))
}

fn parse_json_object_column(raw: Option<String>) -> serde_json::Value {
    raw.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .filter(|value| value.is_object())
        .unwrap_or(serde_json::Value::Null)
}

fn truncate_work_memory_text(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    if max_chars <= 3 {
        return normalized.chars().take(max_chars).collect();
    }
    let clipped: String = normalized.chars().take(max_chars - 3).collect();
    format!("{}...", clipped.trim_end())
}

fn get_work_memory_string_field(
    value: &serde_json::Value,
    key: &str,
    fallback: &str,
    max_chars: usize,
) -> String {
    let raw = value
        .get(key)
        .and_then(|entry| entry.as_str())
        .unwrap_or(fallback);
    truncate_work_memory_text(raw, max_chars)
}

fn normalize_work_memory_status(value: &serde_json::Value) -> &'static str {
    match value
        .get("status")
        .and_then(|entry| entry.as_str())
        .unwrap_or("draft")
    {
        "confirmed" => "confirmed",
        "assumption" => "assumption",
        _ => "draft",
    }
}

fn bounded_json_value(value: serde_json::Value, max_chars: usize) -> serde_json::Value {
    let serialized = value.to_string();
    if serialized.chars().count() <= max_chars {
        return value;
    }
    serde_json::json!({
        "truncated": true,
        "preview": truncate_work_memory_text(&serialized, max_chars),
    })
}

fn normalize_work_memory_source_refs(value: &serde_json::Value) -> serde_json::Value {
    let refs = value
        .get("sourceRefs")
        .or_else(|| value.get("sources"))
        .and_then(|entry| entry.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_object())
                .take(12)
                .map(|entry| {
                    let mut normalized = serde_json::Map::new();
                    for (key, value) in entry {
                        if let Some(raw) = value.as_str() {
                            let clipped = truncate_work_memory_text(raw, 240);
                            if !clipped.is_empty() {
                                normalized.insert(key.clone(), serde_json::Value::String(clipped));
                            }
                        } else if value.is_number() {
                            normalized.insert(key.clone(), value.clone());
                        }
                    }
                    serde_json::Value::Object(normalized)
                })
                .filter(|entry| entry.as_object().map(|map| !map.is_empty()).unwrap_or(false))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    bounded_json_value(
        serde_json::Value::Array(refs),
        MAX_WORK_MEMORY_SOURCE_REFS_JSON_CHARS,
    )
}

fn normalize_work_memory_payload(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let session_id = get_work_memory_string_field(payload, "sessionId", "", 120);
    if session_id.is_empty() {
        return Err("Work memory requires a sessionId.".into());
    }

    let now = current_timestamp_ms() as i64;
    let kind = get_work_memory_string_field(
        payload,
        "kind",
        "phase_artifact",
        MAX_WORK_MEMORY_KIND_CHARS,
    );
    let title = get_work_memory_string_field(
        payload,
        "title",
        kind.as_str(),
        MAX_WORK_MEMORY_TITLE_CHARS,
    );
    let summary = get_work_memory_string_field(
        payload,
        "summary",
        "",
        MAX_WORK_MEMORY_SUMMARY_CHARS,
    );
    if summary.is_empty() {
        return Err("Work memory requires a summary.".into());
    }

    let content = payload
        .get("content")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(serde_json::json!({
        "id": get_work_memory_string_field(
            payload,
            "id",
            &format!("work-memory-{}", create_task_id()),
            180,
        ),
        "sessionId": session_id,
        "taskId": get_work_memory_string_field(payload, "taskId", "", 120),
        "assistantMessageId": get_work_memory_string_field(payload, "assistantMessageId", "", 120),
        "kind": if kind.is_empty() { "phase_artifact".to_string() } else { kind },
        "title": if title.is_empty() { "phase_artifact".to_string() } else { title },
        "summary": summary,
        "status": normalize_work_memory_status(payload),
        "content": bounded_json_value(content, MAX_WORK_MEMORY_CONTENT_JSON_CHARS),
        "sourceRefs": normalize_work_memory_source_refs(payload),
        "nextUse": get_work_memory_string_field(payload, "nextUse", "", MAX_WORK_MEMORY_NEXT_USE_CHARS),
        "createdAt": payload
            .get("createdAt")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .unwrap_or(now),
    }))
}

fn value_to_json_string(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("Failed to serialize JSON payload: {error}"))
}

fn get_json_string_field(value: &serde_json::Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .unwrap_or(fallback)
        .to_string()
}

fn get_json_i64_field(value: &serde_json::Value, key: &str, fallback: i64) -> i64 {
    value
        .get(key)
        .and_then(|entry| entry.as_i64())
        .unwrap_or(fallback)
}

fn get_json_array_field(value: &serde_json::Value, key: &str) -> serde_json::Value {
    value
        .get(key)
        .cloned()
        .filter(|entry| entry.is_array())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()))
}

fn get_json_object_field(value: &serde_json::Value, key: &str) -> serde_json::Value {
    value
        .get(key)
        .cloned()
        .filter(|entry| entry.is_object())
        .unwrap_or(serde_json::Value::Null)
}

fn get_optional_json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.to_string())
}

fn get_optional_json_i64(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|entry| {
        entry
            .as_i64()
            .or_else(|| entry.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| entry.as_f64().map(|value| value.round() as i64))
    })
}

fn runtime_run_status(event_name: &str, details: &serde_json::Value, level: &str) -> Option<String> {
    match event_name {
        "agent.run.started" => Some("running".to_string()),
        "agent.run.finished" | "agent.metrics.summary" => get_optional_json_string(details, "status")
            .or_else(|| {
                if level == "error" {
                    Some("failed".to_string())
                } else {
                    Some("completed".to_string())
                }
            }),
        "agent.error.classified" => Some("failed".to_string()),
        _ => None,
    }
}

fn persist_agent_runtime_log<R: Runtime>(
    app: &tauri::AppHandle<R>,
    runtime_event: &serde_json::Value,
) -> Result<(), String> {
    let event_name = runtime_event
        .get("event")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let level = runtime_event
        .get("level")
        .and_then(|value| value.as_str())
        .unwrap_or("info");
    let details = runtime_event
        .get("details")
        .unwrap_or(&serde_json::Value::Null);
    let Some(run_id) = get_optional_json_string(details, "runId") else {
        return Ok(());
    };

    let now = current_timestamp_ms() as i64;
    let status = runtime_run_status(event_name, details, level);
    let finished_at = match event_name {
        "agent.run.finished" | "agent.metrics.summary" => Some(now),
        _ => None,
    };
    let started_at = if event_name == "agent.run.started" {
        now
    } else {
        0
    };
    let summary_json = value_to_json_string(details)?;
    let connection = open_app_db(app)?;

    connection
        .execute(
            "INSERT INTO agent_runs (
                run_id, session_id, task_id, assistant_message_id, user_message_id, status,
                architecture_mode, requested_architecture_mode, path_mode, provider, model, cwd,
                started_at, finished_at, updated_at, termination_reason, completion_state, graph_state,
                checkpoint_count, recovery_count, tool_count, input_tokens, output_tokens, duration_ms,
                error_code, error_category, summary_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)
             ON CONFLICT(run_id) DO UPDATE SET
                session_id = COALESCE(excluded.session_id, agent_runs.session_id),
                task_id = COALESCE(excluded.task_id, agent_runs.task_id),
                assistant_message_id = COALESCE(excluded.assistant_message_id, agent_runs.assistant_message_id),
                user_message_id = COALESCE(excluded.user_message_id, agent_runs.user_message_id),
                status = COALESCE(excluded.status, agent_runs.status),
                architecture_mode = COALESCE(excluded.architecture_mode, agent_runs.architecture_mode),
                requested_architecture_mode = COALESCE(excluded.requested_architecture_mode, agent_runs.requested_architecture_mode),
                path_mode = COALESCE(excluded.path_mode, agent_runs.path_mode),
                provider = COALESCE(excluded.provider, agent_runs.provider),
                model = COALESCE(excluded.model, agent_runs.model),
                cwd = COALESCE(excluded.cwd, agent_runs.cwd),
                started_at = CASE
                  WHEN agent_runs.started_at <= 0 AND excluded.started_at > 0 THEN excluded.started_at
                  ELSE agent_runs.started_at
                END,
                finished_at = COALESCE(excluded.finished_at, agent_runs.finished_at),
                updated_at = excluded.updated_at,
                termination_reason = COALESCE(excluded.termination_reason, agent_runs.termination_reason),
                completion_state = COALESCE(excluded.completion_state, agent_runs.completion_state),
                graph_state = COALESCE(excluded.graph_state, agent_runs.graph_state),
                checkpoint_count = COALESCE(excluded.checkpoint_count, agent_runs.checkpoint_count),
                recovery_count = COALESCE(excluded.recovery_count, agent_runs.recovery_count),
                tool_count = COALESCE(excluded.tool_count, agent_runs.tool_count),
                input_tokens = COALESCE(excluded.input_tokens, agent_runs.input_tokens),
                output_tokens = COALESCE(excluded.output_tokens, agent_runs.output_tokens),
                duration_ms = COALESCE(excluded.duration_ms, agent_runs.duration_ms),
                error_code = COALESCE(excluded.error_code, agent_runs.error_code),
                error_category = COALESCE(excluded.error_category, agent_runs.error_category),
                summary_json = excluded.summary_json",
            params![
                &run_id,
                get_optional_json_string(details, "sessionId"),
                get_optional_json_string(details, "taskId"),
                get_optional_json_string(details, "assistantMessageId"),
                get_optional_json_string(details, "userMessageId"),
                status.unwrap_or_else(|| "observed".to_string()),
                get_optional_json_string(details, "architectureMode"),
                get_optional_json_string(details, "requestedArchitectureMode"),
                get_optional_json_string(details, "pathMode"),
                get_optional_json_string(details, "provider"),
                get_optional_json_string(details, "model"),
                get_optional_json_string(details, "cwd"),
                started_at,
                finished_at,
                now,
                get_optional_json_string(details, "terminationReason"),
                get_optional_json_string(details, "completionState"),
                get_optional_json_string(details, "graphState")
                    .or_else(|| get_optional_json_string(details, "restoredState"))
                    .or_else(|| get_optional_json_string(details, "state")),
                get_optional_json_i64(details, "checkpointCount"),
                get_optional_json_i64(details, "recoveryCount"),
                get_optional_json_i64(details, "toolCount"),
                get_optional_json_i64(details, "inputTokens"),
                get_optional_json_i64(details, "outputTokens"),
                get_optional_json_i64(details, "durationMs"),
                get_optional_json_string(details, "code")
                    .or_else(|| get_optional_json_string(details, "errorCode")),
                get_optional_json_string(details, "category")
                    .or_else(|| get_optional_json_string(details, "errorCategory")),
                summary_json,
            ],
        )
        .map_err(|error| format!("Failed to persist agent run: {error}"))?;

    if matches!(event_name, "agent.checkpoint.created" | "agent.checkpoint.restored") {
        if let Some(checkpoint_id) = get_optional_json_string(details, "checkpointId") {
            let id = format!("{run_id}:{checkpoint_id}");
            let restored = if event_name == "agent.checkpoint.restored" { 1 } else { 0 };
            connection
                .execute(
                    "INSERT INTO agent_run_checkpoints (
                        id, run_id, checkpoint_id, graph_state, plan_id, subtask_id, reason, restored, created_at, details_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(run_id, checkpoint_id) DO UPDATE SET
                        graph_state = COALESCE(excluded.graph_state, agent_run_checkpoints.graph_state),
                        plan_id = COALESCE(excluded.plan_id, agent_run_checkpoints.plan_id),
                        subtask_id = COALESCE(excluded.subtask_id, agent_run_checkpoints.subtask_id),
                        reason = COALESCE(excluded.reason, agent_run_checkpoints.reason),
                        restored = CASE
                          WHEN excluded.restored = 1 THEN 1
                          ELSE agent_run_checkpoints.restored
                        END,
                        details_json = excluded.details_json",
                    params![
                        id,
                        &run_id,
                        &checkpoint_id,
                        get_optional_json_string(details, "state")
                            .or_else(|| get_optional_json_string(details, "restoredState")),
                        get_optional_json_string(details, "planId"),
                        get_optional_json_string(details, "subtaskId"),
                        get_optional_json_string(details, "reason"),
                        restored,
                        now,
                        value_to_json_string(details)?,
                    ],
                )
                .map_err(|error| format!("Failed to persist agent checkpoint index: {error}"))?;
        }
    }

    Ok(())
}

fn upsert_kv(connection: &Connection, key: &str, value: &serde_json::Value) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO app_kv (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![key, value_to_json_string(value)?],
        )
        .map_err(|error| format!("Failed to persist app state for key {key}: {error}"))?;
    Ok(())
}

fn store_work_memory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let memory = normalize_work_memory_payload(payload)?;
    let connection = open_app_db(app)?;
    let content = memory
        .get("content")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let source_refs = memory
        .get("sourceRefs")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));

    connection
        .execute(
            "INSERT INTO work_memories (
                id, session_id, task_id, assistant_message_id, kind, title, summary, status,
                content_json, source_refs_json, next_use, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                task_id = excluded.task_id,
                assistant_message_id = excluded.assistant_message_id,
                kind = excluded.kind,
                title = excluded.title,
                summary = excluded.summary,
                status = excluded.status,
                content_json = excluded.content_json,
                source_refs_json = excluded.source_refs_json,
                next_use = excluded.next_use,
                created_at = excluded.created_at",
            params![
                memory.get("id").and_then(|value| value.as_str()).unwrap_or_default(),
                memory.get("sessionId").and_then(|value| value.as_str()).unwrap_or_default(),
                memory
                    .get("taskId")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty()),
                memory
                    .get("assistantMessageId")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty()),
                memory.get("kind").and_then(|value| value.as_str()).unwrap_or("phase_artifact"),
                memory.get("title").and_then(|value| value.as_str()).unwrap_or("phase_artifact"),
                memory.get("summary").and_then(|value| value.as_str()).unwrap_or_default(),
                memory.get("status").and_then(|value| value.as_str()).unwrap_or("draft"),
                value_to_json_string(&content)?,
                value_to_json_string(&source_refs)?,
                memory
                    .get("nextUse")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty()),
                memory.get("createdAt").and_then(|value| value.as_i64()).unwrap_or(0),
            ],
        )
        .map_err(|error| format!("Failed to persist work memory: {error}"))?;

    Ok(memory)
}

fn edit_transaction_snapshot_key(transaction_id: &str) -> String {
    format!("{EDIT_TRANSACTION_SNAPSHOT_KEY_PREFIX}{transaction_id}")
}

fn store_edit_transaction_snapshot<R: Runtime>(
    app: &tauri::AppHandle<R>,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let snapshot: EditTransactionSnapshot = serde_json::from_value(payload.clone())
        .map_err(|error| format!("Invalid edit transaction snapshot: {error}"))?;
    if snapshot.transaction_id.trim().is_empty() {
        return Err("Missing edit transaction id.".into());
    }

    let connection = open_app_db(app)?;
    upsert_kv(
        &connection,
        &edit_transaction_snapshot_key(&snapshot.transaction_id),
        payload,
    )?;
    Ok(serde_json::json!({
        "transactionId": snapshot.transaction_id,
        "stored": true,
    }))
}

fn load_edit_transaction_snapshot<R: Runtime>(
    app: &tauri::AppHandle<R>,
    transaction_id: &str,
) -> Result<EditTransactionSnapshot, String> {
    let connection = open_app_db(app)?;
    let raw: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_kv WHERE key = ?1",
            params![edit_transaction_snapshot_key(transaction_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load edit transaction snapshot: {error}"))?;
    let value = parse_json_column(raw);
    serde_json::from_value(value)
        .map_err(|error| format!("Invalid stored edit transaction snapshot: {error}"))
}

fn write_edit_snapshot_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;
    }
    fs::write(path, content)
        .map_err(|error| format!("Failed to write file {}: {error}", path.display()))
}

fn remove_edit_snapshot_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove directory {}: {error}", path.display()))
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove file {}: {error}", path.display()))
    }
}

fn apply_edit_snapshot_change(
    change: &EditSnapshotChange,
    target_after: bool,
) -> Result<(), String> {
    let source_path = PathBuf::from(&change.path);
    let destination_path = change.destination_path.as_ref().map(PathBuf::from);
    let old_content = change.old_content.as_deref().unwrap_or("");
    let new_content = change.new_content.as_deref().unwrap_or("");

    match (change.kind.as_str(), target_after) {
        ("add", true) => write_edit_snapshot_file(&source_path, new_content),
        ("add", false) => remove_edit_snapshot_file(&source_path),
        ("delete", true) => remove_edit_snapshot_file(&source_path),
        ("delete", false) => write_edit_snapshot_file(&source_path, old_content),
        ("move", true) => {
            let destination = destination_path
                .as_ref()
                .ok_or_else(|| "Move snapshot is missing destinationPath.".to_string())?;
            write_edit_snapshot_file(destination, new_content)?;
            remove_edit_snapshot_file(&source_path)
        }
        ("move", false) => {
            if let Some(destination) = destination_path.as_ref() {
                remove_edit_snapshot_file(destination)?;
            }
            write_edit_snapshot_file(&source_path, old_content)
        }
        (_, true) => write_edit_snapshot_file(&source_path, new_content),
        (_, false) => write_edit_snapshot_file(&source_path, old_content),
    }
}

fn apply_edit_transaction_snapshot(
    snapshot: &EditTransactionSnapshot,
    target_after: bool,
) -> Result<(), String> {
    if target_after {
        for change in &snapshot.changes {
            apply_edit_snapshot_change(change, true)?;
        }
    } else {
        for change in snapshot.changes.iter().rev() {
            apply_edit_snapshot_change(change, false)?;
        }
    }
    Ok(())
}

fn load_settings_value<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    let connection = open_app_db(app)?;
    let settings_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_kv WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load settings from SQLite: {error}"))?;
    Ok(parse_json_column(settings_json))
}

fn emit_settings_updated<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    app.emit("settings:updated", ())
        .map_err(|error| format!("Failed to emit settings update event: {error}"))
}

fn handle_bridge_app_action<R: Runtime>(
    app: &tauri::AppHandle<R>,
    action: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match action {
        "get_settings" => load_settings_value(app),
        "set_settings" => {
            let settings = payload
                .get("settings")
                .cloned()
                .ok_or_else(|| "Missing settings payload.".to_string())?;
            let connection = open_app_db(app)?;
            upsert_kv(&connection, "settings", &settings)?;
            emit_settings_updated(app)?;
            Ok(settings)
        }
        "record_edit_transaction_snapshot" => store_edit_transaction_snapshot(app, payload),
        "record_work_memory" => {
            let memory_payload = payload.get("memory").unwrap_or(payload);
            store_work_memory(app, memory_payload)
        }
        "ensure_aura_home" => {
            let aura = ensure_aura_layout(app)?;
            serde_json::to_value(aura)
                .map_err(|error| format!("Failed to serialize Aura state: {error}"))
        }
        _ => Err(format!("Unsupported app action: {action}")),
    }
}

fn resolve_aura_relative_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let sanitized = relative_path.trim().trim_start_matches('/');
    if sanitized.is_empty() {
        return Err("Aura relative path must not be empty.".into());
    }

    let candidate = ensure_aura_layout(app)?.home_dir;
    let candidate = PathBuf::from(candidate).join(sanitized);
    let aura_home = resolve_aura_home()?;

    if candidate
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Parent directory traversal is not allowed in Aura paths.".into());
    }

    if !candidate.starts_with(&aura_home) {
        return Err("Aura path escapes the configured Aura home directory.".into());
    }

    Ok(candidate)
}

fn ignored_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo"
    )
}

fn read_workspace_node(path: &PathBuf, depth: usize) -> Result<WorkspaceNode, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to read metadata for {}: {error}", path.display()))?;
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.clone())
        .display()
        .to_string();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| canonical.clone());

    if metadata.is_file() {
        return Ok(WorkspaceNode {
            name,
            path: canonical,
            kind: "file".into(),
            children: Vec::new(),
        });
    }

    let mut children = Vec::new();
    if depth < 3 {
        let entries = fs::read_dir(path)
            .map_err(|error| format!("Failed to read directory {}: {error}", path.display()))?;
        for entry in entries.flatten().take(80) {
            let child_path = entry.path();
            let child_name = child_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            if child_name.starts_with('.') || ignored_name(&child_name) {
                continue;
            }
            if let Ok(child_node) = read_workspace_node(&child_path, depth + 1) {
                children.push(child_node);
            }
        }
        children.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .reverse()
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
    }

    Ok(WorkspaceNode {
        name,
        path: canonical,
        kind: "directory".into(),
        children,
    })
}

fn resolve_bridge_script_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    script_name: &str,
) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let dev_bridge =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../bridge/{script_name}"));
        if dev_bridge.exists() {
            return dev_bridge
                .canonicalize()
                .map_err(|error| format!("Failed to canonicalize bridge path: {error}"));
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource directory: {error}"))?;

    for relative_path in [
        format!("dist-bridge/{script_name}"),
        format!("bridge/{script_name}"),
    ] {
        let bundled_bridge = resource_dir.join(relative_path);
        if bundled_bridge.exists() {
            return Ok(PathBuf::from(
                bundled_bridge
                    .strip_prefix(&resource_dir)
                    .unwrap_or(&bundled_bridge),
            ));
        }
    }

    Err("Unable to locate the bundled Node bridge script. Make sure `pnpm build:bridge` ran before packaging.".into())
}

fn resolve_bridge_cwd<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        if dev_root.exists() {
            return dev_root
                .canonicalize()
                .map_err(|error| format!("Failed to resolve desktop app root in dev: {error}"));
        }
    }

    app.path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource directory for bridge CWD: {error}"))
}

/// Resolve the full path to the `node` binary.
/// When launched from Finder/Launchpad, macOS gives a minimal PATH that
/// doesn't include Homebrew, nvm, fnm, volta, etc. We probe common locations.
fn resolve_node_binary() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let candidates = [
        // Homebrew Apple Silicon
        "/opt/homebrew/bin/node",
        // Homebrew Intel
        "/usr/local/bin/node",
        // System
        "/usr/bin/node",
    ];

    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }

    // nvm
    let nvm_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = fs::read_dir(&nvm_dir) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.join("bin/node").exists())
            .collect();
        versions.sort();
        if let Some(latest) = versions.last() {
            return latest.join("bin/node").display().to_string();
        }
    }

    // fnm
    let fnm_dir = format!("{}/.local/share/fnm/node-versions", home);
    if let Ok(entries) = fs::read_dir(&fnm_dir) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("installation"))
            .filter(|p| p.join("bin/node").exists())
            .collect();
        versions.sort();
        if let Some(latest) = versions.last() {
            return latest.join("bin/node").display().to_string();
        }
    }

    // volta
    let volta_node = format!("{}/.volta/bin/node", home);
    if Path::new(&volta_node).exists() {
        return volta_node;
    }

    // Fallback — hope it's on PATH
    "node".to_string()
}

fn find_executable_on_path(path_value: &OsString, executable_name: &str) -> Option<PathBuf> {
    for entry in std::env::split_paths(path_value) {
        let candidate = entry.join(executable_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_node_binary_from_path(path_value: &OsString) -> String {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    find_executable_on_path(path_value, executable_name)
        .map(|path| path.display().to_string())
        .unwrap_or_else(resolve_node_binary)
}

/// Build an augmented PATH that includes common Node.js install locations.
/// This ensures child processes can also find npx, npm, etc.
fn resolve_user_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }

    if let Some(profile) = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(profile));
    }

    let home_drive = std::env::var_os("HOMEDRIVE").filter(|value| !value.is_empty());
    let home_path = std::env::var_os("HOMEPATH").filter(|value| !value.is_empty());
    match (home_drive, home_path) {
        (Some(drive), Some(path)) => {
            let mut combined = PathBuf::from(drive);
            combined.push(path);
            Some(combined)
        }
        _ => None,
    }
}

fn build_augmented_path() -> OsString {
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let mut extra_dirs: Vec<PathBuf> = Vec::new();

    if let Some(home) = resolve_user_home_dir() {
        extra_dirs.push(home.join(".aura").join("bin"));
        extra_dirs.push(home.join(".local").join("bin"));
        extra_dirs.push(home.join(".cargo").join("bin"));
        extra_dirs.push(home.join(".bun").join("bin"));

        if cfg!(windows) {
            extra_dirs.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("nodejs"),
            );
            extra_dirs.push(home.join("AppData").join("Roaming").join("npm"));
        }

        let nvm_dir = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.join("bin")
                        .join(if cfg!(windows) { "node.exe" } else { "node" })
                        .exists()
                })
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                extra_dirs.push(latest.join("bin"));
            }
        }

        let fnm_dir = home
            .join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions");
        if let Ok(entries) = fs::read_dir(&fnm_dir) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path().join("installation"))
                .filter(|p| {
                    p.join("bin")
                        .join(if cfg!(windows) { "node.exe" } else { "node" })
                        .exists()
                })
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                extra_dirs.push(latest.join("bin"));
            }
        }

        let volta_bin = home.join(".volta").join("bin");
        if volta_bin.exists() {
            extra_dirs.push(volta_bin);
        }
    }

    if cfg!(windows) {
        if let Some(program_files) =
            std::env::var_os("ProgramFiles").filter(|value| !value.is_empty())
        {
            extra_dirs.push(PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(program_files_x86) =
            std::env::var_os("ProgramFiles(x86)").filter(|value| !value.is_empty())
        {
            extra_dirs.push(PathBuf::from(program_files_x86).join("nodejs"));
        }
        if let Some(local_app_data) =
            std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty())
        {
            extra_dirs.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("nodejs"),
            );
        }
    } else {
        extra_dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/Library/Apple/usr/bin"),
            PathBuf::from("/System/Cryptexes/App/usr/bin"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources"),
        ]);
    }

    let mut merged_paths: Vec<PathBuf> = extra_dirs
        .into_iter()
        .filter(|path| path.exists())
        .collect();
    merged_paths.extend(std::env::split_paths(&current_path));

    std::env::join_paths(merged_paths).unwrap_or(current_path)
}

fn node_runtime_label() -> String {
    if cfg!(debug_assertions) {
        resolve_node_binary()
    } else {
        "sidecar:node".into()
    }
}

fn bridge_launch_log_details<R: Runtime>(
    app: &tauri::AppHandle<R>,
    operation: &str,
    bridge_cwd: &Path,
    script_path: &Path,
    augmented_path: &OsString,
) -> serde_json::Value {
    let resolved_script_path = if script_path.is_absolute() {
        script_path.to_path_buf()
    } else {
        bridge_cwd.join(script_path)
    };
    let path_entries: Vec<PathBuf> = std::env::split_paths(augmented_path).collect();
    let path_sample: Vec<String> = path_entries
        .iter()
        .take(8)
        .map(|path| path.display().to_string())
        .collect();

    serde_json::json!({
        "operation": operation,
        "runtimeMode": if cfg!(debug_assertions) { "debug" } else { "release" },
        "nodeRuntime": node_runtime_label(),
        "nodeRuntimeFallback": if cfg!(debug_assertions) {
            None::<String>
        } else {
            Some(format!("system:{}", resolve_node_binary_from_path(augmented_path)))
        },
        "bridgeCwd": bridge_cwd.display().to_string(),
        "bridgeCwdExists": bridge_cwd.exists(),
        "resourceDir": app.path().resource_dir().ok().map(|path| path.display().to_string()),
        "scriptArg": script_path.display().to_string(),
        "scriptIsRelative": !script_path.is_absolute(),
        "scriptResolvedPath": resolved_script_path.display().to_string(),
        "scriptExists": resolved_script_path.exists(),
        "scriptParentExists": resolved_script_path.parent().map(|path| path.exists()),
        "cwdHasDistBridge": bridge_cwd.join("dist-bridge").exists(),
        "cwdHasBridgeDir": bridge_cwd.join("bridge").exists(),
        "pathEntryCount": path_entries.len(),
        "pathEntrySample": path_sample,
        "pathPreview": truncate_log_value(augmented_path.to_string_lossy().into_owned(), 240),
    })
}

fn format_node_launch_error(error: &std::io::Error) -> String {
    if cfg!(debug_assertions) {
        let node_bin = resolve_node_binary();
        format!("Failed to spawn Node bridge. Is node installed?\nTried: {node_bin}\n\n{error}")
    } else {
        format!("Failed to spawn bundled Node bridge runtime: {error}")
    }
}

fn build_system_node_command(bridge_cwd: &Path, augmented_path: &OsString) -> Command {
    let node_bin = resolve_node_binary_from_path(augmented_path);
    let mut command = Command::new(&node_bin);
    command.current_dir(bridge_cwd);
    command.env("PATH", augmented_path);
    command
}

fn build_primary_node_command<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bridge_cwd: &Path,
    augmented_path: &OsString,
) -> Result<Command, String> {
    let mut command = if cfg!(debug_assertions) {
        let node_bin = resolve_node_binary();
        Command::new(&node_bin)
    } else {
        app.shell()
            .sidecar("node")
            .map(Command::from)
            .map_err(|error| format!("Failed to resolve bundled Node runtime: {error}"))?
    };
    command.current_dir(bridge_cwd);
    command.env("PATH", augmented_path);
    Ok(command)
}

fn should_attempt_system_node_fallback(_error: &std::io::Error) -> bool {
    !cfg!(debug_assertions)
}

fn fallback_node_launch_message(primary_message: &str, fallback_error: &std::io::Error) -> String {
    format!(
        "{primary_message}\nFallback to system Node also failed: {fallback_error}"
    )
}

fn spawn_node_command_with_fallback<R, F>(
    app: &tauri::AppHandle<R>,
    bridge_cwd: &Path,
    augmented_path: &OsString,
    configure: F,
) -> Result<(std::process::Child, bool), String>
where
    R: Runtime,
    F: Fn(&mut Command),
{
    let primary_error = match build_primary_node_command(app, bridge_cwd, augmented_path) {
        Ok(mut command) => {
            configure(&mut command);
            match command.spawn() {
                Ok(child) => return Ok((child, false)),
                Err(error) => {
                    if !should_attempt_system_node_fallback(&error) {
                        return Err(format_node_launch_error(&error));
                    }
                    format_node_launch_error(&error)
                }
            }
        }
        Err(error) => {
            if cfg!(debug_assertions) {
                return Err(error);
            }
            error
        }
    };

    let mut fallback = build_system_node_command(bridge_cwd, augmented_path);
    configure(&mut fallback);
    fallback
        .spawn()
        .map(|child| (child, true))
        .map_err(|error| fallback_node_launch_message(&primary_error, &error))
}

fn output_node_command_with_fallback<R, F>(
    app: &tauri::AppHandle<R>,
    bridge_cwd: &Path,
    augmented_path: &OsString,
    configure: F,
) -> Result<(std::process::Output, bool), String>
where
    R: Runtime,
    F: Fn(&mut Command),
{
    let primary_error = match build_primary_node_command(app, bridge_cwd, augmented_path) {
        Ok(mut command) => {
            configure(&mut command);
            match command.output() {
                Ok(output) => return Ok((output, false)),
                Err(error) => {
                    if !should_attempt_system_node_fallback(&error) {
                        return Err(format_node_launch_error(&error));
                    }
                    format_node_launch_error(&error)
                }
            }
        }
        Err(error) => {
            if cfg!(debug_assertions) {
                return Err(error);
            }
            error
        }
    };

    let mut fallback = build_system_node_command(bridge_cwd, augmented_path);
    configure(&mut fallback);
    fallback
        .output()
        .map(|output| (output, true))
        .map_err(|error| fallback_node_launch_message(&primary_error, &error))
}

fn with_snapshot<F>(snapshot: &Arc<Mutex<AgentTaskSnapshot>>, mutator: F)
where
    F: FnOnce(&mut AgentTaskSnapshot),
{
    if let Ok(mut guard) = snapshot.lock() {
        mutator(&mut guard);
    }
}

fn extract_array(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    value
        .and_then(|entry| entry.as_array().cloned())
        .unwrap_or_default()
}

fn extract_object(value: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    value.and_then(|entry| entry.as_object().cloned().map(serde_json::Value::Object))
}

fn is_terminal_task_status(status: &str) -> bool {
    status == "completed" || status == "failed"
}

fn parse_task_sequence(task_id: &str) -> u64 {
    task_id
        .strip_prefix("task-")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn prune_terminal_task_snapshots(tasks: &mut HashMap<String, AgentTaskHandle>) {
    let mut terminal_tasks: Vec<(String, u64)> = tasks
        .iter()
        .filter_map(|(task_id, handle)| {
            let snapshot = handle.snapshot.lock().ok()?;
            if is_terminal_task_status(&snapshot.status) {
                Some((task_id.clone(), parse_task_sequence(task_id)))
            } else {
                None
            }
        })
        .collect();

    if terminal_tasks.len() <= MAX_TERMINAL_TASK_SNAPSHOTS {
        return;
    }

    terminal_tasks.sort_by_key(|(_, sequence)| *sequence);
    let remove_count = terminal_tasks.len() - MAX_TERMINAL_TASK_SNAPSHOTS;
    for (task_id, _) in terminal_tasks.into_iter().take(remove_count) {
        tasks.remove(&task_id);
    }
}

fn spawn_child_reaper(child: Arc<Mutex<Option<std::process::Child>>>) {
    std::thread::spawn(move || loop {
        let should_stop = {
            let Ok(mut guard) = child.lock() else {
                return;
            };
            let Some(child) = guard.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    true
                }
                Ok(None) => false,
                Err(_) => {
                    *guard = None;
                    true
                }
            }
        };

        if should_stop {
            return;
        }

        std::thread::sleep(std::time::Duration::from_millis(1_000));
    });
}

fn truncate_snapshot_text(value: &str, max_chars: usize) -> String {
    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return value.to_string();
    }

    let marker_chars = SNAPSHOT_TRUNCATION_MARKER.chars().count();
    if max_chars <= marker_chars + 2 {
        return value.chars().take(max_chars).collect();
    }

    let available_chars = max_chars - marker_chars;
    let head_chars = (available_chars * 7) / 10;
    let tail_chars = available_chars - head_chars;
    let head: String = value.chars().take(head_chars).collect();
    let tail: String = value
        .chars()
        .skip(total_chars.saturating_sub(tail_chars))
        .collect();
    format!("{head}{SNAPSHOT_TRUNCATION_MARKER}{tail}")
}

fn append_snapshot_delta(current: &str, delta: &str, max_chars: usize) -> String {
    if current.is_empty() {
        return truncate_snapshot_text(delta, max_chars);
    }

    let mut combined = String::with_capacity(current.len() + delta.len());
    combined.push_str(current);
    combined.push_str(delta);
    truncate_snapshot_text(&combined, max_chars)
}

fn append_reasoning_delta(current: &mut AgentTaskSnapshot, event: &serde_json::Value) {
    let delta = event
        .get("delta")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if delta.is_empty() {
        return;
    }

    let block_id = event
        .get("blockId")
        .and_then(|value| value.as_str())
        .unwrap_or("provider");
    let kind = event
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("provider");
    let order = event.get("order").and_then(|value| value.as_f64());
    let created_at = event
        .get("createdAt")
        .and_then(|value| value.as_u64())
        .unwrap_or_else(current_timestamp_ms);

    if let Some(existing) = current.reasoning.iter_mut().find(|block| {
        block
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == block_id)
            .unwrap_or(false)
    }) {
        let existing_created_at = existing
            .get("createdAt")
            .and_then(|value| value.as_u64())
            .unwrap_or(created_at);
        let next_content = append_snapshot_delta(
            existing
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            delta,
            MAX_REASONING_CHARS,
        );
        *existing = serde_json::json!({
            "id": block_id,
            "kind": kind,
            "content": next_content,
            "order": order,
            "createdAt": existing_created_at,
        });
        return;
    }

    current.reasoning.push(serde_json::json!({
        "id": block_id,
        "kind": kind,
        "content": truncate_snapshot_text(delta, MAX_REASONING_CHARS),
        "order": order,
        "createdAt": created_at,
    }));
}

fn discard_reasoning_block(
    current: &mut AgentTaskSnapshot,
    event: &serde_json::Value,
) -> Option<String> {
    let block_id = event.get("blockId").and_then(|value| value.as_str())?;
    let before_len = current.reasoning.len();
    current.reasoning.retain(|block| {
        block
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value != block_id)
            .unwrap_or(true)
    });

    if current.reasoning.len() == before_len {
        None
    } else {
        Some(block_id.to_string())
    }
}

fn reasoning_blocks_log_summary(reasoning: &[serde_json::Value]) -> serde_json::Value {
    serde_json::Value::Array(
        reasoning
            .iter()
            .map(|block| {
                let content = block
                    .get("content")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                serde_json::json!({
                    "stepId": block.get("id").and_then(|value| value.as_str()),
                    "reasoningStepId": block.get("id").and_then(|value| value.as_str()),
                    "kind": block.get("kind").and_then(|value| value.as_str()),
                    "order": block.get("order").and_then(|value| value.as_f64()),
                    "createdAt": block.get("createdAt").and_then(|value| value.as_u64()),
                    "contentChars": content.chars().count(),
                    "contentPreview": truncate_snapshot_text(content, MAX_LOG_DELTA_CHARS),
                })
            })
            .collect(),
    )
}

fn append_phase_output_delta(current: &mut AgentTaskSnapshot, event: &serde_json::Value) {
    let delta = event
        .get("delta")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if delta.is_empty() {
        return;
    }

    let block_id = event
        .get("blockId")
        .and_then(|value| value.as_str())
        .unwrap_or("provider");
    let order = event.get("order").and_then(|value| value.as_u64());
    let output_id = format!("phase-{block_id}");

    if let Some(existing) = current.phase_outputs.iter_mut().find(|output| {
        output
            .get("blockId")
            .and_then(|value| value.as_str())
            .map(|value| value == block_id)
            .unwrap_or(false)
    }) {
        let next_content = append_snapshot_delta(
            existing
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            delta,
            MAX_PHASE_OUTPUT_CHARS,
        );
        *existing = serde_json::json!({
            "id": output_id,
            "blockId": block_id,
            "content": next_content,
            "order": order,
        });
        return;
    }

    current.phase_outputs.push(serde_json::json!({
        "id": output_id,
        "blockId": block_id,
        "content": truncate_snapshot_text(delta, MAX_PHASE_OUTPUT_CHARS),
        "order": order,
    }));
}

fn merge_tool_event(current: &mut AgentTaskSnapshot, tool_event: &serde_json::Value) {
    let event_id = tool_event
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    if event_id.is_empty() {
        current.tool_events.push(tool_event.clone());
        return;
    }

    if let Some(existing) = current.tool_events.iter_mut().find(|event| {
        event
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == event_id)
            .unwrap_or(false)
    }) {
        *existing = tool_event.clone();
        return;
    }

    current.tool_events.push(tool_event.clone());
}

fn clear_retry_progress_if_connected(current: &mut AgentTaskSnapshot) {
    let Some(retry_info) = current.retry_info.as_mut() else {
        return;
    };
    let Some(retry_object) = retry_info.as_object_mut() else {
        return;
    };
    if retry_object
        .get("inProgress")
        .and_then(|value| value.as_bool())
        != Some(true)
    {
        return;
    }
    retry_object.insert("inProgress".into(), serde_json::Value::Bool(false));
    retry_object.remove("nextRetryDelayMs");
    retry_object.remove("nextAttemptNumber");
}

fn merge_work_memory(current: &mut AgentTaskSnapshot, memory: &serde_json::Value) {
    let memory_id = memory
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    if memory_id.is_empty() {
        current.work_memories.push(memory.clone());
        return;
    }

    if let Some(existing) = current.work_memories.iter_mut().find(|entry| {
        entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == memory_id)
            .unwrap_or(false)
    }) {
        *existing = memory.clone();
        return;
    }

    current.work_memories.push(memory.clone());
}

fn spawn_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    store: &AgentTaskStore,
    payload: serde_json::Value,
) -> Result<String, String> {
    let task_id = create_task_id();
    let mut payload = payload;
    if let Some(payload_object) = payload.as_object_mut() {
        let log_context = payload_object
            .entry("logContext")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(log_context_object) = log_context.as_object_mut() {
            log_context_object.insert(
                "taskId".into(),
                serde_json::Value::String(task_id.clone()),
            );
        }
    }
    let log_context = agent_log_context_details(&task_id, &payload);
    let bridge_path = resolve_bridge_script_path(&app, "ipc.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let augmented_path = build_augmented_path();
    let launch_details = bridge_launch_log_details(
        &app,
        "start_agent_task",
        &bridge_cwd,
        &bridge_path,
        &augmented_path,
    );
    let launch_details_for_error = launch_details.clone();
    append_app_log(
        &app,
        "info",
        "bridge_launch_prepared",
        agent_log_details(&log_context, serde_json::json!({
            "launch": launch_details.clone(),
        })),
    );
    let (mut child, used_system_node_fallback) = spawn_node_command_with_fallback(
        &app,
        &bridge_cwd,
        &augmented_path,
        |command| {
            command
                .arg(&bridge_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        },
    )
    .map_err(|message| {
            append_app_log(
                &app,
                "error",
                "bridge_launch_failed",
                agent_log_details(&log_context, serde_json::json!({
                    "error": message,
                    "launch": launch_details_for_error.clone(),
                })),
            );
            message
    })?;
    if used_system_node_fallback {
        append_app_log(
            &app,
            "warn",
            "bridge_launch_system_node_fallback_used",
            agent_log_details(&log_context, serde_json::json!({
                "launch": launch_details.clone(),
            })),
        );
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture Node bridge stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Node bridge stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Node bridge stderr.".to_string())?;

    append_app_log(
        &app,
        "info",
        "agent_task_spawned",
        serde_json::json!({
            "task": agent_payload_log_details(&task_id, &payload),
            "launch": launch_details,
        }),
    );
    let snapshot = Arc::new(Mutex::new(AgentTaskSnapshot {
        id: task_id.clone(),
        status: "queued".into(),
        message: None,
        phase_outputs: Vec::new(),
        tool_events: Vec::new(),
        appended_inputs: Vec::new(),
        task_tree: Vec::new(),
        reasoning: Vec::new(),
        work_memories: Vec::new(),
        usage: None,
        context_compression: None,
        capability_snapshot: None,
        agent_mode: None,
        route_decision: None,
        completion_state: None,
        evidence_summary: None,
        delivery_note: None,
        retry_info: None,
        phase: Some("preparing".into()),
        phase_started_at: None,
        last_heartbeat_at: None,
        last_progress_at: None,
        stalled: Some(false),
        pending_approval: None,
        pending_user_input: None,
        error: None,
        error_info: None,
        error_code: None,
        error_source: None,
        raw_error: None,
    }));

    let child_handle = Arc::new(Mutex::new(Some(child)));
    spawn_child_reaper(child_handle.clone());

    let handle = AgentTaskHandle {
        child: child_handle,
        stdin: Arc::new(Mutex::new(stdin)),
        snapshot: snapshot.clone(),
        log_context: log_context.clone(),
    };

    {
        let mut tasks = store
            .tasks
            .lock()
            .map_err(|_| "Failed to lock task store.".to_string())?;
        tasks.insert(task_id.clone(), handle.clone());
        prune_terminal_task_snapshots(&mut tasks);
    }

    // 共享 stderr 缓冲区：stderr 线程写入，stdout 线程退出时读取
    let stderr_buffer_for_stderr: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = stderr_buffer_for_stderr.clone();

    let stdout_snapshot = snapshot.clone();
    let stdout_stdin = handle.stdin.clone();
    let stdout_app = app.clone();
    let stdout_log_app = app.clone();
    let stdout_log_context = log_context.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_logged_phase: Option<String> = None;
        let mut logged_running_tools: HashSet<String> = HashSet::new();
        let mut logged_reasoning_blocks: HashSet<String> = HashSet::new();
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                append_app_log(
                    &stdout_log_app,
                    "error",
                    "bridge_event_parse_failed",
                    agent_log_details(&stdout_log_context, serde_json::json!({
                        "line": line,
                    })),
                );
                with_snapshot(&stdout_snapshot, |current| {
                    current.status = "failed".into();
                    current.error = Some(format!("Failed to parse bridge event: {line}"));
                });
                break;
            };

            match event.get("type").and_then(|value| value.as_str()) {
                Some("started") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_task_started",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.status = "running".into();
                    current.phase = Some("preparing".into());
                    current.error = None;
                    current.error_code = None;
                    current.error_source = None;
                    current.raw_error = None;
                }),
                Some("text_delta") => with_snapshot(&stdout_snapshot, |current| {
                    let delta = event
                        .get("delta")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    if delta.is_empty() {
                        return;
                    }
                    clear_retry_progress_if_connected(current);
                    match event.get("target").and_then(|value| value.as_str()) {
                        Some("phase") => {
                            append_app_log(
                                &stdout_log_app,
                                "info",
                                "agent_phase_output_delta",
                                event_log_details(&stdout_log_context, &event),
                            );
                            append_phase_output_delta(current, &event)
                        }
                        _ => {
                            let mut next_message = current.message.clone().unwrap_or_default();
                            next_message.push_str(delta);
                            current.message = Some(next_message);
                        }
                    }
                }),
                Some("reasoning_delta") => with_snapshot(&stdout_snapshot, |current| {
                    clear_retry_progress_if_connected(current);
                    let reasoning_step_id = event_step_id(&event)
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "reasoning".to_string());
                    if logged_reasoning_blocks.insert(reasoning_step_id) {
                        append_app_log(
                            &stdout_log_app,
                            "info",
                            "agent_reasoning_started",
                            event_log_details(&stdout_log_context, &event),
                        );
                    }
                    append_reasoning_delta(current, &event);
                }),
                Some("reasoning_discard") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "warn",
                        "agent_reasoning_discarded",
                        event_log_details(&stdout_log_context, &event),
                    );
                    if let Some(reasoning_step_id) = discard_reasoning_block(current, &event) {
                        logged_reasoning_blocks.remove(&reasoning_step_id);
                    }
                }),
                Some("usage") => with_snapshot(&stdout_snapshot, |current| {
                    current.usage = extract_object(event.get("usage"));
                }),
                Some("context_compression") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_context_compression",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.context_compression = extract_object(event.get("contextCompression"));
                }),
                Some("retry_progress") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "warn",
                        "agent_retry_progress",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.retry_info = extract_object(event.get("retryInfo"));
                }),
                Some("runtime_log") => with_snapshot(&stdout_snapshot, |_current| {
                    let runtime_event = event.get("event").unwrap_or(&serde_json::Value::Null);
                    let event_name = runtime_event
                        .get("event")
                        .and_then(|value| value.as_str())
                        .unwrap_or("agent.runtime_log");
                    let level = runtime_event
                        .get("level")
                        .and_then(|value| value.as_str())
                        .unwrap_or("info");
                    let details = runtime_event
                        .get("details")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    if let Err(error) = persist_agent_runtime_log(&stdout_log_app, runtime_event) {
                        append_app_log(
                            &stdout_log_app,
                            "warn",
                            "agent_run_persist_failed",
                            agent_log_details(&stdout_log_context, serde_json::json!({
                                "runtimeEvent": event_name,
                                "error": error,
                            })),
                        );
                    }
                    append_app_log(
                        &stdout_log_app,
                        normalize_app_log_level(Some(level.to_string())),
                        event_name,
                        agent_log_details(&stdout_log_context, details),
                    );
                }),
                Some("tool_event") => with_snapshot(&stdout_snapshot, |current| {
                    clear_retry_progress_if_connected(current);
                    let tool_event = event.get("event").unwrap_or(&serde_json::Value::Null);
                    let tool_status = tool_event
                        .get("status")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    let should_log_tool_event = if tool_status == "running" {
                        tool_event
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(|id| logged_running_tools.insert(id.to_string()))
                            .unwrap_or(true)
                    } else {
                        true
                    };
                    if should_log_tool_event {
                        append_app_log(
                            &stdout_log_app,
                            if tool_status == "error" {
                                "error"
                            } else {
                                "info"
                            },
                            "agent_tool_event",
                            event_log_details(&stdout_log_context, &event),
                        );
                    }
                    if let Some(tool_event) = event.get("event") {
                        merge_tool_event(current, tool_event);
                    }
                }),
                Some("work_memory") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_work_memory_recorded",
                        event_log_details(&stdout_log_context, &event),
                    );
                    if let Some(memory) = event.get("memory") {
                        merge_work_memory(current, memory);
                    }
                }),
                Some("appended_inputs") => with_snapshot(&stdout_snapshot, |current| {
                    current.appended_inputs = extract_array(event.get("inputs"));
                }),
                Some("task_tree") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_task_tree_updated",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.task_tree = extract_array(event.get("tree"));
                }),
                Some("route_decision") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_route_decision",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.route_decision = extract_object(event.get("routeDecision"));
                }),
                Some("runtime_status") => with_snapshot(&stdout_snapshot, |current| {
                    let next_phase = event
                        .get("phase")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    let stalled = event
                        .get("stalled")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);
                    if stalled || next_phase != last_logged_phase {
                        append_app_log(
                            &stdout_log_app,
                            if stalled { "warn" } else { "info" },
                            "agent_runtime_status",
                            event_log_details(&stdout_log_context, &event),
                        );
                        last_logged_phase = next_phase.clone();
                    }
                    current.phase = event
                        .get("phase")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    if matches!(
                        current.phase.as_deref(),
                        Some("model_streaming")
                            | Some("tool_running")
                            | Some("finalizing")
                            | Some("recovering")
                    ) {
                        clear_retry_progress_if_connected(current);
                    }
                    current.phase_started_at =
                        event.get("phaseStartedAt").and_then(|value| value.as_u64());
                    current.last_heartbeat_at = event
                        .get("lastHeartbeatAt")
                        .and_then(|value| value.as_u64());
                    current.last_progress_at =
                        event.get("lastProgressAt").and_then(|value| value.as_u64());
                    current.stalled = event.get("stalled").and_then(|value| value.as_bool());
                }),
                Some("approval_required") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_approval_required",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.status = "awaiting_approval".into();
                    current.phase = Some("awaiting_approval".into());
                    current.pending_approval = event.get("request").cloned();
                    current.pending_user_input = None;
                }),
                Some("user_input_required") => with_snapshot(&stdout_snapshot, |current| {
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_user_input_required",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.status = "awaiting_user_input".into();
                    current.phase = Some("awaiting_user_input".into());
                    current.pending_approval = None;
                    current.pending_user_input = event.get("request").cloned();
                }),
                Some("app_action_request") => {
                    let request_id = event
                        .get("requestId")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if request_id.is_empty() {
                        continue;
                    }

                    let action = event
                        .get("action")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let payload = event
                        .get("payload")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);

                    let response = match handle_bridge_app_action(&stdout_app, &action, &payload) {
                        Ok(result) => serde_json::json!({
                            "type": "app_action_result",
                            "requestId": request_id,
                            "ok": true,
                            "result": result,
                        }),
                        Err(error) => serde_json::json!({
                            "type": "app_action_result",
                            "requestId": request_id,
                            "ok": false,
                            "error": error,
                        }),
                    };

                    if let Ok(mut stdin) = stdout_stdin.lock() {
                        let serialized = serde_json::to_string(&response).unwrap_or_else(|_| {
                            "{\"type\":\"app_action_result\",\"ok\":false,\"error\":\"Failed to serialize app action result.\"}".into()
                        });
                        let _ = writeln!(stdin, "{serialized}");
                    }
                }
                Some("completed") => with_snapshot(&stdout_snapshot, |current| {
                    let previous_reasoning = current.reasoning.clone();
                    append_app_log(
                        &stdout_log_app,
                        "info",
                        "agent_task_completed",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.status = "completed".into();
                    current.pending_approval = None;
                    current.pending_user_input = None;
                    if let Some(result) = event.get("result") {
                        let next_message = result
                            .get("message")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        let should_replace_message = next_message
                            .as_ref()
                            .map(|value| {
                                let normalized = value.trim();
                                !normalized.is_empty() && normalized != "模型没有返回文本内容。"
                            })
                            .unwrap_or(false);
                        if should_replace_message {
                            current.message = next_message;
                        }
                        current.tool_events = extract_array(result.get("toolEvents"));
                        current.task_tree = extract_array(result.get("taskTree"));
                        current.reasoning = extract_array(result.get("reasoning"));
                        let work_memories = extract_array(result.get("workMemories"));
                        if !work_memories.is_empty() {
                            current.work_memories = work_memories;
                        }
                        current.usage = extract_object(result.get("usage"));
                        if let Some(context_compression) =
                            extract_object(result.get("contextCompression"))
                        {
                            current.context_compression = Some(context_compression);
                        }
                        current.capability_snapshot =
                            extract_object(result.get("capabilitySnapshot"));
                        current.agent_mode = result
                            .get("agentMode")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        current.route_decision = extract_object(result.get("routeDecision"));
                        current.completion_state = result
                            .get("completionState")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        current.evidence_summary = extract_object(result.get("evidenceSummary"));
                        current.delivery_note = result
                            .get("deliveryNote")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        current.retry_info = extract_object(result.get("retryInfo"));
                    }
                    let reasoning_summary = reasoning_blocks_log_summary(&current.reasoning);
                    if reasoning_summary
                        .as_array()
                        .map(|entries| !entries.is_empty())
                        .unwrap_or(false)
                    {
                        append_app_log(
                            &stdout_log_app,
                            "info",
                            "agent_reasoning_completed",
                            agent_log_details(
                                &stdout_log_context,
                                serde_json::json!({
                                    "status": "completed",
                                    "blocks": reasoning_summary,
                                    "previousBlockCount": previous_reasoning.len(),
                                }),
                            ),
                        );
                    }
                }),
                Some("failed") => with_snapshot(&stdout_snapshot, |current| {
                    let reasoning_summary = reasoning_blocks_log_summary(&current.reasoning);
                    if reasoning_summary
                        .as_array()
                        .map(|entries| !entries.is_empty())
                        .unwrap_or(false)
                    {
                        append_app_log(
                            &stdout_log_app,
                            "warn",
                            "agent_reasoning_completed",
                            agent_log_details(
                                &stdout_log_context,
                                serde_json::json!({
                                    "status": "failed",
                                    "blocks": reasoning_summary,
                                }),
                            ),
                        );
                    }
                    append_app_log(
                        &stdout_log_app,
                        "error",
                        "agent_task_failed",
                        event_log_details(&stdout_log_context, &event),
                    );
                    current.status = "failed".into();
                    current.pending_approval = None;
                    current.pending_user_input = None;
                    current.error = event
                        .get("message")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.error_info = extract_object(event.get("errorInfo"));
                    current.agent_mode = event
                        .get("agentMode")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.route_decision = extract_object(event.get("routeDecision"));
                    current.completion_state = event
                        .get("completionState")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.evidence_summary = extract_object(event.get("evidenceSummary"));
                    current.delivery_note = event
                        .get("deliveryNote")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.error_code = event
                        .get("code")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.error_source = event
                        .get("source")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.retry_info = extract_object(event.get("retryInfo"));
                    current.raw_error = event
                        .get("rawMessage")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                }),
                _ => {}
            }
        }

        // --- 核心修复：检测管道断开带来的异常退出 ---
        // 短暂等待以确保 stderr 线程也完成了写入
        std::thread::sleep(std::time::Duration::from_millis(100));
        let collected_stderr = stderr_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        with_snapshot(&stdout_snapshot, |current| {
            if current.status == "running"
                || current.status == "queued"
                || current.status == "awaiting_approval"
                || current.status == "awaiting_user_input"
            {
                current.status = "failed".into();
                let stderr_message = collected_stderr.trim().to_string();
                append_app_log(
                    &stdout_log_app,
                    "error",
                    "bridge_process_disconnected",
                    agent_log_details(&stdout_log_context, serde_json::json!({
                        "stderr": stderr_message,
                    })),
                );
                current.error = Some(if stderr_message.is_empty() {
                    "Node 桥接进程已断开。这可能是由于网络错误或脚本执行异常导致的崩溃。".into()
                } else {
                    stderr_message
                });
            }
        });
    });

    let stderr_buf_for_thread = stderr_buffer_for_stderr.clone();
    let stderr_log_app = app.clone();
    let stderr_log_context = log_context.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            append_app_log(
                &stderr_log_app,
                "warn",
                "bridge_stderr",
                agent_log_details(&stderr_log_context, serde_json::json!({
                    "line": line.as_str(),
                })),
            );
            // 实时追加每行 stderr 到共享 buffer，上限 8KB
            if let Ok(mut buf) = stderr_buf_for_thread.lock() {
                if buf.len() < 8192 {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&line);
                }
            }
        }
    });

    let start_message = serde_json::json!({
        "type": "start",
        "payload": payload,
    });

    {
        let mut stdin = handle
            .stdin
            .lock()
            .map_err(|_| "Failed to lock Node bridge stdin.".to_string())?;
        writeln!(
            stdin,
            "{}",
            serde_json::to_string(&start_message)
                .map_err(|error| format!("Failed to serialize start payload: {error}"))?
        )
        .map_err(|error| format!("Failed to write start payload to Node bridge: {error}"))?;
    }

    Ok(task_id)
}

#[tauri::command]
fn write_app_log<R: Runtime>(
    app: tauri::AppHandle<R>,
    level: Option<String>,
    event: String,
    details: serde_json::Value,
) -> Result<(), String> {
    if event.trim().is_empty() {
        return Ok(());
    }
    append_app_log(&app, normalize_app_log_level(level), event.trim(), details);
    Ok(())
}

#[tauri::command]
async fn run_provider_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let script_path = resolve_bridge_script_path(&app, "providerActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let augmented_path = build_augmented_path();
    let launch_details = bridge_launch_log_details(
        &app,
        "run_provider_action",
        &bridge_cwd,
        &script_path,
        &augmented_path,
    );
    append_app_log(
        &app,
        "info",
        "provider_action_started",
        serde_json::json!({
            "request": provider_action_log_details(&payload),
            "launch": launch_details.clone(),
        }),
    );
    let launch_details_for_error = launch_details.clone();
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("Failed to serialize provider action payload: {error}"))?;
    let app_handle = app.clone();
    let payload_for_blocking = payload.clone();
    let (output, used_system_node_fallback) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(std::process::Output, bool), String> {
            output_node_command_with_fallback(
                &app_handle,
                &bridge_cwd,
                &augmented_path,
                |command| {
                    command.arg(&script_path).arg(&payload_json);
                },
            )
            .map_err(|error| {
                let message = format!("Failed to run provider action bridge: {error}");
                append_app_log(
                    &app_handle,
                    "error",
                    "provider_action_launch_failed",
                    serde_json::json!({
                        "request": provider_action_log_details(&payload_for_blocking),
                        "error": message,
                        "launch": launch_details_for_error.clone(),
                    }),
                );
                message
            })
        })
        .await
        .map_err(|error| format!("Failed to join provider action task: {error}"))??;
    if used_system_node_fallback {
        append_app_log(
            &app,
            "warn",
            "provider_action_system_node_fallback_used",
            serde_json::json!({
                "request": provider_action_log_details(&payload),
                "launch": launch_details.clone(),
            }),
        );
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            "Provider action failed.".into()
        } else {
            stderr
        };
        append_app_log(
            &app,
            "error",
            "provider_action_failed",
            serde_json::json!({
                "request": provider_action_log_details(&payload),
                "error": message,
                "launch": launch_details,
            }),
        );
        return Err(message);
    }

    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse provider action response: {error}"))?;
    append_app_log(
        &app,
        "info",
        "provider_action_completed",
        serde_json::json!({
            "request": provider_action_log_details(&payload),
            "launch": launch_details,
            "modelCount": parsed
                .get("models")
                .and_then(|value| value.as_array())
                .map(|value| value.len())
                .unwrap_or(0),
            "message": parsed.get("message").and_then(|value| value.as_str()),
        }),
    );
    Ok(parsed)
}

#[tauri::command]
async fn compress_agent_context<R: Runtime>(
    app: tauri::AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let script_path = resolve_bridge_script_path(&app, "manualContextCompression.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let augmented_path = build_augmented_path();
    let launch_details = bridge_launch_log_details(
        &app,
        "compress_agent_context",
        &bridge_cwd,
        &script_path,
        &augmented_path,
    );
    append_app_log(
        &app,
        "info",
        "context_compression_started",
        serde_json::json!({
            "request": context_compression_log_details(&payload),
            "launch": launch_details.clone(),
        }),
    );
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("Failed to serialize context compression payload: {error}"))?;
    let app_handle = app.clone();
    let launch_details_for_error = launch_details.clone();
    let payload_for_blocking = payload.clone();

    let output =
        tauri::async_runtime::spawn_blocking(move || -> Result<std::process::Output, String> {
            let (mut child, used_system_node_fallback) = spawn_node_command_with_fallback(
                &app_handle,
                &bridge_cwd,
                &augmented_path,
                |command| {
                    command
                        .arg(&script_path)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                },
            )
            .map_err(|error| {
                    let message = format!("Failed to run context compression bridge: {error}");
                    append_app_log(
                        &app_handle,
                        "error",
                        "context_compression_launch_failed",
                        serde_json::json!({
                            "request": context_compression_log_details(&payload_for_blocking),
                            "error": message,
                            "launch": launch_details_for_error.clone(),
                        }),
                    );
                    message
            })?;
            if used_system_node_fallback {
                append_app_log(
                    &app_handle,
                    "warn",
                    "context_compression_system_node_fallback_used",
                    serde_json::json!({
                        "request": context_compression_log_details(&payload_for_blocking),
                        "launch": launch_details_for_error.clone(),
                    }),
                );
            }

            {
                let mut stdin = child.stdin.take().ok_or_else(|| {
                    "Failed to open context compression bridge stdin.".to_string()
                })?;
                stdin.write_all(payload_json.as_bytes()).map_err(|error| {
                    format!("Failed to write context compression payload: {error}")
                })?;
            }

            child
                .wait_with_output()
                .map_err(|error| format!("Failed to read context compression response: {error}"))
        })
        .await
        .map_err(|error| format!("Failed to join context compression task: {error}"))?
        .map_err(|error| format!("Failed to run context compression bridge: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            "Context compression failed.".into()
        } else {
            stderr
        };
        append_app_log(
            &app,
            "error",
            "context_compression_failed",
            serde_json::json!({
                "request": context_compression_log_details(&payload),
                "error": message,
                "launch": launch_details,
            }),
        );
        return Err(message);
    }

    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse context compression response: {error}"))?;
    append_app_log(
        &app,
        "info",
        "context_compression_completed",
        serde_json::json!({
            "request": context_compression_log_details(&payload),
            "result": {
                "ok": parsed.get("ok").and_then(|value| value.as_bool()),
                "message": parsed.get("message").and_then(|value| value.as_str()),
                "originalTokens": parsed.get("originalTokens").and_then(|value| value.as_u64()),
                "compressedTokens": parsed.get("compressedTokens").and_then(|value| value.as_u64()),
                "originalMessageCount": parsed
                    .get("originalMessageCount")
                    .and_then(|value| value.as_u64()),
                "compressedMessageCount": parsed
                    .get("compressedMessageCount")
                    .and_then(|value| value.as_u64()),
                "keptRecentCount": parsed.get("keptRecentCount").and_then(|value| value.as_u64()),
            },
            "launch": launch_details,
        }),
    );
    Ok(parsed)
}

#[tauri::command]
async fn run_mcp_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let script_path = resolve_bridge_script_path(&app, "mcpActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let augmented_path = build_augmented_path();
    let launch_details = bridge_launch_log_details(
        &app,
        "run_mcp_action",
        &bridge_cwd,
        &script_path,
        &augmented_path,
    );
    append_app_log(
        &app,
        "info",
        "mcp_action_started",
        serde_json::json!({
            "launch": launch_details.clone(),
        }),
    );
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("Failed to serialize MCP action payload: {error}"))?;
    let app_handle = app.clone();
    let launch_details_for_error = launch_details.clone();

    let output =
        tauri::async_runtime::spawn_blocking(move || -> Result<std::process::Output, String> {
            let (output, used_system_node_fallback) = output_node_command_with_fallback(
                &app_handle,
                &bridge_cwd,
                &augmented_path,
                |command| {
                    command.arg(&script_path).arg(&payload_json);
                },
            )
            .map_err(|message| {
                    append_app_log(
                        &app_handle,
                        "error",
                        "mcp_action_launch_failed",
                        serde_json::json!({
                            "error": message,
                            "launch": launch_details_for_error.clone(),
                        }),
                    );
                    message
            })?;
            if used_system_node_fallback {
                append_app_log(
                    &app_handle,
                    "warn",
                    "mcp_action_system_node_fallback_used",
                    serde_json::json!({
                        "launch": launch_details_for_error.clone(),
                    }),
                );
            }
            Ok(output)
        })
        .await
        .map_err(|error| format!("Failed to join MCP action task: {error}"))?
        .map_err(|error| format!("Failed to run MCP action bridge: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            "MCP action failed.".into()
        } else {
            stderr
        };
        append_app_log(
            &app,
            "error",
            "mcp_action_failed",
            serde_json::json!({
                "error": message,
                "launch": launch_details,
            }),
        );
        return Err(message);
    }

    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse MCP action response: {error}"))?;
    append_app_log(
        &app,
        "info",
        "mcp_action_completed",
        serde_json::json!({
            "launch": launch_details,
        }),
    );
    Ok(parsed)
}

#[tauri::command]
fn start_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AgentTaskStore>,
    payload: serde_json::Value,
) -> Result<String, String> {
    spawn_agent_task(app, state.inner(), payload)
}

#[tauri::command]
fn get_agent_task(
    state: State<'_, AgentTaskStore>,
    task_id: String,
) -> Result<AgentTaskSnapshot, String> {
    let mut tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    prune_terminal_task_snapshots(&mut tasks);
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };
    let snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| "Failed to lock task snapshot.".to_string())?;
    Ok(snapshot.clone())
}

#[tauri::command]
fn release_agent_task(state: State<'_, AgentTaskStore>, task_id: String) -> Result<(), String> {
    let mut tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id).cloned() else {
        return Ok(());
    };

    let status = handle
        .snapshot
        .lock()
        .map_err(|_| "Failed to lock task snapshot.".to_string())?
        .status
        .clone();
    if !is_terminal_task_status(&status) {
        return Ok(());
    }

    tasks.remove(&task_id);
    prune_terminal_task_snapshots(&mut tasks);
    Ok(())
}

#[tauri::command]
fn respond_to_agent_approval<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AgentTaskStore>,
    task_id: String,
    decision: String,
) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };
    let log_context = handle.log_context.clone();

    {
        let mut snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| "Failed to lock task snapshot.".to_string())?;
        snapshot.status = "running".into();
        snapshot.pending_approval = None;
    }

    let approval_message = serde_json::json!({
        "type": "approval",
        "decision": decision.as_str(),
    });

    let mut stdin = handle
        .stdin
        .lock()
        .map_err(|_| "Failed to lock Node bridge stdin.".to_string())?;
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&approval_message)
            .map_err(|error| format!("Failed to serialize approval payload: {error}"))?
    )
    .map_err(|error| format!("Failed to write approval payload to Node bridge: {error}"))?;

    append_app_log(
        &app,
        "info",
        "agent_approval_submitted",
        agent_log_details(
            &log_context,
            serde_json::json!({
                "decision": decision.as_str(),
            }),
        ),
    );

    Ok(())
}

#[tauri::command]
fn append_input_to_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AgentTaskStore>,
    task_id: String,
    input: serde_json::Value,
) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };
    let log_context = handle.log_context.clone();

    {
        let mut snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| "Failed to lock task snapshot.".to_string())?;
        if snapshot.pending_user_input.is_some() {
            snapshot.status = "running".into();
            snapshot.phase = Some("preparing".into());
            snapshot.pending_user_input = None;
        }
        snapshot.appended_inputs.push(serde_json::json!({
            "id": input.get("id").and_then(|value| value.as_str()).unwrap_or_default(),
            "content": input.get("content").and_then(|value| value.as_str()).unwrap_or_default(),
            "parts": input
                .get("snapshotParts")
                .or_else(|| input.get("parts"))
                .cloned()
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            "attachments": input
                .get("attachments")
                .cloned()
                .unwrap_or(serde_json::Value::Array(Vec::new())),
            "createdAt": input
                .get("createdAt")
                .and_then(|value| value.as_i64())
                .unwrap_or_default(),
            "status": "queued",
        }));
    }

    let append_message = serde_json::json!({
        "type": "append_input",
        "input": input.clone(),
    });

    let mut stdin = handle
        .stdin
        .lock()
        .map_err(|_| "Failed to lock Node bridge stdin.".to_string())?;
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&append_message)
            .map_err(|error| format!("Failed to serialize appended input payload: {error}"))?
    )
    .map_err(|error| format!("Failed to write appended input payload to Node bridge: {error}"))?;

    append_app_log(
        &app,
        "info",
        "agent_appended_input_submitted",
        agent_log_details(
            &log_context,
            serde_json::json!({
                "inputId": input.get("id").and_then(|value| value.as_str()),
                "contentLength": input
                    .get("content")
                    .and_then(|value| value.as_str())
                    .map(|value| value.chars().count())
                    .unwrap_or(0),
                "attachmentCount": input
                    .get("attachments")
                    .and_then(|value| value.as_array())
                    .map(|value| value.len())
                    .unwrap_or(0),
            }),
        ),
    );

    Ok(())
}

#[tauri::command]
fn cancel_agent_task_step<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AgentTaskStore>,
    task_id: String,
) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };
    let log_context = handle.log_context.clone();

    let cancel_message = serde_json::json!({
        "type": "cancel_current_step",
    });

    let mut stdin = handle
        .stdin
        .lock()
        .map_err(|_| "Failed to lock Node bridge stdin.".to_string())?;
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&cancel_message)
            .map_err(|error| format!("Failed to serialize step cancel payload: {error}"))?
    )
    .map_err(|error| format!("Failed to write step cancel payload to Node bridge: {error}"))?;

    append_app_log(
        &app,
        "warn",
        "agent_step_cancel_requested",
        agent_log_details(&log_context, serde_json::json!({})),
    );

    Ok(())
}

#[tauri::command]
fn abort_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AgentTaskStore>,
    task_id: String,
) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };
    let log_context = handle.log_context.clone();

    {
        let mut child_guard = handle
            .child
            .lock()
            .map_err(|_| "Failed to lock child handle.".to_string())?;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill();
        }
    }

    {
        let mut snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| "Failed to lock task snapshot.".to_string())?;
        if snapshot.status == "running"
            || snapshot.status == "queued"
            || snapshot.status == "awaiting_approval"
            || snapshot.status == "awaiting_user_input"
        {
            snapshot.status = "failed".into();
            snapshot.error = Some("任务已被用户强行终止。".into());
        }
    }

    append_app_log(
        &app,
        "warn",
        "agent_task_abort_requested",
        agent_log_details(&log_context, serde_json::json!({})),
    );

    Ok(())
}

#[tauri::command]
fn load_persisted_app_state<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let connection = open_app_db(&app)?;

    let settings_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_kv WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load settings from SQLite: {error}"))?;

    let project_overrides_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_kv WHERE key = 'project_capability_overrides'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            format!("Failed to load project capability overrides from SQLite: {error}")
        })?;

    let session_folders_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_kv WHERE key = 'session_folders'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load session folders from SQLite: {error}"))?;

    let mut sessions_statement = connection
        .prepare(
            "SELECT s.id, s.title, s.provider_profile_id, s.provider, s.model, s.folder_id, s.workspace_path, s.workspace_root, s.workspace_mode, s.context_compression_json, s.updated_at,
                    COUNT(m.id) AS message_count
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id AND m.deleted_at = 0
             WHERE s.deleted_at = 0
             GROUP BY s.id
             ORDER BY s.updated_at DESC",
        )
        .map_err(|error| format!("Failed to prepare sessions query: {error}"))?;

    let session_rows = sessions_statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "providerProfileId": row.get::<_, String>(2)?,
                "provider": row.get::<_, String>(3)?,
                "model": row.get::<_, String>(4)?,
                "folderId": row.get::<_, Option<String>>(5)?,
                "workspacePath": row.get::<_, String>(6)?,
                "workspaceRoot": row.get::<_, String>(7)?,
                "workspaceMode": row.get::<_, String>(8)?,
                "contextCompression": parse_json_object_column(row.get::<_, Option<String>>(9)?),
                "messages": Vec::<serde_json::Value>::new(),
                "messagesLoaded": false,
                "messageCount": row.get::<_, i64>(11)?,
                "toolEvents": Vec::<serde_json::Value>::new(),
                "taskTree": Vec::<serde_json::Value>::new(),
                "updatedAt": row.get::<_, i64>(10)?,
            }))
        })
        .map_err(|error| format!("Failed to read sessions from SQLite: {error}"))?;

    let mut sessions = Vec::new();
    for session_row in session_rows {
        sessions.push(session_row.map_err(|error| format!("Failed to decode session row: {error}"))?);
    }

    Ok(serde_json::json!({
        "settings": parse_json_column(settings_json),
        "sessions": sessions,
        "sessionFolders": parse_json_column(session_folders_json),
        "projectCapabilityOverrides": parse_json_column(project_overrides_json),
    }))
}

fn load_session_messages_from_db(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut messages_statement = connection
        .prepare(
            "SELECT id, role, linked_message_id, sort_index, active_version_index, created_at, updated_at
             FROM messages
             WHERE session_id = ?1 AND deleted_at = 0
             ORDER BY sort_index ASC",
        )
        .map_err(|error| format!("Failed to prepare messages query: {error}"))?;

    let message_rows = messages_statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|error| format!("Failed to read messages from SQLite: {error}"))?;

    let mut versions_statement = connection
        .prepare(
            "SELECT id, version_index, content, parts_json, status, created_at, attachments_json, reasoning_json, usage_json,
                    capability_snapshot_json, activity_json, events_json, steps_json, error, error_info_json, appended_inputs_json,
                    agent_mode, route_decision_json, completion_state, evidence_summary_json, delivery_note, model_info_json
             FROM message_versions
             WHERE message_id = ?1 AND deleted_at = 0
             ORDER BY version_index ASC",
        )
        .map_err(|error| format!("Failed to prepare message versions query: {error}"))?;

    let mut messages = Vec::new();

    for message_row in message_rows {
        let (
            message_id,
            role,
            linked_message_id,
            _sort_index,
            active_version_index,
            created_at,
            _message_updated_at,
        ) = message_row.map_err(|error| format!("Failed to decode message row: {error}"))?;

        let version_rows = versions_statement
            .query_map(params![message_id.clone()], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "content": row.get::<_, String>(2)?,
                    "parts": parse_json_array_column(row.get::<_, String>(3)?),
                    "status": row.get::<_, Option<String>>(4)?,
                    "createdAt": row.get::<_, i64>(5)?,
                    "attachments": parse_json_array_column(row.get::<_, String>(6)?),
                    "reasoning": parse_json_array_column(row.get::<_, String>(7)?),
                    "usage": parse_json_column(row.get::<_, Option<String>>(8)?),
                    "capabilitySnapshot": parse_json_object_column(row.get::<_, Option<String>>(9)?),
                    "activity": parse_json_object_column(row.get::<_, Option<String>>(10)?),
                    "events": parse_json_array_column(row.get::<_, String>(11)?),
                    "steps": parse_json_array_column(row.get::<_, String>(12)?),
                    "error": row.get::<_, Option<String>>(13)?,
                    "errorInfo": parse_json_object_column(row.get::<_, Option<String>>(14)?),
                    "appendedInputs": parse_json_array_column(row.get::<_, String>(15)?),
                    "agentMode": row.get::<_, Option<String>>(16)?,
                    "routeDecision": parse_json_object_column(row.get::<_, Option<String>>(17)?),
                    "completionState": row.get::<_, Option<String>>(18)?,
                    "evidenceSummary": parse_json_object_column(row.get::<_, Option<String>>(19)?),
                    "deliveryNote": row.get::<_, Option<String>>(20)?,
                    "modelInfo": parse_json_object_column(row.get::<_, Option<String>>(21)?),
                }))
            })
            .map_err(|error| format!("Failed to read message versions from SQLite: {error}"))?;

        let mut versions = Vec::new();
        for version_row in version_rows {
            versions.push(
                version_row
                    .map_err(|error| format!("Failed to decode message version row: {error}"))?,
            );
        }

        messages.push(serde_json::json!({
            "id": message_id,
            "role": role,
            "linkedMessageId": linked_message_id,
            "createdAt": created_at,
            "versions": versions,
            "activeVersionIndex": active_version_index,
        }));
    }

    Ok(messages)
}

#[tauri::command]
fn load_session_messages_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let connection = open_app_db(&app)?;
    let messages = load_session_messages_from_db(&connection, &session_id)?;
    Ok(serde_json::Value::Array(messages))
}

#[tauri::command]
fn search_sessions_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    keyword: String,
) -> Result<Vec<String>, String> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }

    let connection = open_app_db(&app)?;
    let like_pattern = format!("%{}%", keyword.to_lowercase());
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT s.id
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id AND m.deleted_at = 0
             LEFT JOIN message_versions mv
               ON mv.message_id = m.id AND mv.version_index = m.active_version_index AND mv.deleted_at = 0
             WHERE s.deleted_at = 0
               AND (lower(s.title) LIKE ?1 OR lower(COALESCE(mv.content, '')) LIKE ?1)
             ORDER BY s.updated_at DESC",
        )
        .map_err(|error| format!("Failed to prepare sessions search query: {error}"))?;
    let rows = statement
        .query_map(params![like_pattern], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to execute sessions search query: {error}"))?;
    let mut session_ids = Vec::new();
    for row in rows {
        session_ids.push(row.map_err(|error| format!("Failed to decode sessions search row: {error}"))?);
    }
    Ok(session_ids)
}

#[tauri::command]
fn load_work_memories_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let normalized_session_id = session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }

    let safe_limit = limit.unwrap_or(8).clamp(1, 24);
    let connection = open_app_db(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, task_id, assistant_message_id, kind, title, summary, status,
                    content_json, source_refs_json, next_use, created_at
             FROM work_memories
             WHERE session_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )
        .map_err(|error| format!("Failed to prepare work memories query: {error}"))?;

    let rows = statement
        .query_map(params![normalized_session_id, safe_limit], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "taskId": row.get::<_, Option<String>>(2)?,
                "assistantMessageId": row.get::<_, Option<String>>(3)?,
                "kind": row.get::<_, String>(4)?,
                "title": row.get::<_, String>(5)?,
                "summary": row.get::<_, String>(6)?,
                "status": row.get::<_, String>(7)?,
                "content": parse_json_column(Some(row.get::<_, String>(8)?)),
                "sourceRefs": parse_json_array_column(row.get::<_, String>(9)?),
                "nextUse": row.get::<_, Option<String>>(10)?,
                "createdAt": row.get::<_, i64>(11)?,
            }))
        })
        .map_err(|error| format!("Failed to read work memories from SQLite: {error}"))?;

    let mut memories = Vec::new();
    for row in rows {
        memories.push(row.map_err(|error| format!("Failed to decode work memory row: {error}"))?);
    }
    memories.reverse();

    Ok(serde_json::Value::Array(memories))
}

#[tauri::command]
fn list_agent_runs_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: Option<String>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let safe_limit = limit.unwrap_or(24).clamp(1, 100);
    let normalized_session_id = session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let connection = open_app_db(&app)?;

    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(serde_json::json!({
            "runId": row.get::<_, String>(0)?,
            "sessionId": row.get::<_, Option<String>>(1)?,
            "taskId": row.get::<_, Option<String>>(2)?,
            "assistantMessageId": row.get::<_, Option<String>>(3)?,
            "userMessageId": row.get::<_, Option<String>>(4)?,
            "status": row.get::<_, String>(5)?,
            "architectureMode": row.get::<_, Option<String>>(6)?,
            "requestedArchitectureMode": row.get::<_, Option<String>>(7)?,
            "pathMode": row.get::<_, Option<String>>(8)?,
            "provider": row.get::<_, Option<String>>(9)?,
            "model": row.get::<_, Option<String>>(10)?,
            "cwd": row.get::<_, Option<String>>(11)?,
            "startedAt": row.get::<_, i64>(12)?,
            "finishedAt": row.get::<_, Option<i64>>(13)?,
            "updatedAt": row.get::<_, i64>(14)?,
            "terminationReason": row.get::<_, Option<String>>(15)?,
            "completionState": row.get::<_, Option<String>>(16)?,
            "graphState": row.get::<_, Option<String>>(17)?,
            "checkpointCount": row.get::<_, Option<i64>>(18)?,
            "recoveryCount": row.get::<_, Option<i64>>(19)?,
            "toolCount": row.get::<_, Option<i64>>(20)?,
            "inputTokens": row.get::<_, Option<i64>>(21)?,
            "outputTokens": row.get::<_, Option<i64>>(22)?,
            "durationMs": row.get::<_, Option<i64>>(23)?,
            "errorCode": row.get::<_, Option<String>>(24)?,
            "errorCategory": row.get::<_, Option<String>>(25)?,
            "summary": parse_json_object_column(row.get::<_, Option<String>>(26)?),
        }))
    };

    let mut runs = Vec::new();
    if let Some(session_id) = normalized_session_id {
        let mut statement = connection
            .prepare(
                "SELECT run_id, session_id, task_id, assistant_message_id, user_message_id, status,
                        architecture_mode, requested_architecture_mode, path_mode, provider, model, cwd,
                        started_at, finished_at, updated_at, termination_reason, completion_state, graph_state,
                        checkpoint_count, recovery_count, tool_count, input_tokens, output_tokens, duration_ms,
                        error_code, error_category, summary_json
                 FROM agent_runs
                 WHERE session_id = ?1
                 ORDER BY updated_at DESC
                 LIMIT ?2",
            )
            .map_err(|error| format!("Failed to prepare agent runs query: {error}"))?;
        let rows = statement
            .query_map(params![session_id, safe_limit], map_row)
            .map_err(|error| format!("Failed to read agent runs: {error}"))?;
        for row in rows {
            runs.push(row.map_err(|error| format!("Failed to decode agent run row: {error}"))?);
        }
    } else {
        let mut statement = connection
            .prepare(
                "SELECT run_id, session_id, task_id, assistant_message_id, user_message_id, status,
                        architecture_mode, requested_architecture_mode, path_mode, provider, model, cwd,
                        started_at, finished_at, updated_at, termination_reason, completion_state, graph_state,
                        checkpoint_count, recovery_count, tool_count, input_tokens, output_tokens, duration_ms,
                        error_code, error_category, summary_json
                 FROM agent_runs
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|error| format!("Failed to prepare agent runs query: {error}"))?;
        let rows = statement
            .query_map(params![safe_limit], map_row)
            .map_err(|error| format!("Failed to read agent runs: {error}"))?;
        for row in rows {
            runs.push(row.map_err(|error| format!("Failed to decode agent run row: {error}"))?);
        }
    }
    Ok(serde_json::Value::Array(runs))
}

#[tauri::command]
fn load_agent_run_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    let normalized_run_id = run_id.trim();
    if normalized_run_id.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let connection = open_app_db(&app)?;
    let run: Option<serde_json::Value> = connection
        .query_row(
            "SELECT run_id, session_id, task_id, assistant_message_id, user_message_id, status,
                    architecture_mode, requested_architecture_mode, path_mode, provider, model, cwd,
                    started_at, finished_at, updated_at, termination_reason, completion_state, graph_state,
                    checkpoint_count, recovery_count, tool_count, input_tokens, output_tokens, duration_ms,
                    error_code, error_category, summary_json
             FROM agent_runs
             WHERE run_id = ?1",
            params![normalized_run_id],
            |row| {
                Ok(serde_json::json!({
                    "runId": row.get::<_, String>(0)?,
                    "sessionId": row.get::<_, Option<String>>(1)?,
                    "taskId": row.get::<_, Option<String>>(2)?,
                    "assistantMessageId": row.get::<_, Option<String>>(3)?,
                    "userMessageId": row.get::<_, Option<String>>(4)?,
                    "status": row.get::<_, String>(5)?,
                    "architectureMode": row.get::<_, Option<String>>(6)?,
                    "requestedArchitectureMode": row.get::<_, Option<String>>(7)?,
                    "pathMode": row.get::<_, Option<String>>(8)?,
                    "provider": row.get::<_, Option<String>>(9)?,
                    "model": row.get::<_, Option<String>>(10)?,
                    "cwd": row.get::<_, Option<String>>(11)?,
                    "startedAt": row.get::<_, i64>(12)?,
                    "finishedAt": row.get::<_, Option<i64>>(13)?,
                    "updatedAt": row.get::<_, i64>(14)?,
                    "terminationReason": row.get::<_, Option<String>>(15)?,
                    "completionState": row.get::<_, Option<String>>(16)?,
                    "graphState": row.get::<_, Option<String>>(17)?,
                    "checkpointCount": row.get::<_, Option<i64>>(18)?,
                    "recoveryCount": row.get::<_, Option<i64>>(19)?,
                    "toolCount": row.get::<_, Option<i64>>(20)?,
                    "inputTokens": row.get::<_, Option<i64>>(21)?,
                    "outputTokens": row.get::<_, Option<i64>>(22)?,
                    "durationMs": row.get::<_, Option<i64>>(23)?,
                    "errorCode": row.get::<_, Option<String>>(24)?,
                    "errorCategory": row.get::<_, Option<String>>(25)?,
                    "summary": parse_json_object_column(row.get::<_, Option<String>>(26)?),
                }))
            },
        )
        .optional()
        .map_err(|error| format!("Failed to load agent run: {error}"))?;

    let Some(mut run) = run else {
        return Ok(serde_json::Value::Null);
    };

    let mut statement = connection
        .prepare(
            "SELECT checkpoint_id, graph_state, plan_id, subtask_id, reason, restored, created_at, details_json
             FROM agent_run_checkpoints
             WHERE run_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|error| format!("Failed to prepare agent run checkpoints query: {error}"))?;
    let rows = statement
        .query_map(params![normalized_run_id], |row| {
            Ok(serde_json::json!({
                "checkpointId": row.get::<_, String>(0)?,
                "graphState": row.get::<_, Option<String>>(1)?,
                "planId": row.get::<_, Option<String>>(2)?,
                "subtaskId": row.get::<_, Option<String>>(3)?,
                "reason": row.get::<_, Option<String>>(4)?,
                "restored": row.get::<_, i64>(5)? == 1,
                "createdAt": row.get::<_, i64>(6)?,
                "details": parse_json_object_column(row.get::<_, Option<String>>(7)?),
            }))
        })
        .map_err(|error| format!("Failed to load agent run checkpoints: {error}"))?;

    let mut checkpoints = Vec::new();
    for row in rows {
        checkpoints.push(row.map_err(|error| format!("Failed to decode checkpoint row: {error}"))?);
    }
    if let Some(object) = run.as_object_mut() {
        object.insert("checkpoints".to_string(), serde_json::Value::Array(checkpoints));
    }
    Ok(run)
}

#[tauri::command]
fn save_settings_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    upsert_kv(&connection, "settings", &settings)?;
    emit_settings_updated(&app)
}

#[tauri::command]
fn save_project_capability_overrides_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    overrides: serde_json::Value,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    upsert_kv(&connection, "project_capability_overrides", &overrides)
}

#[tauri::command]
fn save_session_folders_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_folders: serde_json::Value,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    upsert_kv(&connection, "session_folders", &session_folders)
}

#[tauri::command]
fn upsert_session_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session: serde_json::Value,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    let context_compression = get_json_object_field(&session, "contextCompression");
    let context_compression_json = if context_compression.is_null() {
        None
    } else {
        Some(context_compression.to_string())
    };
    connection
        .execute(
            "INSERT INTO sessions (
                id, title, provider_profile_id, provider, model, folder_id, workspace_path, workspace_root, workspace_mode, context_compression_json, deleted_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                provider_profile_id = excluded.provider_profile_id,
                provider = excluded.provider,
                model = excluded.model,
                folder_id = excluded.folder_id,
                workspace_path = excluded.workspace_path,
                workspace_root = excluded.workspace_root,
                workspace_mode = excluded.workspace_mode,
                context_compression_json = excluded.context_compression_json,
                deleted_at = 0,
                updated_at = excluded.updated_at",
            params![
                get_json_string_field(&session, "id", ""),
                get_json_string_field(&session, "title", "新会话"),
                get_json_string_field(&session, "providerProfileId", ""),
                get_json_string_field(&session, "provider", "openai"),
                get_json_string_field(&session, "model", ""),
                get_json_string_field(&session, "folderId", ""),
                get_json_string_field(&session, "workspacePath", ""),
                get_json_string_field(&session, "workspaceRoot", ""),
                get_json_string_field(&session, "workspaceMode", "explicit"),
                context_compression_json,
                get_json_i64_field(&session, "updatedAt", 0),
            ],
        )
        .map_err(|error| format!("Failed to upsert session into SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn delete_session_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    let deleted_at = current_timestamp_ms() as i64;
    connection
        .execute(
            "UPDATE sessions SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at = 0",
            params![session_id, deleted_at],
        )
        .map_err(|error| format!("Failed to delete session from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn purge_session_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    connection
        .execute(
            "DELETE FROM agent_run_checkpoints
             WHERE run_id IN (SELECT run_id FROM agent_runs WHERE session_id = ?1)",
            params![&session_id],
        )
        .map_err(|error| format!("Failed to purge session agent run checkpoints from SQLite: {error}"))?;
    connection
        .execute("DELETE FROM agent_runs WHERE session_id = ?1", params![&session_id])
        .map_err(|error| format!("Failed to purge session agent runs from SQLite: {error}"))?;
    connection
        .execute(
            "DELETE FROM work_memories WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|error| format!("Failed to purge session work memories from SQLite: {error}"))?;
    connection
        .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|error| format!("Failed to purge session from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn upsert_message_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
    message: serde_json::Value,
    sort_index: i64,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    connection
        .execute(
            "INSERT INTO messages (
                id, session_id, role, linked_message_id, sort_index, active_version_index, created_at, deleted_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)
             ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                role = excluded.role,
                linked_message_id = excluded.linked_message_id,
                sort_index = excluded.sort_index,
                active_version_index = excluded.active_version_index,
                created_at = excluded.created_at,
                deleted_at = 0,
                updated_at = excluded.updated_at",
            params![
                get_json_string_field(&message, "id", ""),
                session_id,
                get_json_string_field(&message, "role", "assistant"),
                message.get("linkedMessageId").and_then(|value| value.as_str()),
                sort_index,
                get_json_i64_field(&message, "activeVersionIndex", 0),
                get_json_i64_field(&message, "createdAt", 0),
                get_json_i64_field(&message, "createdAt", 0),
            ],
        )
        .map_err(|error| format!("Failed to upsert message into SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn delete_message_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    message_id: String,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    let deleted_at = current_timestamp_ms() as i64;
    connection
        .execute(
            "UPDATE messages SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at = 0",
            params![message_id, deleted_at],
        )
        .map_err(|error| format!("Failed to delete message from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn purge_message_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    message_id: String,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    connection
        .execute("DELETE FROM messages WHERE id = ?1", params![message_id])
        .map_err(|error| format!("Failed to purge message from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn upsert_message_version_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    message_id: String,
    version: serde_json::Value,
    version_index: i64,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    let fallback_version_id = format!("{message_id}:v{version_index}");
    let version_id = get_json_string_field(&version, "id", &fallback_version_id);
    connection
        .execute(
            "INSERT INTO message_versions (
                id, message_id, version_index, content, parts_json, status, created_at, attachments_json, reasoning_json,
                usage_json, capability_snapshot_json, activity_json, events_json, steps_json, error, error_info_json,
                appended_inputs_json, agent_mode, route_decision_json, completion_state, evidence_summary_json, delivery_note, model_info_json, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, 0)
             ON CONFLICT(message_id, version_index) DO UPDATE SET
                content = excluded.content,
                parts_json = excluded.parts_json,
                status = excluded.status,
                created_at = excluded.created_at,
                attachments_json = excluded.attachments_json,
                reasoning_json = excluded.reasoning_json,
                usage_json = excluded.usage_json,
                capability_snapshot_json = excluded.capability_snapshot_json,
                activity_json = excluded.activity_json,
                events_json = excluded.events_json,
                steps_json = excluded.steps_json,
                error = excluded.error,
                error_info_json = excluded.error_info_json,
                appended_inputs_json = excluded.appended_inputs_json,
                agent_mode = excluded.agent_mode,
                route_decision_json = excluded.route_decision_json,
                completion_state = excluded.completion_state,
                evidence_summary_json = excluded.evidence_summary_json,
                delivery_note = excluded.delivery_note,
                model_info_json = excluded.model_info_json,
                id = excluded.id,
                deleted_at = 0",
            params![
                version_id,
                message_id,
                version_index,
                get_json_string_field(&version, "content", ""),
                value_to_json_string(&get_json_array_field(&version, "parts"))?,
                version.get("status").and_then(|value| value.as_str()),
                get_json_i64_field(&version, "createdAt", 0),
                value_to_json_string(&get_json_array_field(&version, "attachments"))?,
                value_to_json_string(&get_json_array_field(&version, "reasoning"))?,
                {
                    let usage = get_json_object_field(&version, "usage");
                    if usage.is_null() { None } else { Some(value_to_json_string(&usage)?) }
                },
                {
                    let snapshot = get_json_object_field(&version, "capabilitySnapshot");
                    if snapshot.is_null() { None } else { Some(value_to_json_string(&snapshot)?) }
                },
                {
                    let activity = get_json_object_field(&version, "activity");
                    if activity.is_null() { None } else { Some(value_to_json_string(&activity)?) }
                },
                value_to_json_string(&get_json_array_field(&version, "events"))?,
                value_to_json_string(&get_json_array_field(&version, "steps"))?,
                version.get("error").and_then(|value| value.as_str()),
                {
                    let error_info = get_json_object_field(&version, "errorInfo");
                    if error_info.is_null() { None } else { Some(value_to_json_string(&error_info)?) }
                },
                value_to_json_string(&get_json_array_field(&version, "appendedInputs"))?,
                version.get("agentMode").and_then(|value| value.as_str()),
                {
                    let route_decision = get_json_object_field(&version, "routeDecision");
                    if route_decision.is_null() {
                        None
                    } else {
                        Some(value_to_json_string(&route_decision)?)
                    }
                },
                version.get("completionState").and_then(|value| value.as_str()),
                {
                    let evidence_summary = get_json_object_field(&version, "evidenceSummary");
                    if evidence_summary.is_null() {
                        None
                    } else {
                        Some(value_to_json_string(&evidence_summary)?)
                    }
                },
                version.get("deliveryNote").and_then(|value| value.as_str()),
                {
                    let model_info = get_json_object_field(&version, "modelInfo");
                    if model_info.is_null() { None } else { Some(value_to_json_string(&model_info)?) }
                },
            ],
        )
        .map_err(|error| format!("Failed to upsert message version into SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn delete_message_version_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    message_id: String,
    version_index: i64,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    let deleted_at = current_timestamp_ms() as i64;
    connection
        .execute(
            "UPDATE message_versions SET deleted_at = ?3 WHERE message_id = ?1 AND version_index = ?2 AND deleted_at = 0",
            params![message_id, version_index, deleted_at],
        )
        .map_err(|error| format!("Failed to delete message version from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn purge_message_version_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    message_id: String,
    version_index: i64,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    connection
        .execute(
            "DELETE FROM message_versions WHERE message_id = ?1 AND version_index = ?2",
            params![message_id, version_index],
        )
        .map_err(|error| format!("Failed to purge message version from SQLite: {error}"))?;
    Ok(())
}

#[tauri::command]
fn read_workspace_tree(root_path: String) -> Result<WorkspaceNode, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("Workspace path does not exist: {}", root.display()));
    }
    read_workspace_node(&root, 0)
}

#[tauri::command]
fn read_text_file(file_path: String) -> Result<String, String> {
    let path = PathBuf::from(file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read file {}: {error}", path.display()))?;
    let truncated = if bytes.len() > 256 * 1024 {
        &bytes[..256 * 1024]
    } else {
        &bytes[..]
    };
    Ok(String::from_utf8_lossy(truncated).to_string())
}

#[tauri::command]
fn toggle_edit_transaction_snapshots<R: Runtime>(
    app: tauri::AppHandle<R>,
    transaction_ids: Vec<String>,
    target_state: String,
) -> Result<serde_json::Value, String> {
    let target_after = match target_state.as_str() {
        "after" => true,
        "before" => false,
        _ => return Err("targetState must be either before or after.".into()),
    };
    let snapshots = transaction_ids
        .iter()
        .filter(|id| !id.trim().is_empty())
        .map(|id| load_edit_transaction_snapshot(&app, id))
        .collect::<Result<Vec<_>, _>>()?;

    if target_after {
        for snapshot in &snapshots {
            apply_edit_transaction_snapshot(snapshot, true)?;
        }
    } else {
        for snapshot in snapshots.iter().rev() {
            apply_edit_transaction_snapshot(snapshot, false)?;
        }
    }

    Ok(serde_json::json!({
        "targetState": target_state,
        "transactionIds": transaction_ids,
        "ok": true,
    }))
}

#[tauri::command]
fn ensure_aura_home<R: Runtime>(app: tauri::AppHandle<R>) -> Result<AuraHomeState, String> {
    ensure_aura_layout(&app)
}

fn system_time_to_timestamp_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn is_valid_app_log_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

#[tauri::command]
fn list_app_log_files<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<AppLogFile>, String> {
    let logs_dir = PathBuf::from(ensure_aura_layout(&app)?.logs_dir);
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(&logs_dir) else {
        return Ok(files);
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(date) = file_name
            .strip_prefix("app-")
            .and_then(|value| value.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if !is_valid_app_log_date(date) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(AppLogFile {
            date: date.to_string(),
            name: file_name.to_string(),
            path: path.display().to_string(),
            size: metadata.len(),
            modified_at: metadata.modified().ok().and_then(system_time_to_timestamp_ms),
        });
    }

    files.sort_by(|left, right| right.date.cmp(&left.date));
    Ok(files)
}

#[tauri::command]
fn read_app_log_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    date: String,
) -> Result<Vec<AppLogEntry>, String> {
    let date = date.trim();
    if !is_valid_app_log_date(date) {
        return Err("Invalid log date.".into());
    }
    let logs_dir = PathBuf::from(ensure_aura_layout(&app)?.logs_dir);
    let path = logs_dir.join(format!("app-{date}.jsonl"));
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = fs::File::open(&path)
        .map_err(|error| format!("Failed to open log file {}: {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<AppLogEntry>(&line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[tauri::command]
fn detect_lightpanda_runtime<R: Runtime>(
    app: tauri::AppHandle<R>,
    executable_path: Option<String>,
) -> Result<LightpandaRuntimeStatusRecord, String> {
    let requested_path = executable_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let install_dir = ensure_aura_layout(&app)?.browser_dir;
    let resolved_path = match requested_path {
        Some(path) => resolve_executable_path(Path::new(path)),
        None => {
            detect_lightpanda_installation(Path::new(&install_dir)).or_else(detect_lightpanda_path)
        }
    };
    let version = resolved_path
        .as_ref()
        .and_then(|path| read_lightpanda_version(path));
    let installed_in_aura = resolved_path
        .as_ref()
        .map(|path| path.starts_with(Path::new(&install_dir)))
        .unwrap_or(false);
    let error = if let Some(path) = requested_path {
        if resolved_path.is_none() {
            Some(format!("未找到可用的 Lightpanda 可执行文件: {path}"))
        } else if version.is_none() {
            Some("已找到 Lightpanda，但无法读取版本信息。".to_string())
        } else {
            None
        }
    } else if resolved_path.is_none() {
        Some("未在 Aura 安装目录或系统 PATH 中检测到 Lightpanda。".to_string())
    } else if version.is_none() {
        Some(if installed_in_aura {
            "已在 Aura 安装目录中发现 Lightpanda，但无法读取版本信息。".to_string()
        } else {
            "已检测到 Lightpanda，但无法读取版本信息。".to_string()
        })
    } else {
        None
    };

    Ok(LightpandaRuntimeStatusRecord {
        detected: resolved_path.is_some(),
        executable_path: resolved_path
            .as_ref()
            .map(|path| canonical_display_path(path))
            .or_else(|| requested_path.map(String::from)),
        version,
        valid: resolved_path.is_some(),
        last_checked_at: current_timestamp_ms(),
        error,
    })
}

#[tauri::command]
fn read_aura_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<Option<String>, String> {
    let target = resolve_aura_relative_path(&app, &relative_path)?;
    if !target.exists() {
        return Ok(None);
    }
    fs::read_to_string(&target)
        .map(Some)
        .map_err(|error| format!("Failed to read Aura file {}: {error}", target.display()))
}

#[tauri::command]
fn write_aura_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_aura_relative_path(&app, &relative_path)?;
    if let Some(parent) = target.parent() {
        ensure_directory(parent)?;
    }
    fs::write(&target, content)
        .map_err(|error| format!("Failed to write Aura file {}: {error}", target.display()))
}

#[tauri::command]
fn delete_aura_asset<R: Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<(), String> {
    let target = resolve_aura_relative_path(&app, &relative_path)?;
    if !target.exists() {
        return Ok(());
    }

    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| {
            format!(
                "Failed to delete Aura directory {}: {error}",
                target.display()
            )
        })?;
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("Failed to delete Aura file {}: {error}", target.display()))?;
    }

    Ok(())
}

#[tauri::command]
fn reset_aura_home<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<(), String> {
    let home = resolve_aura_home()?;
    if home.exists() {
        fs::remove_dir_all(&home).map_err(|error| {
            format!(
                "Failed to reset Aura home directory {}: {error}",
                home.display()
            )
        })?;
    }
    Ok(())
}

fn read_image_data_url_internal(
    file_path: &str,
    max_bytes: Option<usize>,
) -> Result<Option<String>, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return Ok(None),
    };

    if let Some(limit) = max_bytes {
        let file_size = fs::metadata(&path)
            .map_err(|error| format!("Failed to inspect image {}: {error}", path.display()))?
            .len();
        if file_size > limit as u64 {
            return Err(format!(
                "Image is too large to inline: {} bytes exceeds {} bytes.",
                file_size, limit
            ));
        }
    }

    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read image {}: {error}", path.display()))?;

    Ok(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[tauri::command]
fn read_image_preview(file_path: String) -> Result<Option<String>, String> {
    read_image_data_url_internal(&file_path, Some(MAX_INLINE_IMAGE_PREVIEW_BYTES))
}

#[tauri::command]
fn read_image_data_url(file_path: String) -> Result<Option<String>, String> {
    read_image_data_url_internal(&file_path, Some(MAX_RUNTIME_IMAGE_DATA_URL_BYTES))
}

#[tauri::command]
fn open_path_in_default_app(path: String) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(&path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("Failed to open path in default app: {error}"))?;
    Ok(())
}

fn sanitize_workspace_directory_name(value: &str) -> String {
    let mut name = String::new();
    const MAX_WORKSPACE_DIR_NAME_LEN: usize = 80;

    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            name.push(character);
        } else {
            name.push('-');
        }

        if name.len() >= MAX_WORKSPACE_DIR_NAME_LEN {
            break;
        }
    }

    let trimmed = name
        .trim_matches('-')
        .chars()
        .take(MAX_WORKSPACE_DIR_NAME_LEN)
        .collect::<String>();
    if trimmed.is_empty() {
        "session".into()
    } else {
        trimmed
    }
}

fn sanitize_file_name(value: &str) -> String {
    let path = PathBuf::from(value);
    let candidate = path
        .file_name()
        .and_then(|entry| entry.to_str())
        .unwrap_or("attachment");
    let sanitized = candidate
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed
    }
}

fn allocate_attachment_path(workspace_path: &str, file_name: &str) -> Result<PathBuf, String> {
    let attachments_dir = PathBuf::from(workspace_path).join("attachments");
    fs::create_dir_all(&attachments_dir).map_err(|error| {
        format!(
            "Failed to create attachment directory {}: {error}",
            attachments_dir.display()
        )
    })?;

    let safe_name = sanitize_file_name(file_name);
    let stem = PathBuf::from(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    let extension = PathBuf::from(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for attempt in 0..1000_u32 {
        let file_name = if attempt == 0 {
            format!("{stem}{extension}")
        } else {
            format!("{stem}-{attempt}{extension}")
        };
        let candidate = attachments_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Unable to allocate a unique attachment path.".into())
}

#[tauri::command]
fn create_session_workspace<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
    hint: String,
) -> Result<String, String> {
    let root = if root_path.trim().is_empty() {
        PathBuf::from(ensure_aura_layout(&app)?.workspace_dir)
    } else {
        PathBuf::from(root_path)
    };
    if !root.exists() {
        return Err(format!(
            "Default workspace path does not exist: {}",
            root.display()
        ));
    }

    let directory_name = sanitize_workspace_directory_name(&hint);

    for attempt in 0..100_u32 {
        let candidate_name = if attempt == 0 {
            directory_name.clone()
        } else {
            format!("{directory_name}-{attempt}")
        };
        let candidate = root.join(candidate_name);
        if candidate.exists() {
            continue;
        }
        fs::create_dir_all(&candidate).map_err(|error| {
            format!(
                "Failed to create session workspace {}: {error}",
                candidate.display()
            )
        })?;
        return Ok(candidate.display().to_string());
    }

    Err("Unable to allocate a unique session workspace directory.".into())
}

#[tauri::command]
async fn import_attachment_from_path(
    workspace_dir: String,
    file_path: String,
) -> Result<String, String> {
    let source_path = PathBuf::from(&file_path);
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid file path.".to_string())?;

    let destination = allocate_attachment_path(&workspace_dir, file_name)?;
    fs::copy(&source_path, &destination).map_err(|error| {
        format!(
            "Failed to copy attachment into workspace {}: {error}",
            destination.display()
        )
    })?;

    Ok(destination.display().to_string())
}

#[tauri::command]
async fn write_attachment_bytes(
    workspace_dir: String,
    file_name: String,
    bytes_base64: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(bytes_base64)
        .map_err(|error| format!("Failed to decode attachment bytes: {error}"))?;
    let destination = allocate_attachment_path(&workspace_dir, &file_name)?;
    fs::write(&destination, bytes).map_err(|error| {
        format!(
            "Failed to write attachment into workspace {}: {error}",
            destination.display()
        )
    })?;
    Ok(destination.display().to_string())
}

#[tauri::command]
fn delete_workspace_directory<R: Runtime>(
    app: tauri::AppHandle<R>,
    workspace_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&workspace_path);
    if workspace_path.trim().is_empty() {
        return Ok(());
    }
    if !target.exists() {
        return Ok(());
    }
    if !target.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            target.display()
        ));
    }

    let aura_workspace_root = PathBuf::from(ensure_aura_layout(&app)?.workspace_dir);
    let canonical_root = canonicalize_existing_path(&aura_workspace_root)?;
    let canonical_target = canonicalize_existing_path(&target)?;
    if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "Only workspaces inside {} can be deleted by Aura.",
            canonical_root.display()
        ));
    }

    fs::remove_dir_all(&target).map_err(|error| {
        format!(
            "Failed to delete workspace directory {}: {error}",
            target.display()
        )
    })
}

#[tauri::command]
fn quit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!(
                "../../src/assets/aura_status_icon_white.png"
            )) {
                let _ = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .build(app);
            }
            Ok(())
        })
        .manage(AgentTaskStore::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_persisted_app_state,
            load_session_messages_sqlite,
            search_sessions_sqlite,
            load_work_memories_sqlite,
            list_agent_runs_sqlite,
            load_agent_run_sqlite,
            save_settings_sqlite,
            save_project_capability_overrides_sqlite,
            save_session_folders_sqlite,
            upsert_session_sqlite,
            delete_session_sqlite,
            purge_session_sqlite,
            upsert_message_sqlite,
            delete_message_sqlite,
            purge_message_sqlite,
            upsert_message_version_sqlite,
            delete_message_version_sqlite,
            purge_message_version_sqlite,
            start_agent_task,
            get_agent_task,
            release_agent_task,
            abort_agent_task,
            respond_to_agent_approval,
            append_input_to_agent_task,
            cancel_agent_task_step,
            write_app_log,
            run_provider_action,
            compress_agent_context,
            run_mcp_action,
            ensure_aura_home,
            list_app_log_files,
            read_app_log_file,
            detect_lightpanda_runtime,
            read_aura_file,
            write_aura_file,
            read_workspace_tree,
            read_text_file,
            toggle_edit_transaction_snapshots,
            read_image_preview,
            read_image_data_url,
            open_path_in_default_app,
            create_session_workspace,
            import_attachment_from_path,
            write_attachment_bytes,
            delete_workspace_directory,
            delete_aura_asset,
            reset_aura_home,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aura desktop app")
        .run(|app_handle, event| {
            // macOS: 点击程序坞图标时重新显示并激活窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
}
