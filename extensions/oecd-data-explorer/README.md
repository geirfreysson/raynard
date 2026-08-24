# OECD Data Explorer

Raynard Explore-mode API plugin for the OECD Data Explorer / SDMX REST API. It supports a reusable workflow: discover dataflows, parse Data Explorer URLs, inspect dataset structures, look up dimension code values, and fetch observations such as purchasing power parities.

## Authentication

No API key is required for the public OECD SDMX REST endpoints used by this plugin.

## Implemented tools

- `oecd_search_dataflows` — fetches `/dataflow/{agencyID}/{resourceID}/{version}` and locally ranks the ~2,600 dataflow stubs by how many query terms match id, agency, name, and description. Term scoring is what lets a natural-language query such as "GDP per capita PPP US dollars" find a dataflow; a whole-phrase match finds nothing. An empty result is returned as an empty result, citing the registry, not as a failure.
- `oecd_parse_data_explorer_url` — parses Data Explorer visualisation URLs containing `df[id]`, `df[ag]`, `dq`, `lom`, and `lo` into SDMX inputs. `df[id]` is one whole dataflow id (`DSD_NAMAIN10@DF_TABLE4`); the part before `@` is only the datastructure id.
- `oecd_inspect_dataflow_structure` — fetches `/datastructure/{agencyID}/{structureID}/{version}?references=all` and renders dimensions in key order with each codelist's agency, id, and version. Accepts a full dataflow id and reduces it to the structure id.
- `oecd_get_codelist_values` — fetches `/codelist/{agencyID}/{codelistID}/{version}` and optionally searches codes locally by term.
- `oecd_fetch_observations` — fetches `/data/{flowRef}/{key}` with SDMX time/window query parameters (`startPeriod`, `endPeriod`, `updatedAfter`, `firstNObservations`, `lastNObservations`). Accepts either a dot-separated `key` or a `dimensions` object keyed by dimension id, resolves the dataflow's real dimension order first, expands short keys against the live codelists, and decodes country/time/value rows.

## SDMX gotchas this plugin encodes

These are the specific behaviours of the OECD gateway that a naive client gets wrong:

- **The dataflow id is whole.** `df[id]=DSD_NAMAIN10@DF_TABLE4` is one id. Requesting `OECD.SDD.NAD,DF_TABLE4` returns HTTP 404.
- **Two Accept versions.** Structure endpoints serve `application/vnd.sdmx.structure+json; charset=utf-8; version=1.0` only and answer 406 for `2.0`; the data endpoint serves `application/vnd.sdmx.data+json; charset=utf-8; version=2`.
- **`dimensionAtObservation` is camelCase.** `dimension_at_observation` is rejected with HTTP 422.
- **`detail=allstubs` strips codes.** Useful for listing dataflows, useless for a codelist.
- **`version=all` returns every version.** A version-less data request resolves to the newest, so structure resolution picks the newest dataflow and its referenced datastructure rather than the first entry.
- **Keys are positional and full-width.** `DSD_NAMAIN10@DF_TABLE4` takes 12 dimensions: `FREQ.REF_AREA.SECTOR.COUNTERPART_SECTOR.TRANSACTION.INSTR_ASSET.ACTIVITY.EXPENDITURE.UNIT_MEASURE.PRICE_BASE.TRANSFORMATION.TABLE_IDENTIFIER`. PPP for Iceland and Sweden is `A.ISL+SWE...PPP_B1GQ.......`.
- **`Accept-Language` must be a real tag.** Node's `fetch` sends `Accept-Language: *` when the header is unset, and the gateway answers HTTP 500 with the body `languageTag1`. curl sends no such header, so the identical request succeeds from a shell and fails from the plugin — this was the main source of apparent flakiness. Every request sends `Accept-Language: en`.
- **`detail=referencepartial` needs a concrete version.** `/dataflow/{ag}/{id}/all?references=all&detail=referencepartial` returns HTTP 501, so the version is resolved first with a ~2 KB unreferenced call.
- **`detail=referencepartial` is a `/dataflow/` feature.** The `/datastructure/` endpoint answers it with HTTP 501; it needs no `references` at all, since the dimension list already names each codelist by URN (1.9 KB versus 276 KB).
- **Compression is expected.** OECD "strongly recommend" `Accept-Encoding`; structure payloads compress about 5:1.
- **The gateway throttles.** Bursts return 429 and intermittent 5xx; requests retry with backoff.
- **Codelists are cross-agency.** `REF_AREA` uses `OECD:CL_AREA`, `FREQ` uses `SDMX:CL_FREQ`, even though the structure belongs to `OECD.SDD.NAD`. Structure responses name them by URN, not by a nested id.
- **Not every dataflow serves data.** `DSD_NAMAIN10@DF_TABLE4_PPP_P41` resolves structurally but has no mapping set, so its data request fails at the gateway.

Every tool returns bounded text, structured card data, raw payload references, and citeable source metadata.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Tool or future tool |
| --- | --- | --- | --- |
| `GET https://sdmx.oecd.org/public/rest/dataflow/{agencyID}/{dataflowID}/{version}?references=datastructure` | Implemented | Resolves a flowRef to its datastructure and therefore its dimension order. Used by `oecd_fetch_observations` before every data request. | `oecd_fetch_observations` |
| `GET https://sdmx.oecd.org/public/rest/dataflow/{agencyID}/{resourceID}/{version}` | Implemented | Path parameters default to `all`; query uses `detail=allstubs`. Response is SDMX-JSON structure with `data.dataflows[]` stubs including id, agencyID, version, name, and description. No server full-text search is exposed here; filtering is local. | `oecd_search_dataflows` |
| OECD Data Explorer `https://data-explorer.oecd.org/vis?...` URL parameters | Implemented | Parses `df[id]` as the complete dataflow id (the `structureID` is the part before `@`), `df[ag]`, `dq`, `lom=LASTNPERIODS`, and `lo`. Preserves `+` as OECD OR-within-dimension syntax and returns a flowRef that keeps the whole dataflow id. Not a network endpoint; response is normalized SDMX inputs for follow-up calls. | `oecd_parse_data_explorer_url` |
| `GET https://sdmx.oecd.org/public/rest/datastructure/{agencyID}/{structureID}/{version}` | Implemented | Required `agencyID`, `structureID`; version defaults to `all`; query `references=all` retrieves related structures/codelists when the API includes them. Response is SDMX-JSON structure; plugin extracts dimension rows and preserves raw payload. | `oecd_inspect_dataflow_structure` |
| `GET https://sdmx.oecd.org/public/rest/codelist/{agencyID}/{codelistID}/{version}` | Implemented | Required `agencyID`, `codelistID`; version defaults to `all`; `detail=allstubs` is deliberately not sent because stubs omit the codes. Response is SDMX-JSON structure with codelist code items; plugin can filter locally by `q`. | `oecd_get_codelist_values` |
| `GET https://sdmx.oecd.org/public/rest/data/{flowRef}/{key}` | Implemented | Required `flowRef` (often `agencyID,dataflowID`) and dot-separated SDMX `key`. Optional exact query names: `startPeriod`, `endPeriod`, `updatedAfter`, `firstNObservations`, `lastNObservations`, plus `dimensionAtObservation=AllDimensions` (camelCase; the snake_case spelling is rejected with HTTP 422). The key is validated and, when short, expanded against the dataflow's live dimension order before the request. Response is SDMX-JSON data with datasets/series/observations; plugin flattens observation values, decodes series dimensions such as country plus observation dimensions including `TIME_PERIOD` when present, and cites the raw payload. | `oecd_fetch_observations` |
| `GET /data/{flowRef}/all` | Planned | Purpose: fetch all series for a flow where the endpoint allows broad queries. Parameters mirror observation time/window filters. Response can be very large; future tool should enforce conservative caps and require explicit confirmation-like scoping fields. | Future `oecd_fetch_dataset_sample` |
| `GET /dataavailability/{flowRef}/{key}` | Planned | Purpose: discover which dimension combinations have data before fetching observations. Parameters include flow/key and provider-specific options; response is availability metadata. | Future `oecd_check_data_availability` |
| `GET /metadataflow`, `GET /metadatastructure`, `GET /metadata` | Planned | Purpose: discover and retrieve SDMX metadata sets beyond numerical observations. Response shapes are SDMX metadata JSON/XML depending on headers. | Future metadata discovery/detail tools |
| Other SDMX structural resources (`conceptscheme`, `categoryscheme`, `agency`, `provider`, `provisionagreement`) | Planned | Purpose: richer registry browsing and provenance. Path parameters generally follow `{agencyID}/{resourceID}/{version}` with `detail` and `references` options; responses are SDMX-JSON structure resources. | Future focused registry tools as needed |
| POST/PUT/DELETE SDMX endpoints | Not applicable | This Explore plugin is read-only and does not modify OECD resources. | None |

## Source documentation

- https://www.oecd.org/en/data/insights/data-explainers/2024/09/api.html
- https://data-explorer.oecd.org/
- https://gitlab.algobank.oecd.org/public-documentation/dotstat-migration/-/raw/main/OECD_Data_API_documentation.pdf
- https://sdmx.oecd.org/public/rest/

## Development

Runtime helpers, tool types, citations, cards, and test helpers come from the host-supplied `@raynard/plugin-sdk`. Tests use Node's built-in test runner and mocked fetch only:

```bash
node --test client.test.ts tools.test.ts
```
