import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const outdir = path.join(repoRoot, 'dist-bridge')
const destNodeModules = path.join(outdir, 'node_modules')

const entryPoints = {
  ipc: path.join(repoRoot, 'bridge', 'ipc.mjs'),
  providerActions: path.join(repoRoot, 'bridge', 'providerActions.mjs'),
  manualContextCompression: path.join(repoRoot, 'bridge', 'manualContextCompression.mjs'),
  mcpActions: path.join(repoRoot, 'bridge', 'mcpActions.mjs'),
  cli: path.join(repoRoot, 'bridge', 'cli.mjs'),
}

const externalPackages = []

const removableDirectorySuffixes = [
  `${path.sep}playwright-core${path.sep}lib${path.sep}vite`,
  `${path.sep}playwright-core${path.sep}src`,
  `${path.sep}playwright-core${path.sep}types`,
  `${path.sep}chromium-bidi${path.sep}lib${path.sep}iife`,
  `${path.sep}chromium-bidi${path.sep}src`,
  `${path.sep}zod${path.sep}src`,
]

const removableFileExtensions = ['.map', '.d.ts', '.d.cts']

function shouldRemoveDirectory(targetPath) {
  const normalized = targetPath.split(path.sep).join(path.sep)
  return removableDirectorySuffixes.some(suffix => normalized.endsWith(suffix))
}

function shouldRemoveFile(targetPath) {
  return removableFileExtensions.some(extension => targetPath.endsWith(extension))
}

function pruneNodeModules(rootDir) {
  const stack = [rootDir]

  while (stack.length > 0) {
    const currentDir = stack.pop()
    if (!currentDir || !existsSync(currentDir)) {
      continue
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const targetPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (shouldRemoveDirectory(targetPath)) {
          rmSync(targetPath, { recursive: true, force: true })
          continue
        }
        stack.push(targetPath)
        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue
      }

      const stats = lstatSync(targetPath)
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        continue
      }

      if (shouldRemoveFile(targetPath)) {
        rmSync(targetPath, { force: true })
      }
    }
  }
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
  minify: true,
  logLevel: 'info',
  outExtension: { '.js': '.mjs' },
  external: externalPackages,
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __banner_fileURLToPath } from "node:url";',
      'import { dirname as __banner_dirname } from "node:path";',
      'const require = __createRequire(import.meta.url);',
      'const __filename = __banner_fileURLToPath(import.meta.url);',
      'const __dirname = __banner_dirname(__filename);',
    ].join(' '),
  },
})

// --- Post-build: 将外部包及其依赖复制到 dist-bridge/node_modules/ ---
//
// pnpm 使用虚拟 store 结构：
//   node_modules/playwright-core → symlink → .pnpm/playwright-core@x.x.x/node_modules/playwright-core
//   而该包的依赖也在同级 .pnpm/xxx/node_modules/ 下（非顶层 node_modules）。
//
// 策略：对每个 external 包，follow symlink 找到 pnpm store 目录，
//       将该目录下所有兄弟包一并复制（它们就是该包的完整依赖闭包）。

const topNodeModules = path.join(repoRoot, 'node_modules')
mkdirSync(destNodeModules, { recursive: true })

for (const pkg of externalPackages) {
  const symPath = path.join(topNodeModules, pkg)
  if (!existsSync(symPath)) {
    console.warn(`[build-bridge] 警告: 找不到包 ${pkg}，跳过`)
    continue
  }

  // 跟随 pnpm symlink 找到真实路径，再上溯一级得到虚拟 store 的 node_modules
  const realPath = realpathSync(symPath)
  const storeNodeModules = path.dirname(realPath)

  // 复制该虚拟 store 下的所有包（包含自身 + 全部传递依赖）
  for (const entry of readdirSync(storeNodeModules)) {
    const src = path.join(storeNodeModules, entry)
    const dest = path.join(destNodeModules, entry)
    if (existsSync(dest)) {
      continue // 已被前一个 external 包复制过，跳过
    }
    cpSync(src, dest, { recursive: true, dereference: true })
    console.log(`[build-bridge] 已复制外部包: ${entry}`)
  }
}

pruneNodeModules(destNodeModules)
