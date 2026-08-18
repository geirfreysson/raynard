/**
 * Decode-only half of the share-link codec.
 *
 * This is the one place the docs site duplicates app code, so it is kept as
 * small as it can possibly be: base64url → deflate-raw → JSON, and a version
 * check. It reads only `q`, `teaser`, and `degraded`, which is why the site
 * needs no copy of the card renderer, `resolve.ts`, or the CardTemplate types —
 * the app precomputes the teaser strings at share time.
 *
 * `src/share/docs-parity.test.ts` in the app repo asserts this decodes exactly
 * what `encodeSharePayload` produces, so the duplication cannot silently drift.
 */

export const SHARE_PAYLOAD_VERSION = 1;

export class ShareLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new ShareLinkError('This share link is not valid.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new ShareLinkError('This browser cannot read share links.');
  }
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  // The read side rejects on malformed input before this is awaited.
  written.catch(() => {});

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
  }
  await written;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function decodeSharePayload(encoded) {
  const trimmed = String(encoded || '').trim();
  if (!trimmed) throw new ShareLinkError('This share link is empty.');

  let json;
  try {
    json = new TextDecoder().decode(await inflateRaw(base64UrlToBytes(trimmed)));
  } catch (error) {
    if (error instanceof ShareLinkError) throw error;
    throw new ShareLinkError('This share link could not be read.');
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new ShareLinkError('This share link could not be read.');
  }

  if (!payload || typeof payload !== 'object') {
    throw new ShareLinkError('This share link could not be read.');
  }
  if (payload.v !== SHARE_PAYLOAD_VERSION) {
    throw new ShareLinkError('This share link was made by a newer version of Raynard.');
  }
  if (typeof payload.q !== 'string' || typeof payload.a !== 'string') {
    throw new ShareLinkError('This share link could not be read.');
  }
  return payload;
}

/** The one-line summary shown on the landing page, from the precomputed teaser. */
export function teaserLine(payload) {
  const teaser = payload.teaser || {};
  return [teaser.cards, teaser.ext].filter(Boolean).join(' · ');
}

/** What the sender gave up to fit the link, phrased for a recipient. */
export function degradationLine(payload) {
  const degraded = payload.degraded;
  if (!degraded) return null;

  const parts = [];
  if (degraded.rows && degraded.rows.length) {
    const shown = degraded.rows.reduce((sum, row) => sum + row.shown, 0);
    const total = degraded.rows.reduce((sum, row) => sum + row.total, 0);
    parts.push(`tables trimmed to ${shown.toLocaleString()} of ${total.toLocaleString()} rows`);
  }
  if (degraded.droppedCards) {
    parts.push(
      `${degraded.droppedCards} result ${degraded.droppedCards === 1 ? 'card' : 'cards'} left out`
    );
  }
  if (degraded.citationPayloads) parts.push('citation excerpts omitted');

  if (!parts.length) return null;
  return `To fit in a link: ${parts.join(', ')}.`;
}
