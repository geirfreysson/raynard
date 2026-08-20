import {describe, expect, it} from 'vitest';
import shareConfig from '../../../share.config.json';
import {downloadUrlForUserAgent, platformForUserAgent} from './download';

describe('platformForUserAgent', () => {
  it('detects Windows', () => {
    expect(platformForUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  it('detects desktop Linux', () => {
    expect(platformForUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('treats Android as macOS rather than Linux, so the hero offers a real desktop build', () => {
    expect(platformForUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('macos');
  });

  it('falls back to macOS without a user agent, which is what server rendering sees', () => {
    expect(platformForUserAgent()).toBe('macos');
  });
});

describe('downloadUrlForUserAgent', () => {
  it('resolves each detected platform to its configured download', () => {
    expect(downloadUrlForUserAgent('Mozilla/5.0 (Windows NT 10.0)')).toBe(shareConfig.downloads.windows);
    expect(downloadUrlForUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe(shareConfig.downloads.linux);
    expect(downloadUrlForUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(shareConfig.downloads.macos);
  });
});
