// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blobBase64 } from './telegram-media';

describe('Telegram media', () => {
  it('encodes binary image bytes without corrupting Unicode-sized chunks', async () => {
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;

    const encoded = await blobBase64(new Blob([bytes], { type: 'image/png' }));
    const decoded = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });
});
