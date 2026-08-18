// The one platform-dependent corner of share links.
//
// `CompressionStream('deflate-raw')` ships in WebKit from Safari 16.4 (macOS 13,
// which is why `minimumSystemVersion` in tauri.conf.json is 13.0) and in Node
// from 18, so neither the app, the tests, nor the docs page needs a dependency.
//
// The stream is drained with an explicit reader loop rather than
// `new Response(stream).arrayBuffer()`. Under jsdom there is no `Response` and no
// `ReadableStream`; what survives is Node's own `CompressionStream`, whose
// readable is a Node stream object. The reader loop works on that, while the
// `Response` form would be relying on globals leaking between environments.

type ByteStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type StreamCtor = new (format: string) => ByteStream;

function ctor(name: 'CompressionStream' | 'DecompressionStream'): StreamCtor {
  const found = (globalThis as Record<string, unknown>)[name];
  if (typeof found !== 'function') {
    throw new Error(`${name} is unavailable in this runtime.`);
  }
  return found as StreamCtor;
}

/** True when this runtime can build and read share links. */
export function compressionAvailable(): boolean {
  const scope = globalThis as Record<string, unknown>;
  return (
    typeof scope.CompressionStream === 'function' &&
    typeof scope.DecompressionStream === 'function'
  );
}

/**
 * Push `bytes` through a transform stream and collect the result.
 *
 * The write is started but deliberately not awaited before reading begins: a
 * transform stream has a bounded internal queue, so awaiting the write to
 * completion first deadlocks as soon as the output exceeds it.
 */
async function pump(bytes: Uint8Array, stream: ByteStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  // Malformed input rejects on the read side, so `await written` below is never
  // reached. Claim that rejection now or it surfaces as an unhandled promise.
  written.catch(() => {});

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
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

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new (ctor('CompressionStream'))('deflate-raw'));
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new (ctor('DecompressionStream'))('deflate-raw'));
}
