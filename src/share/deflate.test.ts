import { describe, expect, it } from 'vitest';

import { compressionAvailable, deflateRaw, inflateRaw } from './deflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function roundTrip(text: string): Promise<string> {
  return decoder.decode(await inflateRaw(await deflateRaw(encoder.encode(text))));
}

describe('deflate', () => {
  it('reports availability in this runtime', () => {
    expect(compressionAvailable()).toBe(true);
  });

  it('round-trips ASCII', async () => {
    await expect(roundTrip('hello share link')).resolves.toBe('hello share link');
  });

  it('round-trips unicode outside the BMP', async () => {
    const text = 'Ísland — 🦊 “quoted” ünïcode';
    await expect(roundTrip(text)).resolves.toBe(text);
  });

  it('round-trips an empty string', async () => {
    await expect(roundTrip('')).resolves.toBe('');
  });

  it('round-trips a payload larger than the stream queue without deadlocking', async () => {
    // Well past a transform stream's internal high-water mark: this is the case
    // that hangs if the write is awaited to completion before reading starts.
    const rows = Array.from({ length: 4000 }, (_, index) => ({
      id: index,
      name: `Observation ${index}`,
      value: index * 1.5
    }));
    const text = JSON.stringify({ rows });
    expect(text.length).toBeGreaterThan(100_000);
    await expect(roundTrip(text)).resolves.toBe(text);
  });

  it('compresses repetitive JSON substantially', async () => {
    const text = JSON.stringify(
      Array.from({ length: 500 }, (_, index) => ({ label: 'Population, total', year: 2000 + index }))
    );
    const deflated = await deflateRaw(encoder.encode(text));
    expect(deflated.length).toBeLessThan(text.length / 5);
  });

  it('rejects input that is not deflate-raw', async () => {
    await expect(inflateRaw(encoder.encode('not compressed at all'))).rejects.toThrow();
  });
});
