export function buildSystemPrompt(request) {
  const sourceUrls = Array.isArray(request.sourceUrls)
    ? request.sourceUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];
  const sourceBlock = sourceUrls.length ? sourceUrls.map((url) => `- ${url}`).join('\n') : '- none provided';

  return `You are the Raynard plugin builder running in Build mode.

You may write code only inside the current plugin workspace.

Your job is to implement TypeScript API tooling for Raynard Explore mode.

Hard constraints:
- Do not build React components.
- Do not create pages, routes, CSS, visual explorers, or standalone UI.
- Do not modify the host app.
- Do not store API keys or secrets in source.
- Work test-first: create or update executable tests that fail for the missing API behavior before writing the fetcher implementation.
- Use the Node built-in test runner. Test files must end in .test.ts, .test.js, or .test.mjs and run with node --test.
- If index.ts imports another TypeScript module, use explicit .ts ESM imports so node --test can execute the source directly, for example import { fetchItems } from './client.ts'.
- Tests must use mocked fetch and cover every public API fetch helper and every plugin tool.
- Tests for list tools must assert non-empty mocked IDs and useful rendered result text.
- Do not rely on skipped network tests or structure-only tests.
- Run all tests and fix failures before reporting completion.
- Implement API/client/tool code that fetches data and returns structured, citeable references.
- The workspace is pre-scaffolded with shared, vendored plumbing you MUST reuse and MUST NOT edit or re-implement: runtime.ts (createApiReference, apiGet, buildQuery, requireNonEmpty, requirePositiveInt), testing.ts (mockFetch, expectToolResult), tools.ts (an empty registry with ToolResult/ApiTool types to fill), contract.test.ts (keep it), and index.ts (already wires tools + manifest).
- Do NOT write your own fetch wrapper, HTTP error handling, query-string builder, createApiReference, reference.ts, or test harness — import apiGet/createApiReference from ./runtime.ts and mockFetch from ./testing.ts.
- Every API-derived result must expose enough raw payload and source metadata for Explore mode to quote or cite it.
- Treat provided API documentation as a whole API surface. Do not only build the single narrow call implied by the user's latest question unless the docs truly cover only that call.
- Build a practical suite of focused tools for important list/search, detail, user/account, metadata/status, and update/history endpoints when available.
- Prefer multiple focused tools over one broad generic tool.
- If scope forces a subset, document the broader API in README.md under "Endpoint Inventory". Mark every endpoint Implemented, Planned, or Not applicable.
- For unimplemented endpoints record path, purpose, required and optional parameters, response shape, pagination/rate limits, and a proposed future tool.
- Every exported tool must have a routing-quality description and a JSON parameter schema with descriptions, required fields, enum values, and useful optional limits or filters.
- Update README.md with implemented tools, the endpoint inventory, future endpoint notes, and source docs.

Canonical shape. The plumbing is already provided, so only the endpoints,
parameter schemas, response types, and rendering differ between plugins. Write
just client.ts, the tools in tools.ts, and mocked tests:

// client.ts — one thin fetch helper per endpoint using the shared apiGet.
import { apiGet } from './runtime.ts';
const BASE = 'https://api.example.com';
export type Thing = { id: number; name: string };
export const fetchThing = (id: number) => apiGet<Thing>(\`\${BASE}/things/\${id}\`);
// Range/filter endpoints: apiGet(url, { query: { min, max } }) drops undefined params.

// tools.ts — replace the empty registry with real tools. ToolResult/ApiTool are
// already declared at the top of tools.ts by the scaffold; keep them.
import { fetchThing } from './client.ts';
import { createApiReference } from './runtime.ts';

export const tools = {
  example_get_thing: {
    description: 'What question this answers, what API data it fetches, limits, and follow-up tools.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', description: 'Numeric record id to fetch.' } }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const thing = await fetchThing(Number(args?.id));
      return {
        text: \`Thing \${thing.id}: \${thing.name}\`,
        references: [createApiReference({
          id: String(thing.id),
          label: thing.name,
          sourceUrl: \`\${BASE}/things/\${thing.id}\`,
          quote: thing.name,
          payload: thing
        })]
      };
    }
  }
};

// client.test.ts / tools.test.ts — mock the network with the shared harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from './testing.ts';
import { tools } from './tools.ts';

test('example_get_thing renders text and a citation', async () => {
  const fetchMock = mockFetch(() => ({ body: { id: 1, name: 'Widget' } }));
  try {
    const result = await tools.example_get_thing.execute({ id: 1 });
    expectToolResult(result);
    assert.match(result.text, /Widget/);
  } finally {
    fetchMock.restore();
  }
});

Mandatory tool-interface rules (identical across all plugins):
- The runtime invokes each tool as tools[name].execute(args). The callable MUST be named exactly "execute". Never use "handler", "run", "call", or a default-export function.
- "tools" is keyed by the exact tool name; each tool has description (string), parameters (JSON Schema object), and async execute(args) returning { text, references }.
- Build fetch helpers with apiGet from ./runtime.ts (drop to the global fetch only for auth handshakes, non-JSON, or POST/PUT). Build every reference with createApiReference from ./runtime.ts.
- Test with mockFetch from ./testing.ts and keep the provided contract.test.ts. Cover every fetch helper and every tool with mocked responses.
- Only endpoints, parameters, response types, and rendering change between plugins.

Source documentation:
${sourceBlock}`;
}

export function buildUserPrompt(request) {
  return `Implement this Raynard Explore-mode API plugin.

User request:
${String(request.prompt || request.description || '').trim()}

Plugin workspace:
${String(request.pluginDir || '').trim()}

Expected output (the workspace is already scaffolded — reuse runtime.ts/testing.ts, do not edit them):
- client.ts: one thin fetch helper per endpoint, built on apiGet from ./runtime.ts.
- tools.ts: fill the exported tools registry with focused tools, each with a specific description and JSON parameter schema, returning { text, references } via createApiReference.
- Executable mocked-fetch tests in *.test.ts files using mockFetch from ./testing.ts; keep contract.test.ts.
- README.md with an Endpoint Inventory covering implemented and future endpoints.
- No UI code and no re-implemented plumbing.

Run node --test with every test file. Do not report completion until tests pass and the plugin exports at least one runtime tool.`;
}

export function findPluginTestFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter((name) => /\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(String(name)))
    .map(String)
    .sort();
}

export function validatePluginArtifacts({ files, readme, tools }) {
  const testFiles = findPluginTestFiles(files);
  if (!testFiles.length) {
    throw new Error('Plugin validation requires at least one executable test file.');
  }
  if (!/^##?\s+Endpoint Inventory\b/im.test(String(readme || ''))) {
    throw new Error('Plugin README must include an Endpoint Inventory section.');
  }
  if (!Array.isArray(tools) || !tools.length) {
    throw new Error('Plugin must export at least one runtime tool.');
  }
  const notCallable = tools
    .filter((tool) => tool && tool.callable === false)
    .map((tool) => String(tool.name || '(unnamed)'));
  if (notCallable.length) {
    throw new Error(
      `Every tool must expose an async execute(args) method. Not callable: ${notCallable.join(', ')}. Rename the tool method to "execute" (never "handler", "run", or "call").`
    );
  }
  return { testFiles, toolCount: tools.length };
}
