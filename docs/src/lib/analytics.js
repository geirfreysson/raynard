export const DOWNLOAD_EVENT_NAME = 'download_click';
export const DEMO_VIDEO_PLAY_EVENT_NAME = 'demo_video_play';

export function pageViewFields(location) {
  return {
    page_location: `${location.origin}${location.pathname}${location.search}`,
    page_path: `${location.pathname}${location.search}`,
  };
}

export function trackDownloadClick({platform, placement, url, label}, gtag = globalThis.window?.gtag) {
  if (typeof gtag !== 'function') return;

  gtag('event', DOWNLOAD_EVENT_NAME, {
    download_platform: platform,
    link_text: label,
    link_url: url,
    placement,
  });
}

export function trackDemoVideoPlay({placement, url, label}, gtag = globalThis.window?.gtag) {
  if (typeof gtag !== 'function') return;

  gtag('event', DEMO_VIDEO_PLAY_EVENT_NAME, {
    video_title: label,
    video_url: url,
    placement,
  });
}
