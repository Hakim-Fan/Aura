use std::env;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=AURA_NODE_BINARY");
    println!("cargo:rerun-if-env-changed=NODE");
    println!("cargo:rerun-if-env-changed=PATH");
    println!("cargo:rerun-if-env-changed=npm_node_execpath");

    stage_node_sidecar().expect("failed to stage bundled Node runtime");
    tauri_build::build();
}

fn stage_node_sidecar() -> Result<(), String> {
    let target = env::var("TARGET").map_err(|error| format!("missing TARGET env: {error}"))?;
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR")
            .map_err(|error| format!("missing CARGO_MANIFEST_DIR env: {error}"))?,
    );
    let source = resolve_node_binary()?;
    let binaries_dir = manifest_dir.join("binaries");
    fs::create_dir_all(&binaries_dir).map_err(|error| {
        format!(
            "failed to create bundled runtime directory {}: {error}",
            binaries_dir.display()
        )
    })?;

    let extension = if target.contains("windows") { ".exe" } else { "" };
    let destination = binaries_dir.join(format!("node-{target}{extension}"));
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "failed to copy Node runtime from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&destination)
            .map_err(|error| format!("failed to read sidecar permissions: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&destination, permissions)
            .map_err(|error| format!("failed to set sidecar executable bit: {error}"))?;
    }

    Ok(())
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    for key in ["AURA_NODE_BINARY", "npm_node_execpath", "NODE"] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(trimmed);
            if candidate.exists() {
                return candidate
                    .canonicalize()
                    .map_err(|error| format!("failed to canonicalize Node runtime path: {error}"));
            }
        }
    }

    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = env::var_os("PATH").ok_or_else(|| {
        "PATH is unavailable and no explicit Node runtime override was provided.".to_string()
    })?;

    for entry in env::split_paths(&path) {
        let candidate = entry.join(executable_name);
        if candidate.is_file() {
            return candidate
                .canonicalize()
                .map_err(|error| format!("failed to canonicalize Node runtime path: {error}"));
        }
    }

    Err(format!(
        "Unable to locate a Node runtime for bundling. Set AURA_NODE_BINARY or ensure `{executable_name}` is on PATH."
    ))
}
