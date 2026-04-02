import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceNode } from '../types'

export async function readWorkspaceTree(rootPath: string): Promise<WorkspaceNode> {
  return invoke<WorkspaceNode>('read_workspace_tree', { rootPath })
}

export async function readTextFile(filePath: string): Promise<string> {
  return invoke<string>('read_text_file', { filePath })
}
