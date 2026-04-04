#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
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
    #[serde(rename = "pendingApproval")]
    pending_approval: Option<serde_json::Value>,
    error: Option<String>,
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

fn resolve_bridge_cwd() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .map_err(|error| format!("Failed to resolve desktop app root: {error}"))
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

fn spawn_agent_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    store: &AgentTaskStore,
    payload: serde_json::Value,
) -> Result<String, String> {
    let bridge_path = resolve_bridge_script_path(&app, "ipc.mjs")?;
    let bridge_cwd = resolve_bridge_cwd()?;

    let mut child = Command::new("node")
        .arg(bridge_path)
        .current_dir(bridge_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!("Failed to spawn Node bridge. Is node installed and on PATH?\n\n{error}")
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
        pending_approval: None,
        error: None,
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
                }),
                Some("tool_event") => with_snapshot(&stdout_snapshot, |current| {
                    if let Some(tool_event) = event.get("event") {
                        current.tool_events.push(tool_event.clone());
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
                        current.message = result
                            .get("message")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        current.tool_events = extract_array(result.get("toolEvents"));
                        current.task_tree = extract_array(result.get("taskTree"));
                    }
                }),
                Some("failed") => with_snapshot(&stdout_snapshot, |current| {
                    current.status = "failed".into();
                    current.pending_approval = None;
                    current.error = event
                        .get("message")
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
    let bridge_cwd = resolve_bridge_cwd()?;
    let output = Command::new("node")
        .arg(script_path)
        .arg(
            serde_json::to_string(&payload)
                .map_err(|error| format!("Failed to serialize provider action payload: {error}"))?,
        )
        .current_dir(bridge_cwd)
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
fn create_session_workspace(root_path: String, hint: String) -> Result<String, String> {
    let root = PathBuf::from(root_path);
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
fn import_attachment_from_path(workspace_path: String, source_path: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Attachment does not exist: {}", source.display()));
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let destination = allocate_attachment_path(&workspace_path, file_name)?;
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "Failed to copy attachment {} into workspace: {error}",
            source.display()
        )
    })?;
    Ok(destination.display().to_string())
}

#[tauri::command]
fn write_attachment_bytes(
    workspace_path: String,
    file_name: String,
    bytes_base64: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(bytes_base64)
        .map_err(|error| format!("Failed to decode attachment bytes: {error}"))?;
    let destination = allocate_attachment_path(&workspace_path, &file_name)?;
    fs::write(&destination, bytes).map_err(|error| {
        format!(
            "Failed to write attachment into workspace {}: {error}",
            destination.display()
        )
    })?;
    Ok(destination.display().to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AgentTaskStore::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            start_agent_task,
            get_agent_task,
            abort_agent_task,
            respond_to_agent_approval,
            run_provider_action,
            read_workspace_tree,
            read_text_file,
            read_image_preview,
            open_path_in_default_app,
            create_session_workspace,
            import_attachment_from_path,
            write_attachment_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desk Agent desktop app")
}
