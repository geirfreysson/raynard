# IMF SDMX API

Query IMF statistical data through the IMF SDMX 3.0 API (iData): browse the
dataflow registry, inspect a dataflow's dimensions and codelists, check its
coverage, and fetch observation time series.

## Source documentation

- https://portal.api.imf.org/api-details#api=idata-sdmx-api-3-0

## Development

Runtime helpers, tool types, citations, cards, and test helpers come from the
host-supplied `@raynard/plugin-sdk`. Keep this workspace focused on API-specific
client code, tools, behavior tests, and this documentation.

Every tool returns concise text, source references, and structured data matching
its fixed declarative card. List and search results use bounded cards and
preserve useful empty-result data.

## How this API actually behaves

These are the rules the client encodes. Each was verified against the live
service by isolating one variable at a time, and each fails **silently** — with
a 200 or a 204 rather than an error — when it is broken.

1. **Structure artefacts live under `/structure/`.** `GET /sdmx/3.0/dataflow`
   is a 404; `GET /sdmx/3.0/structure/dataflow` is the registry.
2. **An artefact query that matches nothing returns 204 with an empty body**,
   not a 404. `/structure/dataflow/IMF/BOP/+` answers 204 because no dataflow
   belongs to a bare `IMF` agency, and an empty body reads as "the API has no
   data" rather than "your identifiers are wrong". This client names the SDMX
   media types (`application/vnd.sdmx.structure+json;version=2.0.0` and
   `…data+json;version=2.0.0`) to state the contract it parses; plain
   `application/json` is served too. Pin the full `2.0.0` — `;version=2.0` is
   rejected with an explicit 400.
3. **There is no `IMF` agency for dataflows.** Dataflows belong to department
   agencies: `IMF.STA` (351), `IMF.RES`, `IMF.FAD`, `IMF.MCD`, `IMF.WHD`,
   `IMF.AFR`, `IMF.APD`, `IMF.SPR`, `IMF.MCM`, and `ISORA`. Requesting
   `/structure/dataflow/IMF/*` returns 204. Some *codelists* do live under a
   bare `IMF` agency (`CL_FREQ`, `CL_UNIT`, `CL_COUNTRY`), which is why
   `imf_get_codelist` tries `IMF.STA` and then `IMF`.
4. **`+` is the latest version, `*` is every version.** `/structure/dataflow/*/*/+`
   returns 222 latest dataflows; `*/*/*` returns 407 including superseded ones.
   (`~` and `latest` also resolve the latest version.)
5. **The `{key}` path segment is not applied to data queries.** A keyed request
   such as `/data/dataflow/IMF.STA/BOP/+/USA...USD.A` answers `200` with an
   empty `dataSets` entry. Every dimension filter must be a `c[DIMENSION]=`
   query parameter with `*` in the key position. Multiple codes are
   comma-separated.
6. **Time filters need full ISO dates.** `c[TIME_PERIOD]=ge:2018` is ignored and
   the whole history is returned; `ge:2018-01-01` works. A range is
   `ge:2018-01-01+le:2023-12-31` (the `+` must be percent-encoded). SDMX 2.1
   `startPeriod`/`endPeriod` are ignored entirely.
7. **Everything is wrapped in `data`.** Artefacts arrive as `data.dataflows[]`,
   `data.dataStructures[]`, `data.codelists[]`, `data.conceptSchemes[]`,
   `data.dataConstraints[]`.
8. **Dimensions carry no local representation.** A dimension only names a
   `conceptIdentity`; the codelist behind it is the concept's
   `coreRepresentation.enumeration`, reachable by requesting the data structure
   with `?references=children`. Concept urns embed a wildcard patch version
   (`CS_BOP(17.0+.0)`), so they are matched by scheme and concept ID, not by urn
   string equality.
9. **Availability returns coverage, not values.** Every `cubeRegion.keyValues`
   comes back empty; the useful content is the `sdmx_metrics` annotations
   (`series_count`, `time_period_start`, `time_period_end`) and the constrained
   component names. Valid codes come from codelists instead.
10. **An unknown code is not an error.** `c[COUNTRY]=US` (BOP wants ISO-3 `USA`)
    returns `200` with an empty dataset, so `imf_get_data` reports the empty
    result and names the tools that produce valid codes.

Two likely-looking suspects that were tested and are **not** problems: plain
`Accept: application/json` is served on every endpoint tried, and `~`, `+`, and
`latest` all resolve the latest version.

## Data message shape

`data.dataSets[0].series` is keyed by colon-joined **indexes** into
`data.structures[0].dimensions.series[i].values`, and each observation key
indexes `dimensions.observation` (`TIME_PERIOD`), whose entries use `value`
rather than `id`. Observation values are strings.

```json
{"data":{"dataSets":[{"series":{"0:0:0:0:0":{"observations":{"0":["-589622000000",0,0,null]}}}}],
 "structures":[{"dimensions":{"series":[{"id":"COUNTRY","values":[{"id":"USA"}]}],
 "observation":[{"id":"TIME_PERIOD","values":[{"value":"2020"}]}]}}]}}
```

## Tools

1. **`imf_list_dataflows`** — search the registry by text and/or agency; returns
   ID, name, agency, and version. The entry point for every other tool.
2. **`imf_get_dataflow`** — the dataflow's data structure, its ordered
   dimensions, and the codelist behind each dimension.
3. **`imf_get_codelist`** — valid codes for one codelist, with a text filter for
   large lists (`CL_BOP_INDICATOR` has 979 codes).
4. **`imf_get_data`** — observation time series, filtered by dimension/value
   pairs and an optional period range.
5. **`imf_get_availability`** — series count and observed period range for a
   dataflow, plus the dimensions that constrain it.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Tool |
| --- | --- | --- | --- |
| `GET /structure/dataflow/{agencyID}/{resourceID}/{version}` | Implemented | `*/*/+` lists latest dataflows. Returns `data.dataflows[]` with `id`, `name`, `description`, `version`, `agencyID`, `structure` urn. Structure media type required. | `imf_list_dataflows` |
| `GET /structure/dataflow/{agencyID}/{resourceID}/{version}?references=children` | Implemented | Adds `data.dataStructures[]` with `dataStructureComponents.dimensionList.dimensions[]` (`id`, `position`, `conceptIdentity`). | `imf_get_dataflow` |
| `GET /structure/datastructure/{agencyID}/{resourceID}/{version}?references=children` | Implemented | Returns `data.conceptSchemes[]`; each concept's `coreRepresentation.enumeration` is the codelist urn for the dimension of the same ID. | `imf_get_dataflow` |
| `GET /structure/codelist/{agencyID}/{resourceID}/{version}` | Implemented | Returns `data.codelists[0].codes[]` with `id`, `name`, optional `parent`. | `imf_get_codelist` |
| `GET /data/dataflow/{agencyID}/{resourceID}/{version}/{key}` | Implemented | Key must be `*`; filters go in `c[DIMENSION]=` and `c[TIME_PERIOD]=ge:…+le:…`. Data media type required. Returns `data.dataSets[]` + `data.structures[]`. | `imf_get_data` |
| `GET /availability/dataflow/{agencyID}/{resourceID}/{version}/{key}/{componentID}` | Implemented | Returns `data.dataConstraints[0]` with `sdmx_metrics` annotations and `cubeRegions[].components[]`. `keyValues` is always empty at IMF. | `imf_get_availability` |
| `GET /structure/conceptscheme/{agencyID}/{resourceID}/{version}` | Planned | Standalone concept definitions; currently obtained through the data structure's `references=children`. | — |
| `GET /structure/categoryscheme/{agencyID}/{resourceID}/{version}` | Planned | Hierarchical browsing of dataflows by subject. | — |
| `GET /structure/dataflow/{agencyID}/{resourceID}/{version}?references=descendants` | Not implemented | Returns the full closure including every codelist (~3.8 MB for BOP), too large for a tool result. | — |

## Worked example

```
imf_list_dataflows  query="balance of payments"        → IMF.STA:BOP
imf_get_dataflow    dataflow_id="BOP"                  → COUNTRY, BOP_ACCOUNTING_ENTRY,
                                                         INDICATOR, UNIT, FREQUENCY
imf_get_codelist    codelist_id="CL_BOP_INDICATOR"
                    agency_id="IMF.STA" query="current account"  → CAB
imf_get_data        dataflow_id="BOP"
                    filters=[COUNTRY=USA,DEU; INDICATOR=CAB; UNIT=USD; FREQUENCY=A]
                    start_period="2018" end_period="2023"
```

## Tests

`node --test` runs the mocked client and tool tests. The mocks reproduce the
live response shapes above, including the empty dataset returned for an invalid
code — the previous version of this plugin passed its tests against invented
shapes while every live call failed.
