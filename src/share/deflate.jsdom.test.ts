// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { compressionAvailable, deflateRaw, inflateRaw } from './deflate';

// jsdom provides neither `Response` nor `ReadableStream`, so the reader loop in
// deflate.ts is the only drain that works here. What survives the environment
// swap is Node's own `CompressionStream`, because vitest only replaces globals
// that the jsdom window actually defines. If someone rewrites `pump` to use
// `new Response(stream).arrayBuffer()`, this file fails while the node-environment
// suite keeps passing — which is exactly the regression worth catching, since the
// packaged app runs in a webview, not in Node.

describe('deflate under jsdom', () => {
  it('still has a usable CompressionStream', () => {
    expect(compressionAvailable()).toBe(true);
  });

  it('round-trips without Response or ReadableStream globals', async () => {
    const text = JSON.stringify({ q: 'population of Iceland', rows: [1, 2, 3] });
    const bytes = new TextEncoder().encode(text);
    const restored = new TextDecoder().decode(await inflateRaw(await deflateRaw(bytes)));
    expect(restored).toBe(text);
  });
});
