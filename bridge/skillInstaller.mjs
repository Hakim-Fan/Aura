import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { parseCommandSpec } from './utils.mjs'

const gunzipAsync = promisify(zlib.gunzip)
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const MAX_STAGED_FILES = 1_000

function normalizePathSegment(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/gu, '')
}

export function sanitizeSkillId(value, fallback = 'skill') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return normalized || fallback
}

function extractFrontmatterField(content, fieldName) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)
  if (!match) {
    return ''
  }

  const fieldPattern = new RegExp(`^${fieldName}\\s*:\\s*(.+)$`, 'imu')
  const fieldMatch = match[1].match(fieldPattern)
  return fieldMatch ? fieldMatch[1].trim().replace(/^["']|["']$/gu, '') : ''
}

function inferSkillIdFromContent(content, fallback) {
  return sanitizeSkillId(
    extractFrontmatterField(content, 'id') ||
      extractFrontmatterField(content, 'name') ||
      fallback,
    fallback,
  )
}

function looksLikeUrl(value) {
  return /^https?:\/\//iu.test(String(value || '').trim())
}

function looksLikeNpxCommand(value) {
  const spec = parseCommandSpec(value)
  const executable = path.basename(spec.command || '').toLowerCase()
  return executable === 'npx' || executable === 'npx.cmd' || executable === 'npx.ps1'
}

function normalizeSourceType(value) {
  const normalized = String(value || 'auto').trim().toLowerCase()
  return [
    'auto',
    'local',
    'content',
    'url',
    'github',
    'npm',
    'npx',
  ].includes(normalized)
    ? normalized
    : 'auto'
}

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aura-skill-install-'))
}

async function assertDownloadSize(response) {
  const length = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Skill source is too large: ${length} bytes.`)
  }
}

async function fetchText(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    signal,
    headers: {
      'user-agent': 'AuraSkillInstaller/1.0',
      accept: 'text/plain, text/markdown, application/json, */*',
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  }
  await assertDownloadSize(response)
  return response.text()
}

async function fetchJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    signal,
    headers: {
      'user-agent': 'AuraSkillInstaller/1.0',
      accept: 'application/vnd.github+json, application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  }
  await assertDownloadSize(response)
  return response.json()
}

async function fetchBuffer(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    signal,
    headers: {
      'user-agent': 'AuraSkillInstaller/1.0',
      accept: 'application/octet-stream, */*',
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  }
  await assertDownloadSize(response)
  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Skill source is too large: ${arrayBuffer.byteLength} bytes.`)
  }
  return Buffer.from(arrayBuffer)
}

async function stageMarkdownContent(content, requestedId, fallbackId, sourceDescription) {
  const normalizedContent = String(content || '').trim()
  if (!normalizedContent) {
    throw new Error('Skill content is empty.')
  }

  const tempRoot = await createTempRoot()
  const inferredId = sanitizeSkillId(requestedId || inferSkillIdFromContent(normalizedContent, fallbackId))
  const stagedPath = path.join(tempRoot, `${inferredId}.md`)
  await fs.writeFile(stagedPath, `${normalizedContent}\n`, 'utf8')
  return {
    stagedPath,
    tempRoot,
    inferredSkillId: inferredId,
    sourceDescription,
  }
}

async function findSkillCandidates(rootPath, currentPath = rootPath, candidates = []) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }

    const entryPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.github' || entry.name === 'test' || entry.name === 'tests') {
        continue
      }
      await findSkillCandidates(rootPath, entryPath, candidates)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const lowerName = entry.name.toLowerCase()
    if (lowerName === 'skill.md') {
      candidates.push({
        type: 'directory',
        path: currentPath,
        skillFilePath: entryPath,
        score: currentPath === rootPath ? 100 : 80,
      })
    } else if (lowerName.endsWith('.md')) {
      candidates.push({
        type: 'file',
        path: entryPath,
        skillFilePath: entryPath,
        score: lowerName.includes('skill') ? 40 : 10,
      })
    }
  }
  return candidates
}

async function selectSkillCandidate(rootPath, requestedId = '') {
  const stats = await fs.stat(rootPath)
  if (stats.isFile()) {
    if (path.extname(rootPath).toLowerCase() !== '.md') {
      throw new Error(`Expected a markdown skill file, got: ${rootPath}`)
    }
    return {
      stagedPath: rootPath,
      inferredSkillId: sanitizeSkillId(requestedId || path.parse(rootPath).name),
      skillFilePath: rootPath,
    }
  }

  const candidates = await findSkillCandidates(rootPath)
  if (candidates.length === 0) {
    throw new Error('No SKILL.md or markdown skill file was found in the source.')
  }

  const requested = sanitizeSkillId(requestedId, '')
  const ranked = candidates
    .map(candidate => {
      const candidateId =
        candidate.type === 'directory'
          ? sanitizeSkillId(path.basename(candidate.path))
          : sanitizeSkillId(path.parse(candidate.path).name)
      const exactMatch = requested && candidateId === requested ? 1000 : 0
      return {
        ...candidate,
        candidateId,
        rank: exactMatch + candidate.score,
      }
    })
    .sort((left, right) => right.rank - left.rank || left.path.localeCompare(right.path))

  const selected = ranked[0]
  return {
    stagedPath: selected.path,
    inferredSkillId: sanitizeSkillId(requestedId || selected.candidateId),
    skillFilePath: selected.skillFilePath,
  }
}

async function stageLocalPath(cwd, source, requestedId) {
  const sourcePath = path.isAbsolute(source)
    ? path.resolve(source)
    : path.resolve(cwd, source)
  const selected = await selectSkillCandidate(sourcePath, requestedId)
  return {
    ...selected,
    tempRoot: '',
    sourceDescription: sourcePath,
  }
}

function parseGithubSource(source) {
  const text = String(source || '').trim()
  if (text.startsWith('github:')) {
    const [repoAndPath, hashRef] = text.slice('github:'.length).split('#')
    const parts = repoAndPath.split('/').filter(Boolean)
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/'),
      ref: hashRef || '',
    }
  }

  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    return {
      owner: parts[0],
      repo: parts[1],
      ref: parts[2],
      path: parts.slice(3).join('/'),
      rawUrl: url.toString(),
    }
  }

  if (url.hostname !== 'github.com') {
    return null
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const owner = parts[0]
  const repo = parts[1]
  if (!owner || !repo) {
    return null
  }

  if (parts[2] === 'blob' || parts[2] === 'tree') {
    return {
      owner,
      repo,
      ref: parts[3] || '',
      path: parts.slice(4).join('/'),
    }
  }

  return {
    owner,
    repo,
    ref: '',
    path: parts.slice(2).join('/'),
  }
}

async function writeGithubContents(fetchImpl, targetRoot, spec, apiPath, signal, fileCount = { value: 0 }) {
  const refQuery = spec.ref ? `?ref=${encodeURIComponent(spec.ref)}` : ''
  const apiUrl = `https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/${apiPath}${refQuery}`
  const payload = await fetchJson(fetchImpl, apiUrl, signal)

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (fileCount.value > MAX_STAGED_FILES) {
        throw new Error(`Skill source has too many files; limit is ${MAX_STAGED_FILES}.`)
      }
      if (entry.type === 'dir') {
        await writeGithubContents(fetchImpl, targetRoot, spec, entry.path, signal, fileCount)
      } else if (entry.type === 'file') {
        const relativePath = normalizePathSegment(entry.path).slice(normalizePathSegment(spec.path).length).replace(/^\/+/u, '')
        const targetPath = path.join(targetRoot, relativePath || path.basename(entry.path))
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        const filePayload = await fetchJson(fetchImpl, entry.url, signal)
        const content = Buffer.from(filePayload.content || '', filePayload.encoding === 'base64' ? 'base64' : 'utf8')
        await fs.writeFile(targetPath, content)
        fileCount.value += 1
      }
    }
    return
  }

  if (payload.type !== 'file') {
    throw new Error(`Unsupported GitHub contents response for ${apiPath}.`)
  }

  const targetPath = path.join(targetRoot, path.basename(payload.path || apiPath || 'SKILL.md'))
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const content = Buffer.from(payload.content || '', payload.encoding === 'base64' ? 'base64' : 'utf8')
  await fs.writeFile(targetPath, content)
}

async function stageGithubSource(fetchImpl, source, requestedId, signal) {
  const spec = parseGithubSource(source)
  if (!spec?.owner || !spec?.repo) {
    throw new Error(`Invalid GitHub skill source: ${source}`)
  }

  if (spec.rawUrl) {
    return stageMarkdownContent(
      await fetchText(fetchImpl, spec.rawUrl, signal),
      requestedId,
      path.parse(spec.path).name || spec.repo,
      spec.rawUrl,
    )
  }

  const tempRoot = await createTempRoot()
  const stageRoot = path.join(tempRoot, sanitizeSkillId(requestedId || path.basename(spec.path || spec.repo)))
  await fs.mkdir(stageRoot, { recursive: true })
  await writeGithubContents(fetchImpl, stageRoot, spec, normalizePathSegment(spec.path), signal)
  const selected = await selectSkillCandidate(stageRoot, requestedId || path.basename(spec.path || spec.repo))
  return {
    ...selected,
    tempRoot,
    sourceDescription: `github:${spec.owner}/${spec.repo}${spec.path ? `/${spec.path}` : ''}${spec.ref ? `#${spec.ref}` : ''}`,
  }
}

function parseNpmSpecifier(value) {
  let specifier = String(value || '').trim().replace(/^npm:/u, '')
  if (!specifier) {
    throw new Error('NPM skill source is empty.')
  }

  let version = 'latest'
  let packageName = specifier
  if (specifier.startsWith('@')) {
    const secondAt = specifier.indexOf('@', 1)
    if (secondAt > 0) {
      packageName = specifier.slice(0, secondAt)
      version = specifier.slice(secondAt + 1) || 'latest'
    }
  } else {
    const atIndex = specifier.lastIndexOf('@')
    if (atIndex > 0) {
      packageName = specifier.slice(0, atIndex)
      version = specifier.slice(atIndex + 1) || 'latest'
    }
  }

  return { packageName, version }
}

function npmRegistryName(packageName) {
  return packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1)).replace('%2F', '%2f')}`
    : encodeURIComponent(packageName)
}

function parseTarString(buffer, offset, length) {
  return buffer
    .slice(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/u, '')
}

async function stageTarGzPackage(buffer, requestedId, fallbackId) {
  const tempRoot = await createTempRoot()
  const archive = await gunzipAsync(buffer)
  let offset = 0
  let fileCount = 0

  while (offset + 512 <= archive.length) {
    const header = archive.slice(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      break
    }

    const name = parseTarString(header, 0, 100)
    const prefix = parseTarString(header, 345, 155)
    const fullName = normalizePathSegment([prefix, name].filter(Boolean).join('/'))
    const sizeText = parseTarString(header, 124, 12).trim()
    const size = Number.parseInt(sizeText || '0', 8) || 0
    const typeFlag = parseTarString(header, 156, 1)
    offset += 512

    if ((typeFlag === '0' || typeFlag === '') && fullName) {
      if (fileCount > MAX_STAGED_FILES) {
        throw new Error(`Skill package has too many files; limit is ${MAX_STAGED_FILES}.`)
      }
      const relativePath = fullName.replace(/^package\//u, '')
      if (relativePath && !relativePath.startsWith('..')) {
        const targetPath = path.join(tempRoot, relativePath)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, archive.slice(offset, offset + size))
        fileCount += 1
      }
    }

    offset += Math.ceil(size / 512) * 512
  }

  const selected = await selectSkillCandidate(tempRoot, requestedId || fallbackId)
  return {
    ...selected,
    tempRoot,
  }
}

async function stageNpmPackage(fetchImpl, source, requestedId, signal) {
  const { packageName, version } = parseNpmSpecifier(source)
  const packument = await fetchJson(
    fetchImpl,
    `https://registry.npmjs.org/${npmRegistryName(packageName)}`,
    signal,
  )
  const resolvedVersion =
    version === 'latest' ? packument?.['dist-tags']?.latest : version
  const versionInfo = packument?.versions?.[resolvedVersion]
  const tarballUrl = versionInfo?.dist?.tarball
  if (!tarballUrl) {
    throw new Error(`Could not find npm package tarball for ${packageName}@${resolvedVersion || version}.`)
  }

  const staged = await stageTarGzPackage(
    await fetchBuffer(fetchImpl, tarballUrl, signal),
    requestedId,
    packageName.split('/').pop() || packageName,
  )
  return {
    ...staged,
    sourceDescription: `npm:${packageName}@${resolvedVersion || version}`,
  }
}

function firstInstallSourceFromArgs(args) {
  for (const arg of args) {
    if (looksLikeUrl(arg) || arg.startsWith('github:') || arg.startsWith('npm:')) {
      return arg
    }
  }
  return ''
}

function firstNpmPackageFromNpxArgs(args) {
  let packageOptionValue = ''
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-p' || arg === '--package') {
      packageOptionValue = args[index + 1] || ''
      index += 1
      continue
    }
    if (arg.startsWith('--package=')) {
      packageOptionValue = arg.slice('--package='.length)
      continue
    }
    if (arg === '-y' || arg === '--yes' || arg === '--no-install') {
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    return packageOptionValue || arg
  }
  return packageOptionValue
}

async function stageNpxCommand(fetchImpl, command, requestedId, signal) {
  const spec = parseCommandSpec(command)
  const directSource = firstInstallSourceFromArgs(spec.args)
  if (directSource) {
    return stageAnySource({
      fetchImpl,
      cwd: process.cwd(),
      source: directSource,
      sourceType: 'auto',
      requestedId,
      signal,
    })
  }

  const packageName = firstNpmPackageFromNpxArgs(spec.args)
  if (!packageName) {
    throw new Error('Could not identify a package or URL inside the npx command.')
  }

  const staged = await stageNpmPackage(fetchImpl, packageName, requestedId, signal)
  return {
    ...staged,
    sourceDescription: `npx:${command}`,
    note: 'Parsed the npx command as an npm package source; the installer did not execute the npx script.',
  }
}

async function stageUrl(fetchImpl, source, requestedId, signal) {
  const githubSpec = parseGithubSource(source)
  if (githubSpec) {
    return stageGithubSource(fetchImpl, source, requestedId, signal)
  }

  return stageMarkdownContent(
    await fetchText(fetchImpl, source, signal),
    requestedId,
    path.parse(new URL(source).pathname).name || 'skill',
    source,
  )
}

async function stageAnySource({ fetchImpl, cwd, source, sourceType, content, requestedId, signal }) {
  const type = normalizeSourceType(sourceType)
  const trimmedSource = String(source || '').trim()

  if (type === 'content' || (type === 'auto' && content)) {
    return stageMarkdownContent(content, requestedId, 'skill', 'inline skill content')
  }
  if (!trimmedSource) {
    throw new Error('Skill source is required unless content is provided.')
  }

  if (type === 'local') {
    return stageLocalPath(cwd, trimmedSource, requestedId)
  }
  if (type === 'github') {
    return stageGithubSource(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (type === 'npm') {
    return stageNpmPackage(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (type === 'npx') {
    return stageNpxCommand(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (type === 'url') {
    return stageUrl(fetchImpl, trimmedSource, requestedId, signal)
  }

  if (looksLikeNpxCommand(trimmedSource)) {
    return stageNpxCommand(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (looksLikeUrl(trimmedSource)) {
    return stageUrl(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (trimmedSource.startsWith('github:')) {
    return stageGithubSource(fetchImpl, trimmedSource, requestedId, signal)
  }
  if (trimmedSource.startsWith('npm:')) {
    return stageNpmPackage(fetchImpl, trimmedSource, requestedId, signal)
  }

  try {
    return await stageLocalPath(cwd, trimmedSource, requestedId)
  } catch (error) {
    if (/^[a-z0-9@][a-z0-9._/@-]*(?:@[a-z0-9._-]+)?$/iu.test(trimmedSource)) {
      return stageNpmPackage(fetchImpl, trimmedSource, requestedId, signal)
    }
    throw error
  }
}

export async function resolveAuraSkillInstallSource({
  cwd,
  source,
  sourceType = 'auto',
  content = '',
  skillId = '',
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('The current runtime does not provide fetch, so remote skill sources are unavailable.')
  }

  const staged = await stageAnySource({
    fetchImpl,
    cwd,
    source,
    sourceType,
    content,
    requestedId: skillId,
    signal,
  })
  const skillContent = await fs.readFile(staged.skillFilePath || staged.stagedPath, 'utf8')
  const inferredSkillId = sanitizeSkillId(skillId || inferSkillIdFromContent(skillContent, staged.inferredSkillId))

  return {
    ...staged,
    inferredSkillId,
    name: extractFrontmatterField(skillContent, 'name') || inferredSkillId,
    description: extractFrontmatterField(skillContent, 'description'),
    cleanup: async () => {
      if (staged.tempRoot) {
        await fs.rm(staged.tempRoot, { recursive: true, force: true })
      }
    },
  }
}
