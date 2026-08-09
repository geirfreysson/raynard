/**
 * Links rendered from model output or plugin READMEs are ordinary anchors, but a
 * Tauri webview cannot open them: `target="_blank"` is inert and an in-place
 * navigation would replace the app. One delegated listener sends every http(s)
 * anchor click to the host, which hands it to the platform browser instead.
 */

/**
 * Returns a normalized http(s) URL safe to hand to a platform opener, or null.
 * The normalized form matters: parsing percent-encodes anything the opener could
 * otherwise read as a separate argument.
 */
export function resolveExternalUrl(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  // A leading "-" would reach the platform opener as a flag rather than a URL.
  if (!trimmed || trimmed.startsWith('-')) return null;
  if (/\s/.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Routes clicks on any external anchor under `root` through `openExternal`. */
export function attachExternalLinkHandler(
  root: Document | HTMLElement,
  openExternal: (url: string) => void | Promise<void>
) {
  root.addEventListener('click', (event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.defaultPrevented || mouseEvent.button !== 0) return;

    const target = mouseEvent.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor) return;

    const url = resolveExternalUrl(anchor.getAttribute('href'));
    if (!url) return;

    event.preventDefault();
    void openExternal(url);
  });
}
