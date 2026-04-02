import fs from 'node:fs/promises'
import path from 'node:path'

async function snapshotDirectory(root, maxItems = 24) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  return entries
    .slice(0, maxItems)
    .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
    .join('\n')
}

export const plugin = {
  id: 'workspace-inspector',
  name: 'Workspace Inspector',
  description: 'Expose a quick workspace snapshot tool to the agent.',
  tools: [
    {
      name: 'workspace_snapshot',
      description: 'Summarize the current workspace root and top-level files.',
      inputSchema: {
        type: 'object',
        properties: {
          subpath: {
            type: 'string',
            description: 'Optional relative path inside the workspace.',
          },
        },
      },
      async handler({ args, context }) {
        const target = path.resolve(context.cwd, args.subpath || '.')
        const summary = await snapshotDirectory(target)
        return `Workspace snapshot for ${target}\n\n${summary || '(empty directory)'}`
      },
    },
  ],
}
