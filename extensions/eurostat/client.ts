import {
  apiGet,
  buildQuery,
  requireNonEmpty
} from '@raynard/plugin-sdk';

export const DATAFLOW_BASE_URL =
  'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT';
export const DATAFLOW_CATALOGUE_URL =
  `${DATAFLOW_BASE_URL}/all/latest?format=JSON&detail=allstubs`;
export const STATISTICS_BASE_URL =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

export type EurostatAnnotation = {
  type?: string;
  title?: string;
  text?: string;
  date?: string;
  href?: string;
};

export type EurostatDataflow = {
  class?: string;
  label?: string;
  extension: {
    lang?: string;
    id: string;
    agencyId?: string;
    version?: string;
    datastructure?: { id?: string; agencyId?: string; version?: string };
    annotation?: EurostatAnnotation[];
  };
};

export type EurostatCatalogue = {
  version?: string;
  class?: string;
  updated?: string;
  link: { item: EurostatDataflow[] };
};

export type JsonStatCategory = {
  index?: Record<string, number> | string[];
  label?: Record<string, string>;
};

export type JsonStatDimension = {
  label?: string;
  category?: JsonStatCategory;
};

export type JsonStatDataset = {
  version?: string;
  class?: string;
  label?: string;
  source?: string;
  updated?: string;
  id: string[];
  size: number[];
  dimension: Record<string, JsonStatDimension>;
  value: Array<number | string | null> | Record<string, number | string | null>;
  status?: Array<string | null> | Record<string, string | null>;
};

export type DimensionFilter = {
  dimension: string;
  value: string;
};

export type StatisticsOptions = {
  datasetCode: string;
  language?: 'en' | 'de' | 'fr';
  filters?: DimensionFilter[];
  geoLevel?: 'aggregate' | 'country' | 'nuts1' | 'nuts2' | 'nuts3' | 'city';
  lastTimePeriod?: number;
  sinceTimePeriod?: string;
  untilTimePeriod?: string;
};

export function normalizeDatasetCode(value: unknown): string {
  const code = requireNonEmpty(value, 'datasetCode').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(code)) {
    throw new Error(
      'datasetCode may contain only letters, numbers, underscores, dots, and hyphens.'
    );
  }
  return code;
}

function languageCode(value: unknown): 'EN' | 'DE' | 'FR' {
  const language = String(value ?? 'en').trim().toUpperCase();
  if (language !== 'EN' && language !== 'DE' && language !== 'FR') {
    throw new Error('language must be EN, DE, or FR.');
  }
  return language;
}

function validateFilters(value: unknown): DimensionFilter[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 24) {
    throw new Error('filters must be an array with at most 24 entries.');
  }
  return value.map((entry) => {
    const dimension = requireNonEmpty(entry?.dimension, 'dimension');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(dimension)) {
      throw new Error('dimension may contain only letters, numbers, and underscores.');
    }
    const filterValue = requireNonEmpty(entry?.value, 'filter value');
    if (filterValue.length > 200) {
      throw new Error('filter value must be at most 200 characters.');
    }
    return { dimension, value: filterValue };
  });
}

function optionalPeriod(value: unknown, label: string): string | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const period = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(period)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return period;
}

function boundedLastPeriod(value: unknown): number | undefined {
  if (value == null) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('lastTimePeriod must be an integer between 1 and 100.');
  }
  return count;
}

export function buildStatisticsUrl(options: StatisticsOptions): string {
  const datasetCode = normalizeDatasetCode(options.datasetCode);
  const filters = validateFilters(options.filters);
  const sinceTimePeriod = optionalPeriod(options.sinceTimePeriod, 'sinceTimePeriod');
  const untilTimePeriod = optionalPeriod(options.untilTimePeriod, 'untilTimePeriod');
  const suppliedLastTimePeriod = boundedLastPeriod(options.lastTimePeriod);
  const hasTimeFilter = filters.some(({ dimension }) =>
    ['time', 'time_period'].includes(dimension.toLowerCase())
  );
  if (suppliedLastTimePeriod != null && (sinceTimePeriod || untilTimePeriod || hasTimeFilter)) {
    throw new Error(
      'lastTimePeriod cannot be combined with a time filter, sinceTimePeriod, or untilTimePeriod.'
    );
  }
  if (hasTimeFilter && (sinceTimePeriod || untilTimePeriod)) {
    throw new Error(
      'A time dimension filter cannot be combined with sinceTimePeriod or untilTimePeriod.'
    );
  }
  const lastTimePeriod =
    suppliedLastTimePeriod ?? (sinceTimePeriod || untilTimePeriod || hasTimeFilter ? undefined : 1);
  const query = buildQuery({
    format: 'JSON',
    lang: languageCode(options.language),
    geoLevel: options.geoLevel,
    lastTimePeriod,
    sinceTimePeriod,
    untilTimePeriod
  });
  const url = new URL(`${STATISTICS_BASE_URL}/${datasetCode}${query}`);
  for (const filter of filters) {
    url.searchParams.append(filter.dimension, filter.value);
  }
  return url.toString();
}

function assertCatalogue(payload: EurostatCatalogue): EurostatCatalogue {
  if (!payload || !payload.link || !Array.isArray(payload.link.item)) {
    throw new Error('Eurostat dataflow catalogue returned an unexpected response.');
  }
  return payload;
}

function assertDataflow(payload: EurostatDataflow): EurostatDataflow {
  if (!payload || !payload.extension || !payload.extension.id) {
    throw new Error('Eurostat dataset metadata returned an unexpected response.');
  }
  return payload;
}

function assertJsonStat(payload: JsonStatDataset): JsonStatDataset {
  if (
    !payload ||
    payload.class !== 'dataset' ||
    !Array.isArray(payload.id) ||
    !Array.isArray(payload.size) ||
    !payload.dimension ||
    payload.value == null
  ) {
    throw new Error('Eurostat Statistics API returned an unexpected JSON-stat response.');
  }
  return payload;
}

export async function fetchDatasetCatalogue(): Promise<EurostatCatalogue> {
  return assertCatalogue(await apiGet<EurostatCatalogue>(DATAFLOW_CATALOGUE_URL));
}

export async function fetchDatasetMetadata(datasetCode: string): Promise<EurostatDataflow> {
  const code = normalizeDatasetCode(datasetCode);
  return assertDataflow(
    await apiGet<EurostatDataflow>(`${DATAFLOW_BASE_URL}/${code}/latest`, {
      query: { format: 'JSON' }
    })
  );
}

export async function fetchStatisticsData(options: StatisticsOptions): Promise<JsonStatDataset> {
  return assertJsonStat(await apiGet<JsonStatDataset>(buildStatisticsUrl(options)));
}
