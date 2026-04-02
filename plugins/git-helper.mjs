import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const plugin = {
  id: 'git-helper',
  name: 'Git Helper',
  description: 'Expose a read-only git status tool to the agent.',
  tools: [
    {
      name: 'git_status',
      description: 'Return git branch and working tree status for the workspace.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async handler({ context }) {
        const { stdout } = await execFileAsync(
          'git',
          ['status', '--short', '--branch'],
          {
            cwd: context.cwd,
            maxBuffer: 1024 * 1024,
          },
        )
        return stdout || 'git status returned no output'
      },
    },
  ],
}
