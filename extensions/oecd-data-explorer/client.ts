import { apiGet } from '@raynard/plugin-sdk';

export const BASE = 'https://sdmx.oecd.org/public/rest';

// Header spellings are the ones OECD documents in "OECD Data API documentation"
// (22 July 2024). SDMX-JSON v1 is the only JSON structure format offered, which
// is why asking a structure endpoint for version=2.0 returns HTTP 406.
export const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json; charset=utf-8; version=1.0';
export const DATA_ACCEPT = 'application/vnd.sdmx.data+json; charset=utf-8; version=2';
// "We strongly recommend using this feature systematically to minimise the usage
// of the internet band width and increase the download speed." Structure
// payloads compress roughly 5:1, and smaller responses are less likely to trip
// the gateway's throttling.
const ACCEPT_ENCODING = 'gzip, deflate, br';
// Node's fetch sends `Accept-Language: *` when the header is unset, and the
// OECD gateway fails to parse that wildcard: it answers HTTP 500 with the body
// "languageTag1". curl sends no Accept-Language at all, which is why the same
// request succeeds from a shell and fails from the plugin. Sending a real
// language tag — the doc's documented mechanism — makes it deterministic.
const ACCEPT_LANGUAGE = 'en';
function structureHeaders() {
  return { Accept: STRUCTURE_ACCEPT, 'Accept-Encoding': ACCEPT_ENCODING, 'Accept-Language': ACCEPT_LANGUAGE };
}

export type LocalisedText = string | { value?: string; locale?: string } | Record<string, unknown>;
export type SdmxDataflow = {
  id: string;
  agencyID?: string;
  version?: string;
  name?: LocalisedText;
  description?: LocalisedText;
  [key: string]: unknown;
};
export type DataflowsResponse = { data?: { dataflows?: SdmxDataflow[] }; [key: string]: unknown };

export type StructureResponse = Record<string, unknown>;
export type CodelistResponse = Record<string, unknown>;
export type DataResponse = Record<string, unknown>;

export type FetchDataflowsOptions = { agencyID?: string; resourceID?: string; version?: string };
export type FetchDataflowReferencesOptions = {
  agencyID: string;
  dataflowID: string;
  version?: string;
  references?: string;
  detail?: string;
};
export type FetchStructureOptions = { agencyID: string; structureID: string; version?: string; references?: string; detail?: string };
export type FetchCodelistOptions = { agencyID: string; codelistID: string; version?: string };
export type FetchObservationsOptions = {
  flowRef: string;
  key: string;
  startPeriod?: string;
  endPeriod?: string;
  updatedAfter?: string;
  firstNObservations?: number;
  lastNObservations?: number;
};

// The gateway throttles bursts with 429 and intermittent 5xx, and resolving one
// key can need several structure calls in a row, so a transient refusal must not
// look like "this codelist has no codes".
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];
export async function withRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = RETRY_STATUSES.some((status) => message.includes(`HTTP ${status}`));
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt + Math.random() * 250));
    }
  }
  throw lastError;
}

export function fetchDataflows(options: FetchDataflowsOptions = {}) {
  const agencyID = options.agencyID ?? 'all';
  const resourceID = options.resourceID ?? 'all';
  const version = options.version ?? 'all';
  return withRetry(() => apiGet<DataflowsResponse>(`${BASE}/dataflow/${agencyID}/${resourceID}/${version}`, {
    query: { detail: 'allstubs' },
    headers: structureHeaders(),
    label: 'OECD dataflows'
  }));
}

// Lists a dataflow's available versions in ~2 KB. detail=referencepartial is
// answered with HTTP 501 unless the version is concrete, so this runs first.
export function fetchDataflowVersions(options: { agencyID: string; dataflowID: string }) {
  return withRetry(() => apiGet<StructureResponse>(
    `${BASE}/dataflow/${options.agencyID}/${options.dataflowID}/all`,
    { headers: structureHeaders(), label: 'OECD dataflow versions' }
  ));
}

// The documented structure query is
// /dataflow/{agency}/{id}/{version}?references=all&detail=referencepartial.
// referencepartial is what makes it affordable: it returns only the codes the
// dataflow actually serves, so one 40 KB call yields both the dimension order
// and every codelist needed to resolve a key. references=all on its own returns
// the unconstrained codelists — 1.2 MB for DSD_NAMAIN10 — and is what the
// gateway is most likely to throttle or fail. Pass a concrete version.
export function fetchDataflowReferences(options: FetchDataflowReferencesOptions) {
  return withRetry(() => apiGet<StructureResponse>(
    `${BASE}/dataflow/${options.agencyID}/${options.dataflowID}/${options.version ?? 'all'}`,
    {
      query: { references: options.references ?? 'all', detail: options.detail ?? 'referencepartial' },
      headers: structureHeaders(),
      label: 'OECD dataflow structure'
    }
  ));
}

// No references by default. The dimension list already names each codelist by
// URN, so listing dimensions needs 1.9 KB rather than the 276 KB references=all
// returns — and detail=referencepartial is answered here with HTTP 501, since
// OECD documents it only for the /dataflow/ structure query.
export function fetchDataflowStructure(options: FetchStructureOptions) {
  return withRetry(() => apiGet<StructureResponse>(`${BASE}/datastructure/${options.agencyID}/${options.structureID}/${options.version ?? 'all'}`, {
    query: { references: options.references, detail: options.detail },
    headers: structureHeaders(),
    label: 'OECD datastructure'
  }));
}

// detail=allstubs is deliberately not sent: stubs omit the codes, which are the
// only reason to fetch a codelist.
export function fetchCodelist(options: FetchCodelistOptions) {
  return withRetry(() => apiGet<CodelistResponse>(`${BASE}/codelist/${options.agencyID}/${options.codelistID}/${options.version ?? 'all'}`, {
    headers: structureHeaders(),
    label: 'OECD codelist'
  }));
}

export function fetchObservations(options: FetchObservationsOptions) {
  return withRetry(() => apiGet<DataResponse>(`${BASE}/data/${options.flowRef}/${options.key}`, {
    query: {
      startPeriod: options.startPeriod,
      endPeriod: options.endPeriod,
      updatedAfter: options.updatedAfter,
      firstNObservations: options.firstNObservations,
      lastNObservations: options.lastNObservations,
      dimensionAtObservation: 'AllDimensions'
    },
    headers: { Accept: DATA_ACCEPT, 'Accept-Encoding': ACCEPT_ENCODING, 'Accept-Language': ACCEPT_LANGUAGE },
    label: 'OECD observations'
  }));
}
