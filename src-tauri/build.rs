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
    let host = env::var("HOST").map_err(|error| format!("missing HOST env: {error}"))?;
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR")
            .map_err(|error| format!("missing CARGO_MANIFEST_DIR env: {error}"))?,
    );
    let source = resolve_node_binary(&target, &host)?;
    validate_node_binary_for_target(&source, &target)?;
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

fn explicit_node_binary_from_env(key: &str) -> Result<Option<PathBuf>, String> {
    let Ok(value) = env::var(key) else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        return Err(format!("{key} points to a missing Node runtime: {}", candidate.display()));
    }
    candidate
        .canonicalize()
        .map(Some)
        .map_err(|error| format!("failed to canonicalize Node runtime path from {key}: {error}"))
}

fn resolve_node_binary(target: &str, host: &str) -> Result<PathBuf, String> {
    if let Some(explicit) = explicit_node_binary_from_env("AURA_NODE_BINARY")? {
        return Ok(explicit);
    }

    if target != host {
        return Err(format!(
            "Refusing to bundle the host Node runtime for cross-target build {host} -> {target}. Set AURA_NODE_BINARY to a Node executable built for {target}."
        ));
    }

    for key in ["npm_node_execpath", "NODE"] {
        if let Some(explicit) = explicit_node_binary_from_env(key)? {
            return Ok(explicit);
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

fn validate_node_binary_for_target(source: &PathBuf, target: &str) -> Result<(), String> {
    let header = fs::read(source)
        .map_err(|error| format!("failed to read Node runtime {}: {error}", source.display()))?;
    if target.contains("windows") {
        return validate_windows_pe_binary(source, target, &header);
    }
    if target.contains("apple") {
        if header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
            || header.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
            || header.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
            || header.starts_with(&[0xca, 0xfe, 0xba, 0xbf])
        {
            return Ok(());
        }
        return Err(format!(
            "Node runtime {} is not a Mach-O binary for target {target}.",
            source.display()
        ));
    }
    if target.contains("linux") {
        if header.starts_with(b"\x7fELF") {
            return Ok(());
        }
        return Err(format!(
            "Node runtime {} is not an ELF binary for target {target}.",
            source.display()
        ));
    }
    Ok(())
}

fn validate_windows_pe_binary(source: &PathBuf, target: &str, header: &[u8]) -> Result<(), String> {
    if !header.starts_with(b"MZ") {
        return Err(format!(
            "Node runtime {} is not a Windows PE executable for target {target}.",
            source.display()
        ));
    }
    if header.len() < 0x40 {
        return Err(format!("Node runtime {} has an invalid PE header.", source.display()));
    }
    let pe_offset = u32::from_le_bytes([header[0x3c], header[0x3d], header[0x3e], header[0x3f]])
        as usize;
    if header.len() < pe_offset + 6 || &header[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err(format!("Node runtime {} has an invalid PE signature.", source.display()));
    }
    let machine = u16::from_le_bytes([header[pe_offset + 4], header[pe_offset + 5]]);
    let expected_machine = if target.starts_with("x86_64") {
        Some(0x8664)
    } else if target.starts_with("i686") {
        Some(0x014c)
    } else if target.starts_with("aarch64") {
        Some(0xaa64)
    } else {
        None
    };

    if let Some(expected) = expected_machine {
        if machine != expected {
            return Err(format!(
                "Node runtime {} PE machine 0x{machine:04x} does not match target {target} (expected 0x{expected:04x}). Set AURA_NODE_BINARY to a matching Node executable.",
                source.display()
            ));
        }
    }

    Ok(())
}
