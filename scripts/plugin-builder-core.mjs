import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import ts from 'typescript';

const CATALOG_CATEGORIES = new Set([
  'Arts',
  'Business',
  'Data',
  'Developer Tools',
  'Economics',
  'Education',
  'Entertainment',
  'Finance',
  'Games',
  'Government',
  'Health',
  'Maps',
  'News',
  'Reference',
  'Science',
  'Social',
  'Sports',
  'Travel',
  'Utilities',
  'Weather'
]);
const CATALOG_ICONS = new Set(['book-open', 'database', 'message-square']);

// Shared across the fresh-build and interactive-edit prompts so the card
// contract can never drift between them.
const CARD_RULES = `Result-card rules (which tool results become a visible card):
- EVERY API tool, including list/search tools and intermediate discovery calls, MUST declare a static "card" template on the tool AND return a matching "data" object from every successful execute path. The host renders one coherent card per tool invocation beneath the assistant message.
- Keep model-visible text bounded, but preserve every row returned by the fetched API page in table-bound card data so the host's table filter can search the full fetched set. Do not apply a text display limit to card data. A tool does not need to fetch unseen API pages unless its documented behavior says it does. Empty-result paths still return card data with an empty rows array and useful fetched/stored/total count fields.
- The card layout is FIXED at build time and stored on the tool. It never varies per call; only the "data" it binds to changes. Do not build a different card shape per response.
- The card is DECLARATIVE — objects only, no JSX, no functions, no host/React code. You are still forbidden from writing UI; you only describe layout and which data fields go where.
- Card shape: { name: { singular: string, plural: string }, title?: string, layout: CardBlock[] }. "name" is REQUIRED and contains short lower-case count nouns shown by the host (e.g. { singular: 'monster', plural: 'monsters' } produces "1 monster" / "2 monsters"). Use an explicit plural so irregular nouns work. Strings in "title" and Text blocks support {{path}} interpolation from "data" (e.g. "{{symbol}} — {{name}}"). Block "field"/"rows" are dotted paths into "data" (e.g. "quote.price", "holdings").
- Allowed CardBlock components (nothing else — unknown components fail validation):
  - { component: 'MetricRow', items: [{ label, field, tone?: 'delta' | 'muted' }] }  // headline numbers; 'delta' colors +/- values
  - { component: 'Table', columns: [{ header, field }], rows: '<path to array in data>' }
  - { component: 'KeyValue', pairs: [{ label, field }] }
  - { component: 'Text', text: '<string with {{path}} interpolation>' }
  - { component: 'Section', title?, layout: CardBlock[] }  // groups nested blocks
  - { component: 'Stack', gap?: 'sm' | 'md' | 'lg', layout: CardBlock[] }  // vertical composition
  - { component: 'Grid', columns?: 1 | 2 | 3 | 4, gap?: 'sm' | 'md' | 'lg', layout: CardBlock[] }  // equal-width cells
  - { component: 'Columns', gap?: 'sm' | 'md' | 'lg', collapseBelow?: 'sm' | 'md' | 'never', columns: [{ width?: number, layout: CardBlock[] }] }  // weighted columns; widths are relative
  - { component: 'Badge', field, tone?: 'success' | 'warn' | 'muted' }
  - { component: 'Image', field, alt?, variant?: 'avatar' | 'media', fit?: 'cover' | 'contain', aspectRatio?: '1/1' | '3/4' | '4/3' | '16/9' | 'auto' }  // defaults to a rounded header avatar; media renders inline at the container's full width
  - { component: 'Json', field? }  // raw fallback; whole data when field omitted
- Translate the user's natural-language visual request into these composable primitives. For example, "large image on the right taking 25%" is Columns with widths 3 and 1, with { component: 'Image', variant: 'media', ... } in the right column. Nest Stack/Grid/Columns as needed.
- Use only documented components and properties. Do not invent a component, CSS class, JSX, or unsupported property. If the requested visual cannot be expressed with this contract, do not claim it was implemented. Respond with exactly "HOST_CAPABILITY_REQUIRED: <the missing reusable primitive or behavior>" so the shared SDK and host can be extended first.
- Import the required CardTemplate, ApiTool, and ToolResult contracts from @raynard/plugin-sdk; do not declare local substitutes.
- Add tests asserting EVERY tool returns "data" whose fields its card binds to (e.g. data.price exists when a MetricRow binds field 'price').`;

function propertyName(node) {
  const name = node && node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return '';
}

function containsTargetNode(node, targets) {
  if (
    (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
    targets.has(node.text)
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsTargetNode(child, targets)) found = true;
  });
  return found;
}

function sourceSlice(source, node) {
  return source.slice(node.getStart(), node.getEnd());
}

export function buildTargetedPluginSnapshot({ files, taskKind, targetTools }) {
  const targets = [...new Set(
    (Array.isArray(targetTools) ? targetTools : [])
      .map((value) => String(value).trim())
      .filter(Boolean)
  )];
  if (taskKind !== 'card-edit' || !targets.length) return null;

  const toolsSource = String(files?.['tools.ts'] || '');
  if (!toolsSource) return null;
  const toolsFile = ts.createSourceFile('tools.ts', toolsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let toolsObject;
  for (const statement of toolsFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'tools' &&
        declaration.initializer
      ) {
        const initializer = declaration.initializer;
        if (ts.isObjectLiteralExpression(initializer)) {
          toolsObject = initializer;
        } else if (
          ts.isCallExpression(initializer) &&
          initializer.arguments[0] &&
          ts.isObjectLiteralExpression(initializer.arguments[0])
        ) {
          toolsObject = initializer.arguments[0];
        }
      }
    }
  }
  if (!toolsObject) return null;

  const byName = new Map(
    toolsObject.properties.map((property) => [propertyName(property), property])
  );
  if (targets.some((target) => !byName.has(target))) return null;

  const supportingParts = [];

  const targetSet = new Set(targets);
  for (const [name, sourceValue] of Object.entries(files || {})) {
    if (!/\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(name)) continue;
    const source = String(sourceValue || '');
    const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matching = sourceFile.statements.filter((statement) =>
      containsTargetNode(statement, targetSet)
    );
    if (matching.length) {
      supportingParts.push(
        `===== ${name} :: matching tests =====\n${matching
          .map((statement) => sourceSlice(source, statement))
          .join('\n\n')}`
      );
    }
  }

  const sdkName = 'sdk.d.ts';
  const sdkSource = String(files?.[sdkName] || '');
  if (!sdkSource) return null;
  const sdkFile = ts.createSourceFile(
    sdkName,
    sdkSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const aliases = sdkFile.statements.filter(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      ['CardBlock', 'CardTemplate', 'CardGap'].includes(statement.name.text)
  );
  if (
    !aliases.some((statement) => statement.name.text === 'CardBlock') ||
    !aliases.some((statement) => statement.name.text === 'CardTemplate')
  ) {
    return null;
  }

  return [
    'TARGETED CARD-EDIT SNAPSHOT',
    `Target tools: ${targets.join(', ')}`,
    `Files in this plugin: ${Object.keys(files || {}).sort().join(', ')}`,
    ...targets.map(
      (target) =>
        `===== tools.ts :: ${target} =====\n${sourceSlice(toolsSource, byName.get(target))}`
    ),
    ...supportingParts,
    `===== ${sdkName} :: canonical card types =====\n${aliases
      .map((statement) => sourceSlice(sdkSource, statement))
      .join('\n\n')}`
  ].join('\n\n');
}

/**
 * The SDK's own type declarations, inlined.
 *
 * The package is installed above the plugin workspace, which no prompt ever
 * said. One observed build spent eleven tool calls and seven minutes locating
 * it, reading both .d.ts files, then reading the compiled .js to recover
 * signatures, then grepping a sibling plugin — before writing a single byte.
 * Handing over the declarations costs a few thousand tokens and removes all of
 * that.
 */
function buildSdkSurfaceBlock(request) {
  const sdkDir = String(request?.sdkDir || '').trim();
  const types = request?.sdkTypes && typeof request.sdkTypes === 'object' ? request.sdkTypes : {};
  const files = Object.entries(types)
    .map(([name, source]) => [String(name), String(source || '').trim()])
    .filter(([, source]) => source);
  if (!sdkDir && !files.length) return '';

  const parts = [];
  parts.push('The shared SDK is ALREADY INSTALLED — do not search for it.');
  if (sdkDir) {
    parts.push(
      `It lives at ${sdkDir}, one level ABOVE your plugin workspace, and resolves by package name (@raynard/plugin-sdk). There is no node_modules inside the plugin directory.`
    );
  }
  if (files.length) {
    parts.push(
      "Its complete public interface is below. This is everything the SDK exports: never read the SDK's `.js` implementation files, and do not copy from a sibling plugin to work out how it is used."
    );
    for (const [name, source] of files) {
      parts.push(`===== @raynard/plugin-sdk/${name} =====\n${source}`);
    }
  }
  return `\n\nSDK (already installed):\n${parts.join('\n\n')}`;
}

/**
 * The credential the main agent already identified while researching the API.
 * Without this the builder re-derives the key name and hunts for a sign-up page
 * the host has been holding all along.
 */
function buildKnownCredentialBlock(auth) {
  if (!auth || !auth.required) return '';
  const label = String(auth.credentialLabel || '').trim();
  const signupUrl = String(auth.signupUrl || '').trim();
  if (!label && !signupUrl) return '';
  const lines = ['This API is already known to need a credential — do not research this again.'];
  if (label) lines.push(`- Label to show the user: ${label}`);
  if (/^https?:\/\//i.test(signupUrl)) lines.push(`- Sign-up page (use verbatim as signupUrl): ${signupUrl}`);
  lines.push('- Choose the UPPER_SNAKE_CASE key yourself and declare it as described under Authentication.');
  return `\n\nKnown credential:\n${lines.join('\n')}`;
}

export function buildSystemPrompt(request) {
  if (request && request.editMode) {
    return buildEditSystemPrompt(request);
  }
  const sourceUrls = Array.isArray(request.sourceUrls)
    ? request.sourceUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];
  const sourceBlock = sourceUrls.length ? sourceUrls.map((url) => `- ${url}`).join('\n') : '- none provided';
  const sdkBlock = buildSdkSurfaceBlock(request);
  const authBlock = buildKnownCredentialBlock(request.auth);

  return `You are the Raynard plugin builder running in Build mode.

You may read and write ONLY inside the current plugin workspace. Paths outside it are blocked by the host and the tool call will fail.

Work from these instructions alone. Do not open another plugin's directory, the shared SDK's source, or anything else on the machine to work out how something is done: the complete SDK interface, the canonical tool and card shapes, and the test conventions are all given to you below. If something you need genuinely is not specified here, say so in your final message instead of going looking for it.

Your job is to implement TypeScript API tooling for Raynard Explore mode.

Hard constraints:
- Do not build React components.
- Do not create pages, routes, CSS, visual explorers, or standalone UI.
- Do not modify the host app.
- Never hard-code, print, echo, or commit an API key. If the API needs one, declare it and read it from the host at runtime, as described under Authentication below.
- Work test-first: create or update executable tests that fail for the missing API behavior before writing the fetcher implementation.
- Use the Node built-in test runner. Test files must end in .test.ts, .test.js, or .test.mjs and run with node --test.
- Use explicit .ts extensions for local ESM imports so node --test can execute the source directly, for example import { fetchItems } from './client.ts'.
- Tests must use mocked fetch and cover every public API fetch helper and every plugin tool.
- Tests for list tools must assert non-empty mocked IDs and useful rendered result text.
- Do not rely on skipped network tests or structure-only tests.
- Run all tests and fix failures before reporting completion.
- Implement API/client/tool code that fetches data and returns structured, citeable references.
- The host supplies one shared, versioned @raynard/plugin-sdk. Import defineTools, createApiReference, apiGet, buildQuery, requireNonEmpty, requirePositiveInt, requireCredential, and configureCredentials from it. Import mockFetch and expectToolResult from @raynard/plugin-sdk/testing.
- The author-owned workspace is intentionally small: plugin.json, tools.ts, optional client.ts/supporting modules, behavior tests, and README.md. Do not create index.ts, runtime.ts, testing.ts, contract.test.ts, reference.ts, or another SDK wrapper.
- You MUST reuse the SDK and MUST NOT re-implement its fetch wrapper, HTTP error handling, query-string builder, references, tool contracts, card types, or test harness.
- Every API-derived result must expose enough raw payload and source metadata for Explore mode to quote or cite it.
- Query-parameter names must come from the documented API surface, spelled exactly as the API expects, including case. APIs commonly ignore unknown parameters and silently return unfiltered data, which looks like a working tool that quietly answers the wrong question.
- Because tests mock the network, a misspelled parameter still passes a response-shape assertion. Any tool exposing a filter, range, or pagination parameter MUST have a test asserting the built request URL contains that parameter, not only that the mocked response was parsed.
- That assertion catches a renamed or misspelled query key and nothing more: a mocked test proves only what the plugin SENT, never that the API honored it. Exercise filters against the live API while building, and write what you observe into the tool and parameter descriptions.
- Treat provided API documentation as a whole API surface. Do not only build the single narrow call implied by the user's latest question unless the docs truly cover only that call.
- Build a practical suite of focused tools for important list/search, detail, user/account, metadata/status, and update/history endpoints when available.
- Prefer multiple focused tools over one broad generic tool.
- If scope forces a subset, document the broader API in README.md under "Endpoint Inventory". Mark every endpoint Implemented, Planned, or Not applicable.
- For unimplemented endpoints record path, purpose, required and optional parameters, response shape, pagination/rate limits, and a proposed future tool.
- Every exported tool must have a routing-quality description and a JSON parameter schema with descriptions, required fields, enum values, and useful optional limits or filters.
- A tool's description and its parameter descriptions are the ONLY plugin text the Explore agent ever sees at runtime. README.md, code comments, and plugin.json never reach it. Anything a caller must know to use the endpoint correctly belongs in those descriptions, not only in README.md.
- So record, in the tool description or in the specific parameter's description: parameters that only take effect in combination or are ignored on their own; inputs the API silently drops; defaults applied when a parameter is omitted; result caps, maximum page size, and how to page; the sort order of results; the format and source of IDs and codes; units; and which tool to call before or after this one.
- Put a per-parameter rule on that parameter's description and whole-endpoint behavior on the tool description. README.md may repeat any of it for human readers, but must never be its only home.
- Update README.md with implemented tools, the endpoint inventory, future endpoint notes, and source docs.
- Authentication. If the API requires a key, token, or app id:
  - Declare every secret in plugin.json under "auth": { "credentials": [ { "key": "PROVIDER_API_KEY", "label": "Provider API key", "description": "short note, e.g. free tier", "signupUrl": "https://the page where a user signs up for the key" } ] }. The key must be UPPER_SNAKE_CASE; the label and signupUrl are required.
  - signupUrl must be the specific page where a user obtains the key, not the generic API docs root.
  - Read the value with requireCredential('PROVIDER_API_KEY', 'Provider API key') from @raynard/plugin-sdk, INSIDE execute(), never at module load. The second argument is the label the host shows when prompting, so pass the same label you declared. Tool discovery runs before any key is configured and must not throw.
  - Document each credential in README.md under an "## Authentication" heading, and include its sign-up URL there verbatim. This is how a user finds out where the key came from later.
  - Do NOT ask the user for the key and do NOT read process.env or a .env file. The host stores it in the OS keychain and supplies it at call time; when it is missing, the host prompts the user for you.
  - Keep tests fully mocked. The builder never has a real key, so tests must never depend on one. Inject a fake at the top of the test file with configureCredentials({ PROVIDER_API_KEY: 'TEST_KEY' }) from @raynard/plugin-sdk, and cover the missing-key path by asserting the tool rejects when no value is configured.
- Set plugin.json.samplePrompts to exactly three distinct, concise, natural-language questions that demonstrate useful things this plugin's implemented tools can answer. Use concrete inputs when a tool requires them; never use placeholders such as "<id>".
- Set plugin.json.catalogMetadata to { "category", "tags", "icon" }: choose the best-fit category from: ${[...CATALOG_CATEGORIES].join(', ')} (use Data only when none is more specific); use 4–7 unique lowercase kebab-case tags specific to its provider, subject, provenance, or geography and include api; choose icon book-open, database, or message-square.

Canonical shape. The plumbing is already provided, so only the endpoints,
parameter schemas, response types, and rendering differ between plugins. Write
just client.ts, the tools in tools.ts, mocked tests, README.md, and plugin.json metadata:

// client.ts — one thin fetch helper per endpoint using the shared apiGet.
import { apiGet } from '@raynard/plugin-sdk';
const BASE = 'https://api.example.com';
export type Thing = { id: number; name: string };
export const fetchThing = (id: number) => apiGet<Thing>(\`\${BASE}/things/\${id}\`);
// Range/filter endpoints: apiGet(url, { query: { min, max } }) drops undefined params.

// tools.ts — the only runtime entry point; defineTools type-checks the registry.
import { fetchThing } from './client.ts';
import { createApiReference, defineTools } from '@raynard/plugin-sdk';

export const tools = defineTools({
  // Every API tool declares a fixed card and returns matching \`data\`.
  example_get_thing: {
    description: 'What question this answers, what API data it fetches, result caps and ordering, any parameter the API ignores on its own, and follow-up tools.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', description: 'Numeric record id to fetch.' } }
    },
    card: {
      name: { singular: 'thing', plural: 'things' },
      title: '{{name}} (#{{id}})',
      layout: [
        { component: 'MetricRow', items: [
          { label: 'Price', field: 'price' },
          { label: 'Change', field: 'change', tone: 'delta' }
        ]},
        { component: 'KeyValue', pairs: [{ label: 'Category', field: 'category' }] }
      ]
    },
    async execute(args) {
      const thing = await fetchThing(Number(args?.id));
      return {
        text: \`Thing \${thing.id}: \${thing.name}\`,
        // \`data\` supplies the fields the card binds to (price, change, category…).
        data: { id: thing.id, name: thing.name, price: thing.price, change: thing.change, category: thing.category },
        references: [createApiReference({
          id: String(thing.id),
          label: thing.name,
          sourceUrl: \`\${BASE}/things/\${thing.id}\`,
          quote: thing.name,
          payload: thing
        })]
      };
    }
  },
  // A LIST/SEARCH tool also has a filterable result card with all fetched rows.
  example_search_things: {
    description: 'Search things by keyword. Returns candidate ids for a follow-up detail call.',
    parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string', description: 'Search text.' } } },
    card: {
      name: { singular: 'search', plural: 'searches' },
      title: 'Search results for {{query}}',
      layout: [{ component: 'Table', columns: [{ header: 'ID', field: 'id' }, { header: 'Name', field: 'name' }], rows: 'hits' }]
    },
    async execute(args) {
      const hits = await searchThings(String(args?.q ?? ''));
      return {
        text: hits.map((h) => \`\${h.id}: \${h.name}\`).join('\\n'),
        data: { query: String(args?.q ?? ''), hits },
        references: hits.map((h) => createApiReference({ id: String(h.id), label: h.name, sourceUrl: \`\${BASE}/things/\${h.id}\`, quote: h.name, payload: h }))
      };
    }
  }
});

// client.test.ts / tools.test.ts — mock the network with the shared harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
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
- "tools" is keyed by the exact tool name; each tool has description (string), parameters (JSON Schema object), card, and async execute(args) returning { text, references, data }.
- Build fetch helpers with apiGet from @raynard/plugin-sdk (drop to the global fetch only for auth handshakes, non-JSON, or POST/PUT). Build every reference with createApiReference from the same SDK.
- Test with mockFetch from @raynard/plugin-sdk/testing. Cover every fetch helper and every tool with mocked responses; the host performs structural contract validation, so do not duplicate it in a local contract.test.ts.
- Only endpoints, parameters, response types, and rendering change between plugins.

${CARD_RULES}

Source documentation:
${sourceBlock}${sdkBlock}${authBlock}`;
}

// Interactive edit mode: Build mode is a live coding session on an EXISTING
// plugin. The agent reads the real files and makes the smallest change, rather
// than filling a fresh scaffold.
function buildEditSystemPrompt(request) {
  const pluginDir = String(request.pluginDir || '').trim();
  const name = String(request.name || '').trim();
  const targetTools = (Array.isArray(request.targetTools) ? request.targetTools : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  const cardFastPath =
    request.taskKind === 'card-edit' && targetTools.length
      ? `
CARD-EDIT FAST PATH — targets: ${targetTools.join(', ')}
- The user has requested a focused card-only edit. The targeted tool definitions, matching tests, and canonical card types are supplied in the snapshot. Do not reread unrelated files.
- Apply the explicit visual request directly. A right-side image at 25% width is one Columns block with widths 3 and 1 (75% / 25%): existing compact details on the left, and { component: 'Image', variant: 'media', fit: 'contain', ... } on the right.
- Keep long tables or verbose Section content full-width below the Columns block so narrow columns remain readable.
- Preserve execute(), API behavior, references, and the existing data shape unless a genuinely new card binding is required. Update the nearest existing structural card test first, make the card change, then run the plugin's Node tests.
- The canonical card types in the snapshot come from the shared SDK and are authoritative. Never create or edit a local runtime.ts or cast around missing documented primitives. If those supplied types do not contain a documented primitive required by the request, stop with exactly "HOST_SDK_OUTDATED: <missing primitive>".
`
      : '';
  return `You are Pi, an interactive coding agent editing an existing Raynard plugin in Build mode.

You are working inside one plugin workspace: ${name || '(the current plugin)'} at ${pluginDir || '(the plugin directory)'}.
The user talks to you turn by turn to change this plugin's code — treat it like a normal coding session where the repo happens to be their plugin.

How to work:
- The user message embeds an authoritative current-source snapshot. A targeted card edit contains the exact tool, matching tests, and canonical card types; a general edit contains the broader plugin files. DO NOT re-read source already shown. Only read something absent from the snapshot or use file tools to make edits. Real tools already exist here; this is never a fresh scaffold.
- Cards live on tools in tools.ts: a tool's \`card\` property is its result card, and the tool name tells you which card it is (e.g. the "monster card" is the \`card\` on the dnd_get_monster tool). To change a card, edit that tool's \`card\` template.
- Make the SMALLEST change that satisfies the user's request. Preserve existing tool names, behavior, exports, and passing tests. Do not rewrite the plugin from scratch or delete working code.
- Reuse helpers and types from @raynard/plugin-sdk. Do not add local SDK, runtime, reference, or testing wrappers.
- When an edit changes parameters, filters, limits, defaults, result ordering, or any other observable API behavior, update that tool's description and parameter descriptions in the SAME turn. Those descriptions are the only plugin text the Explore agent sees at runtime — README.md and comments never reach it — so a stale description silently teaches the agent to call the tool wrongly.
- Stay within the plugin. Do not modify the host app. Do not build React, pages, routes, CSS, or any UI — this is TypeScript API tooling only.
- Keep secrets out of source. If this edit makes the plugin need an API key, declare it in plugin.json under auth.credentials with a label and a signupUrl (the page where a user gets the key), read it with requireCredential('KEY') inside execute(), and document it in README.md under an "## Authentication" heading including that URL. Never read process.env, and never ask the user for the key yourself — the host prompts for it and supplies it at call time.
- Tests: use your bash tool to run \`node --test <files>\` when the user asks or after a substantive change, and fix failures. You are not forced to pass whole-plugin validation on every turn — respond to what the user asked.

${cardFastPath}
${CARD_RULES}

When the user asks for "nice rendering" of a tool's results, that means: edit the fixed result-card (and matching "data") on the relevant tool(s) per the rules above.`;
}

// A short recap of recent build-conversation turns, so a follow-up like "now
// tweak that" has context without depending on the agent's internal message
// format. The plugin files remain the source of truth.
function buildConversationRecap(messages) {
  const turns = Array.isArray(messages) ? messages.slice(-6) : [];
  if (!turns.length) return '';
  const lines = turns
    .map((message) => {
      const role = message && message.role === 'assistant' ? 'You' : 'User';
      const content = String((message && message.content) || '').trim();
      if (!content) return '';
      return `${role}: ${content.slice(0, 600)}`;
    })
    .filter(Boolean);
  return lines.length ? `Recent conversation so far:\n${lines.join('\n')}\n\n` : '';
}

export function buildUserPrompt(request) {
  if (request && request.editMode) {
    const instruction = String(request.prompt || request.description || '').trim();
    const snapshot = String(request.pluginSnapshot || '').trim();
    const snapshotBlock = snapshot
      ? `The plugin's CURRENT source is below. This is the up-to-date state on disk — do NOT re-read these files, just edit them directly. Only read a file if it is not shown here or you need something beyond it.

${snapshot}

`
      : '';
    return `${buildConversationRecap(request.messages)}${snapshotBlock}The user's request for this turn:
${instruction || '(no instruction provided)'}

Make the smallest change that satisfies the request. Preserve existing tools and passing tests. Run node --test after a substantive change.

Important: reading files is not the task — you MUST apply the change by editing the source files this turn. Use at most a brief plan, then make the first required edit. Do not exhaust the response by describing code you intend to write. Do not end your turn after only inspecting the code; keep going until the edits are written to disk and (for code changes) the tests run. Finish with a one or two sentence summary of what you changed.`;
  }
  // A fresh build that finds work already on disk is a RESUME, not a restart.
  // The previous attempt may have left passing tests and a finished client; the
  // agent used to rediscover or redo all of it because nothing told it what was
  // already there.
  const snapshot = String(request.pluginSnapshot || '').trim();
  const resumeBlock = snapshot
    ? `RESUMING AN UNFINISHED BUILD — a previous attempt on this plugin did not complete.

Its current state on disk is below. Do not start over and do not rewrite files that already work: read this, run the existing tests to see where they stand, and continue from there. Keep what already works.

${snapshot}

`
    : '';

  return `${buildConversationRecap(request.messages)}${resumeBlock}Implement this Raynard Explore-mode API plugin.

User request:
${String(request.prompt || request.description || '').trim()}

Plugin workspace:
${String(request.pluginDir || '').trim()}

Expected output (the workspace is already scaffolded and the shared SDK is installed by the host):
- client.ts: one thin fetch helper per endpoint, built on apiGet from @raynard/plugin-sdk.
- tools.ts: export defineTools({...}) with focused tools, each with a specific description and JSON parameter schema, returning { text, references, data } via the SDK.
- Result cards: give EVERY tool, including list/search tools, a fixed "card" template plus a matching "data" object on every successful result path. Follow the Result-card rules in the system prompt.
- Executable mocked-fetch tests in *.test.ts files using @raynard/plugin-sdk/testing.
- plugin.json: keep its identity/source metadata and set exactly three samplePrompts plus catalogMetadata.
- README.md with an Endpoint Inventory covering implemented and future endpoints.
- No index.ts, local runtime/testing/contract plumbing, or UI code.

Use only a brief plan (at most five bullets), then immediately create the first failing test with a filesystem tool. Do not exhaust the response by designing every type, endpoint, or card in prose; put that detail directly into the files.

Build ONE tool completely before starting the next: its client helper, then the tool with its card, then its test, then node --test green. Then repeat for the next endpoint. Never draft file contents in your reasoning — write the file first with a filesystem tool and refine it in place. Composing a whole multi-tool file in your head before writing anything spends the response budget on text nobody keeps, and the turn can end before a single line reaches disk.

Run node --test with every test file. Do not report completion until tests pass and the plugin exports at least one runtime tool.`;
}

export function assertBuilderTurnCompleted({
  editMode,
  madeFileEdits,
  stopReason,
  errorMessage
}) {
  // The provider's own words, when the stream carried any. Without them a
  // caller can only report that the turn stopped, and whatever generic failure
  // it checks next ("no runtime tool") gets blamed for the real cause.
  const detail = String(errorMessage || '').trim();
  const because = detail ? `: ${detail}` : '.';
  if (stopReason === 'length') {
    throw new Error(
      `Plugin builder reached the model output limit before completing the turn${because}`
    );
  }
  if (stopReason === 'aborted' || stopReason === 'error') {
    throw new Error(`Plugin builder was interrupted before completing the turn${because}`);
  }
  if (editMode && !madeFileEdits) {
    throw new Error('Plugin builder stopped without writing any changes after its retry.');
  }
}

/** Files the host writes when it scaffolds an empty plugin. */
const SCAFFOLD_FILES = new Set(['plugin.json', 'tools.ts', 'README.md']);

/**
 * True when a workspace holds authored work beyond the host's scaffold.
 *
 * Callers use this on the fresh-build path only, where it means "a previous
 * attempt left something behind, so this is a resume". A build that dies
 * partway leaves real artifacts — a finished client.ts and passing tests —
 * while tools.ts is still the stub, and restarting blind threw all of it away.
 * (A plugin that finished also has authored work, but it routes through the
 * interactive edit path instead and never reaches this check.)
 */
export function hasAuthoredPluginWork({ files, toolsSource }) {
  const names = (Array.isArray(files) ? files : [])
    .map(String)
    .filter((name) => name && !name.startsWith('.'));
  if (names.some((name) => /\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(name))) return true;
  if (names.some((name) => !SCAFFOLD_FILES.has(name))) return true;
  const source = String(toolsSource || '').trim();
  if (!source) return false;
  // The stub registry is `defineTools({})`; anything else is authored code.
  return !/defineTools\(\s*\{\s*\}\s*\)/.test(source);
}

export function findPluginTestFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter((name) => /\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(String(name)))
    .map(String)
    .sort();
}

// Components the host card renderer knows how to draw. Unknown components are
// rejected so the builder fixes typos before completion.
const CARD_COMPONENTS = new Set([
  'MetricRow',
  'Table',
  'KeyValue',
  'Text',
  'Section',
  'Stack',
  'Grid',
  'Columns',
  'Badge',
  'Image',
  'Json'
]);

function collectCardComponents(layout, found = []) {
  if (!Array.isArray(layout)) return found;
  for (const block of layout) {
    if (!block || typeof block !== 'object') continue;
    found.push(block.component);
    if (['Section', 'Stack', 'Grid'].includes(block.component)) {
      collectCardComponents(block.layout, found);
    } else if (block.component === 'Columns' && Array.isArray(block.columns)) {
      for (const column of block.columns) collectCardComponents(column && column.layout, found);
    }
  }
  return found;
}

function validateToolCard(tool) {
  const card = tool && tool.card;
  const name = String(tool.name || '(unnamed)');
  if (card == null) {
    throw new Error(`Every tool must declare a result card. Missing card: "${name}".`);
  }
  if (typeof card !== 'object' || !Array.isArray(card.layout) || card.layout.length === 0) {
    throw new Error(`Tool "${name}" has a card with no layout blocks. Give it a { name: { singular, plural }, title?, layout: [...] } or remove the card.`);
  }
  if (
    !card.name ||
    typeof card.name !== 'object' ||
    typeof card.name.singular !== 'string' ||
    !card.name.singular.trim() ||
    typeof card.name.plural !== 'string' ||
    !card.name.plural.trim()
  ) {
    throw new Error(
      `Tool "${name}" card must define non-empty singular and plural display names, for example { name: { singular: 'monster', plural: 'monsters' }, layout: [...] }.`
    );
  }
  const bad = collectCardComponents(card.layout).filter((component) => !CARD_COMPONENTS.has(component));
  if (bad.length) {
    throw new Error(
      `Tool "${name}" card uses unknown component(s): ${bad.join(', ')}. Allowed: ${[...CARD_COMPONENTS].join(', ')}.`
    );
  }
}

const CREDENTIAL_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Reads and cleans plugin.json auth.credentials. A declaration without a usable
 * sign-up page is dropped: the host prompt's only job is to send the user
 * somewhere to get a key, so a declaration that cannot do that is a dead end.
 */
export function normalizePluginAuth(manifest) {
  const entries = Array.isArray(manifest?.auth?.credentials) ? manifest.auth.credentials : [];
  const credentials = [];
  for (const entry of entries) {
    const key = String(entry?.key || '').trim();
    const signupUrl = String(entry?.signupUrl || '').trim();
    const label = String(entry?.label || '').trim();
    if (!CREDENTIAL_KEY_PATTERN.test(key)) continue;
    if (!/^https?:\/\//i.test(signupUrl)) continue;
    if (!label) continue;
    if (credentials.some((existing) => existing.key === key)) continue;
    credentials.push({
      key,
      label: label.slice(0, 120),
      description: String(entry?.description || '').trim().slice(0, 240),
      signupUrl
    });
    if (credentials.length === 8) break;
  }
  return credentials;
}

/** Credential names the plugin actually reads at runtime. */
export function findUsedCredentialKeys(sources) {
  const text = Array.isArray(sources) ? sources.join('\n') : String(sources || '');
  const used = new Set();
  for (const match of text.matchAll(/requireCredential\(\s*['"`]([^'"`]+)['"`]/g)) {
    const key = match[1].trim();
    if (key) used.add(key);
  }
  return [...used].sort();
}

function validateCatalogMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Fresh plugins must set plugin.json.catalogMetadata.');
  }
  const category = typeof value.category === 'string' ? value.category.trim() : '';
  if (!CATALOG_CATEGORIES.has(category)) {
    throw new Error(
      `plugin.json.catalogMetadata.category must be one of: ${[...CATALOG_CATEGORIES].join(', ')}.`
    );
  }
  const tags = Array.isArray(value.tags) ? value.tags : [];
  if (
    tags.length < 4 ||
    tags.length > 7 ||
    tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) ||
    new Set(tags).size !== tags.length ||
    !tags.includes('api')
  ) {
    throw new Error(
      'plugin.json.catalogMetadata.tags must contain 4–7 unique lowercase kebab-case tags and include api.'
    );
  }
  const icon = typeof value.icon === 'string' ? value.icon.trim() : '';
  if (!CATALOG_ICONS.has(icon)) {
    throw new Error(
      'plugin.json.catalogMetadata.icon must be book-open, database, or message-square.'
    );
  }
  return { category, tags: [...tags], icon };
}

export function validatePluginArtifacts({
  files,
  readme,
  tools,
  samplePrompts,
  catalogMetadata,
  auth,
  sources,
  requireSamplePrompts = false,
  requireCatalogMetadata = false
}) {
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
  if (requireSamplePrompts) {
    const prompts = Array.isArray(samplePrompts)
      ? samplePrompts.map((prompt) => typeof prompt === 'string' ? prompt.trim() : '')
      : [];
    if (
      prompts.length !== 3 ||
      prompts.some((prompt) => !prompt) ||
      new Set(prompts).size !== 3
    ) {
      throw new Error(
        'Fresh plugins must set plugin.json.samplePrompts to exactly three distinct, non-empty prompt strings.'
      );
    }
  }
  const validatedCatalogMetadata =
    requireCatalogMetadata || catalogMetadata !== undefined
      ? validateCatalogMetadata(catalogMetadata)
      : null;
  const credentials = normalizePluginAuth(auth ? { auth } : undefined);
  const usedCredentialKeys = findUsedCredentialKeys(sources);
  const undeclared = usedCredentialKeys.filter(
    (key) => !credentials.some((credential) => credential.key === key)
  );
  if (undeclared.length) {
    // Without a declaration the host cannot name the credential, link a
    // sign-up page, or detect the gap before the call — the user would just
    // see a failed tool.
    throw new Error(
      `Every credential read with requireCredential must be declared in plugin.json under auth.credentials with a label and signupUrl. Undeclared: ${undeclared.join(', ')}.`
    );
  }
  if (credentials.length) {
    const readmeText = String(readme || '');
    if (!/^##?\s+Authentication\b/im.test(readmeText)) {
      throw new Error(
        'A plugin that requires credentials must document them in README.md under an "Authentication" section, including the page where the user signs up for a key.'
      );
    }
    const undocumented = credentials
      .filter((credential) => !readmeText.includes(credential.signupUrl))
      .map((credential) => credential.key);
    if (undocumented.length) {
      throw new Error(
        `The README Authentication section must include the sign-up URL for: ${undocumented.join(', ')}.`
      );
    }
  }
  for (const tool of tools) validateToolCard(tool);
  const cardCount = tools.filter((tool) => tool && tool.card).length;
  return {
    testFiles,
    toolCount: tools.length,
    cardCount,
    credentials,
    ...(validatedCatalogMetadata ? { catalogMetadata: validatedCatalogMetadata } : {})
  };
}

// --- Workspace containment -------------------------------------------------
//
// Pi's coding tools take a cwd but do not enforce it: `resolveToCwd` happily
// resolves an absolute path or `~`, and bash inherits a real shell. Without the
// guards below, the builder can read and write any file on the machine — which
// is how it came to "check a sibling plugin" instead of working from its
// instructions. Everything it legitimately needs (the full SDK surface, the
// canonical tool shape, the card contract) is already in the system prompt.

/** Absolute path for a tool argument, or null when it escapes the workspace. */
export function resolveInsideRoot(root, rawPath) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return null;
  const expanded = raw === '~' || raw.startsWith('~/') ? `${homedir()}${raw.slice(1)}` : raw;
  const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(root, expanded);
  const normalizedRoot = resolvePath(root);
  if (absolute === normalizedRoot) return absolute;
  return absolute.startsWith(`${normalizedRoot}${sep}`) ? absolute : null;
}

/**
 * True when a bash command reaches outside the plugin workspace.
 *
 * A parent-directory hop or a `~`/absolute path is never needed for plugin
 * work: tests run in place and the shared SDK is resolved by Node, not read by
 * hand. Treating those as escapes is what keeps the agent from browsing the
 * generated-plugins root.
 */
export function bashCommandEscapesRoot(command) {
  const text = String(command ?? '');
  if (/(^|[\s"'`=(:])~(\/|$)/.test(text)) return true;
  if (/(^|[\s"'`=(:])\/(?:Users|home|etc|var|tmp|private|opt|usr)\//.test(text)) return true;
  // A `..` path segment, but not `...` or a range like `a..b` in a version.
  return /(^|[\s"'`=(:/])\.\.(\/|$|[\s"'`);])/.test(text);
}

export const WORKSPACE_ESCAPE_MESSAGE =
  'Blocked: this path is outside your plugin workspace. You may only read and write files in this plugin directory. Do not inspect other plugins, the shared SDK source, or anything else on the machine — the complete SDK interface, the canonical tool shape, and the card contract are already in your instructions. Work from those.';
