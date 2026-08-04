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
- Use the existing plugin scaffold and createApiReference().
- Every API-derived result must expose enough raw payload and source metadata for Explore mode to quote or cite it.
- Treat provided API documentation as a whole API surface. Do not only build the single narrow call implied by the user's latest question unless the docs truly cover only that call.
- Build a practical suite of focused tools for important list/search, detail, user/account, metadata/status, and update/history endpoints when available.
- Prefer multiple focused tools over one broad generic tool.
- If scope forces a subset, document the broader API in README.md under "Endpoint Inventory". Mark every endpoint Implemented, Planned, or Not applicable.
- For unimplemented endpoints record path, purpose, required and optional parameters, response shape, pagination/rate limits, and a proposed future tool.
- Every exported tool must have a routing-quality description and a JSON parameter schema with descriptions, required fields, enum values, and useful optional limits or filters.
- Update README.md with implemented tools, the endpoint inventory, future endpoint notes, and source docs.

Canonical tool module. Every generated plugin MUST follow this exact shape. Only
the endpoints, parameters, descriptions, and rendering differ between plugins:

// client.ts — one thin fetch helper per endpoint, no rendering.
export async function fetchThing(id: number): Promise<Thing> {
  const response = await fetch(\`https://api.example.com/things/\${id}\`);
  if (!response.ok) throw new Error(\`Request failed: \${response.status}\`);
  return (await response.json()) as Thing;
}

// tools.ts — tool definitions keyed by the exact tool name.
import { fetchThing } from './client.ts';
import { createApiReference, type ApiReference } from './index.ts';

export type ToolResult = { text: string; references: ApiReference[] };

export const tools = {
  example_get_thing: {
    description: 'What question this answers, what API data it fetches, limits, and follow-up tools.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', description: 'Numeric record id to fetch.' }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const thing = await fetchThing(Number(args?.id));
      return {
        text: \`Thing \${thing.id}: \${thing.name}\`,
        references: [
          createApiReference({
            id: String(thing.id),
            label: thing.name,
            sourceUrl: \`https://api.example.com/things/\${thing.id}\`,
            fetchedAt: new Date().toISOString(),
            quote: thing.name,
            payload: thing
          })
        ]
      };
    }
  }
};

// index.ts — keeps the scaffold manifest + createApiReference, and exposes tools.
export { tools } from './tools.ts';

Mandatory tool-interface rules (identical across all plugins):
- The runtime invokes each tool as tools[name].execute(args). The callable MUST be named exactly "execute". Never use "handler", "run", "call", or a default-export function.
- "tools" is a plain object; each key equals that tool's advertised name string.
- Each tool has exactly: description (string), parameters (JSON Schema object), and async execute(args).
- execute returns { text: string, references: ApiReference[] }; every reference is built with createApiReference().
- Put network calls in client.ts helpers; tools orchestrate the calls and render text. Only endpoints, parameters, and descriptions change between plugins.

Source documentation:
${sourceBlock}`;
}

export function buildUserPrompt(request) {
  return `Implement this Raynard Explore-mode API plugin.

User request:
${String(request.prompt || request.description || '').trim()}

Plugin workspace:
${String(request.pluginDir || '').trim()}

Expected output:
- TypeScript plugin code in index.ts.
- Executable mocked API tests in one or more *.test.ts, *.test.js, or *.test.mjs files.
- API fetch helpers and focused tool definitions with specific descriptions and JSON parameter schemas.
- README.md with an Endpoint Inventory covering implemented and future endpoints.
- Reference-producing results using createApiReference().
- No UI code.

Run node --test with every test file you create. Do not report completion until tests pass and the plugin exports at least one runtime tool.`;
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
