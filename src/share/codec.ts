import { deflateRaw, inflateRaw } from './deflate';
import { SHARE_PAYLOAD_VERSION, ShareLinkError } from './types';
import type { SharedAnswerPayload } from './types';

// JSON → deflate-raw → base64url. base64url because the same string has to
// survive a URL fragment, a `raynard://share/<...>` path segment, and whatever
// chat client carried the link, with no percent-encoding anywhere.

const CHUNK = 0x8000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ShareLinkError('This share link is not valid.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encodeSharePayload(payload: SharedAnswerPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return bytesToBase64Url(await deflateRaw(json));
}

export async function decodeSharePayload(encoded: string): Promise<SharedAnswerPayload> {
  const trimmed = String(encoded || '').trim();
  if (!trimmed) throw new ShareLinkError('This share link is empty.');

  let json: string;
  try {
    json = new TextDecoder().decode(await inflateRaw(base64UrlToBytes(trimmed)));
  } catch (error) {
    if (error instanceof ShareLinkError) throw error;
    throw new ShareLinkError('This share link could not be read.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ShareLinkError('This share link could not be read.');
  }

  return validateSharePayload(parsed);
}

/**
 * Reject anything that is not a payload this build understands, rather than
 * letting a partial object reach the renderer and half-draw an answer.
 */
export function validateSharePayload(value: unknown): SharedAnswerPayload {
  if (!value || typeof value !== 'object') {
    throw new ShareLinkError('This share link could not be read.');
  }
  const payload = value as Partial<SharedAnswerPayload>;

  if (payload.v !== SHARE_PAYLOAD_VERSION) {
    throw new ShareLinkError('This share link was made by a newer version of Raynard.');
  }
  if (typeof payload.q !== 'string' || typeof payload.a !== 'string') {
    throw new ShareLinkError('This share link could not be read.');
  }
  if (payload.cards !== undefined && !Array.isArray(payload.cards)) {
    throw new ShareLinkError('This share link could not be read.');
  }
  if (payload.sources !== undefined && !Array.isArray(payload.sources)) {
    throw new ShareLinkError('This share link could not be read.');
  }

  return payload as SharedAnswerPayload;
}

/** The https link a sender copies. The payload rides in the fragment, unsent. */
export function shareLinkFor(encoded: string, baseUrl: string): string {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/s#${encoded}`;
}

/**
 * The handoff the landing page opens. A path segment rather than a fragment:
 * base64url is path-safe, and nothing between LaunchServices and Rust can drop
 * a path the way a URL parser can drop a fragment.
 */
export function deepLinkFor(encoded: string, scheme: string): string {
  return `${scheme}://share/${encoded}`;
}
