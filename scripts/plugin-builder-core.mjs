import ts from 'typescript';

// Shared across the fresh-build and interactive-edit prompts so the card
// contract can never drift between them.
const CARD_RULES = `Result-card rules (which tool results become a visible card):
- A FINAL-DATA tool (a single record, a detail view, a computed summary, a status snapshot) MUST declare a static "card" template on the tool AND return a matching "data" object from execute. The host renders the card beneath the assistant message.
- A LIST/SEARCH tool (returns candidates, ids, or search hits the agent drills into) MUST NOT declare a card and MUST NOT return "data". These are intermediate steps, not final results.
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
- Use only documented components and properties. Do not invent a component, CSS class, JSX, or unsupported property. If the requested visual cannot be expressed with this contract, do not claim it was implemented and do not edit runtime.ts. Respond with exactly "HOST_CAPABILITY_REQUIRED: <the missing reusable primitive or behavior>" so the host can be extended first.
- If the plugin's tool type does not allow "card"/"data" yet, widen it (add optional card?/data? to the tool interface). You may import the CardTemplate type from ./runtime.ts to type the card (optional).
- Add a test asserting the final-data tool returns "data" whose fields the card binds to (e.g. data.price exists when a MetricRow binds field 'price').`;

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
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        toolsObject = declaration.initializer;
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

  const runtimeSource = String(files?.['runtime.ts'] || '');
  if (!runtimeSource) return null;
  const runtimeFile = ts.createSourceFile(
    'runtime.ts',
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const aliases = runtimeFile.statements.filter(
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
    `===== runtime.ts :: canonical card types =====\n${aliases
      .map((statement) => sourceSlice(runtimeSource, statement))
      .join('\n\n')}`
  ].join('\n\n');
}

export function buildSystemPrompt(request) {
  if (request && request.editMode) {
    return buildEditSystemPrompt(request);
  }
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
- Create sample-prompts.json as a JSON array containing exactly three distinct, concise, natural-language questions that demonstrate useful things this plugin's implemented tools can answer. Use concrete inputs when a tool requires them; never use placeholders such as "<id>". This file feeds the host's empty-chat splash and is not plugin documentation.

Canonical shape. The plumbing is already provided, so only the endpoints,
parameter schemas, response types, and rendering differ between plugins. Write
just client.ts, the tools in tools.ts, mocked tests, and sample-prompts.json:

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
  // A FINAL-DATA tool: fetches one record, so it declares a fixed card and
  // returns a matching \`data\` object. The card layout is authored ONCE here and
  // never varies per call — only \`data\` changes.
  example_get_thing: {
    description: 'What question this answers, what API data it fetches, limits, and follow-up tools.',
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
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
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
  // A LIST/SEARCH tool: NOT a final result, so it has NO card and NO data.
  example_search_things: {
    description: 'Search things by keyword. Returns candidate ids for a follow-up detail call.',
    parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string', description: 'Search text.' } } },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const hits = await searchThings(String(args?.q ?? ''));
      return {
        text: hits.map((h) => \`\${h.id}: \${h.name}\`).join('\\n'),
        references: hits.map((h) => createApiReference({ id: String(h.id), label: h.name, sourceUrl: \`\${BASE}/things/\${h.id}\`, quote: h.name, payload: h }))
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

${CARD_RULES}

Source documentation:
${sourceBlock}`;
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
- The canonical card types in the snapshot are authoritative and runtime.ts is vendored. Never edit runtime.ts or cast around missing documented primitives. If those supplied types do not contain a documented primitive required by the request, stop with exactly "HOST_RUNTIME_OUTDATED: <missing primitive>".
`
      : '';
  return `You are Pi, an interactive coding agent editing an existing Raynard plugin in Build mode.

You are working inside one plugin workspace: ${name || '(the current plugin)'} at ${pluginDir || '(the plugin directory)'}.
The user talks to you turn by turn to change this plugin's code — treat it like a normal coding session where the repo happens to be their plugin.

How to work:
- The user message embeds an authoritative current-source snapshot. A targeted card edit contains the exact tool, matching tests, and canonical card types; a general edit contains the broader plugin files. DO NOT re-read source already shown. Only read something absent from the snapshot or use file tools to make edits. Real tools already exist here; this is never a fresh scaffold.
- Cards live on tools in tools.ts: a tool's \`card\` property is its result card, and the tool name tells you which card it is (e.g. the "monster card" is the \`card\` on the dnd_get_monster tool). To change a card, edit that tool's \`card\` template.
- Make the SMALLEST change that satisfies the user's request. Preserve existing tool names, behavior, exports, and passing tests. Do not rewrite the plugin from scratch or delete working code.
- Adapt to THIS plugin's conventions. Some plugins predate the shared runtime and use their own reference helper (e.g. references.ts) and a local tool interface instead of ./runtime.ts — keep using whatever the plugin already uses. Only import from ./runtime.ts if the plugin already does or if you clearly need a shared helper (apiGet, createApiReference) or the CardTemplate type.
- Stay within the plugin. Do not modify the host app. Do not build React, pages, routes, CSS, or any UI — this is TypeScript API tooling only.
- Keep secrets out of source.
- Tests: use your bash tool to run \`node --test <files>\` when the user asks or after a substantive change, and fix failures. You are not forced to pass whole-plugin validation on every turn — respond to what the user asked.

${cardFastPath}
${CARD_RULES}

When the user asks for "nice rendering" of a tool's results, that means: add a fixed result-card (and matching "data") to the relevant FINAL-DATA tool(s) per the rules above, widening the plugin's tool type to allow card?/data? if needed.`;
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

Important: reading files is not the task — you MUST apply the change by editing the source files this turn. Do not end your turn after only inspecting the code; keep going until the edits are written to disk and (for code changes) the tests run. Finish with a one or two sentence summary of what you changed.`;
  }
  return `Implement this Raynard Explore-mode API plugin.

User request:
${String(request.prompt || request.description || '').trim()}

Plugin workspace:
${String(request.pluginDir || '').trim()}

Expected output (the workspace is already scaffolded — reuse runtime.ts/testing.ts, do not edit them):
- client.ts: one thin fetch helper per endpoint, built on apiGet from ./runtime.ts.
- tools.ts: fill the exported tools registry with focused tools, each with a specific description and JSON parameter schema, returning { text, references } via createApiReference.
- Result cards: give every FINAL-DATA tool (detail/record/summary/status) a fixed "card" template plus a matching "data" object; give LIST/SEARCH tools neither. Follow the Result-card rules in the system prompt.
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

// Components the host card renderer knows how to draw. A card that names an
// unknown component still renders (raw-JSON fallback) but is rejected here so
// the builder fixes typos before completion.
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
  if (card == null) return;
  const name = String(tool.name || '(unnamed)');
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

export function validatePluginArtifacts({
  files,
  readme,
  tools,
  samplePrompts,
  requireSamplePrompts = false
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
      !files.includes('sample-prompts.json') ||
      prompts.length !== 3 ||
      prompts.some((prompt) => !prompt) ||
      new Set(prompts).size !== 3
    ) {
      throw new Error(
        'Fresh plugins must include sample-prompts.json with exactly three distinct, non-empty prompt strings.'
      );
    }
  }
  for (const tool of tools) validateToolCard(tool);
  const cardCount = tools.filter((tool) => tool && tool.card).length;
  return { testFiles, toolCount: tools.length, cardCount };
}
