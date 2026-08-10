---
sidebar_position: 5
---

# Creating generated plugins

<div className="plugin-creation-intro">
  <div className="plugin-creation-intro__copy">
    <p className="plugin-creation-intro__eyebrow">Start with the API</p>
    <h2>Connect Raynard to a new service</h2>
    <p>
      Find a link to the documentation for the API you want to use, then ask
      Raynard to connect to it. Include the link in your message and describe
      what you would like to do with the service.
    </p>
    <p className="plugin-creation-intro__example">
      “Connect to the Hacker News API using
      https://github.com/HackerNews/API and let me browse the top stories.”
    </p>
    <p>
      Raynard will propose a plugin for you to review before it writes any code.
    </p>
  </div>
  <div
    className="plugin-creation-intro__screenshot"
    role="img"
    aria-label="Placeholder for a screenshot of asking Raynard to connect to an API"
  >
    <span className="plugin-creation-intro__screenshot-icon" aria-hidden="true">▧</span>
    <strong>Screenshot placeholder</strong>
    <span>Ask Raynard to connect to an API</span>
  </div>
</div>

Generated plugins give Raynard API-backed tools without adding feature-specific
code to the desktop application. A plugin describes one API, exposes a focused
set of tools to the chat agent, preserves source data for citations, and defines
the result card rendered by the host for every tool call.

This guide describes the current plugin contract. Every tool returns a card and
matching card data on every successful API call.

## How creation works

The normal way to create a plugin is through a chat:

1. Ask Raynard for information or an API capability that is not installed.
2. The Explore agent proposes a plugin build with an exact plugin name, a broad
   capability description, source documentation URLs, and a reason.
3. Review and confirm the proposal. Confirmation is the action that switches
   the conversation from Explore to Build.
4. Raynard scaffolds a new plugin and starts a coding agent restricted to that
   plugin directory.
5. The coding agent writes failing mocked tests first, implements the client and
   tools, documents the API surface, and runs validation.
6. If validation fails, a fresh build gets one focused repair pass before its
   final result is reported.

Asking to change an installed plugin follows the same confirmation flow, but
opens it for an in-place edit. The existing source is preserved. An edit pass
should make the smallest requested change and run the relevant tests; it is not automatically
subjected to every fresh-plugin gate.

Each confirmed build is one coding pass. Later ordinary messages return to
Explore, so another code change requires another explicit build proposal and
confirmation. Use the exact installed plugin name when requesting an edit so
the host does not interpret the request as a new plugin.

## Where plugins live

Plugins are stored outside the source repository in the operating system's app
data directory. On macOS, the default location is:

```text
~/Library/Application Support/ai.raynard/generated-plugins/
```

Each immediate child is one plugin directory, for example:

```text
generated-plugins/
├── node_modules/@raynard/plugin-sdk/  # one host-managed shared SDK
├── fantasy-premier-league/
├── hacker-news/
└── my-api-plugin/
```

On other platforms, use the application-local-data directory resolved for the
`ai.raynard` app identifier. Do not place generated plugins in this repository
or in `dist/`.

## Directory structure

A typical completed plugin looks like this:

```text
my-api-plugin/
├── plugin.json             # identity, sources, SDK version, and sample prompts
├── client.ts               # thin typed API access and response normalization
├── tools.ts                # runtime entry: schemas, execution, references, cards
├── client.test.ts          # mocked client tests
├── tools.test.ts           # mocked end-to-end tool tests
└── README.md               # usage, sources, and Endpoint Inventory
```

Small plugins may keep the client and tools together, and larger plugins may
split them into more TypeScript modules. Local ESM imports must include their
`.ts` extension.

The host installs `@raynard/plugin-sdk` once above all plugin workspaces. It
contains networking, validation, citation, card, tool, and testing primitives.
Do not copy those helpers into a plugin. Runtime discovery may create a hidden
`.runtime-tools.json` cache; it is host-owned and should not be edited.

Generated plugins are API tooling only. They must not add React components,
pages, routes, CSS, host application edits, or embedded secrets.

## The manifest

`plugin.json` identifies the plugin and records its external sources:

```json
{
  "id": "raynard.generated.my-api-plugin",
  "name": "My API Plugin",
  "version": "0.1.0",
  "sdkVersion": 1,
  "description": "Looks up current and historical data from the My API service.",
  "status": "built",
  "sourceUrls": [
    "https://api.example.com/docs"
  ],
  "samplePrompts": [
    "Which records changed today?",
    "Show the ten highest-value records.",
    "Look up the details for record 42."
  ]
}
```

Use a stable lowercase directory slug and a matching unique ID. Keep the
description broad enough to describe the whole plugin rather than one endpoint.
`sdkVersion` is mandatory. Plugins without the current SDK version are not
loaded; there is no old-format manifest or entrypoint fallback. Never put API
keys or other credentials in the manifest or source files.

## Authentication

A plugin that wraps an authenticated API declares the secrets it needs. It never
stores or asks for a value: the host keeps that in the operating system keychain
and supplies it at call time.

```json
"auth": {
  "credentials": [
    {
      "key": "OPENWEATHER_API_KEY",
      "label": "OpenWeather API key",
      "description": "Free tier, no card required.",
      "signupUrl": "https://openweathermap.org/api"
    }
  ]
}
```

`key` must be `UPPER_SNAKE_CASE`. `label` and `signupUrl` are required, and
`signupUrl` must be the page where a user actually obtains the key — not the
API documentation root, which belongs in `sourceUrls`. It is the link the app
shows whenever it asks for the key, so a declaration without a usable one is
dropped.

Read the value inside `execute()`, never at module load, so tool discovery keeps
working before any key is configured:

```ts
import { apiGet, requireCredential } from '@raynard/plugin-sdk';

async execute(args) {
  const apiKey = requireCredential('OPENWEATHER_API_KEY');
  const payload = await apiGet('https://api.openweathermap.org/data/2.5/weather', {
    query: { q: String(args.city), appid: apiKey }
  });
  // ...
}
```

`requireCredential` throws when the user has not stored a value. The host turns
that into a prompt with the sign-up link rather than a failed tool call, so the
plugin needs no fallback path. `getCredential` returns `''` instead of throwing
when a credential is genuinely optional.

Every credential read with `requireCredential` must also be declared in the
manifest and documented in `README.md` under an `## Authentication` heading that
includes the sign-up URL; validation rejects the build otherwise. Tests stay
fully mocked — the plugin builder never has a real key.

## The runtime entry

`tools.ts` is the only required code entry point. Export a registry created by
the SDK:

```ts
import { defineTools } from "@raynard/plugin-sdk";

export const tools = defineTools({
  // Tool definitions go here.
});
```

At runtime, Raynard transpiles the plugin's TypeScript in an isolated temporary
directory, imports this registry, discovers its tools, and invokes the selected
tool's `execute(args)` function.

## Writing the API client

Keep API-specific networking in a thin, typed client. Prefer the shared SDK's
`apiGet()` and `buildQuery()` helpers so errors and query encoding are
consistent:

```ts
import { apiGet, buildQuery, requirePositiveInt } from "@raynard/plugin-sdk";

const API_BASE = "https://api.example.com/v1";

export type Player = {
  id: number;
  name: string;
  team: string;
  price: number;
  points: number;
};

export async function listPlayers(limit = 10): Promise<Player[]> {
  const safeLimit = requirePositiveInt(limit, "limit");
  return apiGet<Player[]>(
    `${API_BASE}/players${buildQuery({ limit: safeLimit })}`,
  );
}
```

Export the public fetch helpers so tests can exercise each supported endpoint.
Normalize only what makes the tool easier to use; retain enough of the original
payload to support citations and future fields.

## Defining tools

Every tool needs five things:

- a unique, stable name;
- a specific routing description;
- an object-shaped JSON parameter schema;
- a fixed declarative card;
- an asynchronous `execute(args)` implementation.

The SDK exports the shared types and inference helper:

```ts
import {
  defineTools,
  type ApiTool,
  type ToolResult,
} from "@raynard/plugin-sdk";
```

Descriptions are routing instructions for the chat agent. State what the tool
returns and when it should be chosen, and distinguish neighboring operations.
For example, “List and filter current players by position, team, price, and
value” routes better than “Gets players.”

They are also the tool's **operating** instructions. A tool's description and its
parameter descriptions are the only plugin text the chat agent ever sees at
runtime — the host passes exactly these two fields to the model, and nothing
else. `README.md`, code comments, and `plugin.json` are written for people and
never reach it. Anything a caller must know to use the endpoint correctly has to
live in a description:

- parameters that only take effect in combination, or are ignored on their own;
- inputs the API silently drops;
- defaults applied when a parameter is omitted;
- result caps, maximum page size, and how to page;
- the sort order of results;
- the format and source of IDs and codes, and units;
- which tool to call before or after this one.

Put a per-parameter rule on that parameter's description and whole-endpoint
behavior on the tool description. `README.md` may repeat any of it for human
readers, but must never be its only home — a quirk documented only there is a
quirk the agent will keep tripping over.

Use small validated parameter sets. `requireNonEmpty()` and
`requirePositiveInt()` are available for common checks. Reject unknown fields
with `additionalProperties: false` unless the API genuinely needs them.

Prefer a practical family of tools over one overloaded endpoint wrapper. A
useful plugin commonly offers list/search, detail, account or owner, status, and
history operations where the API supports them. Keep list results bounded.

## Returning text, references, data, and a card

Every successful API-backed execution returns:

- `text`: concise, useful prose for the chat model;
- `references`: one or more source records carrying the URL and supporting API
  payload;
- `data`: structured values consumed by the declared card.

The fixed `card` lives on the tool definition, not in the result. The data is
dynamic and is returned by `execute()`. Here is a complete simplified example:

```ts
import {
  createApiReference,
  defineTools,
  type CardTemplate,
} from "@raynard/plugin-sdk";
import { listPlayers } from "./client.ts";

const valuePlayersCard: CardTemplate = {
  name: { singular: "player", plural: "players" },
  title: "Best-value defenders",
  layout: [
    {
      component: "Stack",
      gap: "md",
      layout: [
        {
          component: "MetricRow",
          items: [
            { label: "Matches", field: "count" },
            { label: "Maximum price (£m)", field: "maxPrice" },
          ],
        },
        {
          component: "Table",
          columns: [
            { header: "Player", field: "name" },
            { header: "Team", field: "team" },
            { header: "Price", field: "price" },
            { header: "Points/£m", field: "value" },
          ],
          rows: "rows",
        },
      ],
    },
  ],
};

export const tools = defineTools({
  players_list_value_defenders: {
    description:
      "List current defenders ranked by points per price unit; use for value-for-money comparisons.",
    parameters: {
      type: "object",
      properties: {
        maxPrice: {
          type: "number",
          description: "Maximum player price in millions.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          default: 10,
        },
      },
      required: ["maxPrice"],
      additionalProperties: false,
    },
    card: valuePlayersCard,
    async execute(args: Record<string, unknown>) {
      const maxPrice = Number(args.maxPrice);
      if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
        throw new Error("maxPrice must be a positive number.");
      }
      const limit = Number(args.limit ?? 10);
      const payload = await listPlayers(100);
      const rows = payload
        .filter((player) => player.price <= maxPrice)
        .map((player) => ({
          name: player.name,
          team: player.team,
          price: `£${player.price.toFixed(1)}m`,
          value: (player.points / player.price).toFixed(1),
        }))
        .slice(0, limit);

      return {
        text: rows.length
          ? `Found ${rows.length} defenders at or below £${maxPrice}m.`
          : `No defenders were found at or below £${maxPrice}m.`,
        references: [
          createApiReference({
            id: "players-bootstrap",
            label: "Current player data",
            sourceUrl: "https://api.example.com/v1/players",
            quote: `Current player data used to rank ${rows.length} matches.`,
            payload,
          }),
        ],
        data: {
          count: rows.length,
          maxPrice,
          rows,
        },
      };
    },
  },
});
```

### References and citations

Use `createApiReference()` for API-derived claims. A reference accepts:

- `id`: stable within the result;
- `label`: readable source name;
- `sourceUrl`: the actual documentation or endpoint URL;
- `quote`: a short explanation of what the payload supports;
- `fetchedAt`, `payloadPath`, and `payload`: optional provenance and raw data.

Include the response payload, or the relevant bounded portion of it, whenever
practical. The runtime produces both a compact model-visible representation and
expanded raw JSON for citation inspection. If a tool combines several API
requests, preserve the relevant source for each distinct claim.

Do not treat `text` as a substitute for references. A successful API-derived
result must contain useful text and at least one source reference.

## Designing result cards

Cards are host-rendered declarative data. Plugin code never creates React or
HTML. The card template must be static and serializable: no functions, JSX, or
runtime component imports.

Every API tool needs one coherent card, including list, search, autocomplete,
and intermediate lookup tools. If a tool makes several internal API requests,
combine their result into that one tool card. An empty result still returns its
card data—for example, `rows: []`, `count: 0`, and the active filters—so the host
can render a meaningful empty state.

A card requires:

- `name.singular` and `name.plural`, used in the collapsed disclosure label;
- a non-empty `layout` block;
- optionally, an interpolated `title`.

Card titles and text blocks can interpolate values from `data` with `{{path}}`
expressions. A block's `field` and `rows` properties use plain dotted paths such
as `player.price` and `players`. Use simple, stable field names and make every
referenced path available on every successful return path.

The current host supports these blocks:

| Block | Typical use |
| --- | --- |
| `MetricRow` | A few headline figures |
| `Table` | Bounded comparable rows or rankings |
| `KeyValue` | Detail records and metadata |
| `Text` | Explanatory text or an empty-state message |
| `Section` | A titled group of related content |
| `Stack` | Vertical composition |
| `Grid` | Repeated or balanced items |
| `Columns` | Side-by-side summary and detail |
| `Badge` | Short categorical status |
| `Image` | An API-provided image with useful alt text |
| `Json` | Structured data that has no better visual form |

Choose the smallest layout that clarifies the result. Tables work well for
rankings and searches; key/value layouts work well for detail tools. Keep rows
bounded and avoid mirroring a huge raw API payload into the visual card.

When the desired presentation cannot be expressed by these blocks, return or
report `HOST_CAPABILITY_REQUIRED: <short description>` instead of inventing a
component. If an edit requires a supported primitive missing from the shared
SDK, report `HOST_SDK_OUTDATED: <short description>`.

## Tests

Fresh builds use the Node test runner. Tests must be deterministic and must not
depend on the live API. Use the shared SDK helpers:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./tools.ts";
import { expectToolResult, mockFetch } from "@raynard/plugin-sdk/testing";

test("the value tool returns rows, references, and card data", async () => {
  const mocked = mockFetch(() => ({
    body: [{
      id: 1,
      name: "Ada Defender",
      team: "North Foxes",
      price: 4.5,
    }],
  }));

  try {
    const tool = tools.players_list_value_defenders;
    assert.ok(tool);

    const result = await tool.execute({ maxPrice: 5, limit: 10 });
    expectToolResult(result);
    assert.equal(result.data.count, 1);
    assert.equal(Array.isArray(result.data.rows), true);
    assert.match(result.text, /Ada Defender|1 defender/);
  } finally {
    mocked.restore();
  }
});
```

Test every public fetch helper and every exported tool. In particular, assert:

- URL paths, query encoding, and request behavior;
- useful identifiers and facts in list/search text;
- source URLs and non-empty references;
- card data for normal and empty results;
- input validation and API error behavior;
- tool names, descriptions, object schemas, callable execution, and non-empty
  card layouts.

The host performs common structural checks during runtime discovery and fresh
build validation, so plugins do not carry a duplicate contract test. A live
smoke test can supplement the mocked suite; it cannot be the only test.

## Sample prompts

`plugin.json.samplePrompts` contains exactly three distinct, concrete questions:

```json
{
  "samplePrompts": [
    "Which defenders offer the best value below £5.0m?",
    "Compare the current form of three midfielders.",
    "Which teams have the easiest next five fixtures?"
  ]
}
```

Keep them concise, user-facing, and answerable by the implemented tools. Avoid
placeholders such as “Try the API.” The host uses these questions as empty-chat
suggestions.

## README and Endpoint Inventory

The README should explain the plugin's purpose, tools, data sources, important
limitations, and how it was tested. It must also contain an `Endpoint Inventory`
covering the relevant documented API surface, not only the endpoints already
implemented.

A useful inventory records:

| Endpoint | Status | Parameters and response shape | Plugin tool / future tool |
| --- | --- | --- | --- |
| `GET /players` | Implemented | filters; paginated player summaries | `players_list` |
| `GET /players/{id}` | Planned | player ID; one detailed player | `players_get` |
| `POST /admin/reindex` | Not applicable | privileged mutation | excluded: read-only plugin |

Use only `Implemented`, `Planned`, or `Not applicable` for status. Note
pagination, important parameters, response shape, and a concrete future tool
name for planned endpoints. Explain why an endpoint is not applicable.

## Validation and local inspection

A fresh plugin is accepted only when it has:

- executable mocked tests discovered as `.test.ts`, `.test.js`, or `.test.mjs`;
- a passing `node --test` run;
- successful runtime discovery;
- at least one exported callable tool;
- valid descriptions, object parameter schemas, cards, and implementations;
- a README with an Endpoint Inventory;
- exactly three valid sample prompts in `plugin.json`.

From the Raynard repository, inspect an installed plugin without starting the
desktop app:

```bash
PLUGIN_DIR="$HOME/Library/Application Support/ai.raynard/generated-plugins/my-api-plugin"

(cd "$PLUGIN_DIR" && node --test)

node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","listTools":true}
EOF
```

The runner prints one JSON object. Discovery succeeds when it contains
`"ok": true`; inspect every tool's name, description, schema, and card.

Invoke one tool directly with mocked-safe or public arguments:

```bash
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","toolName":"players_list_value_defenders","args":{"maxPrice":5,"limit":10}}
EOF
```

For a successful call, inspect `result.text`, `result.references`, and
`result.data`, not just the process exit status.

## Editing and debugging

Open **Generated Plugins** in the app sidebar to inspect metadata, runtime
tools, card previews, README content, and selected source files.

When a tool call succeeds but no card appears, check in this order:

1. Runtime discovery shows a non-null `card` on that exact tool.
2. Every successful branch returns `data` containing all template paths.
3. The card uses only supported declarative blocks.
4. The tool was actually called during the current chat turn.
5. `.runtime-tools.json` is not stale; let the host regenerate it rather than
   editing it manually.

For other failures:

- no discovered tools usually points to `tools.ts`, an import error, or an
  invalid exported tool registry;
- `tool_call` without `tool_result` points to execution, networking, or
  cancellation;
- empty text or references means the implementation violated the result
  contract even if the HTTP request succeeded;
- a stuck build should be checked against its last builder event and then
  reproduced with the plugin's tests and the runner.

## Completion checklist

Before considering a plugin complete, confirm that:

- the manifest identifies one coherent API capability and its sources;
- the tool suite covers a useful breadth of the documented API;
- every tool has a precise description and an object JSON schema;
- every tool declares a card and every successful API call returns text,
  references, and matching card data;
- list and search cards handle both populated and empty results;
- all external claims retain source URLs and supporting payload data;
- mocked tests cover every public client helper and tool;
- all tests and runtime discovery pass;
- the README includes a complete Endpoint Inventory;
- `plugin.json.samplePrompts` has exactly three useful questions;
- every credential is declared in `auth.credentials` with a label and sign-up
  URL, read with `requireCredential` inside `execute`, and documented under an
  `Authentication` heading in the README;
- no secrets, host UI code, or copied SDK/runtime plumbing is included.
