/**
 * Clipboard writes for the copy affordances on rendered tables and charts.
 *
 * The app runs in a WKWebView: `npm run tauri dev` serves from 127.0.0.1 and
 * gets the full async clipboard API, but a packaged build serves from the
 * `tauri://localhost` custom scheme, where the API may be missing entirely.
 * So each write walks down a ladder — rich item, then plain text, then the
 * legacy `execCommand` path — and reports whether anything landed rather than
 * throwing.
 */

export type CopyPayload = {
  /** Always written, so a text target gets something useful. */
  text: string;
  /** Produces the `image/png` flavor. Called at most once, at copy time. */
  image?: () => Promise<Blob>;
};

const TEXT_TYPE = 'text/plain';
const IMAGE_TYPE = 'image/png';

type ClipboardItemCtor = new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem;

/** Writes a payload to the system clipboard. Returns false if nothing landed. */
export async function writeClipboard(payload: CopyPayload): Promise<boolean> {
  if (await writeClipboardItem(payload)) return true;
  if (await writeClipboardText(payload.text)) return true;
  return writeClipboardTextLegacy(payload.text);
}

/** The only tier that can carry an image: one item holding every flavor. */
async function writeClipboardItem(payload: CopyPayload): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  const ClipboardItemCtor = (globalThis as { ClipboardItem?: ClipboardItemCtor }).ClipboardItem;
  if (typeof clipboard?.write !== 'function' || typeof ClipboardItemCtor !== 'function') {
    return false;
  }

  const items: Record<string, Blob | Promise<Blob>> = {
    [TEXT_TYPE]: new Blob([payload.text], { type: TEXT_TYPE })
  };
  if (payload.image) {
    // WebKit closes the user-gesture window while an image is being produced,
    // so the unresolved promise goes straight into the item and the write
    // itself does the waiting. The no-op catch only marks the promise handled;
    // clipboard.write() still sees the rejection and is caught below.
    const image = payload.image();
    image.catch(() => {});
    items[IMAGE_TYPE] = image;
  }

  try {
    await clipboard.write([new ClipboardItemCtor(items)]);
    return true;
  } catch {
    return false;
  }
}

async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Off-screen textarea plus `execCommand`, for webviews with no clipboard API. */
function writeClipboardTextLegacy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
