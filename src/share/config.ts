import shareConfig from '../../share.config.json';

// One source of truth for the share base URL, the app's URL scheme, and release
// downloads, shared by the app and the Docusaurus site. DOWNLOAD_URL remains
// the default macOS link for renderer surfaces that cannot inspect the reader's
// operating system; the docs select from `shareConfig.downloads` in-browser.

export const SHARE_BASE_URL = String(
  (import.meta.env?.VITE_SHARE_BASE_URL as string | undefined) || shareConfig.shareBaseUrl
).replace(/\/+$/, '');

export const APP_SCHEME: string = shareConfig.appScheme;

export const DOWNLOAD_URL: string = shareConfig.downloadUrl;
