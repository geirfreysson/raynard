import {describe, expect, it, vi} from 'vitest';
import {DOWNLOAD_EVENT_NAME, pageViewFields, trackDownloadClick} from './analytics';

describe('pageViewFields', () => {
  it('never sends a shared-answer fragment to analytics', () => {
    expect(pageViewFields({
      origin: 'https://raynard.ai',
      pathname: '/s',
      search: '?from=docs',
      hash: '#private-shared-answer-payload',
    })).toEqual({
      page_location: 'https://raynard.ai/s?from=docs',
      page_path: '/s?from=docs',
    });
  });
});

describe('trackDownloadClick', () => {
  it('sends a download event with useful report dimensions', () => {
    const gtag = vi.fn();

    trackDownloadClick(
      {
        platform: 'macos',
        placement: 'homepage_primary',
        url: 'https://example.com/Raynard.dmg',
        label: 'Download for Mac',
      },
      gtag,
    );

    expect(gtag).toHaveBeenCalledWith('event', DOWNLOAD_EVENT_NAME, {
      download_platform: 'macos',
      link_text: 'Download for Mac',
      link_url: 'https://example.com/Raynard.dmg',
      placement: 'homepage_primary',
    });
  });

  it('does nothing when analytics is unavailable', () => {
    expect(() => trackDownloadClick({platform: 'linux'}, null)).not.toThrow();
  });
});
