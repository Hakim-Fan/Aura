#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, Runtime, State};
use base64::{engine::general_purpose::STANDARD, Engine as _};

static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Default)]
struct AgentTaskSnapshot {
    id: String,
    status: String,
    message: Option<String>,
    #[serde(rename = "toolEvents")]
    tool_events: Vec<serde_json::Value>,
    #[serde(rename = "taskTree")]
    task_tree: Vec<serde_json::Value>,
    reasoning: Vec<serde_json::Value>,
    usage: Option<serde_json::Value>,
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
    #[serde(rename = "settingsPath")]
    settings_path: String,
    #[serde(rename = "sessionsPath")]
    sessions_path: String,
    #[serde(rename = "mcpServersPath")]
    mcp_servers_path: String,
    skills: Vec<AuraAssetMetadata>,
    plugins: Vec<AuraAssetMetadata>,
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
        return (
            false,
            Some("当前只支持 .mjs / .js 作为插件入口。".into()),
        );
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
        Some("已发现插件入口，但它不是 Aura 当前支持的工具插件格式。需要导出 plugin 对象及 tools。".into()),
    )
}

fn resolve_plugin_entry(dir: &Path, manifest_content: Option<&str>) -> (Option<PathBuf>, Option<String>) {
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

fn scan_aura_assets<R: Runtime>(app: &tauri::AppHandle<R>, dir: &Path, kind: &str) -> Result<Vec<AuraAssetMetadata>, String> {
    let mut assets = Vec::new();
    let bundled_dir = resolve_default_asset_dir(app, kind).ok();

    let entries = fs::read_dir(dir)
        .map_err(|error| format!("Failed to read Aura asset directory {}: {error}", dir.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let (id, name, description, content_path, entry_path, supported, support_message, readonly) = if kind == "skills" {
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
                let readonly = bundled_dir.as_ref().map(|bundled| bundled.join(path.file_name().unwrap()).exists()).unwrap_or(false);
                (id, name, description, path.clone(), Some(path.clone()), true, None, readonly)
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
                let readonly = bundled_dir.as_ref().map(|bundled| bundled.join(path.file_name().unwrap()).exists()).unwrap_or(false);
                (id, name, description, skill_path.clone(), Some(skill_path), true, None, readonly)
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
                let readonly = bundled_dir.as_ref().map(|bundled| bundled.join(path.file_name().unwrap()).exists()).unwrap_or(false);
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

                let readonly = bundled_dir.as_ref().map(|bundled| bundled.join(path.file_name().unwrap()).exists()).unwrap_or(false);
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
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../{dir_name}"));
    if dev_dir.exists() {
        return dev_dir
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize default {dir_name} directory: {error}"));
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

fn seed_directory_from_defaults<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dir_name: &str,
    target_dir: &Path,
) -> Result<(), String> {
    ensure_directory(target_dir)?;
    let source_dir = resolve_default_asset_dir(app, dir_name)?;
    let entries = fs::read_dir(&source_dir)
        .map_err(|error| format!("Failed to read bundled {dir_name} directory {}: {error}", source_dir.display()))?;

    for entry in entries.flatten() {
        let source_path = entry.path();
        if !source_path.is_file() {
            continue;
        }
        let Some(file_name) = source_path.file_name() else {
            continue;
        };
        let target_path = target_dir.join(file_name);
        if target_path.exists() {
            continue;
        }
        fs::copy(&source_path, &target_path).map_err(|error| {
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

    for dir in [
        &home_dir,
        &config_dir,
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

fn resolve_aura_relative_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let sanitized = relative_path.trim().trim_start_matches('/');
    if sanitized.is_empty() {
        return Err("Aura relative path must not be empty.".into());
    }

    let candidate = ensure_aura_layout(app)?
        .home_dir;
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
    let dev_bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../bridge/{script_name}"));
    if dev_bridge.exists() {
        return dev_bridge
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize bridge path: {error}"));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource directory: {error}"))?;
    let bundled_bridge = resource_dir.join(format!("bridge/{script_name}"));
    if bundled_bridge.exists() {
        return Ok(bundled_bridge);
    }

    Err("Unable to locate the Node bridge script.".into())
}

fn resolve_bridge_cwd<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if dev_root.exists() {
        return dev_root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve desktop app root in dev: {error}"));
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

fn with_snapshot<F>(snapshot: &Arc<Mutex<AgentTaskSnapshot>>, mutator: F)
where
    F: FnOnce(&mut AgentTaskSnapshot),
{
    if let Ok(mut guard) = snapshot.lock() {
        mutator(&mut guard);
    }
}

fn extract_array(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    value.and_then(|entry| entry.as_array().cloned()).unwrap_or_default()
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

    let node_bin = resolve_node_binary();
    let augmented_path = build_augmented_path();
    let mut child = Command::new(&node_bin)
        .arg(bridge_path)
        .current_dir(bridge_cwd)
        .env("PATH", &augmented_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!("Failed to spawn Node bridge. Is node installed?\nTried: {node_bin}\n\n{error}")
        })?;

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
        tool_events: Vec::new(),
        task_tree: Vec::new(),
        reasoning: Vec::new(),
        usage: None,
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

    let stdout_snapshot = snapshot.clone();
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

                    let mut next_message = current.message.clone().unwrap_or_default();
                    next_message.push_str(delta);
                    current.message = Some(next_message);
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
                Some("task_tree") => with_snapshot(&stdout_snapshot, |current| {
                    current.task_tree = extract_array(event.get("tree"));
                }),
                Some("approval_required") => with_snapshot(&stdout_snapshot, |current| {
                    current.status = "awaiting_approval".into();
                    current.pending_approval = event.get("request").cloned();
                }),
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
                    current.raw_error = event
                        .get("rawMessage")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                }),
                _ => {}
            }
        }
    });

    let stderr_snapshot = snapshot.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            with_snapshot(&stderr_snapshot, |current| {
                if current.status == "failed" && current.error.is_none() {
                    current.error = Some(line.clone());
                }
            });
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
    let node_bin = resolve_node_binary();
    let augmented_path = build_augmented_path();
    let output = Command::new(&node_bin)
        .arg(script_path)
        .arg(
            serde_json::to_string(&payload)
                .map_err(|error| format!("Failed to serialize provider action payload: {error}"))?,
        )
        .current_dir(bridge_cwd)
        .env("PATH", &augmented_path)
        .output()
        .map_err(|error| format!("Failed to run provider action bridge: {error}"))?;

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

    let output = tauri::async_runtime::spawn_blocking(move || {
        let node_bin = resolve_node_binary();
        let augmented_path = build_augmented_path();
        Command::new(&node_bin)
            .arg(script_path)
            .arg(payload_json)
            .current_dir(bridge_cwd)
            .env("PATH", &augmented_path)
            .output()
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
fn abort_agent_task(
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
        if snapshot.status == "running" || snapshot.status == "queued" || snapshot.status == "awaiting_approval" {
            snapshot.status = "failed".into();
            snapshot.error = Some("任务已被用户强行终止。".into());
        }
    }

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
    let bytes =
        fs::read(&path).map_err(|error| format!("Failed to read file {}: {error}", path.display()))?;
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
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Failed to delete Aura directory {}: {error}", target.display()))?;
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("Failed to delete Aura file {}: {error}", target.display()))?;
    }

    Ok(())
}

#[tauri::command]
fn reset_aura_home<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let home = resolve_aura_home()?;
    if home.exists() {
        fs::remove_dir_all(&home)
            .map_err(|error| format!("Failed to reset Aura home directory {}: {error}", home.display()))?;
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

    Ok(Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))))
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
fn quit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(icon) = app.default_window_icon() {
                let _ = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .icon(icon.clone())
                    .build(app);
            }
            Ok(())
        })
        .manage(AgentTaskStore::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            start_agent_task,
            get_agent_task,
            abort_agent_task,
            respond_to_agent_approval,
            run_provider_action,
            run_mcp_action,
            ensure_aura_home,
            read_aura_file,
            write_aura_file,
            read_workspace_tree,
            read_text_file,
            read_image_preview,
            open_path_in_default_app,
            create_session_workspace,
            import_attachment_from_path,
            write_attachment_bytes,
            delete_aura_asset,
            reset_aura_home,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aura desktop app")
}
