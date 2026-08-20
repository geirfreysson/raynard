import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { APP_SCHEME, DOWNLOAD_URL, SHARE_BASE_URL } from './config';

const root = new URL('../../', import.meta.url);
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');
type SharedConfig = {
  appScheme: string;
  downloadUrl: string;
  shareBaseUrl: string;
  downloads: Record<string, string>;
};
const shareConfig = JSON.parse(read('share.config.json')) as SharedConfig;

describe('share.config.json', () => {
  it('declares the app links and platform downloads in one shared file', () => {
    expect(Object.keys(shareConfig).sort()).toEqual([
      'appScheme',
      'downloadUrl',
      'downloads',
      'shareBaseUrl'
    ]);
    expect(shareConfig.downloads.macos).toBe(shareConfig.downloadUrl);
  });

  it('uses a scheme that is a valid URL scheme', () => {
    expect(shareConfig.appScheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
  });

  it('points the download at https', () => {
    expect(shareConfig.downloadUrl).toMatch(/^https:\/\//);
    for (const download of Object.values(shareConfig.downloads)) {
      expect(download).toMatch(/^https:\/\//);
    }
  });
});

describe('exported config', () => {
  it('strips trailing slashes so links never double up', () => {
    expect(SHARE_BASE_URL).not.toMatch(/\/$/);
    expect(SHARE_BASE_URL).toBe(shareConfig.shareBaseUrl.replace(/\/+$/, ''));
  });

  it('re-exports the scheme and download URL unchanged', () => {
    expect(APP_SCHEME).toBe(shareConfig.appScheme);
    expect(DOWNLOAD_URL).toBe(shareConfig.downloadUrl);
  });
});

describe('docs download links', () => {
  const RELEASE_URL = /https:\/\/github\.com\/[^\s"')\]]*releases\/latest\/download\/[^\s"')\]]*/g;

  // Code reads the URL from share.config.json directly.
  it('is imported, not hardcoded, in the pages that can import it', () => {
    for (const place of [
      'docs/docusaurus.config.js',
      'docs/src/pages/index.js',
      'docs/src/pages/s.js',
      'docs/src/lib/download.js',
      'docs/src/content/homepage-copy.json'
    ]) {
      expect(read(place).match(RELEASE_URL)).toBeNull();
      }
  });

  // Markdown cannot import, so equality is enforced here instead.
  it('matches share.config.json in getting-started.md', () => {
    const found = read('docs/docs/getting-started.md').match(RELEASE_URL) ?? [];
    expect(found.length).toBeGreaterThan(0);
    const configuredDownloads = new Set([
      shareConfig.downloadUrl,
      ...Object.values(shareConfig.downloads)
    ]);
    for (const url of found) expect(configuredDownloads).toContain(url);
  });
});
