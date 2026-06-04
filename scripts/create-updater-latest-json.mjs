import fs from 'node:fs';
import path from 'node:path';

const [artifactsDirArg, tagArg, repositoryArg, notesPathArg] = process.argv.slice(2);

const artifactsDir = artifactsDirArg || 'artifacts';
const tag = tagArg || process.env.GITHUB_REF_NAME || '';
const repository = repositoryArg || process.env.GITHUB_REPOSITORY || 'Hakim-Fan/Aura';
const notesPath = notesPathArg || 'RELEASE_NOTES.md';
const version = tag.replace(/^v/, '');

if (!version) {
  throw new Error('Missing release tag/version for updater manifest.');
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function readSignature(sigPath) {
  return fs.readFileSync(sigPath, 'utf8').trim();
}

function encodeAssetName(filePath) {
  return encodeURIComponent(path.basename(filePath)).replace(/%2F/g, '/');
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

for (const sigPath of files.filter(file => file.endsWith('.sig'))) {
  const packagePath = sigPath.slice(0, -4);
  if (!fs.existsSync(packagePath)) {
    continue;
  }
  const platformKey = platformKeyFor(packagePath);
  if (!platformKey) {
    continue;
  }
  const assetName = encodeAssetName(packagePath);
  platforms[platformKey] = {
    signature: readSignature(sigPath),
    url: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error('No updater artifacts with signatures were found.');
}

const manifest = {
  version,
  notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '',
  pub_date: new Date().toISOString(),
  platforms,
};

const outputPath = path.join(artifactsDir, 'latest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Created updater manifest at ${outputPath}`);
console.log(Object.keys(platforms).sort().join('\n'));
