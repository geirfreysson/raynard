# Eurostat

This local generated plugin connects Raynard to Eurostat's public dissemination
APIs. It provides a deliberate three-step workflow:

1. Search the official SDMX dataflow catalogue with
   `eurostat_search_datasets` to discover an exact online dataset code.
2. Inspect coverage, update time, observation count, and metadata links with
   `eurostat_get_dataset_metadata`.
3. Retrieve a bounded JSON-stat 2.0 cube with `eurostat_query_data`, using exact
   dimension codes and position codes from the selected dataset.

The Eurostat endpoints used here are public and require no API key. The host
caches GET responses for 24 hours by default; this is especially useful for the
compact all-dataflows catalogue.

## Implemented tools

| Tool | Purpose |
| --- | --- |
| `eurostat_search_datasets` | Searches all Eurostat SDMX dataflows by title words or exact online code and returns ranked dataset codes. |
| `eurostat_get_dataset_metadata` | Retrieves one dataflow's title, coverage, observation count, update timestamp, data-structure version, source institution, and explanatory metadata link. |
| `eurostat_query_data` | Calls the Statistics API with exact dimension/time filters and decodes JSON-stat cube cells into labelled observation rows. |

## Query behavior and limits

The Statistics API accepts any dimension present in a dataset as a query
parameter, for example `geo=DE`, `sex=T`, or `na_item=B1GQ`. Pass these through
the tool's `filters` array. Repeating a dimension requests multiple values.
Dimension and position codes are dataset-specific; the API can reject invalid
codes or return an empty cube.

Eurostat permits one time selection mechanism per query, except that
`sinceTimePeriod` and `untilTimePeriod` may be combined into an inclusive
range. When no time selection is supplied, the plugin sends
`lastTimePeriod=1`. `geoLevel` can select aggregates, countries, NUTS levels,
or cities, while exact `geo` filters select named entities.

JSON-stat cubes can be large. The plugin defaults to a 2,500-cell safety limit
and permits at most 10,000 cells. An oversized response fails with guidance to
add narrower filters. Every non-empty cell in an accepted response is retained
in the result card; `displayLimit` only bounds the text shown to the model.
Observation status codes are preserved verbatim. The returned API payload and
exact request URL are retained in a source reference for citation inspection.

The current search tool uses all query words as an AND search against dataset
codes and English titles. It is not semantic search. Try fewer or more specific
words if no result is found.

## Example workflow

Find a population dataset:

```text
eurostat_search_datasets({ query: "population age sex", limit: 10 })
```

Inspect the selected code:

```text
eurostat_get_dataset_metadata({ datasetCode: "DEMO_PJAN" })
```

Query two countries for the latest year:

```text
eurostat_query_data({
  datasetCode: "DEMO_PJAN",
  filters: [
    { dimension: "sex", value: "T" },
    { dimension: "age", value: "TOTAL" },
    { dimension: "geo", value: "DE" },
    { dimension: "geo", value: "FR" }
  ],
  lastTimePeriod: 1
})
```

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Plugin tool / future tool |
| --- | --- | --- | --- |
| `GET /eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT/all/latest?format=JSON&detail=allstubs` | Implemented | Compact catalogue of approximately eight thousand dataflow stubs; JSON-stat collection with `updated` and `link.item[]` records containing title, code, agency, and version. Host-cached; searched locally and paged with `offset`/`limit`. | `eurostat_search_datasets` |
| `GET /eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT/{datasetCode}/latest?format=JSON` | Implemented | Exact dataset code; JSON-stat metadata document with title and extension annotations such as observation count, overall periods, timestamps, source institution, data-structure reference, and ESMS link. | `eurostat_get_dataset_metadata` |
| `GET /eurostat/api/dissemination/statistics/1.0/data/{datasetCode}` | Implemented | Exact dataset code; optional `lang`, any dataset dimension as a repeatable filter, `geoLevel`, and one time mechanism (`time`/`time_period`, `lastTimePeriod`, or `sinceTimePeriod` + `untilTimePeriod`). JSON-stat 2.0 dataset with dimensions, category codes/labels, sparse values, and statuses. No server pagination; response size depends on filtering. | `eurostat_query_data` |
| `GET /eurostat/api/dissemination/sdmx/3.0/structure/dataflow/{agency}/{resource}/{version}` | Planned | SDMX structure query for one or all dataflows; XML 3.0/2.1 response, wildcard catalogue support, `detail`, and `references`. | future `eurostat_get_dataflow_structure` |
| `GET /eurostat/api/dissemination/sdmx/3.0/structure/datastructure/{agency}/{resource}/{version}` | Planned | Dataset structure definition identifying ordered dimensions, attributes, and referenced codelists; XML response. | future `eurostat_get_dataset_structure` |
| `GET /eurostat/api/dissemination/sdmx/3.0/structure/codelist/{agency}/{resource}/{version}` | Planned | One controlled vocabulary and its allowed codes/labels; XML response with optional detail/references. | future `eurostat_get_codelist` |
| `GET /eurostat/api/dissemination/sdmx/3.0/data/dataflow/{agency}/{resource}/{version}/{key}` | Planned | SDMX 3 data query using ordered keys or `c[DIMENSION]` component filters, observation limits, attributes/measures, and CSV/XML response formats; large results may become asynchronous. | future `eurostat_query_sdmx_data` |
| `GET /eurostat/api/dissemination/catalogue/metabase.txt.gz` | Planned | Twice-daily gzip TSV mapping every dataset code to ordered dimension and position codes; large catalogue download with no request parameters. | future `eurostat_get_dataset_dimensions` |
| `GET /eurostat/api/dissemination/catalogue/toc/{xml\|txt}` | Planned | Multilingual hierarchical Eurostat table of contents; XML or one-language text response, no pagination. | future `eurostat_browse_catalogue` |
| `GET /eurostat/api/dissemination/catalogue/dcat/ESTAT/{FULL\|UPDATES}` | Planned | DCAT-AP RDF dataset catalogue; full catalogue or twice-daily updates. | future `eurostat_get_catalogue_updates` |
| `GET /eurostat/api/dissemination/catalogue/rss/{lang}/statistics-update.rss` | Planned | English, French, or German RSS feed for recent data-product and codelist changes. | future `eurostat_list_updates` |
| Comext/Prodcom under `/eurostat/api/comext/dissemination/...` | Planned | Separate dissemination base for trade and production datasets; Statistics-style and SDMX access with dataset-specific dimensions. | future `eurostat_query_comext_data` |
| Catalogue or data mutations | Not applicable | The documented Eurostat dissemination APIs are read-only; no create/update/delete operation belongs in this plugin. | excluded: read-only plugin |

## Testing

The deterministic test suite mocks every HTTP request. It covers all three
public client helpers and all three tools, exact paths and query parameter
spellings, repeated dimension filters, default and conflicting time behavior,
catalogue ranking and empty results, metadata annotations, JSON-stat cube
decoding, sparse values, observation statuses, size limits, references, card
data, schemas, descriptions, and HTTP errors.

```sh
node --test
```

Runtime discovery from the Raynard repository:

```sh
PLUGIN_DIR="$HOME/Library/Application Support/ai.raynard/generated-plugins/eurostat"
node scripts/plugin-tool-runner.mjs <<EOF
{"pluginDir":"$PLUGIN_DIR","listTools":true}
EOF
```

## Sources

- API overview: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started
- Statistics API getting started: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/api
- Statistics API detailed guidelines: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/api-statistics
- SDMX 3 structure queries: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/sdmx3-0/structure-queries
- SDMX 3 data queries: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/sdmx3-0/data-query
- Catalogue API getting started: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/catalogue-api
