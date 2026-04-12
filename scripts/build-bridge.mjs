import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const outdir = path.join(repoRoot, 'dist-bridge')

const entryPoints = {
  ipc: path.join(repoRoot, 'bridge', 'ipc.mjs'),
  providerActions: path.join(repoRoot, 'bridge', 'providerActions.mjs'),
  mcpActions: path.join(repoRoot, 'bridge', 'mcpActions.mjs'),
  browserProfileActions: path.join(repoRoot, 'bridge', 'browserProfileActions.mjs'),
  cli: path.join(repoRoot, 'bridge', 'cli.mjs'),
}

await rm(outdir, { recursive: true, force: true })

await build({
  entryPoints,
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  packages: 'bundle',
  splitting: false,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  outExtension: { '.js': '.mjs' },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
})
