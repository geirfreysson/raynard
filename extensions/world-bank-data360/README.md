# World Bank Data360

This generated plugin gives Raynard a deliberate two-step workflow for official
World Bank Data360 development data:

1. Search the indicator catalog with `data360_search_indicators`.
2. Pass the returned `databaseId` and `indicatorId` to `data360_get_data` to
   retrieve observations from `/data360/data`.

Do not guess either identifier. Search results also expose the indicator's unit,
frequency, coverage, database name, supported disaggregation dimensions, and
the API data URL. The public API does not require an API key.

## Implemented tools

| Tool | Purpose |
| --- | --- |
| `data360_search_indicators` | Full-text indicator discovery through `POST /data360/searchv2`, optionally scoped to a database. Returns the exact IDs needed by the data tool. |
| `data360_get_data` | Observation retrieval through `GET /data360/data` with geography, time, demographic, frequency, unit, and indicator-specific dimension filters. |

The data endpoint returns at most 1,000 records per API call, sorted by period
and then by area. `skip` selects a later API page; `displayLimit` only bounds the
observations copied into the model-visible text. Every row fetched for the page
remains available in the result card's filterable table. Search is limited to 25
matches per tool call. Both tools retain the exact API URL and supporting
response payload in source references.

Time filtering needs both ends of the range: `/data360/data` silently ignores
`timePeriodFrom` or `timePeriodTo` on its own and returns the full history. The
client therefore fills whichever bound is missing (`1800` / `2100`, wide enough
to be equivalent to no bound), so callers may pass either one alone.

## Example workflow

Search for a series:

```text
data360_search_indicators({ query: "population total", databaseId: "WB_WDI" })
```

Then use an exact match from the result:

```text
data360_get_data({
  databaseId: "WB_WDI",
  indicatorId: "WB_WDI_SP_POP_TOTL",
  refArea: "KEN",
  timePeriodFrom: "2015",
  timePeriodTo: "2024"
})
```

Codes such as `KEN`, `F`, `M`, `URB`, and `RUR` are API identifiers. The search
result's `disaggregation_types` says which dimensions an indicator supports,
but it does not enumerate every valid value. A future disaggregation tool is
recorded below.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Plugin tool / future tool |
| --- | --- | --- | --- |
| `POST /data360/searchv2` | Implemented | JSON search body: `search`, `top`, `skip`, `count`, `filter`, `select`; OData response with `@odata.count` and `value[]` indicator metadata. The tool forces `type eq 'indicator'`. | `data360_search_indicators` |
| `GET /data360/data` | Implemented | Required `DATABASE_ID`; optional `INDICATOR`, `REF_AREA`, `SEX`, `AGE`, `URBANISATION`, `COMP_BREAKDOWN_1..3`, `TIME_PERIOD`, `FREQ`, `UNIT_MEASURE`, `UNIT_TYPE`, `UNIT_MULT`, `timePeriodFrom`, `timePeriodTo`, `skip`; `{ count, value: observation[] }`. Maximum 1,000 rows per call. The plugin requires `INDICATOR` to keep calls focused. **The API applies the time range only when both `timePeriodFrom` and `timePeriodTo` are sent — a one-sided range is silently ignored and the full history is returned, so the client fills the missing bound.** | `data360_get_data` |
| `GET /data360/disaggregation` | Planned | Required `datasetId`, optional `indicatorId`; list of available dimension fields and values for a series. | future `data360_get_disaggregation` |
| `GET /data360/indicators` | Planned | Required `datasetId`; list of indicator IDs in one database. Search already covers common discovery. | future `data360_list_indicators` |
| `POST /data360/metadata` | Planned | JSON `{ query }` with Data360 metadata filter/select syntax; metadata response under `value`. | future `data360_get_metadata` |

## Testing

The test suite uses mocked HTTP responses and covers both public client helpers,
both tools, URL/query construction, POST bodies, normal and empty responses,
pagination/filter inputs, two-sided time-range construction, result references,
card data, validation, and API errors.

```sh
node --test
```

Runtime discovery from the Northfox/Raynard repository:

```sh
PLUGIN_DIR="$HOME/Library/Application Support/ai.raynard/generated-plugins/world-bank-data360"
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","listTools":true}
EOF
```

## Sources

- API explorer: https://data360.worldbank.org/en/api
- Official OpenAPI document: https://raw.githubusercontent.com/worldbank/open-api-specs/refs/heads/main/Data360%20Open_API.json
- API base URL: https://data360api.worldbank.org/data360

Data360 documents the API under CC BY 4.0. Individual datasets can include
additional third-party terms; retain and inspect the series metadata when reuse
rights matter.
