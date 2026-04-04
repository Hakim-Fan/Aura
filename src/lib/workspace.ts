import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceNode } from '../types'

export async function readWorkspaceTree(rootPath: string): Promise<WorkspaceNode> {
  return invoke<WorkspaceNode>('read_workspace_tree', { rootPath })
}

export async function readTextFile(filePath: string): Promise<string> {
  return invoke<string>('read_text_file', { filePath })
}

export async function readImagePreview(filePath: string): Promise<string | null> {
  return invoke<string | null>('read_image_preview', { filePath })
}

export async function openPathInDefaultApp(path: string): Promise<void> {
  return invoke('open_path_in_default_app', { path })
}

export async function createSessionWorkspace(
  rootPath: string,
  hint: string,
): Promise<string> {
  return invoke<string>('create_session_workspace', { rootPath, hint })
}

export async function importAttachmentFromPath(
  workspacePath: string,
  sourcePath: string,
): Promise<string> {
  return invoke<string>('import_attachment_from_path', { workspacePath, sourcePath })
}

export async function writeAttachmentBytes(
  workspacePath: string,
  fileName: string,
  bytesBase64: string,
): Promise<string> {
  return invoke<string>('write_attachment_bytes', {
    workspacePath,
    fileName,
    bytesBase64,
  })
}
