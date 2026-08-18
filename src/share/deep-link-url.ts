/**
 * Sanity cap on an encoded payload arriving from the OS.
 *
 * This is not the LaunchServices ceiling — that is measured separately and is
 * what sets `SHARE_URL_BUDGET_CHARS`. This is only here so a malformed or
 * hostile URL cannot hand the decoder an unbounded string.
 */
const MAX_ENCODED_LENGTH = 64 * 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Pull the encoded payload out of `<scheme>://share/<base64url>`.
 *
 * Returns null rather than throwing: this runs on input handed over by the
 * operating system, and an unrecognized URL is a no-op, not an error worth
 * surfacing. The scheme and host are matched case-insensitively because URL
 * handlers routinely lowercase both.
 */
export function parseShareDeepLink(url: string, scheme: string): string | null {
  const trimmed = String(url || '').trim();
  const prefix = `${scheme}://share/`;
  if (trimmed.length <= prefix.length) return null;
  if (!trimmed.slice(0, prefix.length).toLowerCase().startsWith(prefix.toLowerCase())) return null;

  // A trailing slash is a common normalization; anything else non-base64url is a reject.
  const encoded = trimmed.slice(prefix.length).replace(/\/+$/, '');
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) return null;
  if (!BASE64URL.test(encoded)) return null;
  return encoded;
}
