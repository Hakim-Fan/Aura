import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from '../app-version.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  throw new Error(`Invalid APP_VERSION: ${APP_VERSION}`)
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function writeText(relativePath, text) {
  fs.writeFileSync(path.join(repoRoot, relativePath), text)
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Unable to find ${label}`)
  }
  return text.replace(pattern, replacement)
}

const packageJson = JSON.parse(readText('package.json'))
packageJson.version = APP_VERSION
writeJson('package.json', packageJson)

const tauriConfig = JSON.parse(readText('src-tauri/tauri.conf.json'))
tauriConfig.version = APP_VERSION
writeJson('src-tauri/tauri.conf.json', tauriConfig)

const cargoToml = replaceRequired(
  readText('src-tauri/Cargo.toml'),
  /^version = ".*"$/m,
  `version = "${APP_VERSION}"`,
  'package version in src-tauri/Cargo.toml',
)
writeText('src-tauri/Cargo.toml', cargoToml)

const cargoLockPath = 'src-tauri/Cargo.lock'
if (fs.existsSync(path.join(repoRoot, cargoLockPath))) {
  const cargoLock = readText(cargoLockPath)
  const nextCargoLock = replaceRequired(
    cargoLock,
    /(\[\[package\]\]\nname = "Aura"\nversion = ").*(")/,
    `$1${APP_VERSION}$2`,
    'Aura package version in src-tauri/Cargo.lock',
  )
  writeText(cargoLockPath, nextCargoLock)
}

console.log(`Synced Aura version ${APP_VERSION}`)
