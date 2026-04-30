import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceNode } from '../types'

export async function readWorkspaceTree(rootPath: string): Promise<WorkspaceNode> {
  return invoke<WorkspaceNode>('read_workspace_tree', { rootPath })
}

export async function readTextFile(filePath: string): Promise<string> {
  return invoke<string>('read_text_file', { filePath })
}

export async function toggleEditTransactionSnapshots(
  transactionIds: string[],
  targetState: 'before' | 'after',
): Promise<void> {
  await invoke('toggle_edit_transaction_snapshots', { transactionIds, targetState })
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
  return invoke<string>('import_attachment_from_path', {
    workspaceDir: workspacePath,
    filePath: sourcePath,
  })
}

export async function writeAttachmentBytes(
  workspacePath: string,
  fileName: string,
  bytesBase64: string,
): Promise<string> {
  return invoke<string>('write_attachment_bytes', {
    workspaceDir: workspacePath,
    fileName,
    bytesBase64,
  })
}

export async function deleteWorkspaceDirectory(workspacePath: string): Promise<void> {
  return invoke('delete_workspace_directory', { workspacePath })
}
