import { apiGet } from '@raynard/plugin-sdk';

export const BASE_URL = 'https://api.imf.org/external/sdmx/3.0';

// The gateway also serves plain `application/json`, but asking for the SDMX
// representation by name states the contract this parser is written against.
// Pin the full `2.0.0`: `;version=2.0` is rejected with an explicit 400.
const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=2.0.0';
const DATA_ACCEPT = 'application/vnd.sdmx.data+json;version=2.0.0';

// `+` is the latest stable version and `*` is every version. (`~` and `latest`
// are accepted here too; `+` is the SDMX 3.0 spelling.)
export const LATEST_VERSION = '+';

export type SdmxName = string;

export type SdmxAnnotation = {
  id?: string;
  title?: string;
  type?: string;
  value?: string;
};

export type SdmxDataflow = {
  id: string;
  name: SdmxName;
  description?: string;
  version: string;
  agencyID: string;
  structure?: string;
  annotations?: SdmxAnnotation[];
};

export type SdmxDimension = {
  id: string;
  position: number;
  conceptIdentity?: string;
  localRepresentation?: { enumeration?: string };
};

export type SdmxDataStructure = {
  id: string;
  name: SdmxName;
  version: string;
  agencyID: string;
  dataStructureComponents?: {
    dimensionList?: { dimensions?: SdmxDimension[] };
    attributeList?: { attributes?: Array<{ id: string }> };
    measureList?: { measures?: Array<{ id: string }> };
  };
};

export type SdmxConcept = {
  id: string;
  name?: SdmxName;
  coreRepresentation?: { enumeration?: string };
};

export type SdmxConceptScheme = {
  id: string;
  agencyID: string;
  version: string;
  concepts?: SdmxConcept[];
};

export type SdmxCode = {
  id: string;
  name?: SdmxName;
  description?: string;
  parent?: string;
};

export type SdmxCodelist = {
  id: string;
  name?: SdmxName;
  version: string;
  agencyID: string;
  codes?: SdmxCode[];
};

export type SdmxStructureMessage = {
  data?: {
    dataflows?: SdmxDataflow[];
    dataStructures?: SdmxDataStructure[];
    conceptSchemes?: SdmxConceptScheme[];
    codelists?: SdmxCodelist[];
    dataConstraints?: SdmxDataConstraint[];
  };
};

export type SdmxDataConstraint = {
  id: string;
  name?: SdmxName;
  agencyID: string;
  version: string;
  annotations?: SdmxAnnotation[];
  cubeRegions?: Array<{
    components?: Array<{ id: string }>;
    keyValues?: Array<{ id: string; values?: string[] }>;
  }>;
};

export type SdmxDimensionValue = { id?: string; value?: string; name?: SdmxName };

export type SdmxDataMessage = {
  data?: {
    dataSets?: Array<{
      series?: Record<string, { observations?: Record<string, unknown[]> }>;
      observations?: Record<string, unknown[]>;
    }>;
    structures?: Array<{
      dimensions?: {
        series?: Array<{ id: string; values?: SdmxDimensionValue[] }>;
        observation?: Array<{ id: string; values?: SdmxDimensionValue[] }>;
      };
    }>;
  };
};

function structureGet<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  return apiGet<T>(`${BASE_URL}${path}`, {
    query,
    headers: { Accept: STRUCTURE_ACCEPT },
    label: 'IMF SDMX structure'
  });
}

/**
 * Parses `urn:sdmx:org.sdmx.infomodel.<package>.<Class>=AGENCY:ID(VERSION)`.
 * Versions inside urns can carry a wildcard patch such as `18.0+.0`, which is
 * not a fetchable version, so callers normally re-request with `+`.
 */
export function parseUrn(urn: string | undefined): { agencyID: string; id: string; version: string } | null {
  if (!urn) return null;
  const match = /=([^:]+):([^(]+)\(([^)]+)\)/.exec(urn);
  if (!match) return null;
  return { agencyID: match[1], id: match[2], version: match[3] };
}

/** Latest version of every dataflow the IMF registry publishes. */
export async function fetchDataflows(): Promise<SdmxDataflow[]> {
  const message = await structureGet<SdmxStructureMessage>(
    `/structure/dataflow/*/*/${LATEST_VERSION}`
  );
  return message.data?.dataflows ?? [];
}

/** One dataflow plus the data structure definition it points at. */
export async function fetchDataflowWithStructure(
  agencyID: string,
  dataflowID: string,
  version: string = LATEST_VERSION
): Promise<{ dataflow: SdmxDataflow | null; dataStructure: SdmxDataStructure | null }> {
  const message = await structureGet<SdmxStructureMessage>(
    `/structure/dataflow/${encodeURIComponent(agencyID)}/${encodeURIComponent(dataflowID)}/${version}`,
    { references: 'children' }
  );
  return {
    dataflow: message.data?.dataflows?.[0] ?? null,
    dataStructure: message.data?.dataStructures?.[0] ?? null
  };
}

/**
 * The concept schemes behind a data structure. IMF dimensions carry no local
 * representation, so the codelist for a dimension is only reachable through
 * its concept's `coreRepresentation.enumeration`.
 */
export async function fetchDataStructureConcepts(
  agencyID: string,
  dataStructureID: string,
  version: string = LATEST_VERSION
): Promise<SdmxConceptScheme[]> {
  const message = await structureGet<SdmxStructureMessage>(
    `/structure/datastructure/${encodeURIComponent(agencyID)}/${encodeURIComponent(dataStructureID)}/${version}`,
    { references: 'children' }
  );
  return message.data?.conceptSchemes ?? [];
}

export async function fetchCodelist(
  agencyID: string,
  codelistID: string,
  version: string = LATEST_VERSION
): Promise<SdmxCodelist | null> {
  const message = await structureGet<SdmxStructureMessage>(
    `/structure/codelist/${encodeURIComponent(agencyID)}/${encodeURIComponent(codelistID)}/${version}`
  );
  return message.data?.codelists?.[0] ?? null;
}

export async function fetchAvailability(
  agencyID: string,
  dataflowID: string,
  version: string = LATEST_VERSION,
  key = '*',
  componentID = '*'
): Promise<SdmxDataConstraint | null> {
  const message = await structureGet<SdmxStructureMessage>(
    `/availability/dataflow/${encodeURIComponent(agencyID)}/${encodeURIComponent(dataflowID)}/${version}/${key}/${componentID}`
  );
  return message.data?.dataConstraints?.[0] ?? null;
}

/**
 * SDMX 3.0 time operators want a full date. `ge:2020` is silently ignored by
 * this gateway and the whole series history comes back instead.
 */
export function buildTimeFilter(startPeriod?: string, endPeriod?: string): string | undefined {
  const parts: string[] = [];
  if (startPeriod) parts.push(`ge:${expandPeriod(startPeriod, 'start')}`);
  if (endPeriod) parts.push(`le:${expandPeriod(endPeriod, 'end')}`);
  return parts.length ? parts.join('+') : undefined;
}

function expandPeriod(period: string, edge: 'start' | 'end'): string {
  const trimmed = period.trim();
  if (/^\d{4}$/.test(trimmed)) return edge === 'start' ? `${trimmed}-01-01` : `${trimmed}-12-31`;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return edge === 'start' ? `${trimmed}-01` : `${trimmed}-28`;
  const quarter = /^(\d{4})-?Q([1-4])$/i.exec(trimmed);
  if (quarter) {
    const startMonth = (Number(quarter[2]) - 1) * 3 + 1;
    return edge === 'start'
      ? `${quarter[1]}-${String(startMonth).padStart(2, '0')}-01`
      : `${quarter[1]}-${String(startMonth + 2).padStart(2, '0')}-28`;
  }
  return trimmed;
}

export type DataQuery = {
  agencyID: string;
  dataflowID: string;
  version?: string;
  filters?: Record<string, string>;
  startPeriod?: string;
  endPeriod?: string;
};

export function buildDataUrl(query: DataQuery): string {
  const version = query.version || LATEST_VERSION;
  // The key path segment is accepted but not applied by this gateway: a keyed
  // request answers 200 with an empty dataSet. Every dimension filter must go
  // through `c[DIMENSION]=` instead, with `*` standing in for the key.
  const path = `${BASE_URL}/data/dataflow/${encodeURIComponent(query.agencyID)}/${encodeURIComponent(query.dataflowID)}/${version}/*`;
  const search = new URLSearchParams();
  for (const [dimension, value] of Object.entries(query.filters ?? {})) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    search.set(`c[${dimension}]`, String(value).trim());
  }
  const timeFilter = buildTimeFilter(query.startPeriod, query.endPeriod);
  if (timeFilter) search.set('c[TIME_PERIOD]', timeFilter);
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function fetchData(query: DataQuery): Promise<SdmxDataMessage> {
  return apiGet<SdmxDataMessage>(buildDataUrl(query), {
    headers: { Accept: DATA_ACCEPT },
    label: 'IMF SDMX data'
  });
}

export type SeriesObservation = {
  series: string;
  period: string;
  value: number | null;
};

export type ParsedSeries = {
  key: string;
  dimensions: Record<string, string>;
  observations: Array<{ period: string; value: number | null }>;
};

/**
 * Flattens an SDMX-JSON 2.0 data message. Series keys are colon-joined indexes
 * into `structures[0].dimensions.series[i].values`, observation keys index
 * into the observation dimension (TIME_PERIOD), whose entries use `value`
 * rather than `id`.
 */
export function parseDataMessage(message: SdmxDataMessage): ParsedSeries[] {
  const structure = message.data?.structures?.[0];
  const seriesDimensions = structure?.dimensions?.series ?? [];
  const observationDimensions = structure?.dimensions?.observation ?? [];
  const timeValues =
    observationDimensions.find((dimension) => dimension.id === 'TIME_PERIOD')?.values ?? [];
  const dataSet = message.data?.dataSets?.[0];
  const parsed: ParsedSeries[] = [];

  for (const [seriesKey, series] of Object.entries(dataSet?.series ?? {})) {
    const indexes = seriesKey.split(':');
    const dimensions: Record<string, string> = {};
    seriesDimensions.forEach((dimension, position) => {
      const value = dimension.values?.[Number(indexes[position])];
      if (value?.id !== undefined) dimensions[dimension.id] = value.id;
      else if (value?.value !== undefined) dimensions[dimension.id] = value.value;
    });

    const observations: Array<{ period: string; value: number | null }> = [];
    for (const [observationIndex, cell] of Object.entries(series.observations ?? {})) {
      const timeValue = timeValues[Number(observationIndex)];
      const period = timeValue?.value ?? timeValue?.id ?? observationIndex;
      const raw = Array.isArray(cell) ? cell[0] : cell;
      const numeric = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      observations.push({
        period,
        value: numeric !== null && Number.isFinite(numeric) ? numeric : null
      });
    }
    observations.sort((a, b) => a.period.localeCompare(b.period));

    parsed.push({
      key: Object.values(dimensions).join('.') || seriesKey,
      dimensions,
      observations
    });
  }

  return parsed;
}
