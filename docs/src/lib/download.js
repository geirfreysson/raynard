import shareConfig from '../../../share.config.json';

export function platformForUserAgent(userAgent = '') {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes('windows')) return 'windows';
  if (normalized.includes('linux') && !normalized.includes('android')) return 'linux';
  return 'macos';
}

export function downloadUrlForUserAgent(userAgent = '') {
  return shareConfig.downloads[platformForUserAgent(userAgent)];
}
