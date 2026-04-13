#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
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
    #[serde(rename = "retryInfo")]
    retry_info: Option<serde_json::Value>,
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

#[derive(Clone)]
struct ManagedBrowserInstallHandle {
    cancel_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct ManagedBrowserInstallStore {
    current: Mutex<Option<ManagedBrowserInstallHandle>>,
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
    #[serde(rename = "browserDir")]
    browser_dir: String,
    #[serde(rename = "browserProfilesDir")]
    browser_profiles_dir: String,
    #[serde(rename = "browserRuntimesDir")]
    browser_runtimes_dir: String,
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
struct BrowserRuntimeStatusRecord {
    #[serde(rename = "systemChromeDetected")]
    system_chrome_detected: bool,
    #[serde(rename = "systemChromePath")]
    system_chrome_path: Option<String>,
    #[serde(rename = "managedChromeInstalled")]
    managed_chrome_installed: bool,
    #[serde(rename = "managedChromePath")]
    managed_chrome_path: Option<String>,
    #[serde(rename = "managedChromeSizeBytes")]
    managed_chrome_size_bytes: Option<u64>,
    #[serde(rename = "customExecutablePath")]
    custom_executable_path: Option<String>,
    #[serde(rename = "customExecutableValid")]
    custom_executable_valid: Option<bool>,
    #[serde(rename = "lastCheckedAt")]
    last_checked_at: u64,
}

#[derive(Clone, Serialize)]
struct ManagedBrowserInstallProgressPayload {
    stage: String,
    message: String,
    progress: Option<f64>,
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: Option<u64>,
    #[serde(rename = "totalBytes")]
    total_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
struct ChromeImportSource {
    id: String,
    #[serde(rename = "profileName")]
    profile_name: String,
    #[serde(rename = "profilePath")]
    profile_path: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

#[derive(Debug, Deserialize)]
struct ChromeLocalState {
    profile: Option<ChromeLocalStateProfile>,
}

#[derive(Debug, Deserialize)]
struct ChromeLocalStateProfile {
    #[serde(rename = "info_cache")]
    info_cache: Option<HashMap<String, ChromeProfileInfo>>,
}

#[derive(Debug, Deserialize)]
struct ChromeProfileInfo {
    name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PendingBrowserCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    #[serde(rename = "httpOnly")]
    http_only: bool,
    #[serde(rename = "sameSite", skip_serializing_if = "Option::is_none")]
    same_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<f64>,
}

#[derive(Clone, Serialize)]
struct ChromeImportResult {
    domain: String,
    #[serde(rename = "cookieCount")]
    cookie_count: usize,
    #[serde(rename = "importedAt")]
    imported_at: u64,
}

#[derive(Clone, Serialize)]
struct ClearAuraSiteCookiesResult {
    #[serde(rename = "removedCount")]
    removed_count: usize,
    #[serde(rename = "pendingRemovedCount")]
    pending_removed_count: usize,
}

#[derive(Clone, Serialize)]
struct ResetAuraBrowserProfileResult {
    #[serde(rename = "clearedProfile")]
    cleared_profile: bool,
    #[serde(rename = "pendingRemovedCount")]
    pending_removed_count: usize,
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
        "chromeopenurl",
        "chromegetactivetab",
        "chromerunjavascript",
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
    let browser_dir = home_dir.join("browser");
    let browser_profiles_dir = browser_dir.join("profiles");
    let browser_runtimes_dir = browser_dir.join("runtimes");
    let skills_dir = home_dir.join("skills");
    let plugins_dir = home_dir.join("plugins");
    let mcp_dir = home_dir.join("mcp");
    let workspace_dir = home_dir.join("workspace");
    let logs_dir = home_dir.join("logs");

    for dir in [
        &home_dir,
        &config_dir,
        &browser_dir,
        &browser_profiles_dir,
        &browser_runtimes_dir,
        &skills_dir,
        &plugins_dir,
        &mcp_dir,
        &workspace_dir,
        &logs_dir,
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
        browser_dir: browser_dir.display().to_string(),
        browser_profiles_dir: browser_profiles_dir.display().to_string(),
        browser_runtimes_dir: browser_runtimes_dir.display().to_string(),
        skills_dir: skills_dir.display().to_string(),
        plugins_dir: plugins_dir.display().to_string(),
        mcp_dir: mcp_dir.display().to_string(),
        workspace_dir: workspace_dir.display().to_string(),
        logs_dir: logs_dir.display().to_string(),
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

fn resolve_browser_executable_path(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    resolve_app_bundle_executable(path)
}

fn total_path_size(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return Some(metadata.len());
    }
    if !metadata.is_dir() {
        return None;
    }

    let mut total = 0_u64;
    for entry in fs::read_dir(path).ok()? {
        let entry = entry.ok()?;
        total = total.saturating_add(total_path_size(&entry.path())?);
    }
    Some(total)
}

fn detect_system_chrome_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let mut candidates = vec![
            PathBuf::from("/Applications/Google Chrome.app"),
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ];

        if let Ok(home) = resolve_user_home() {
            candidates.push(home.join("Applications/Google Chrome.app"));
            candidates
                .push(home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        }

        return candidates
            .into_iter()
            .find_map(|candidate| resolve_browser_executable_path(&candidate));
    }

    None
}

fn detect_managed_chrome_path(runtime_root: &Path, explicit_path: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = explicit_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return resolve_browser_executable_path(Path::new(path));
    }

    let mut candidates = vec![
        runtime_root.join("chrome").join("Google Chrome.app"),
        runtime_root
            .join("chrome")
            .join("Google Chrome for Testing.app"),
        runtime_root
            .join("chrome")
            .join("Google Chrome.app")
            .join("Contents/MacOS/Google Chrome"),
        runtime_root
            .join("chrome")
            .join("Google Chrome for Testing.app")
            .join("Contents/MacOS/Google Chrome for Testing"),
        runtime_root.join("chrome").join("chrome"),
        runtime_root
            .join("chrome")
            .join("chrome-mac")
            .join("Google Chrome for Testing.app"),
        runtime_root
            .join("chrome")
            .join("chrome-mac")
            .join("Google Chrome for Testing"),
    ];

    if chrome_for_testing_platform() != "unsupported" {
        let platform_dir = runtime_root
            .join("chrome")
            .join(format!("chrome-{}", chrome_for_testing_platform()));
        candidates.push(platform_dir.join("Google Chrome for Testing.app"));
        candidates.push(
            platform_dir
                .join("Google Chrome for Testing.app")
                .join("Contents/MacOS/Google Chrome for Testing"),
        );
        candidates.push(platform_dir.join("Google Chrome for Testing"));
        candidates.push(platform_dir.join("chrome"));
    }

    candidates
        .into_iter()
        .find_map(|candidate| resolve_browser_executable_path(&candidate))
}

fn managed_browser_install_cancelled_error() -> String {
    "Aura 托管浏览器安装已取消。".to_string()
}

fn ensure_managed_browser_install_not_cancelled(cancel_requested: &Arc<AtomicBool>) -> Result<(), String> {
    if cancel_requested.load(Ordering::SeqCst) {
        Err(managed_browser_install_cancelled_error())
    } else {
        Ok(())
    }
}

fn cleanup_managed_browser_runtime(runtime_root: &Path) {
    if runtime_root.exists() {
        let _ = fs::remove_dir_all(runtime_root);
    }
}

fn start_managed_browser_install(
    store: &State<'_, ManagedBrowserInstallStore>,
) -> Result<Arc<AtomicBool>, String> {
    let mut current = store
        .current
        .lock()
        .map_err(|_| "Managed browser install state is unavailable.".to_string())?;
    if current.is_some() {
        return Err("Aura 托管浏览器已经在安装中。".into());
    }

    let cancel_requested = Arc::new(AtomicBool::new(false));
    *current = Some(ManagedBrowserInstallHandle {
        cancel_requested: Arc::clone(&cancel_requested),
    });
    Ok(cancel_requested)
}

fn finish_managed_browser_install(
    store: &State<'_, ManagedBrowserInstallStore>,
    cancel_requested: &Arc<AtomicBool>,
) {
    if let Ok(mut current) = store.current.lock() {
        if current
            .as_ref()
            .map(|handle| Arc::ptr_eq(&handle.cancel_requested, cancel_requested))
            == Some(true)
        {
            *current = None;
        }
    }
}

fn emit_managed_browser_install_progress<R: Runtime>(
    app: &tauri::AppHandle<R>,
    stage: &str,
    message: impl Into<String>,
    progress: Option<f64>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let payload = ManagedBrowserInstallProgressPayload {
        stage: stage.to_string(),
        message: message.into(),
        progress: progress.map(|value| value.clamp(0.0, 1.0)),
        downloaded_bytes,
        total_bytes,
    };

    let _ = app.emit("browser-install-progress", payload);
}

fn extract_zip_archive<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bytes: &[u8],
    destination: &Path,
    cancel_requested: &Arc<AtomicBool>,
) -> Result<(), String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Failed to open browser archive: {error}"))?;
    let total_entries = archive.len();

    for index in 0..archive.len() {
        ensure_managed_browser_install_not_cancelled(cancel_requested)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read browser archive entry: {error}"))?;
        let Some(relative_path) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
            continue;
        };
        let target_path = destination.join(relative_path);

        if entry.name().ends_with('/') {
            if let Some(parent) = target_path.parent() {
                ensure_directory(parent)?;
            }
            ensure_directory(&target_path)?;
            continue;
        }

        if let Some(parent) = target_path.parent() {
            ensure_directory(parent)?;
        }

        let mut output = fs::File::create(&target_path).map_err(|error| {
            format!(
                "Failed to create extracted browser file {}: {error}",
                target_path.display()
            )
        })?;
        std::io::copy(&mut entry, &mut output).map_err(|error| {
            format!(
                "Failed to write extracted browser file {}: {error}",
                target_path.display()
            )
        })?;

        if total_entries > 0 && (index == 0 || index + 1 == total_entries || (index + 1) % 25 == 0)
        {
            emit_managed_browser_install_progress(
                app,
                "extracting",
                format!("正在解压浏览器文件（{}/{}）", index + 1, total_entries),
                Some((index + 1) as f64 / total_entries as f64),
                None,
                None,
            );
        }
    }

    Ok(())
}

fn fetch_managed_browser_download_url() -> Result<String, String> {
    if chrome_for_testing_platform() == "unsupported" {
        return Err("Managed browser installation is currently implemented for macOS only.".into());
    }

    let response = reqwest::blocking::get(
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
    )
    .map_err(|error| format!("Failed to fetch Chrome download metadata: {error}"))?
    .error_for_status()
    .map_err(|error| format!("Chrome download metadata request failed: {error}"))?;

    let payload: serde_json::Value = response
        .json()
        .map_err(|error| format!("Failed to parse Chrome download metadata: {error}"))?;

    payload["channels"]["Stable"]["downloads"]["chrome"]
        .as_array()
        .and_then(|entries| {
            entries.iter().find_map(|entry| {
                let platform = entry["platform"].as_str()?;
                let url = entry["url"].as_str()?;
                if platform == chrome_for_testing_platform() {
                    Some(url.to_string())
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| {
            "Failed to locate a Chrome for Testing download for this platform.".to_string()
        })
}

fn install_managed_browser_inner<R: Runtime>(
    app: &tauri::AppHandle<R>,
    cancel_requested: &Arc<AtomicBool>,
) -> Result<(), String> {
    let aura = ensure_aura_layout(app)?;
    let runtime_root = managed_browser_runtime_root(Path::new(&aura.browser_runtimes_dir));
    if let Some(parent) = runtime_root.parent() {
        ensure_directory(parent)?;
    }
    ensure_managed_browser_install_not_cancelled(cancel_requested)?;

    emit_managed_browser_install_progress(
        app,
        "preparing",
        "正在准备 Aura 托管浏览器安装环境…",
        Some(0.02),
        None,
        None,
    );

    emit_managed_browser_install_progress(
        app,
        "resolving-download",
        "正在获取可用的 Chrome 版本信息…",
        Some(0.08),
        None,
        None,
    );
    ensure_managed_browser_install_not_cancelled(cancel_requested)?;
    let download_url = fetch_managed_browser_download_url()?;

    emit_managed_browser_install_progress(
        app,
        "downloading",
        "正在下载 Aura 托管浏览器…",
        Some(0.12),
        Some(0),
        None,
    );
    ensure_managed_browser_install_not_cancelled(cancel_requested)?;
    let mut response = reqwest::blocking::get(&download_url)
        .map_err(|error| format!("Failed to download managed browser: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Managed browser download failed: {error}"))?;

    let total_bytes = response.content_length();
    let mut archive_bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded_bytes = 0_u64;
    loop {
        ensure_managed_browser_install_not_cancelled(cancel_requested).inspect_err(|_| {
            cleanup_managed_browser_runtime(&runtime_root);
        })?;
        let bytes_read = response
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read managed browser archive: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        archive_bytes.extend_from_slice(&buffer[..bytes_read]);
        downloaded_bytes = downloaded_bytes.saturating_add(bytes_read as u64);
        let progress = total_bytes
            .filter(|total| *total > 0)
            .map(|total| downloaded_bytes as f64 / total as f64);
        emit_managed_browser_install_progress(
            app,
            "downloading",
            if let Some(total) = total_bytes {
                format!(
                    "正在下载 Aura 托管浏览器（{} / {}）",
                    human_readable_size(downloaded_bytes),
                    human_readable_size(total),
                )
            } else {
                format!(
                    "正在下载 Aura 托管浏览器（已下载 {}）",
                    human_readable_size(downloaded_bytes)
                )
            },
            progress.map(|value| 0.12 + value * 0.58).or(Some(0.2)),
            Some(downloaded_bytes),
            total_bytes,
        );
    }

    if runtime_root.exists() {
        fs::remove_dir_all(&runtime_root).map_err(|error| {
            format!(
                "Failed to clear old managed browser runtime {}: {error}",
                runtime_root.display()
            )
        })?;
    }
    ensure_directory(&runtime_root)?;

    ensure_managed_browser_install_not_cancelled(cancel_requested).inspect_err(|_| {
        cleanup_managed_browser_runtime(&runtime_root);
    })?;
    emit_managed_browser_install_progress(
        app,
        "extracting",
        "下载完成，正在解压浏览器文件…",
        Some(0.74),
        Some(downloaded_bytes),
        total_bytes,
    );

    if let Err(error) = extract_zip_archive(app, &archive_bytes, &runtime_root, cancel_requested) {
        if error == managed_browser_install_cancelled_error() {
            cleanup_managed_browser_runtime(&runtime_root);
        }
        return Err(error);
    }

    ensure_managed_browser_install_not_cancelled(cancel_requested).inspect_err(|_| {
        cleanup_managed_browser_runtime(&runtime_root);
    })?;
    emit_managed_browser_install_progress(
        app,
        "verifying",
        "正在验证托管浏览器是否可用…",
        Some(0.96),
        Some(downloaded_bytes),
        total_bytes,
    );
    Ok(())
}

fn human_readable_size(value: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut size = value as f64;
    let mut unit_index = 0_usize;

    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 || size >= 100.0 {
        format!("{:.0} {}", size, UNITS[unit_index])
    } else {
        format!("{:.1} {}", size, UNITS[unit_index])
    }
}

fn chrome_profile_name_map() -> HashMap<String, String> {
    let local_state_path = chrome_user_data_root()
        .map(|root| root.join("Local State"))
        .ok();

    let Some(local_state_path) = local_state_path else {
        return HashMap::new();
    };

    let Ok(content) = fs::read_to_string(local_state_path) else {
        return HashMap::new();
    };

    let Ok(parsed) = serde_json::from_str::<ChromeLocalState>(&content) else {
        return HashMap::new();
    };

    parsed
        .profile
        .and_then(|profile| profile.info_cache)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| {
            let name = value.name.unwrap_or_default().trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some((key, name))
            }
        })
        .collect()
}

fn pending_cookie_imports_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(PathBuf::from(ensure_aura_layout(app)?.browser_dir).join("pending-cookie-imports.json"))
}

fn chrome_safe_storage_password() -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-w", "-s", "Chrome Safe Storage"])
        .output()
        .map_err(|error| format!("Failed to access macOS keychain for Chrome cookies: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        return Err("Chrome Safe Storage password is empty.".into());
    }

    Ok(password)
}

fn decrypt_chrome_cookie_value(
    encrypted_value: &[u8],
    safe_storage_password: &str,
) -> Result<String, String> {
    if encrypted_value.is_empty() {
        return Ok(String::new());
    }

    let payload = if encrypted_value.starts_with(b"v10") || encrypted_value.starts_with(b"v11") {
        &encrypted_value[3..]
    } else {
        encrypted_value
    };

    let mut key = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(
        safe_storage_password.as_bytes(),
        b"saltysalt",
        1003,
        &mut key,
    );
    let iv = [b' '; 16];
    let mut buffer = payload.to_vec();
    let decrypted = cbc::Decryptor::<Aes128>::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|error| format!("Failed to decrypt Chrome cookie value: {error}"))?;

    String::from_utf8(decrypted.to_vec())
        .map_err(|error| format!("Decrypted Chrome cookie value was not valid UTF-8: {error}"))
}

fn chrome_epoch_to_unix_seconds(value: i64) -> Option<f64> {
    if value <= 0 {
        return None;
    }

    let unix_seconds = (value as f64 / 1_000_000.0) - 11_644_473_600.0;
    if unix_seconds.is_finite() && unix_seconds > 0.0 {
        Some(unix_seconds)
    } else {
        None
    }
}

fn chrome_same_site_label(value: i64) -> Option<String> {
    match value {
        1 => Some("None".to_string()),
        2 => Some("Lax".to_string()),
        3 => Some("Strict".to_string()),
        _ => None,
    }
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    let normalized_host = host.trim_start_matches('.').to_ascii_lowercase();
    let normalized_domain = domain.trim_start_matches('.').to_ascii_lowercase();

    normalized_host == normalized_domain
        || normalized_host.ends_with(&format!(".{normalized_domain}"))
}

fn load_pending_cookie_imports<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<PendingBrowserCookie>, String> {
    let path = pending_cookie_imports_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read pending cookie imports {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str::<Vec<PendingBrowserCookie>>(&content).map_err(|error| {
        format!(
            "Failed to parse pending cookie imports {}: {error}",
            path.display()
        )
    })
}

fn save_pending_cookie_imports<R: Runtime>(
    app: &tauri::AppHandle<R>,
    cookies: &[PendingBrowserCookie],
) -> Result<(), String> {
    let path = pending_cookie_imports_path(app)?;
    if let Some(parent) = path.parent() {
        ensure_directory(parent)?;
    }
    let content = serde_json::to_string_pretty(cookies)
        .map_err(|error| format!("Failed to serialize pending cookie imports: {error}"))?;
    fs::write(&path, content).map_err(|error| {
        format!(
            "Failed to write pending cookie imports {}: {error}",
            path.display()
        )
    })
}

fn remove_pending_site_cookie_imports<R: Runtime>(
    app: &tauri::AppHandle<R>,
    domain: &str,
) -> Result<usize, String> {
    let mut pending = load_pending_cookie_imports(app)?;
    let original_len = pending.len();
    pending.retain(|cookie| !host_matches_domain(&cookie.domain, domain));
    if pending.len() == original_len {
        return Ok(0);
    }
    save_pending_cookie_imports(app, &pending)?;
    Ok(original_len - pending.len())
}

fn clear_pending_cookie_imports<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<usize, String> {
    let path = pending_cookie_imports_path(app)?;
    if !path.exists() {
        return Ok(0);
    }

    let pending = load_pending_cookie_imports(app)?;
    fs::remove_file(&path).map_err(|error| {
        format!(
            "Failed to remove pending cookie imports {}: {error}",
            path.display()
        )
    })?;
    Ok(pending.len())
}

fn resolve_aura_browser_profile_target<R: Runtime>(
    app: &tauri::AppHandle<R>,
    aura_profile_path: Option<String>,
) -> Result<PathBuf, String> {
    let aura = ensure_aura_layout(app)?;
    let profiles_root = PathBuf::from(&aura.browser_profiles_dir);
    let browser_root = PathBuf::from(&aura.browser_dir);
    let target = aura_profile_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| profiles_root.join("default"));

    if !target.starts_with(&profiles_root) || target == profiles_root || target == browser_root {
        return Err(format!(
            "Refusing to modify browser profile outside Aura profiles directory: {}",
            target.display()
        ));
    }

    Ok(target)
}

fn managed_browser_runtime_root(runtime_root: &Path) -> PathBuf {
    runtime_root.join("chrome")
}

fn chrome_for_testing_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "mac-arm64"
    }

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        "mac-x64"
    }

    #[cfg(not(target_os = "macos"))]
    {
        "unsupported"
    }
}

fn chrome_user_data_root() -> Result<PathBuf, String> {
    Ok(resolve_user_home()?
        .join("Library")
        .join("Application Support")
        .join("Google")
        .join("Chrome"))
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
        retry_info: None,
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
                Some("approval_required") => with_snapshot(&stdout_snapshot, |current| {
                    current.status = "awaiting_approval".into();
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

    let mut sessions_statement = connection
        .prepare(
            "SELECT id, title, provider_profile_id, provider, model, workspace_path, workspace_root, workspace_mode, updated_at
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
                row.get::<_, i64>(8)?,
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
                            capability_snapshot_json, activity_json, events_json, steps_json, error, error_info_json, appended_inputs_json, model_info_json
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
                        "modelInfo": parse_json_object_column(row.get::<_, Option<String>>(15)?),
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
fn upsert_session_sqlite<R: Runtime>(
    app: tauri::AppHandle<R>,
    session: serde_json::Value,
) -> Result<(), String> {
    let connection = open_app_db(&app)?;
    connection
        .execute(
            "INSERT INTO sessions (
                id, title, provider_profile_id, provider, model, workspace_path, workspace_root, workspace_mode, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                provider_profile_id = excluded.provider_profile_id,
                provider = excluded.provider,
                model = excluded.model,
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
                appended_inputs_json, model_info_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
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
fn detect_browser_runtime<R: Runtime>(
    app: tauri::AppHandle<R>,
    custom_executable_path: Option<String>,
    managed_executable_path: Option<String>,
) -> Result<BrowserRuntimeStatusRecord, String> {
    let aura = ensure_aura_layout(&app)?;
    let runtime_root = PathBuf::from(aura.browser_runtimes_dir);

    let system_chrome_path = detect_system_chrome_path();
    let managed_chrome_path =
        detect_managed_chrome_path(&runtime_root, managed_executable_path.as_deref());

    let custom_path_input = custom_executable_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let custom_resolved_path =
        custom_path_input.and_then(|value| resolve_browser_executable_path(Path::new(value)));

    Ok(BrowserRuntimeStatusRecord {
        system_chrome_detected: system_chrome_path.is_some(),
        system_chrome_path: system_chrome_path
            .as_ref()
            .map(|path| canonical_display_path(path)),
        managed_chrome_installed: managed_chrome_path.is_some(),
        managed_chrome_path: managed_chrome_path
            .as_ref()
            .map(|path| canonical_display_path(path)),
        managed_chrome_size_bytes: {
            let managed_root = managed_browser_runtime_root(&runtime_root);
            if managed_root.exists() {
                total_path_size(&managed_root)
            } else {
                managed_chrome_path
                    .as_ref()
                    .and_then(|path| total_path_size(path))
            }
        },
        custom_executable_path: custom_resolved_path
            .as_ref()
            .map(|path| canonical_display_path(path))
            .or_else(|| custom_path_input.map(String::from)),
        custom_executable_valid: custom_path_input.map(|_| custom_resolved_path.is_some()),
        last_checked_at: current_timestamp_ms(),
    })
}

#[tauri::command]
async fn install_managed_browser<R: Runtime>(
    app: tauri::AppHandle<R>,
    install_store: State<'_, ManagedBrowserInstallStore>,
) -> Result<BrowserRuntimeStatusRecord, String> {
    let cancel_requested = start_managed_browser_install(&install_store)?;

    let app_for_task = app.clone();
    let cancel_for_task = Arc::clone(&cancel_requested);
    let install_result = tauri::async_runtime::spawn_blocking(move || {
        match install_managed_browser_inner(&app_for_task, &cancel_for_task) {
            Ok(()) => {
                let status = detect_browser_runtime(app_for_task.clone(), None, None)?;
                emit_managed_browser_install_progress(
                    &app_for_task,
                    "completed",
                    "Aura 托管浏览器安装完成。",
                    Some(1.0),
                    None,
                    None,
                );
                Ok(status)
            }
            Err(error) => {
                let stage = if error == managed_browser_install_cancelled_error() {
                    "cancelled"
                } else {
                    "failed"
                };
                emit_managed_browser_install_progress(
                    &app_for_task,
                    stage,
                    error.clone(),
                    None,
                    None,
                    None,
                );
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("Managed browser install task failed: {error}"));

    finish_managed_browser_install(&install_store, &cancel_requested);

    install_result?
}

#[tauri::command]
fn cancel_managed_browser_install(
    install_store: State<'_, ManagedBrowserInstallStore>,
) -> Result<(), String> {
    let current = install_store
        .current
        .lock()
        .map_err(|_| "Managed browser install state is unavailable.".to_string())?;
    let Some(handle) = current.as_ref() else {
        return Err("当前没有正在进行的 Aura 托管浏览器安装。".into());
    };

    handle.cancel_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn uninstall_managed_browser<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<BrowserRuntimeStatusRecord, String> {
    let aura = ensure_aura_layout(&app)?;
    let runtime_root = managed_browser_runtime_root(Path::new(&aura.browser_runtimes_dir));
    if runtime_root.exists() {
        fs::remove_dir_all(&runtime_root).map_err(|error| {
            format!(
                "Failed to remove managed browser runtime {}: {error}",
                runtime_root.display()
            )
        })?;
    }
    detect_browser_runtime(app, None, None)
}

#[tauri::command]
fn discover_chrome_import_sources() -> Result<Vec<ChromeImportSource>, String> {
    let chrome_root = chrome_user_data_root()?;
    if !chrome_root.exists() {
        return Ok(Vec::new());
    }

    let profile_names = chrome_profile_name_map();
    let mut sources = fs::read_dir(&chrome_root)
        .map_err(|error| {
            format!(
                "Failed to read Chrome user data directory {}: {error}",
                chrome_root.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let directory_name = path.file_name()?.to_str()?.to_string();
            let is_profile_dir =
                directory_name == "Default" || directory_name.starts_with("Profile ");
            if !is_profile_dir {
                return None;
            }

            let profile_name = profile_names
                .get(&directory_name)
                .cloned()
                .unwrap_or_else(|| {
                    if directory_name == "Default" {
                        "Default".to_string()
                    } else {
                        directory_name.clone()
                    }
                });

            Some(ChromeImportSource {
                id: directory_name.clone(),
                profile_name,
                profile_path: path.display().to_string(),
                is_default: directory_name == "Default",
            })
        })
        .collect::<Vec<_>>();

    sources.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.profile_name.cmp(&right.profile_name))
    });

    Ok(sources)
}

#[tauri::command]
fn import_chrome_site_cookies<R: Runtime>(
    app: tauri::AppHandle<R>,
    source_profile_path: String,
    domain: String,
) -> Result<ChromeImportResult, String> {
    let normalized_domain = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if normalized_domain.is_empty() {
        return Err("Import domain cannot be empty.".into());
    }

    let cookies_db = PathBuf::from(&source_profile_path).join("Cookies");
    if !cookies_db.exists() {
        return Err(format!(
            "Chrome cookie database not found: {}",
            cookies_db.display()
        ));
    }

    let temp_db = std::env::temp_dir().join(format!(
        "aura-chrome-cookies-{}-{}.sqlite",
        normalized_domain,
        current_timestamp_ms()
    ));
    fs::copy(&cookies_db, &temp_db)
        .map_err(|error| format!("Failed to copy Chrome cookie database: {error}"))?;

    let safe_storage_password = chrome_safe_storage_password()?;
    let connection = Connection::open(&temp_db)
        .map_err(|error| format!("Failed to open copied Chrome cookie database: {error}"))?;

    let mut statement = connection
        .prepare(
            "SELECT host_key, path, name, value, encrypted_value, expires_utc, is_secure, is_httponly, has_expires, same_site
             FROM cookies",
        )
        .map_err(|error| format!("Failed to query Chrome cookie database: {error}"))?;

    let mut rows = statement
        .query([])
        .map_err(|error| format!("Failed to iterate Chrome cookie database rows: {error}"))?;

    let mut imported_cookies = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read Chrome cookie row: {error}"))?
    {
        let host_key: String = row.get(0).unwrap_or_default();
        if !host_matches_domain(&host_key, &normalized_domain) {
            continue;
        }

        let name: String = row.get(2).unwrap_or_default();
        if name.trim().is_empty() {
            continue;
        }

        let plaintext_value: String = row.get(3).unwrap_or_default();
        let encrypted_value: Vec<u8> = row.get(4).unwrap_or_default();
        let value = if !plaintext_value.is_empty() {
            plaintext_value
        } else if !encrypted_value.is_empty() {
            decrypt_chrome_cookie_value(&encrypted_value, &safe_storage_password)?
        } else {
            String::new()
        };

        imported_cookies.push(PendingBrowserCookie {
            name,
            value,
            domain: host_key,
            path: row.get::<_, String>(1).unwrap_or_else(|_| "/".to_string()),
            secure: row.get::<_, i64>(6).unwrap_or(0) != 0,
            http_only: row.get::<_, i64>(7).unwrap_or(0) != 0,
            same_site: chrome_same_site_label(row.get::<_, i64>(9).unwrap_or(0)),
            expires: if row.get::<_, i64>(8).unwrap_or(0) != 0 {
                chrome_epoch_to_unix_seconds(row.get::<_, i64>(5).unwrap_or(0))
            } else {
                None
            },
        });
    }

    let _ = fs::remove_file(&temp_db);

    if imported_cookies.is_empty() {
        return Err(format!(
            "No Chrome cookies were found for domain {normalized_domain}."
        ));
    }

    let mut pending = load_pending_cookie_imports(&app)?;
    pending.retain(|cookie| !host_matches_domain(&cookie.domain, &normalized_domain));
    pending.extend(imported_cookies.clone());
    save_pending_cookie_imports(&app, &pending)?;

    Ok(ChromeImportResult {
        domain: normalized_domain,
        cookie_count: imported_cookies.len(),
        imported_at: current_timestamp_ms(),
    })
}

#[tauri::command]
fn clear_aura_site_cookies<R: Runtime>(
    app: tauri::AppHandle<R>,
    domain: String,
    browser_source: String,
    executable_path: Option<String>,
    managed_executable_path: Option<String>,
    aura_profile_path: Option<String>,
) -> Result<ClearAuraSiteCookiesResult, String> {
    let normalized_domain = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if normalized_domain.is_empty() {
        return Err("Domain cannot be empty when clearing Aura site cookies.".into());
    }

    let pending_removed_count = remove_pending_site_cookie_imports(&app, &normalized_domain)?;
    let script_path = resolve_bridge_script_path(&app, "browserProfileActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let payload = serde_json::json!({
        "action": "clear-site-cookies",
        "domain": normalized_domain,
        "settings": {
            "browser": {
                "enabled": true,
                "source": browser_source,
                "executablePath": executable_path,
                "managedExecutablePath": managed_executable_path,
                "auraProfilePath": aura_profile_path,
                "headlessByDefault": true,
                "search": {
                    "engine": "google",
                    "region": "auto",
                    "language": "auto",
                    "safeSearch": "moderate"
                },
                "behavior": {
                    "acceptLanguage": "auto",
                    "timezone": "system",
                    "locale": "system",
                    "colorScheme": "system",
                    "userAgentMode": "default"
                }
            }
        }
    });

    let output = build_node_command(&app, &bridge_cwd)?
        .arg(script_path)
        .arg(serde_json::to_string(&payload).map_err(|error| {
            format!("Failed to serialize browser profile action payload: {error}")
        })?)
        .output()
        .map_err(|error| format!("Failed to run browser profile action bridge: {}", format_node_launch_error(&error)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Clearing Aura site cookies failed.".into()
        } else {
            stderr
        });
    }

    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse browser profile action response: {error}"))?;
    let removed_count = parsed["removedCount"].as_u64().unwrap_or(0) as usize;

    Ok(ClearAuraSiteCookiesResult {
        removed_count,
        pending_removed_count,
    })
}

#[tauri::command]
fn reset_aura_site_sessions<R: Runtime>(
    app: tauri::AppHandle<R>,
    browser_source: String,
    executable_path: Option<String>,
    managed_executable_path: Option<String>,
    aura_profile_path: Option<String>,
) -> Result<ClearAuraSiteCookiesResult, String> {
    let pending_removed_count = clear_pending_cookie_imports(&app)?;
    let script_path = resolve_bridge_script_path(&app, "browserProfileActions.mjs")?;
    let bridge_cwd = resolve_bridge_cwd(&app)?;
    let payload = serde_json::json!({
        "action": "clear-all-cookies",
        "settings": {
            "browser": {
                "enabled": true,
                "source": browser_source,
                "executablePath": executable_path,
                "managedExecutablePath": managed_executable_path,
                "auraProfilePath": aura_profile_path,
                "headlessByDefault": true,
                "search": {
                    "engine": "google",
                    "region": "auto",
                    "language": "auto",
                    "safeSearch": "moderate"
                },
                "behavior": {
                    "acceptLanguage": "auto",
                    "timezone": "system",
                    "locale": "system",
                    "colorScheme": "system",
                    "userAgentMode": "default"
                }
            }
        }
    });

    let output = build_node_command(&app, &bridge_cwd)?
        .arg(script_path)
        .arg(serde_json::to_string(&payload).map_err(|error| {
            format!("Failed to serialize browser profile action payload: {error}")
        })?)
        .output()
        .map_err(|error| format!("Failed to run browser profile action bridge: {}", format_node_launch_error(&error)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Resetting Aura site sessions failed.".into()
        } else {
            stderr
        });
    }

    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Failed to parse browser profile action response: {error}"))?;
    let removed_count = parsed["removedCount"].as_u64().unwrap_or(0) as usize;

    Ok(ClearAuraSiteCookiesResult {
        removed_count,
        pending_removed_count,
    })
}

#[tauri::command]
fn reset_aura_browser_profile<R: Runtime>(
    app: tauri::AppHandle<R>,
    aura_profile_path: Option<String>,
) -> Result<ResetAuraBrowserProfileResult, String> {
    let profile_path = resolve_aura_browser_profile_target(&app, aura_profile_path)?;
    let pending_removed_count = clear_pending_cookie_imports(&app)?;
    let cleared_profile = profile_path.exists();

    if cleared_profile {
        fs::remove_dir_all(&profile_path).map_err(|error| {
            format!(
                "Failed to clear Aura browser profile {}: {error}",
                profile_path.display()
            )
        })?;
    }

    ensure_directory(&profile_path)?;

    Ok(ResetAuraBrowserProfileResult {
        cleared_profile,
        pending_removed_count,
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

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-').to_string();
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
fn delete_workspace_directory(workspace_path: String) -> Result<(), String> {
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
        .manage(ManagedBrowserInstallStore::default())
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
            detect_browser_runtime,
            install_managed_browser,
            cancel_managed_browser_install,
            uninstall_managed_browser,
            discover_chrome_import_sources,
            import_chrome_site_cookies,
            clear_aura_site_cookies,
            reset_aura_site_sessions,
            reset_aura_browser_profile,
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
