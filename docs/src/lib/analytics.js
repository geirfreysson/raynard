export const DOWNLOAD_EVENT_NAME = 'download_click';

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
