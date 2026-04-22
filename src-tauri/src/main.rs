#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Emitter, Manager, Runtime, State};
use tauri_plugin_shell::ShellExt;

static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);

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
    usage: Option<serde_json::Value>,
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
    #[serde(rename = "lightpandaDir")]
    lightpanda_dir: String,
    #[serde(rename = "settingsPath")]
    settings_path: String,
    #[serde(rename = "sessionsPath")]
    sessions_path: String,
    #[serde(rename = "mcpServersPath")]
    mcp_servers_path: String,
    skills: Vec<AuraAssetMetadata>,
    plugins: Vec<AuraAssetMetadata>,
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
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Failed to resolve the user home directory.".to_string())
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
        "auraimportskill",
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
    let lightpanda_dir = home_dir.join("lightpanda");

    for dir in [
        &home_dir,
        &config_dir,
        &skills_dir,
        &plugins_dir,
        &mcp_dir,
        &workspace_dir,
        &logs_dir,
        &lightpanda_dir,
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
        lightpanda_dir: lightpanda_dir.display().to_string(),
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
    if file_name == "lightpanda"
        || file_name == "lightpanda.exe"
        || file_name == "lightpanda.app"
    {
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
            "#,
        )
        .map_err(|error| format!("Failed to initialize SQLite schema: {error}"))?;

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
            return Ok(bundled_bridge);
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

/// Build an augmented PATH that includes common Node.js install locations.
/// This ensures child processes can also find npx, npm, etc.
fn build_augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| String::new());
    let current_path = std::env::var("PATH").unwrap_or_else(|_| String::new());

    let mut extra_dirs: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];

    // Add nvm current bin if exists
    let nvm_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = fs::read_dir(&nvm_dir) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.join("bin/node").exists())
            .collect();
        versions.sort();
        if let Some(latest) = versions.last() {
            extra_dirs.push(latest.join("bin").display().to_string());
        }
    }

    // Add fnm
    let fnm_dir = format!("{}/.local/share/fnm/node-versions", home);
    if let Ok(entries) = fs::read_dir(&fnm_dir) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("installation"))
            .filter(|p| p.join("bin/node").exists())
            .collect();
        versions.sort();
        if let Some(latest) = versions.last() {
            extra_dirs.push(latest.join("bin").display().to_string());
        }
    }

    // Add volta
    let volta_bin = format!("{}/.volta/bin", home);
    if Path::new(&volta_bin).exists() {
        extra_dirs.push(volta_bin);
    }

    // Merge: extra dirs first, then existing PATH
    extra_dirs.push(current_path);
    extra_dirs.join(":")
}

fn format_node_launch_error(error: &std::io::Error) -> String {
    if cfg!(debug_assertions) {
        let node_bin = resolve_node_binary();
        format!("Failed to spawn Node bridge. Is node installed?\nTried: {node_bin}\n\n{error}")
    } else {
        format!("Failed to spawn bundled Node bridge runtime: {error}")
    }
}

fn build_node_command<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bridge_cwd: &Path,
) -> Result<Command, String> {
    let augmented_path = build_augmented_path();
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
    command.env("PATH", &augmented_path);
    Ok(command)
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
    let order = event.get("order").and_then(|value| value.as_u64());

    if let Some(existing) = current.reasoning.iter_mut().find(|block| {
        block
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == block_id)
            .unwrap_or(false)
    }) {
        let next_content = format!(
            "{}{}",
            existing
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            delta
        );
        *existing = serde_json::json!({
            "id": block_id,
            "kind": kind,
            "content": next_content,
            "order": order,
        });
        return;
    }

    current.reasoning.push(serde_json::json!({
        "id": block_id,
        "kind": kind,
        "content": delta,
        "order": order,
    }));
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
        let next_content = format!(
            "{}{}",
            existing
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            delta
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
        "content": delta,
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

fn spawn_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    store: &AgentTaskStore,
    payload: serde_json::Value,
) -> Result<String, String> {
    let bridge_path = resolve_bridge_script_path(&app, "ipc.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let mut child = build_node_command(&app, &bridge_cwd)?
        .arg(bridge_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format_node_launch_error(&error))?;

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

    let task_id = format!("task-{}", NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed));
    let snapshot = Arc::new(Mutex::new(AgentTaskSnapshot {
        id: task_id.clone(),
        status: "queued".into(),
        message: None,
        phase_outputs: Vec::new(),
        tool_events: Vec::new(),
        appended_inputs: Vec::new(),
        task_tree: Vec::new(),
        reasoning: Vec::new(),
        usage: None,
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
        error: None,
        error_info: None,
        error_code: None,
        error_source: None,
        raw_error: None,
    }));

    let handle = AgentTaskHandle {
        child: Arc::new(Mutex::new(Some(child))),
        stdin: Arc::new(Mutex::new(stdin)),
        snapshot: snapshot.clone(),
    };

    {
        let mut tasks = store
            .tasks
            .lock()
            .map_err(|_| "Failed to lock task store.".to_string())?;
        tasks.insert(task_id.clone(), handle.clone());
    }

    // 共享 stderr 缓冲区：stderr 线程写入，stdout 线程退出时读取
    let stderr_buffer_for_stderr: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = stderr_buffer_for_stderr.clone();

    let stdout_snapshot = snapshot.clone();
    let stdout_stdin = handle.stdin.clone();
    let stdout_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                with_snapshot(&stdout_snapshot, |current| {
                    current.status = "failed".into();
                    current.error = Some(format!("Failed to parse bridge event: {line}"));
                });
                break;
            };

            match event.get("type").and_then(|value| value.as_str()) {
                Some("started") => with_snapshot(&stdout_snapshot, |current| {
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
                    match event.get("target").and_then(|value| value.as_str()) {
                        Some("phase") => append_phase_output_delta(current, &event),
                        _ => {
                            let mut next_message = current.message.clone().unwrap_or_default();
                            next_message.push_str(delta);
                            current.message = Some(next_message);
                        }
                    }
                }),
                Some("reasoning_delta") => with_snapshot(&stdout_snapshot, |current| {
                    append_reasoning_delta(current, &event);
                }),
                Some("usage") => with_snapshot(&stdout_snapshot, |current| {
                    current.usage = extract_object(event.get("usage"));
                }),
                Some("tool_event") => with_snapshot(&stdout_snapshot, |current| {
                    if let Some(tool_event) = event.get("event") {
                        merge_tool_event(current, tool_event);
                    }
                }),
                Some("appended_inputs") => with_snapshot(&stdout_snapshot, |current| {
                    current.appended_inputs = extract_array(event.get("inputs"));
                }),
                Some("task_tree") => with_snapshot(&stdout_snapshot, |current| {
                    current.task_tree = extract_array(event.get("tree"));
                }),
                Some("runtime_status") => with_snapshot(&stdout_snapshot, |current| {
                    current.phase = event
                        .get("phase")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    current.phase_started_at =
                        event.get("phaseStartedAt").and_then(|value| value.as_u64());
                    current.last_heartbeat_at =
                        event.get("lastHeartbeatAt").and_then(|value| value.as_u64());
                    current.last_progress_at =
                        event.get("lastProgressAt").and_then(|value| value.as_u64());
                    current.stalled = event.get("stalled").and_then(|value| value.as_bool());
                }),
                Some("approval_required") => with_snapshot(&stdout_snapshot, |current| {
                    current.status = "awaiting_approval".into();
                    current.phase = Some("awaiting_approval".into());
                    current.pending_approval = event.get("request").cloned();
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
                    current.status = "completed".into();
                    current.pending_approval = None;
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
                        current.usage = extract_object(result.get("usage"));
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
                }),
                Some("failed") => with_snapshot(&stdout_snapshot, |current| {
                    current.status = "failed".into();
                    current.pending_approval = None;
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
        let collected_stderr = stderr_buffer.lock().unwrap_or_else(|e| e.into_inner()).clone();
        with_snapshot(&stdout_snapshot, |current| {
            if current.status == "running" || current.status == "queued" || current.status == "awaiting_approval" {
                current.status = "failed".into();
                let stderr_message = collected_stderr.trim().to_string();
                current.error = Some(if stderr_message.is_empty() {
                    "Node 桥接进程已断开。这可能是由于网络错误或脚本执行异常导致的崩溃。".into()
                } else {
                    stderr_message
                });
            }
        });
    });

    let stderr_buf_for_thread = stderr_buffer_for_stderr.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
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
fn run_provider_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let script_path = resolve_bridge_script_path(&app, "providerActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let output = build_node_command(&app, &bridge_cwd)?
        .arg(script_path)
        .arg(
            serde_json::to_string(&payload)
                .map_err(|error| format!("Failed to serialize provider action payload: {error}"))?,
        )
        .output()
        .map_err(|error| format!("Failed to run provider action bridge: {}", format_node_launch_error(&error)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Provider action failed.".into()
        } else {
            stderr
        });
    }

    serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse provider action response: {error}"))
}

#[tauri::command]
async fn run_mcp_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let script_path = resolve_bridge_script_path(&app, "mcpActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("Failed to serialize MCP action payload: {error}"))?;
    let app_handle = app.clone();

    let output = tauri::async_runtime::spawn_blocking(move || -> Result<std::process::Output, String> {
        build_node_command(&app_handle, &bridge_cwd)?
            .arg(script_path)
            .arg(payload_json)
            .output()
            .map_err(|error| format_node_launch_error(&error))
    })
    .await
    .map_err(|error| format!("Failed to join MCP action task: {error}"))?
    .map_err(|error| format!("Failed to run MCP action bridge: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "MCP action failed.".into()
        } else {
            stderr
        });
    }

    serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse MCP action response: {error}"))
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
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
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
fn respond_to_agent_approval(
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
        "decision": decision,
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

    Ok(())
}

#[tauri::command]
fn append_input_to_agent_task(
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

    {
        let mut snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| "Failed to lock task snapshot.".to_string())?;
        snapshot.appended_inputs.push(serde_json::json!({
            "id": input.get("id").and_then(|value| value.as_str()).unwrap_or_default(),
            "content": input.get("content").and_then(|value| value.as_str()).unwrap_or_default(),
            "parts": input.get("parts").cloned().unwrap_or(serde_json::Value::Array(Vec::new())),
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
        "input": input,
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

    Ok(())
}

#[tauri::command]
fn cancel_agent_task_step(state: State<'_, AgentTaskStore>, task_id: String) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };

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

    Ok(())
}

#[tauri::command]
fn abort_agent_task(state: State<'_, AgentTaskStore>, task_id: String) -> Result<(), String> {
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "Failed to lock task store.".to_string())?;
    let Some(handle) = tasks.get(&task_id) else {
        return Err(format!("Agent task not found: {task_id}"));
    };

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
        {
            snapshot.status = "failed".into();
            snapshot.error = Some("任务已被用户强行终止。".into());
        }
    }

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
            "SELECT id, title, provider_profile_id, provider, model, folder_id, workspace_path, workspace_root, workspace_mode, updated_at
             FROM sessions
             ORDER BY updated_at DESC",
        )
        .map_err(|error| format!("Failed to prepare sessions query: {error}"))?;

    let session_rows = sessions_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })
        .map_err(|error| format!("Failed to read sessions from SQLite: {error}"))?;

    let mut sessions = Vec::new();

    for session_row in session_rows {
        let (
            session_id,
            title,
            provider_profile_id,
            provider,
            model,
            folder_id,
            workspace_path,
            workspace_root,
            workspace_mode,
            updated_at,
        ) = session_row.map_err(|error| format!("Failed to decode session row: {error}"))?;

        let mut messages_statement = connection
            .prepare(
                "SELECT id, role, linked_message_id, sort_index, active_version_index, created_at, updated_at
                 FROM messages
                 WHERE session_id = ?1
                 ORDER BY sort_index ASC",
            )
            .map_err(|error| format!("Failed to prepare messages query: {error}"))?;

        let message_rows = messages_statement
            .query_map(params![session_id.clone()], |row| {
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

            let mut versions_statement = connection
                .prepare(
                    "SELECT version_index, content, parts_json, status, created_at, attachments_json, reasoning_json, usage_json,
                            capability_snapshot_json, activity_json, events_json, steps_json, error, error_info_json, appended_inputs_json,
                            agent_mode, route_decision_json, completion_state, evidence_summary_json, delivery_note, model_info_json
                     FROM message_versions
                     WHERE message_id = ?1
                     ORDER BY version_index ASC",
                )
                .map_err(|error| format!("Failed to prepare message versions query: {error}"))?;

            let version_rows = versions_statement
                .query_map(params![message_id.clone()], |row| {
                    Ok(serde_json::json!({
                        "content": row.get::<_, String>(1)?,
                        "parts": parse_json_array_column(row.get::<_, String>(2)?),
                        "status": row.get::<_, Option<String>>(3)?,
                        "createdAt": row.get::<_, i64>(4)?,
                        "attachments": parse_json_array_column(row.get::<_, String>(5)?),
                        "reasoning": parse_json_array_column(row.get::<_, String>(6)?),
                        "usage": parse_json_column(row.get::<_, Option<String>>(7)?),
                        "capabilitySnapshot": parse_json_object_column(row.get::<_, Option<String>>(8)?),
                        "activity": parse_json_object_column(row.get::<_, Option<String>>(9)?),
                        "events": parse_json_array_column(row.get::<_, String>(10)?),
                        "steps": parse_json_array_column(row.get::<_, String>(11)?),
                        "error": row.get::<_, Option<String>>(12)?,
                        "errorInfo": parse_json_object_column(row.get::<_, Option<String>>(13)?),
                        "appendedInputs": parse_json_array_column(row.get::<_, String>(14)?),
                        "agentMode": row.get::<_, Option<String>>(15)?,
                        "routeDecision": parse_json_object_column(row.get::<_, Option<String>>(16)?),
                        "completionState": row.get::<_, Option<String>>(17)?,
                        "evidenceSummary": parse_json_object_column(row.get::<_, Option<String>>(18)?),
                        "deliveryNote": row.get::<_, Option<String>>(19)?,
                        "modelInfo": parse_json_object_column(row.get::<_, Option<String>>(20)?),
                    }))
                })
                .map_err(|error| format!("Failed to read message versions from SQLite: {error}"))?;

            let mut versions = Vec::new();
            for version_row in version_rows {
                versions.push(
                    version_row.map_err(|error| {
                        format!("Failed to decode message version row: {error}")
                    })?,
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

        sessions.push(serde_json::json!({
            "id": session_id,
            "title": title,
            "providerProfileId": provider_profile_id,
            "provider": provider,
            "model": model,
            "folderId": folder_id,
            "workspacePath": workspace_path,
            "workspaceRoot": workspace_root,
            "workspaceMode": workspace_mode,
            "messages": messages,
            "toolEvents": [],
            "taskTree": [],
            "updatedAt": updated_at,
        }));
    }

    Ok(serde_json::json!({
        "settings": parse_json_column(settings_json),
        "sessions": sessions,
        "sessionFolders": parse_json_column(session_folders_json),
        "projectCapabilityOverrides": parse_json_column(project_overrides_json),
    }))
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
    connection
        .execute(
            "INSERT INTO sessions (
                id, title, provider_profile_id, provider, model, folder_id, workspace_path, workspace_root, workspace_mode, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                provider_profile_id = excluded.provider_profile_id,
                provider = excluded.provider,
                model = excluded.model,
                folder_id = excluded.folder_id,
                workspace_path = excluded.workspace_path,
                workspace_root = excluded.workspace_root,
                workspace_mode = excluded.workspace_mode,
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
    connection
        .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|error| format!("Failed to delete session from SQLite: {error}"))?;
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
                id, session_id, role, linked_message_id, sort_index, active_version_index, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                role = excluded.role,
                linked_message_id = excluded.linked_message_id,
                sort_index = excluded.sort_index,
                active_version_index = excluded.active_version_index,
                created_at = excluded.created_at,
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
    connection
        .execute("DELETE FROM messages WHERE id = ?1", params![message_id])
        .map_err(|error| format!("Failed to delete message from SQLite: {error}"))?;
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
    let version_id = format!("{message_id}:{version_index}");
    connection
        .execute(
            "INSERT INTO message_versions (
                id, message_id, version_index, content, parts_json, status, created_at, attachments_json, reasoning_json,
                usage_json, capability_snapshot_json, activity_json, events_json, steps_json, error, error_info_json,
                appended_inputs_json, agent_mode, route_decision_json, completion_state, evidence_summary_json, delivery_note, model_info_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
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
                model_info_json = excluded.model_info_json",
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
    connection
        .execute(
            "DELETE FROM message_versions WHERE message_id = ?1 AND version_index = ?2",
            params![message_id, version_index],
        )
        .map_err(|error| format!("Failed to delete message version from SQLite: {error}"))?;
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
fn ensure_aura_home<R: Runtime>(app: tauri::AppHandle<R>) -> Result<AuraHomeState, String> {
    ensure_aura_layout(&app)
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
    let install_dir = ensure_aura_layout(&app)?.lightpanda_dir;
    let resolved_path = match requested_path {
        Some(path) => resolve_executable_path(Path::new(path)),
        None => detect_lightpanda_installation(Path::new(&install_dir)).or_else(detect_lightpanda_path),
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

#[tauri::command]
fn read_image_preview(file_path: String) -> Result<Option<String>, String> {
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

    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read image {}: {error}", path.display()))?;

    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Image is too large to preview inline.".into());
    }

    Ok(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[tauri::command]
fn open_path_in_default_app(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Failed to open path in default app: {error}"))?;
    Ok(())
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    const MAX_SESSION_SLUG_LEN: usize = 80;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }

        if slug.len() >= MAX_SESSION_SLUG_LEN {
            break;
        }
    }

    let trimmed = slug
        .trim_matches('-')
        .chars()
        .take(MAX_SESSION_SLUG_LEN)
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
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
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

    let slug = slugify(&hint);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Failed to resolve current time: {error}"))?
        .as_secs();

    for attempt in 0..100_u32 {
        let suffix = if attempt == 0 {
            format!("{timestamp}")
        } else {
            format!("{timestamp}-{attempt}")
        };
        let candidate = root.join(format!("{slug}-{suffix}"));
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
            save_settings_sqlite,
            save_project_capability_overrides_sqlite,
            save_session_folders_sqlite,
            upsert_session_sqlite,
            delete_session_sqlite,
            upsert_message_sqlite,
            delete_message_sqlite,
            upsert_message_version_sqlite,
            delete_message_version_sqlite,
            start_agent_task,
            get_agent_task,
            abort_agent_task,
            respond_to_agent_approval,
            append_input_to_agent_task,
            cancel_agent_task_step,
            run_provider_action,
            run_mcp_action,
            ensure_aura_home,
            detect_lightpanda_runtime,
            read_aura_file,
            write_aura_file,
            read_workspace_tree,
            read_text_file,
            read_image_preview,
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
