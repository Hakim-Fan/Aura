import { getVersion } from '@tauri-apps/api/app';
import { check as checkTauriUpdate, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { fetch } from '@tauri-apps/plugin-http';

const GITHUB_REPOSITORY = 'Hakim-Fan/Aura';
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const GITHUB_RELEASES_ATOM_URL = `https://github.com/${GITHUB_REPOSITORY}/releases.atom`;

export interface ReleaseInfo {
  version: string;
  notes: string;
  url: string;
  publishedAt: string;
  source: 'tauri' | 'github';
  update?: Update;
  updaterError?: string;
}

export type UpdateInstallProgress = {
  phase: 'downloading' | 'downloaded' | 'installing' | 'relaunching';
  downloaded: number;
  total?: number;
  percent?: number;
};

export type UpdateTaskStatus =
  | 'idle'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'relaunching'
  | 'error';

export type UpdateTaskSnapshot = {
  status: UpdateTaskStatus;
  release: ReleaseInfo | null;
  progress: UpdateInstallProgress | null;
  error: string;
};

type UpdateTaskListener = (snapshot: UpdateTaskSnapshot) => void;

let updateTask: UpdateTaskSnapshot = {
  status: 'idle',
  release: null,
  progress: null,
  error: '',
};
let pendingUpdate: Update | null = null;
let downloadTask: Promise<void> | null = null;
const updateTaskListeners = new Set<UpdateTaskListener>();

function updateTaskSnapshot(): UpdateTaskSnapshot {
  return {
    ...updateTask,
    progress: updateTask.progress ? { ...updateTask.progress } : null,
  };
}

function setUpdateTask(next: Partial<UpdateTaskSnapshot>) {
  updateTask = {
    ...updateTask,
    ...next,
  };
  const snapshot = updateTaskSnapshot();
  for (const listener of updateTaskListeners) {
    listener(snapshot);
  }
}

export function getUpdateTaskSnapshot(): UpdateTaskSnapshot {
  return updateTaskSnapshot();
}

export function subscribeUpdateTask(listener: UpdateTaskListener): () => void {
  updateTaskListeners.add(listener);
  listener(updateTaskSnapshot());
  return () => {
    updateTaskListeners.delete(listener);
  };
}

function extractVersion(value: string): string {
  return String(value || '').match(/v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || '';
}

/**
 * Compare two version strings.
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2.
 */
export function compareVersions(v1: string, v2: string): number {
  const n1 = extractVersion(v1).replace(/^v/, '').split('.').map(Number);
  const n2 = extractVersion(v2).replace(/^v/, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(n1.length, n2.length); i++) {
    const a = n1[i] || 0;
    const b = n2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]*>/g, '').trim());
}

function extractAtomEntry(feed: string): string {
  return feed.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1] || '';
}

function extractAtomText(entry: string, tagName: string): string {
  const match = entry.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

function extractAtomLink(entry: string): string {
  return (
    entry.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] ||
    entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] ||
    ''
  );
}

async function checkForUpdatesFromAtom(currentVersion: string, updaterError = ''): Promise<ReleaseInfo | null> {
  const response = await fetch(GITHUB_RELEASES_ATOM_URL, {
    method: 'GET',
    headers: {
      'Accept': 'application/atom+xml, application/xml, text/xml',
      'User-Agent': 'Aura-Desktop-App',
    },
    connectTimeout: 5000,
  });

  if (!response.ok) {
    return null;
  }

  const feed = await response.text();
  const entry = extractAtomEntry(feed);
  const latestVersion = extractVersion(extractAtomText(entry, 'title'));
  if (!latestVersion) {
    return null;
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return null;
  }

  return {
    version: latestVersion.replace(/^v/, ''),
    notes: stripHtml(extractAtomText(entry, 'content')),
    url: extractAtomLink(entry) || `https://github.com/${GITHUB_REPOSITORY}/releases`,
    publishedAt: extractAtomText(entry, 'updated'),
    source: 'github',
    updaterError,
  };
}

export async function checkForUpdates(): Promise<ReleaseInfo | null> {
  const currentVersion = await getVersion();
  let updaterError = '';

  try {
    const update = await checkTauriUpdate({
      timeout: 5000,
    });
    if (update) {
      return {
        version: update.version,
        notes: update.body || '',
        url: `https://github.com/${GITHUB_REPOSITORY}/releases`,
        publishedAt: update.date || '',
        source: 'tauri',
        update,
      };
    }
  } catch (error) {
    updaterError = error instanceof Error ? error.message : String(error);
    console.warn('Tauri updater check failed, falling back to GitHub release check:', error);
  }

  try {
    const response = await fetch(GITHUB_RELEASES_API_URL, {
      method: 'GET',
      headers: {
         'Accept': 'application/vnd.github+json',
         'User-Agent': 'Aura-Desktop-App'
      },
      connectTimeout: 5000
    });
    
    if (!response.ok) {
      return await checkForUpdatesFromAtom(currentVersion, updaterError);
    }
    
    const data = await response.json();
    const latestVersion = extractVersion(data.tag_name);
    if (typeof latestVersion !== 'string' || !latestVersion.trim()) {
      return null;
    }
    
    // If latest version is higher than current version
    if (compareVersions(latestVersion, currentVersion) > 0) {
      return {
        version: latestVersion.replace(/^v/, ''),
        notes: data.body || '',
        url: data.html_url,
        publishedAt: data.published_at,
        source: 'github',
        updaterError,
      };
    }
    
    return null;
  } catch (error) {
    console.error('Check for updates failed:', error);
    try {
      return await checkForUpdatesFromAtom(currentVersion, updaterError);
    } catch (fallbackError) {
      console.error('Check for updates fallback failed:', fallbackError);
      return null;
    }
  }
}

export function downloadReleaseUpdate(release: ReleaseInfo): Promise<void> {
  if (
    downloadTask &&
    updateTask.release?.version === release.version &&
    updateTask.status === 'downloading'
  ) {
    return downloadTask;
  }

  downloadTask = (async () => {
    setUpdateTask({
      status: 'downloading',
      release,
      progress: null,
      error: '',
    });

    const update = release.update ?? await checkTauriUpdate({
      timeout: 10000,
    });

    if (!update) {
      throw new Error(
        release.updaterError
          ? `暂时无法应用内安装更新：${release.updaterError}`
          : '暂时无法应用内安装更新。请确认当前 GitHub Release 已上传 latest.json 和签名更新包。',
      );
    }

    let downloaded = 0;
    let total: number | undefined;
    await update.download((event: DownloadEvent) => {
      if (event.event === 'Started') {
        downloaded = 0;
        total = event.data.contentLength;
        setUpdateTask({
          progress: {
            phase: 'downloading',
            downloaded,
            total,
            percent: total ? 0 : undefined,
          },
        });
        return;
      }

      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        setUpdateTask({
          progress: {
            phase: 'downloading',
            downloaded,
            total,
            percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined,
          },
        });
        return;
      }

      setUpdateTask({
        progress: {
          phase: 'downloaded',
          downloaded,
          total,
          percent: total ? 100 : undefined,
        },
      });
    });

    pendingUpdate = update;
    setUpdateTask({
      status: 'downloaded',
      release: {
        ...release,
        source: 'tauri',
        update,
      },
      progress: {
        phase: 'downloaded',
        downloaded,
        total,
        percent: total ? 100 : undefined,
      },
      error: '',
    });
  })().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateTask({
      status: 'error',
      release,
      error: message,
    });
    throw error;
  }).finally(() => {
    downloadTask = null;
  });

  return downloadTask;
}

export async function installDownloadedUpdate(): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('更新包尚未下载完成。');
  }

  const downloaded = updateTask.progress?.downloaded ?? 0;
  const total = updateTask.progress?.total;
  setUpdateTask({
    status: 'installing',
    progress: {
      phase: 'installing',
      downloaded,
      total,
      percent: total ? 100 : undefined,
    },
  });

  try {
    await pendingUpdate.install();
    pendingUpdate = null;

    setUpdateTask({
      status: 'relaunching',
      progress: {
        phase: 'relaunching',
        downloaded,
        total,
        percent: total ? 100 : undefined,
      },
    });
    await relaunch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateTask({
      status: 'error',
      error: message,
    });
    throw error;
  }
}
