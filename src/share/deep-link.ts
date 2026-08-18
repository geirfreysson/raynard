import { Channel, invoke } from '@tauri-apps/api/core';

import { parseShareDeepLink } from './deep-link-url';

/**
 * Shared answers arriving from the operating system.
 *
 * Rust validates and buffers the URL and pushes it over a `Channel`, the same
 * transport the agent streams use. Deliberately not `listen()` from
 * `@tauri-apps/api/event`: that would require the app's first capability file
 * and change the whole webview's permission posture for one feature.
 */
export async function subscribeDeepLinks(
  scheme: string,
  onEncoded: (encoded: string) => void
): Promise<void> {
  const channel = new Channel<string>((url) => {
    const encoded = parseShareDeepLink(url, scheme);
    if (encoded) onEncoded(encoded);
  });
  await invoke('subscribe_deep_links', { onUrl: channel });
}

/**
 * Development backdoor.
 *
 * macOS cannot register a URL scheme at runtime, so a deep link only works from
 * a bundled app installed in /Applications — `npm run tauri dev` never sees one.
 * Loading `http://127.0.0.1:1420/#share=<encoded>` runs the identical import
 * path, which turns a multi-minute rebuild loop into a page reload.
 *
 * Returns the encoded payload, or null when the hash is anything else.
 */
export function readDevShareHash(hash: string): string | null {
  const match = /^#share=(.+)$/.exec(String(hash || '').trim());
  if (!match) return null;
  const encoded = match[1];
  return /^[A-Za-z0-9_-]+$/.test(encoded) ? encoded : null;
}
