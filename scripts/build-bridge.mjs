import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
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

// 这些包含大量运行时路径解析（require.resolve / __dirname / 子进程启动），
// 无法被 esbuild 正确打包为单文件 ESM，必须以原始 node_modules 目录结构随 App 分发。
const externalPackages = ['playwright-core', 'chromium-bidi']

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
const destNodeModules = path.join(outdir, 'node_modules')
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
