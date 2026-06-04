import fs from 'node:fs';
import path from 'node:path';

const [artifactsDirArg, tagArg, repositoryArg, notesPathArg] = process.argv.slice(2);

const artifactsDir = artifactsDirArg || 'artifacts';
const tag = tagArg || process.env.GITHUB_REF_NAME || '';
const repository = repositoryArg || process.env.GITHUB_REPOSITORY || 'Hakim-Fan/Aura';
const notesPath = notesPathArg || 'RELEASE_NOTES.md';
const version = tag.replace(/^v/, '');
const releaseAssetsDir = path.join(artifactsDir, 'release-assets');

if (!version) {
  throw new Error('Missing release tag/version for updater manifest.');
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && path.resolve(fullPath) === path.resolve(releaseAssetsDir)) {
      return [];
    }
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function readSignature(sigPath) {
  return fs.readFileSync(sigPath, 'utf8').trim();
}

function encodeAssetName(assetName) {
  return encodeURIComponent(assetName).replace(/%2F/g, '/');
}

function platformKeyFor(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const isWindows = normalized.includes('windows') || /\.(msi|nsis|exe)\.zip$/.test(normalized);
  const isMac = normalized.includes('macos') || normalized.includes('darwin') || normalized.endsWith('.app.tar.gz');
  const isLinux = normalized.includes('linux') || normalized.endsWith('.appimage.tar.gz');

  const isArm = normalized.includes('aarch64') || normalized.includes('arm64');
  const isX64 = normalized.includes('x86_64') || normalized.includes('x64') || normalized.includes('amd64');

  if (isMac && isArm) return 'darwin-aarch64';
  if (isMac && isX64) return 'darwin-x86_64';
  if (isWindows && isArm) return 'windows-aarch64';
  if (isWindows && isX64) return 'windows-x86_64';
  if (isLinux && isArm) return 'linux-aarch64';
  if (isLinux) return 'linux-x86_64';
  return '';
}

const files = walk(artifactsDir);
const platforms = {};
const updaterCandidatesByPlatform = new Map();

function updaterPackageExtension(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('.app.tar.gz')) return 'app.tar.gz';
  if (normalized.endsWith('.appimage.tar.gz')) return 'AppImage.tar.gz';
  if (normalized.endsWith('.nsis.zip')) return 'nsis.zip';
  if (normalized.endsWith('.msi.zip')) return 'msi.zip';
  if (normalized.endsWith('.exe.zip')) return 'exe.zip';
  if (normalized.endsWith('.tar.gz')) return 'tar.gz';
  if (normalized.endsWith('.zip')) return 'zip';
  return path.basename(filePath);
}

function updaterCandidateScore(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('.nsis.zip')) return 50;
  if (normalized.endsWith('.appimage.tar.gz')) return 50;
  if (normalized.endsWith('.app.tar.gz')) return 50;
  if (normalized.endsWith('.exe.zip')) return 40;
  if (normalized.endsWith('.msi.zip')) return 30;
  return 10;
}

function copyFileUnique(sourcePath, preferredName, usedNames) {
  let candidateName = preferredName;
  const parsed = path.parse(preferredName);
  let index = 2;

  while (usedNames.has(candidateName)) {
    candidateName = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  }

  usedNames.add(candidateName);
  fs.copyFileSync(sourcePath, path.join(releaseAssetsDir, candidateName));
  return candidateName;
}

for (const sigPath of files.filter(file => file.endsWith('.sig'))) {
  const packagePath = sigPath.slice(0, -4);
  if (!fs.existsSync(packagePath)) {
    continue;
  }
  const platformKey = platformKeyFor(packagePath);
  if (!platformKey) {
    continue;
  }

  const candidate = {
    packagePath,
    score: updaterCandidateScore(packagePath),
    signature: readSignature(sigPath),
  };
  const previous = updaterCandidatesByPlatform.get(platformKey);
  if (!previous || candidate.score > previous.score) {
    updaterCandidatesByPlatform.set(platformKey, candidate);
  }
}

if (updaterCandidatesByPlatform.size === 0) {
  const scannedFiles = files.length > 0 ? files.map(file => `- ${file}`).join('\n') : '(none)';
  throw new Error(`No updater artifacts with signatures were found.\nScanned files:\n${scannedFiles}`);
}

fs.rmSync(releaseAssetsDir, { force: true, recursive: true });
fs.mkdirSync(releaseAssetsDir, { recursive: true });

const usedNames = new Set();
const publicInstallerPattern = /\.(dmg|msi|exe|deb|appimage)$/i;
for (const filePath of files.filter(file => publicInstallerPattern.test(file))) {
  copyFileUnique(filePath, path.basename(filePath), usedNames);
}

for (const [platformKey, candidate] of updaterCandidatesByPlatform.entries()) {
  const extension = updaterPackageExtension(candidate.packagePath);
  const assetName = copyFileUnique(
    candidate.packagePath,
    `Aura_${version}_${platformKey}_${extension}`,
    usedNames,
  );
  platforms[platformKey] = {
    signature: candidate.signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeAssetName(assetName)}`,
  };
}

const manifest = {
  version,
  notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '',
  pub_date: new Date().toISOString(),
  platforms,
};

const outputPath = path.join(releaseAssetsDir, 'latest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Created updater manifest at ${outputPath}`);
console.log(Object.keys(platforms).sort().join('\n'));
