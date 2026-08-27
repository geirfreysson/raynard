import {describe, expect, it, vi} from 'vitest';
import {
  DEMO_VIDEO_PLAY_EVENT_NAME,
  DOWNLOAD_EVENT_NAME,
  pageViewFields,
  trackDemoVideoPlay,
  trackDownloadClick,
} from './analytics';

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

describe('trackDemoVideoPlay', () => {
  it('sends a dedicated event when the hero demo is started', () => {
    const gtag = vi.fn();

    trackDemoVideoPlay(
      {
        placement: 'homepage_hero',
        url: '/img/screenshots/raymond-demo-video.mp4',
        label: 'Product demo',
      },
      gtag,
    );

    expect(gtag).toHaveBeenCalledWith('event', DEMO_VIDEO_PLAY_EVENT_NAME, {
      video_title: 'Product demo',
      video_url: '/img/screenshots/raymond-demo-video.mp4',
      placement: 'homepage_hero',
    });
  });

  it('does nothing when analytics is unavailable', () => {
    expect(() => trackDemoVideoPlay({placement: 'homepage_hero'}, null)).not.toThrow();
  });
});
