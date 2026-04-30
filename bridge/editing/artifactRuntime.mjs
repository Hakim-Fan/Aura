import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const OFFICE_OPEN_XML_SIGNATURES = {
  docx: {
    requiredEntries: ['[Content_Types].xml', 'word/document.xml'],
    label: 'docx',
  },
  pptx: {
    requiredEntries: ['[Content_Types].xml', 'ppt/presentation.xml'],
    label: 'pptx',
  },
  xlsx: {
    requiredEntries: ['[Content_Types].xml', 'xl/workbook.xml'],
    label: 'xlsx',
  },
}

const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'ppt', 'xls'])

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function readExtension(targetPath) {
  return path.extname(targetPath).slice(1).toLowerCase()
}

function hasPrefix(buffer, bytes) {
  if (buffer.length < bytes.length) {
    return false
  }
  return bytes.every((byte, index) => buffer[index] === byte)
}

function detectBasicArtifactKind(buffer, extension) {
  if (OFFICE_OPEN_XML_SIGNATURES[extension]) {
    return extension
  }
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    return 'legacy-office'
  }
  if (hasPrefix(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'pdf'
  }
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47])) {
    return 'png'
  }
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
    return 'jpeg'
  }
  return extension || 'file'
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50
  const minimumOffset = Math.max(0, buffer.length - 22 - 65_535)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset
    }
  }
  return -1
}

function readZipEntryNames(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
    return {
      isZip: false,
      entries: [],
    }
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  const entries = []
  let offset = centralDirectoryOffset

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      return {
        isZip: true,
        malformed: true,
        entries,
      }
    }

    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const fileNameStart = offset + 46
    const fileNameEnd = fileNameStart + fileNameLength
    if (fileNameEnd > buffer.length) {
      return {
        isZip: true,
        malformed: true,
        entries,
      }
    }
    entries.push(buffer.subarray(fileNameStart, fileNameEnd).toString('utf8'))
    offset = fileNameEnd + extraLength + commentLength
  }

  return {
    isZip: true,
    malformed: false,
    entries,
  }
}

function summarizeOpenXml(buffer, extension) {
  const signature = OFFICE_OPEN_XML_SIGNATURES[extension]
  if (!signature) {
    return null
  }

  const zip = readZipEntryNames(buffer)
  const entrySet = new Set(zip.entries)
  const missingEntries = signature.requiredEntries.filter(entry => !entrySet.has(entry))
  const structureVerified =
    zip.isZip === true &&
    zip.malformed !== true &&
    missingEntries.length === 0

  return {
    format: signature.label,
    container: 'zip',
    isZip: zip.isZip === true,
    malformedZip: zip.malformed === true,
    requiredEntries: signature.requiredEntries,
    missingEntries,
    structureVerified,
    entries: zip.entries.slice(0, 80),
  }
}

function summarizeLegacyOffice(buffer, extension) {
  if (!LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    return null
  }

  const hasOleSignature = hasPrefix(buffer, [
    0xd0,
    0xcf,
    0x11,
    0xe0,
    0xa1,
    0xb1,
    0x1a,
    0xe1,
  ])

  return {
    format: extension,
    container: 'ole',
    structureVerified: hasOleSignature,
  }
}

export async function verifyWorkspaceArtifact(targetPath, options = {}) {
  const displayPath =
    typeof options.displayPath === 'string' && options.displayPath.trim()
      ? options.displayPath.trim()
      : targetPath
  const expectedKind =
    typeof options.expectedKind === 'string' && options.expectedKind.trim()
      ? options.expectedKind.trim().toLowerCase()
      : ''

  const stats = await fs.stat(targetPath)
  const buffer = await fs.readFile(targetPath)
  const extension = readExtension(targetPath)
  const kind = detectBasicArtifactKind(buffer, extension)
  const office =
    summarizeOpenXml(buffer, extension) ||
    summarizeLegacyOffice(buffer, extension) ||
    null
  const expectedKindMatches = expectedKind ? expectedKind === kind || expectedKind === extension : true
  const structureVerified = office ? office.structureVerified === true : true
  const verified =
    stats.isFile() &&
    stats.size > 0 &&
    expectedKindMatches &&
    structureVerified

  return {
    operation: 'verify_artifact',
    path: displayPath,
    absolutePath: targetPath,
    exists: true,
    bytes: stats.size,
    sha256: sha256(buffer),
    extension,
    kind,
    expectedKind: expectedKind || undefined,
    expectedKindMatches,
    readBackOk: true,
    office: office || undefined,
    verified,
  }
}
