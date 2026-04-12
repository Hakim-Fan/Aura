import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';

export interface ReleaseInfo {
  version: string;
  notes: string;
  url: string;
  publishedAt: string;
}

/**
 * Compare two version strings.
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2.
 */
export function compareVersions(v1: string, v2: string): number {
  const n1 = v1.replace(/^v/, '').split('.').map(Number);
  const n2 = v2.replace(/^v/, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(n1.length, n2.length); i++) {
    const a = n1[i] || 0;
    const b = n2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

export async function checkForUpdates(): Promise<ReleaseInfo | null> {
  try {
    const currentVersion = await getVersion();
    const response = await fetch('https://api.github.com/repos/Hakim-Fan/Aura-release/releases/latest', {
      method: 'GET',
      headers: {
         'Accept': 'application/vnd.github+json',
         'User-Agent': 'Aura-Desktop-App'
      },
      connectTimeout: 5000
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    const latestVersion = data.tag_name;
    
    // If latest version is higher than current version
    if (compareVersions(latestVersion, currentVersion) > 0) {
      return {
        version: latestVersion.replace(/^v/, ''),
        notes: data.body || '',
        url: data.html_url,
        publishedAt: data.published_at,
      };
    }
    
    return null;
  } catch (error) {
    console.error('Check for updates failed:', error);
    return null;
  }
}
