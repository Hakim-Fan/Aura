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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceCargoLockPackageVersion(text, packageName, version) {
  const packageNamePattern = new RegExp(
    `^name = "${escapeRegExp(packageName)}"\\r?$`,
    'm',
  )
  const packageBlocks = text.split(/(?=^\[\[package\]\]\r?$)/m)
  let found = false
  const nextBlocks = packageBlocks.map((block) => {
    if (!packageNamePattern.test(block)) {
      return block
    }
    found = true
    return replaceRequired(
      block,
      /^version = ".*"\r?$/m,
      `version = "${version}"`,
      `${packageName} package version in src-tauri/Cargo.lock`,
    )
  })

  if (!found) {
    throw new Error(`Unable to find ${packageName} package in src-tauri/Cargo.lock`)
  }

  return nextBlocks.join('')
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

const cargoPackageNameMatch = cargoToml.match(/^name = "([^"]+)"$/m)
if (!cargoPackageNameMatch) {
  throw new Error('Unable to find package name in src-tauri/Cargo.toml')
}

const cargoLockPath = 'src-tauri/Cargo.lock'
if (fs.existsSync(path.join(repoRoot, cargoLockPath))) {
  const cargoLock = readText(cargoLockPath)
  const nextCargoLock = replaceCargoLockPackageVersion(
    cargoLock,
    cargoPackageNameMatch[1],
    APP_VERSION,
  )
  writeText(cargoLockPath, nextCargoLock)
}

console.log(`Synced Aura version ${APP_VERSION}`)
