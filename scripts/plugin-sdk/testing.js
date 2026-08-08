import { assertToolResult } from './index.js';

export function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body = {} } = handler(url) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

export function expectToolResult(result) {
  return assertToolResult(result);
}
