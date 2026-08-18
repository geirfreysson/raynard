import shareConfig from '../../share.config.json';

// One source of truth for the share base URL, the app's URL scheme, and the DMG
// download link, shared by the app and the Docusaurus site. Pointing production
// links at a real domain is a JSON edit, or a `.env` override for a one-off.

export const SHARE_BASE_URL = String(
  (import.meta.env?.VITE_SHARE_BASE_URL as string | undefined) || shareConfig.shareBaseUrl
).replace(/\/+$/, '');

export const APP_SCHEME: string = shareConfig.appScheme;

export const DOWNLOAD_URL: string = shareConfig.downloadUrl;
