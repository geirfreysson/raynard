import { createApiReference, defineTools, requireNonEmpty, requirePositiveInt, type ApiTool } from '@raynard/plugin-sdk';
import { BASE, fetchCodelist, fetchDataflowReferences, fetchDataflowStructure, fetchDataflowVersions, fetchDataflows, fetchObservations, type LocalisedText, type SdmxDataflow } from './client.ts';

function textValue(value: LocalisedText | undefined): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.en === 'string') return record.en;
  if (typeof record.value === 'string') return record.value;
  const names = record.names as Record<string, unknown> | undefined;
  if (names && typeof names.en === 'string') return names.en;
  const first = Object.values(record).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}
function namedText(entity: any): string {
  return textValue(entity?.name) || textValue(entity?.names);
}
function sourceUrlForDataflow(flow: SdmxDataflow): string { return `${BASE}/dataflow/${flow.agencyID ?? 'all'}/${flow.id}/${flow.version ?? 'all'}`; }
function arr(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function firstArrayAt(data: any, names: string[]): any[] {
  for (const name of names) {
    const value = data?.data?.[name] ?? data?.[name];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// SDMX 1.0 structure messages reference other artefacts by URN
// (urn:...Codelist=OECD:CL_AREA(1.1)) rather than by a nested {id} object.
export function parseSdmxUrn(urn: string, kind: 'Codelist' | 'DataStructure') {
  const match = new RegExp(`${kind}=([^:]+):([^(]+)\\((.+)\\)\\s*$`).exec(String(urn ?? ''));
  if (!match) return { agencyID: '', id: '', version: '' };
  return { agencyID: match[1], id: match[2], version: match[3] };
}
function codelistRefFor(dimension: any) {
  const enumeration = dimension?.localRepresentation?.enumeration;
  if (enumeration && typeof enumeration === 'object' && typeof enumeration.id === 'string') {
    return { agencyID: String(enumeration.agencyID ?? ''), id: enumeration.id, version: String(enumeration.version ?? '') };
  }
  return parseSdmxUrn(typeof enumeration === 'string' ? enumeration : '', 'Codelist');
}

function compareVersions(left: string, right: string) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}
// A version-less request resolves to the newest artefact, so `version=all`
// responses must be narrowed the same way rather than taking the first entry.
function latestByVersion(entities: any[]) {
  return [...entities].sort((left, right) => compareVersions(String(right?.version ?? '0'), String(left?.version ?? '0')))[0];
}
function dataStructuresFrom(payload: any): any[] {
  return firstArrayAt(payload, ['dataStructures']);
}
function dimensionsOf(structure: any) {
  const dims = arr(structure?.dataStructureComponents?.dimensionList?.dimensions ?? structure?.components?.dimensionList?.dimensions);
  return dims.map((d, index) => {
    const codelist = codelistRefFor(d);
    return {
      id: String(d.id ?? d?.conceptIdentity?.id ?? `DIM${index + 1}`),
      position: Number.isFinite(Number(d.position)) ? Number(d.position) : index,
      name: namedText(d),
      codelistID: codelist.id,
      codelistAgencyID: codelist.agencyID,
      codelistVersion: codelist.version,
      raw: d
    };
  }).sort((a, b) => a.position - b.position);
}
function dimensionsFromStructure(payload: any) {
  return dimensionsOf(latestByVersion(dataStructuresFrom(payload)));
}
function codesFromCodelist(payload: any, codelistID = '') {
  const codelists = firstArrayAt(payload, ['codelists']);
  const wanted = codelistID ? codelists.filter((list) => String(list?.id ?? '') === codelistID) : codelists;
  const list = (wanted.length ? wanted : codelists)[0] ?? {};
  const items = arr(list.codes ?? list.items);
  return { codelist: list, codes: items.map((c) => ({ id: String(c.id ?? ''), name: namedText(c), description: textValue(c.description) || textValue(c.descriptions), raw: c })) };
}
function decodeDimensions(dimensions: any[], key: string) {
  const indices = key ? key.split(':') : [];
  return dimensions.map((dimension, index) => {
    const code = dimension?.values?.[Number(indices[index])] ?? {};
    return { id: String(dimension?.id ?? `DIM${index + 1}`), value: String(code.id ?? indices[index] ?? ''), name: namedText(code) };
  });
}
function observationRows(payload: any) {
  const root = payload?.data ?? payload;
  // data+json 2.0 returns structures[]; 1.0 returned a single structure object.
  const structure = root?.structure ?? arr(root?.structures)[0] ?? {};
  const structureDimensions = structure?.dimensions ?? {};
  const observationDimensions = arr(structureDimensions.observation);
  const seriesDimensions = arr(structureDimensions.series);
  const datasetDimensions = arr(structureDimensions.dataSet);
  const datasetDecoded = datasetDimensions.map((dimension) => ({
    id: String(dimension?.id ?? ''),
    value: String(dimension?.values?.[0]?.id ?? ''),
    name: namedText(dimension?.values?.[0])
  }));
  const rowFor = (seriesKey: string, observationKey: string, value: any, seriesDecoded: any[] = []) => {
    const decoded = [...datasetDecoded, ...seriesDecoded, ...decodeDimensions(observationDimensions, observationKey)];
    const time = decoded.find((dimension) => dimension.id === 'TIME_PERIOD');
    const country = decoded.find((dimension) => ['REF_AREA', 'LOCATION', 'COUNTRY'].includes(dimension.id));
    return {
      seriesKey,
      observationKey,
      country: country?.name || country?.value || '',
      countryCode: country?.value ?? '',
      timePeriod: time?.value ?? '',
      dimensionKey: decoded.map((dimension) => `${dimension.id}=${dimension.value}`).join(', '),
      dimensions: decoded,
      value: Array.isArray(value) ? value[0] : value,
      raw: value
    };
  };
  const dataSet = arr(root?.dataSets)[0] ?? {};
  const series = dataSet.series ?? {};
  const seriesRows = Object.entries(series).flatMap(([seriesKey, seriesValue]: [string, any]) => {
    const seriesDecoded = decodeDimensions(seriesDimensions, seriesKey);
    return Object.entries(seriesValue?.observations ?? {}).map(([observationKey, value]) => rowFor(seriesKey, observationKey, value, seriesDecoded));
  });
  if (seriesRows.length) return seriesRows;
  const observations = dataSet.observations ?? {};
  return Object.entries(observations).map(([observationKey, value]) => rowFor(observationKey, observationKey, value));
}
function sortObservationRows(rows: any[]) {
  return [...rows].sort((left, right) => {
    const byCountry = String(left.country || left.countryCode).localeCompare(String(right.country || right.countryCode));
    if (byCountry !== 0) return byCountry;
    return String(left.timePeriod).localeCompare(String(right.timePeriod));
  });
}
function rawQueryParam(parsed: URL, name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const part = parsed.search.slice(1).split('&').find((item) => item.startsWith(prefix) || item.startsWith(`${name}=`));
  if (!part) return parsed.searchParams.get(name) ?? '';
  return decodeURIComponent(part.slice(part.indexOf('=') + 1));
}

// A Data Explorer df[id] such as DSD_NAMAIN10@DF_TABLE4 is one dataflow id.
// Splitting it and keeping only DF_TABLE4 produces a flowRef the SDMX gateway
// answers with HTTP 404.
export function parseExplorerUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  const dataflowID = rawQueryParam(parsed, 'df[id]');
  const structureID = dataflowID.includes('@') ? dataflowID.split('@')[0] : dataflowID;
  const agencyID = rawQueryParam(parsed, 'df[ag]');
  const dq = rawQueryParam(parsed, 'dq');
  const lo = parsed.searchParams.get('lo');
  const lom = parsed.searchParams.get('lom');
  return {
    sourceUrl: rawUrl,
    agencyID,
    structureID,
    dataflowID,
    flowRef: [agencyID, dataflowID].filter(Boolean).join(','),
    dq,
    key: dq,
    lastNObservations: lom === 'LASTNPERIODS' && lo ? Number(lo) : undefined
  };
}

// A phrase like "GDP per capita PPP US dollars" never appears verbatim in a
// dataflow name, so a whole-string `includes` match returns nothing. Score on
// terms instead: every term present ranks first, then partial matches, so a
// natural-language query still surfaces the right dataflow.
export function scoreDataflowMatch(haystack: string, terms: string[]) {
  const text = haystack.toLowerCase();
  const hits = terms.filter((term) => text.includes(term)).length;
  return hits === terms.length ? hits + 1 : hits;
}
export function searchTerms(query: string) {
  return query.toLowerCase().split(/[^a-z0-9_@.]+/i).filter((term) => term.length > 1);
}

export function parseFlowRef(flowRef: string) {
  const [agencyID = '', dataflowID = '', version = ''] = flowRef.split(',');
  return { agencyID, dataflowID, version, structureID: dataflowID.includes('@') ? dataflowID.split('@')[0] : dataflowID };
}

// One documented references=all&detail=referencepartial call answers both
// questions a key needs: the dimension order, and which codes each dimension
// actually serves in this dataflow. Resolving a key therefore costs one request
// rather than one per dimension, which is most of what made this plugin flaky.
async function flowDimensions(flowRef: string) {
  const { agencyID, dataflowID, version } = parseFlowRef(flowRef);
  if (!agencyID || !dataflowID) throw new Error(`flowRef must look like agencyID,dataflowID (received "${flowRef}").`);
  // Resolve the concrete version first. A version-less data request uses the
  // newest, and referencepartial refuses version=all with HTTP 501.
  let resolvedVersion = version;
  if (!resolvedVersion) {
    const versions = await fetchDataflowVersions({ agencyID, dataflowID });
    resolvedVersion = String(latestByVersion(firstArrayAt(versions, ['dataflows']))?.version ?? '');
    if (!resolvedVersion) throw new Error(`No dataflow found for OECD flowRef ${flowRef}; check the agency and dataflow id.`);
  }
  const payload = await fetchDataflowReferences({ agencyID, dataflowID, version: resolvedVersion });
  const flow = latestByVersion(firstArrayAt(payload, ['dataflows']));
  const structureRef = parseSdmxUrn(String(flow?.structure ?? ''), 'DataStructure');
  const structures = dataStructuresFrom(payload);
  const structure = structures.find((entry) => String(entry?.id) === structureRef.id && String(entry?.version) === structureRef.version)
    ?? latestByVersion(structures);
  const dimensions = dimensionsOf(structure);
  if (!dimensions.length) throw new Error(`No dimensions found for OECD flowRef ${flowRef}; check the agency and dataflow id.`);
  const codelists = firstArrayAt(payload, ['codelists']);
  const codesByDimension = new Map<string, Set<string>>();
  for (const dimension of dimensions) {
    const match = codelists.find((list) => String(list?.id) === dimension.codelistID
      && (!dimension.codelistVersion || String(list?.version) === dimension.codelistVersion))
      ?? codelists.find((list) => String(list?.id) === dimension.codelistID);
    codesByDimension.set(dimension.id, new Set(arr(match?.codes ?? match?.items).map((code) => String(code?.id ?? ''))));
  }
  return { dimensions, codesByDimension };
}

function keyOrderMessage(flowRef: string, dimensions: { id: string }[]) {
  return `OECD flowRef ${flowRef} takes ${dimensions.length} dot-separated dimensions in this order: ${dimensions.map((d) => d.id).join('.')}. Leave a position empty to request all of its codes, and join alternatives with +.`;
}

// The Data Explorer lets a user drop dimensions they did not filter on, so a
// pasted or remembered key is often shorter than the structure requires. Each
// shorthand segment is matched to the next dimension that actually serves those
// codes, which keeps this general instead of special-casing one dataflow.
function expandShorthandKey(segments: string[], dimensions: any[], codesByDimension: Map<string, Set<string>>) {
  const assigned = new Array(dimensions.length).fill('');
  let cursor = 0;
  for (const segment of segments) {
    if (!segment) { cursor += 1; continue; }
    const codes = segment.split('+');
    let index = -1;
    for (let position = cursor; position < dimensions.length; position += 1) {
      const available = codesByDimension.get(dimensions[position].id) ?? new Set<string>();
      if (codes.every((code) => available.has(code))) { index = position; break; }
    }
    if (index === -1) return '';
    assigned[index] = segment;
    cursor = index + 1;
  }
  return assigned.join('.');
}

export async function resolveObservationKey(flowRef: string, rawKey: string, dimensionValues?: Record<string, unknown>) {
  const { dimensions, codesByDimension } = await flowDimensions(flowRef);
  const order = dimensions.map((dimension) => dimension.id);
  if (dimensionValues && Object.keys(dimensionValues).length) {
    const unknown = Object.keys(dimensionValues).filter((id) => !order.includes(id));
    if (unknown.length) throw new Error(`Unknown dimension(s) ${unknown.join(', ')}. ${keyOrderMessage(flowRef, dimensions)}`);
    const key = order.map((id) => {
      const value = dimensionValues[id];
      if (value == null) return '';
      const codes = (Array.isArray(value) ? value : [value]).map((entry) => String(entry)).filter(Boolean);
      // referencepartial codelists are the codes this dataflow really serves, so
      // a typo can be named here instead of coming back as an opaque gateway error.
      const available = codesByDimension.get(id);
      if (available?.size) {
        const missing = codes.filter((code) => !available.has(code));
        if (missing.length) {
          const sample = [...available].slice(0, 12).join(', ');
          throw new Error(`${id} does not serve ${missing.join(', ')} in ${flowRef}. Available codes include: ${sample}${available.size > 12 ? `, … (${available.size} total)` : ''}.`);
        }
      }
      return codes.join('+');
    }).join('.');
    return { key, dimensions: order };
  }
  const key = requireNonEmpty(rawKey, 'key');
  if (key === 'all') return { key, dimensions: order };
  const segments = key.split('.');
  if (segments.length === order.length) return { key, dimensions: order };
  if (segments.length < order.length) {
    const expanded = expandShorthandKey(segments, dimensions, codesByDimension);
    if (expanded) return { key: expanded, dimensions: order };
  }
  throw new Error(`Key "${key}" has ${segments.length} dimensions. ${keyOrderMessage(flowRef, dimensions)}`);
}

export const tools = defineTools({
  oecd_search_dataflows: {
    description: 'Search OECD SDMX dataflows/endpoints by text in id, agency, name, or description. Fetches the public /dataflow registry with detail=allstubs and filters client-side because the SDMX endpoint has no general full-text search parameter; omitted limit defaults to 20 and max useful limit is 100. Returned ids are complete SDMX dataflow ids such as DSD_NAMAIN10@DF_TABLE4 and must be used whole, including the part before @. Pass agencyID and the returned id to oecd_inspect_dataflow_structure, and use agencyID,id as the flowRef for oecd_fetch_observations.',
    parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string', description: 'Required search text, for example "purchasing power parities", "PPP", "national accounts", or a dataflow id fragment such as "DF_TABLE4". Matching is case-insensitive and performed locally over the fetched dataflow stubs.' }, agencyID: { type: 'string', description: 'Optional SDMX agency id path segment to narrow the registry request, such as OECD.SDD.NAD. Defaults to all.' }, resourceID: { type: 'string', description: 'Optional exact dataflow id path segment for the registry request. Defaults to all; use when you already know an id.' }, version: { type: 'string', description: 'Optional SDMX version path segment. Defaults to all.' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matched rows returned after local filtering. Defaults to 20; card data contains every row in this fetched result page up to this limit.' } } },
    card: { name: { singular: 'dataflow', plural: 'dataflows' }, title: 'OECD dataflows matching {{query}}', layout: [{ component: 'MetricRow', items: [{ label: 'Matches', field: 'count' }, { label: 'Returned', field: 'returned' }] }, { component: 'Table', rows: 'flows', columns: [{ header: 'Agency', field: 'agencyID' }, { header: 'ID', field: 'id' }, { header: 'Version', field: 'version' }, { header: 'Name', field: 'name' }] }] },
    async execute(args) {
      const query = requireNonEmpty(args?.q, 'q');
      const terms = searchTerms(query);
      const limit = args?.limit == null ? 20 : Math.min(requirePositiveInt(args.limit, 'limit'), 100);
      const registryUrl = `${BASE}/dataflow/${args?.agencyID || 'all'}/${args?.resourceID || 'all'}/${args?.version || 'all'}`;
      const response = await fetchDataflows({ agencyID: typeof args?.agencyID === 'string' && args.agencyID ? args.agencyID : undefined, resourceID: typeof args?.resourceID === 'string' && args.resourceID ? args.resourceID : undefined, version: typeof args?.version === 'string' && args.version ? args.version : undefined });
      const allFlows = response.data?.dataflows ?? [];
      const scored = allFlows
        .map((flow) => ({ flow, score: scoreDataflowMatch([flow.id, flow.agencyID, namedText(flow), textValue(flow.description)].join(' '), terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);
      const flows = scored.slice(0, limit).map(({ flow }) => ({ agencyID: flow.agencyID ?? '', id: flow.id, version: flow.version ?? '', flowRef: [flow.agencyID ?? '', flow.id].filter(Boolean).join(','), name: namedText(flow), description: textValue(flow.description), raw: flow }));
      // An empty result is a legitimate answer, but the SDK requires at least one
      // reference, so cite the registry that was searched rather than throwing.
      const references = flows.length
        ? flows.map((flow) => createApiReference({ id: `${flow.agencyID}/${flow.id}`, label: flow.name || flow.id, sourceUrl: sourceUrlForDataflow(flow.raw as SdmxDataflow), quote: `${flow.id}: ${flow.name}`, payload: flow.raw }))
        : [createApiReference({ id: registryUrl, label: 'OECD dataflow registry', sourceUrl: registryUrl, quote: `No dataflow matched "${query}" among ${allFlows.length} dataflows.`, payload: { query, terms, searched: allFlows.length } })];
      return {
        text: flows.length
          ? flows.map((f) => `${f.flowRef} (v${f.version}): ${f.name || '(unnamed dataflow)'}`).join('\n')
          : `No OECD dataflow matched "${query}" among ${allFlows.length} dataflows. Try fewer or broader words — matching is over dataflow ids, names, and descriptions.`,
        data: { query, terms, count: scored.length, returned: flows.length, searched: allFlows.length, flows },
        references
      };
    }
  } satisfies ApiTool,
  oecd_parse_data_explorer_url: {
    description: 'Parse an OECD Data Explorer visualisation URL into reusable SDMX inputs. Extracts df[ag] as agencyID and df[id] as the complete dataflowID (DSD_NAMAIN10@DF_TABLE4 stays whole; structureID is the DSD_NAMAIN10 part before @ for datastructure lookups), dq as the SDMX dimension key with + preserved as OECD OR-within-dimension syntax, and lom=LASTNPERIODS with lo as lastNObservations. The returned flowRef and key can be passed straight to oecd_fetch_observations, which validates and expands the key against the real structure.',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Full OECD Data Explorer URL from data-explorer.oecd.org/vis containing df[id], df[ag], and usually dq. Example df[id]=DSD_NAMAIN10%40DF_TABLE4.' } } },
    card: { name: { singular: 'parsed url', plural: 'parsed urls' }, title: '{{dataflowID}} parsed from OECD Data Explorer', layout: [{ component: 'KeyValue', pairs: [{ label: 'Agency', field: 'agencyID' }, { label: 'Structure', field: 'structureID' }, { label: 'Dataflow', field: 'dataflowID' }, { label: 'Flow ref', field: 'flowRef' }, { label: 'Key', field: 'key' }, { label: 'Last N', field: 'lastNObservations' }] }] },
    async execute(args) { const parsed = parseExplorerUrl(requireNonEmpty(args?.url, 'url')); return { text: `Parsed flowRef ${parsed.flowRef} (structure ${parsed.structureID}) with key ${parsed.key || '(none)'}${parsed.lastNObservations ? ` and last ${parsed.lastNObservations} observations` : ''}.`, data: parsed, references: [createApiReference({ id: parsed.sourceUrl, label: 'OECD Data Explorer URL', sourceUrl: parsed.sourceUrl, quote: parsed.key || parsed.dataflowID, payload: parsed })] }; }
  } satisfies ApiTool,
  oecd_inspect_dataflow_structure: {
    description: 'Inspect an OECD SDMX datastructure and return its dimensions in key order with the agency, id, and version of each dimension codelist. Uses /datastructure/{agencyID}/{structureID}/{version}; version defaults to all. A dataflow id such as DSD_NAMAIN10@DF_TABLE4 is accepted and reduced to its DSD_NAMAIN10 structure id. The dimension order returned here is the order of the dot-separated observation key.',
    parameters: { type: 'object', required: ['agencyID', 'structureID'], properties: { agencyID: { type: 'string', description: 'SDMX agency id, for example OECD.SDD.NAD from df[ag] in Data Explorer URLs.' }, structureID: { type: 'string', description: 'Datastructure id such as DSD_NAMAIN10, or a full dataflow id such as DSD_NAMAIN10@DF_TABLE4 which is reduced to the part before @.' }, version: { type: 'string', description: 'Optional SDMX structure version; defaults to all.' } } },
    card: { name: { singular: 'dimension', plural: 'dimensions' }, title: 'Structure {{structureID}} dimensions', layout: [{ component: 'MetricRow', items: [{ label: 'Dimensions', field: 'count' }] }, { component: 'Table', rows: 'dimensions', columns: [{ header: 'Position', field: 'position' }, { header: 'ID', field: 'id' }, { header: 'Name', field: 'name' }, { header: 'Codelist', field: 'codelistID' }, { header: 'Codelist agency', field: 'codelistAgencyID' }] }] },
    async execute(args) { const agencyID = requireNonEmpty(args?.agencyID, 'agencyID'); const rawStructureID = requireNonEmpty(args?.structureID, 'structureID'); const structureID = rawStructureID.includes('@') ? rawStructureID.split('@')[0] : rawStructureID; const version = typeof args?.version === 'string' && args.version ? args.version : 'all'; const payload = await fetchDataflowStructure({ agencyID, structureID, version }); const dimensions = dimensionsFromStructure(payload); return { text: dimensions.length ? [`Key order: ${dimensions.map((d) => d.id).join('.')}`, ...dimensions.map((d) => `${d.position}. ${d.id}${d.codelistID ? ` (${d.codelistAgencyID}:${d.codelistID} v${d.codelistVersion})` : ''}`)].join('\n') : `No dimensions found in ${structureID}.`, data: { agencyID, structureID, version, count: dimensions.length, keyOrder: dimensions.map((d) => d.id).join('.'), dimensions, raw: payload }, references: [createApiReference({ id: `${agencyID}/${structureID}`, label: structureID, sourceUrl: `${BASE}/datastructure/${agencyID}/${structureID}/${version}`, quote: dimensions.map((d) => d.id).join(', '), payload })] }; }
  } satisfies ApiTool,
  oecd_get_codelist_values: {
    description: 'Fetch allowed values for one OECD SDMX codelist and optionally search them locally by id/name/description. Uses /codelist/{agencyID}/{codelistID}/{version}; version defaults to all, limit defaults to 100 and is capped at 500. Use the codelistAgencyID, codelistID, and codelistVersion reported by oecd_inspect_dataflow_structure, since a dimension codelist is often owned by a different agency (SDMX or OECD) than the datastructure.',
    parameters: { type: 'object', required: ['agencyID', 'codelistID'], properties: { agencyID: { type: 'string', description: 'SDMX agency id owning the codelist, such as OECD, SDMX, or OECD.SDD.NAD. Take it from the codelistAgencyID field of a dimension row.' }, codelistID: { type: 'string', description: 'Codelist id such as CL_AREA, CL_FREQ, or CL_TRANSACTION.' }, version: { type: 'string', description: 'Optional codelist version; defaults to all.' }, q: { type: 'string', description: 'Optional local search text over code id, name, and description. Omit to return the first codes up to limit.' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum code rows returned after local filtering. Defaults to 100; card data includes every returned code.' } } },
    card: { name: { singular: 'code', plural: 'codes' }, title: 'Codes in {{codelistID}}', layout: [{ component: 'MetricRow', items: [{ label: 'Returned', field: 'returned' }] }, { component: 'Table', rows: 'codes', columns: [{ header: 'ID', field: 'id' }, { header: 'Name', field: 'name' }, { header: 'Description', field: 'description' }] }] },
    async execute(args) { const agencyID = requireNonEmpty(args?.agencyID, 'agencyID'); const codelistID = requireNonEmpty(args?.codelistID, 'codelistID'); const version = typeof args?.version === 'string' && args.version ? args.version : 'all'; const limit = args?.limit == null ? 100 : Math.min(requirePositiveInt(args.limit, 'limit'), 500); const payload = await fetchCodelist({ agencyID, codelistID, version }); const parsed = codesFromCodelist(payload, codelistID); const q = typeof args?.q === 'string' ? args.q.toLowerCase() : ''; const sourceUrl = `${BASE}/codelist/${agencyID}/${codelistID}/${version}`; const terms = q ? searchTerms(q) : []; const matched = terms.length ? parsed.codes.filter((c) => scoreDataflowMatch([c.id, c.name, c.description].join(' '), terms) > 0) : parsed.codes; const filtered = matched.slice(0, limit); // A codelist with no match still has to cite the codelist it searched.
      const references = filtered.length ? filtered.map((c) => createApiReference({ id: `${codelistID}/${c.id}`, label: c.name || c.id, sourceUrl, quote: `${c.id}: ${c.name}`, payload: c.raw })) : [createApiReference({ id: codelistID, label: codelistID, sourceUrl, quote: `No code matched "${args?.q}" among ${parsed.codes.length} codes.`, payload: { codelistID, searched: parsed.codes.length } })]; return { text: filtered.length ? filtered.map((c) => `${c.id}: ${c.name || '(unnamed code)'}`).join('\n') : `No code matched "${args?.q ?? ''}" among ${parsed.codes.length} codes in ${codelistID}.`, data: { agencyID, codelistID, version, query: args?.q ?? '', searched: parsed.codes.length, returned: filtered.length, codes: filtered, raw: payload }, references }; }
  } satisfies ApiTool,
  oecd_fetch_observations: {
    description: 'Fetch OECD SDMX observations for a dataflow. flowRef is agencyID,dataflowID using the complete dataflow id, for example OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4. Give either a dot-separated key in structure order or a dimensions object mapping dimension ids to codes, which is safer because the key is then assembled from the live structure. A short key is expanded by matching each segment to the dimension whose codelist contains those codes, and an unresolvable key fails with the dataflow\'s real dimension order. startPeriod, endPeriod, updatedAfter, firstNObservations, and lastNObservations are sent with these exact SDMX names. Results decode REF_AREA and TIME_PERIOD into country/time/value rows sorted for over-time country comparisons such as PPP for Iceland and Sweden since 2015.',
    parameters: { type: 'object', required: ['flowRef'], properties: { flowRef: { type: 'string', description: 'SDMX flow reference agencyID,dataflowID such as OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4. Keep the whole dataflow id including any part before @; an optional third comma-separated segment pins the version.' }, key: { type: 'string', description: 'Dot-separated SDMX dimension key in structure order, for example A.ISL+SWE...PPP_B1GQ....... for DSD_NAMAIN10@DF_TABLE4. Use + inside one position for several codes, leave a position empty for all its codes, or pass "all" for every series. Shorter keys such as A.ISL+SWE.PPP_B1GQ are expanded against the live structure. Provide this or dimensions.' }, dimensions: { type: 'object', description: 'Alternative to key: an object mapping dimension ids from oecd_inspect_dataflow_structure to a code string or array of codes, for example {"FREQ":"A","REF_AREA":["ISL","SWE"],"TRANSACTION":"PPP_B1GQ"}. Omitted dimensions match all of their codes. Takes precedence over key.' }, startPeriod: { type: 'string', description: 'Optional SDMX startPeriod lower bound, for example 2015 or 2019-Q1.' }, endPeriod: { type: 'string', description: 'Optional SDMX endPeriod upper bound, for example 2023 or 2023-Q4.' }, updatedAfter: { type: 'string', description: 'Optional SDMX updatedAfter timestamp filter; use ISO datetime if needed.' }, firstNObservations: { type: 'integer', minimum: 1, description: 'Optional firstNObservations window sent exactly by name. Do not combine with lastNObservations unless intentionally asking the API to resolve both.' }, lastNObservations: { type: 'integer', minimum: 1, description: 'Optional lastNObservations window sent exactly by name; for Data Explorer LASTNPERIODS URLs use the parsed lo value.' } } },
    card: { name: { singular: 'observation', plural: 'observations' }, title: 'OECD observations for {{flowRef}} / {{key}}', layout: [{ component: 'MetricRow', items: [{ label: 'Observations', field: 'count' }] }, { component: 'Table', rows: 'observations', columns: [{ header: 'Country', field: 'country' }, { header: 'Time', field: 'timePeriod' }, { header: 'Dimensions', field: 'dimensionKey' }, { header: 'Value', field: 'value' }] }] },
    async execute(args) {
      const flowRef = requireNonEmpty(args?.flowRef, 'flowRef');
      const dimensionValues = args?.dimensions && typeof args.dimensions === 'object' && !Array.isArray(args.dimensions) ? (args.dimensions as Record<string, unknown>) : undefined;
      const originalKey = typeof args?.key === 'string' ? args.key : '';
      if (!originalKey && !dimensionValues) throw new Error('Provide either key or dimensions for oecd_fetch_observations.');
      const resolved = await resolveObservationKey(flowRef, originalKey, dimensionValues);
      const key = resolved.key;
      const payload = await fetchObservations({ flowRef, key, startPeriod: typeof args?.startPeriod === 'string' ? args.startPeriod : undefined, endPeriod: typeof args?.endPeriod === 'string' ? args.endPeriod : undefined, updatedAfter: typeof args?.updatedAfter === 'string' ? args.updatedAfter : undefined, firstNObservations: args?.firstNObservations == null ? undefined : requirePositiveInt(args.firstNObservations, 'firstNObservations'), lastNObservations: args?.lastNObservations == null ? undefined : requirePositiveInt(args.lastNObservations, 'lastNObservations') });
      const observations = sortObservationRows(observationRows(payload));
      const summary = observations.slice(0, 60).map((row) => `${row.country || row.countryCode || '?'} ${row.timePeriod}: ${row.value}`).join('\n');
      return {
        text: observations.length
          ? `Fetched ${observations.length} observations for ${flowRef}/${key}.\n${summary}${observations.length > 60 ? `\n… ${observations.length - 60} more in the card.` : ''}`
          : `Fetched 0 observations for ${flowRef}/${key}. The key is structurally valid but matched no data; widen the key or the period.`,
        data: { flowRef, key, originalKey, keyOrder: resolved.dimensions.join('.'), count: observations.length, observations, raw: payload },
        references: [createApiReference({ id: `${flowRef}/${key}`, label: `${flowRef} ${key}`, sourceUrl: `${BASE}/data/${flowRef}/${key}`, quote: `${observations.length} observations`, payload })]
      };
    }
  } satisfies ApiTool
});
