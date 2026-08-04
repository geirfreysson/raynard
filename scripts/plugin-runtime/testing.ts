// Raynard generated-plugin test helpers — vendored UNCHANGED into each plugin.
// Import these in *.test.ts files; do not edit them inside a plugin.

export type MockResponseSpec = {
  /** HTTP status to simulate (default 200). */
  status?: number;
  /** JSON body (object/array) or a raw string. */
  body?: unknown;
};

export type MockFetch = {
  /** URLs requested, in order. */
  calls: string[];
  /** Restore the real global fetch. Always call this in a finally block. */
  restore: () => void;
};

/**
 * Replace globalThis.fetch with a deterministic stub for the duration of a test.
 * `handler` maps a requested URL to a { status, body } response; returning
 * undefined yields an empty 200.
 */
export function mockFetch(handler: (url: string) => MockResponseSpec | undefined): MockFetch {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body = {} } = handler(url) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/**
 * Assert a tool result is well-formed: non-empty text and at least one citation.
 * Throws a plain Error (works under both node:test and vitest) and returns the
 * result so it can be chained.
 */
export function expectToolResult<T extends { text?: unknown; references?: unknown }>(result: T): T {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('Tool result must include non-empty text.');
  }
  if (!Array.isArray(result.references) || result.references.length === 0) {
    throw new Error('Tool result must include at least one createApiReference() citation.');
  }
  return result;
}
