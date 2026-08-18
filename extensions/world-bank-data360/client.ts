import {
  apiGet,
  buildQuery,
  requireNonEmpty
} from '@raynard/plugin-sdk';

export const API_BASE = 'https://data360api.worldbank.org/data360';
export const SEARCH_URL = `${API_BASE}/searchv2`;
export const DATA_URL = `${API_BASE}/data`;

const SEARCH_SELECT = [
  'disaggregation_types',
  'series_description/idno',
  'series_description/name',
  'series_description/database_id',
  'series_description/database_name',
  'series_description/measurement_unit',
  'series_description/periodicity',
  'series_description/time_periods',
  'series_description/api_link'
].join(', ');

export type Data360TimePeriod = {
  start?: string | null;
  end?: string | null;
  notes?: string | null;
};

export type Data360SeriesDescription = {
  idno: string;
  name: string;
  database_id: string;
  database_name?: string | null;
  measurement_unit?: string | null;
  periodicity?: string | null;
  time_periods?: Data360TimePeriod[] | null;
  api_link?: string | null;
};

export type Data360SearchItem = {
  '@search.score'?: number;
  disaggregation_types?: string[] | null;
  series_description: Data360SeriesDescription;
};

export type Data360SearchResponse = {
  '@odata.context'?: string;
  '@odata.count'?: number;
  value: Data360SearchItem[];
};

export type SearchData360Options = {
  query: string;
  databaseId?: string;
  limit?: number;
  skip?: number;
};

export type Data360Record = {
  OBS_VALUE?: string | number | null;
  TIME_FORMAT?: string | null;
  UNIT_MULT?: string | number | null;
  COMMENT_OBS?: string | null;
  OBS_STATUS?: string | null;
  OBS_CONF?: string | null;
  AGG_METHOD?: string | null;
  DECIMALS?: string | number | null;
  COMMENT_TS?: string | null;
  DATA_SOURCE?: string | null;
  LATEST_DATA?: boolean | null;
  DATABASE_ID?: string | null;
  INDICATOR?: string | null;
  REF_AREA?: string | null;
  SEX?: string | null;
  AGE?: string | null;
  URBANISATION?: string | null;
  COMP_BREAKDOWN_1?: string | null;
  COMP_BREAKDOWN_2?: string | null;
  COMP_BREAKDOWN_3?: string | null;
  TIME_PERIOD?: string | null;
  FREQ?: string | null;
  UNIT_MEASURE?: string | null;
  UNIT_TYPE?: string | null;
  [key: string]: unknown;
};

export type Data360DataResponse = {
  count: number;
  value: Data360Record[];
};

export type Data360DataOptions = {
  databaseId: string;
  indicatorId: string;
  refArea?: string;
  sex?: string;
  age?: string;
  urbanisation?: string;
  compBreakdown1?: string;
  compBreakdown2?: string;
  compBreakdown3?: string;
  timePeriod?: string;
  frequency?: string;
  unitMeasure?: string;
  unitType?: string;
  unitMultiplier?: string;
  timePeriodFrom?: string;
  timePeriodTo?: string;
  skip?: number;
};

function requireNonNegativeInt(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return numeric;
}

function requireRange(value: unknown, label: string, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return numeric;
}

function optionalTrimmed(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    const detail = body?.message ?? body?.error;
    return typeof detail === 'string' && detail.trim() ? ` — ${detail.trim()}` : '';
  } catch {
    return '';
  }
}

/** POST /data360/searchv2 for indicator series that can subsequently be passed to /data. */
export async function searchData360Indicators(
  options: SearchData360Options
): Promise<Data360SearchResponse> {
  const query = requireNonEmpty(options.query, 'query');
  const limit = requireRange(options.limit ?? 10, 'limit', 1, 25);
  const skip = requireNonNegativeInt(options.skip ?? 0, 'skip');
  const databaseId = optionalTrimmed(options.databaseId);
  if (databaseId && !/^[A-Za-z0-9_-]+$/.test(databaseId)) {
    throw new Error('databaseId may contain only letters, numbers, underscores, and hyphens.');
  }

  const filter = databaseId
    ? `type eq 'indicator' and series_description/database_id eq '${databaseId}'`
    : `type eq 'indicator'`;
  const body = {
    count: true,
    filter,
    select: SEARCH_SELECT,
    search: query,
    top: limit,
    skip
  };

  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(
      `Data360 search request failed with HTTP ${response.status} for ${SEARCH_URL}${await responseErrorDetail(response)}`
    );
  }
  const payload = await response.json() as Data360SearchResponse;
  if (!payload || !Array.isArray(payload.value)) {
    throw new Error('Data360 search returned an unexpected response without a value array.');
  }
  return payload;
}

// Data360 honours the time range only when BOTH bounds are present: sending
// timePeriodFrom on its own is silently ignored and the full history comes back
// (verified live — from=2010 alone returned the same 6,185 rows as no filter,
// while from=2010&to=2023 returned 1,503). So a one-sided range is widened with
// an open bound at the other end rather than being sent as-is.
const OPEN_PERIOD_START = '1800';
const OPEN_PERIOD_END = '2100';

function timeRange(options: Data360DataOptions): { from?: string; to?: string } {
  const from = optionalTrimmed(options.timePeriodFrom);
  const to = optionalTrimmed(options.timePeriodTo);
  if (!from && !to) return {};
  return {
    from: from ?? OPEN_PERIOD_START,
    to: to ?? OPEN_PERIOD_END
  };
}

function dataQuery(options: Data360DataOptions): Record<string, string | number | undefined> {
  const period = timeRange(options);
  return {
    DATABASE_ID: requireNonEmpty(options.databaseId, 'databaseId'),
    INDICATOR: requireNonEmpty(options.indicatorId, 'indicatorId'),
    REF_AREA: optionalTrimmed(options.refArea),
    SEX: optionalTrimmed(options.sex),
    AGE: optionalTrimmed(options.age),
    URBANISATION: optionalTrimmed(options.urbanisation),
    COMP_BREAKDOWN_1: optionalTrimmed(options.compBreakdown1),
    COMP_BREAKDOWN_2: optionalTrimmed(options.compBreakdown2),
    COMP_BREAKDOWN_3: optionalTrimmed(options.compBreakdown3),
    TIME_PERIOD: optionalTrimmed(options.timePeriod),
    FREQ: optionalTrimmed(options.frequency),
    UNIT_MEASURE: optionalTrimmed(options.unitMeasure),
    UNIT_TYPE: optionalTrimmed(options.unitType),
    UNIT_MULT: optionalTrimmed(options.unitMultiplier),
    timePeriodFrom: period.from,
    timePeriodTo: period.to,
    skip: requireNonNegativeInt(options.skip ?? 0, 'skip')
  };
}

/** Exact source URL used for a Data360 observation request. */
export function buildData360DataUrl(options: Data360DataOptions): string {
  return `${DATA_URL}${buildQuery(dataQuery(options))}`;
}

/** GET /data360/data for a database/indicator pair returned by the search helper. */
export async function fetchData360Data(
  options: Data360DataOptions
): Promise<Data360DataResponse> {
  const query = dataQuery(options);
  const payload = await apiGet<Data360DataResponse>(DATA_URL, {
    label: 'World Bank Data360 data',
    query
  });
  if (!payload || !Array.isArray(payload.value) || !Number.isFinite(Number(payload.count))) {
    throw new Error('Data360 data returned an unexpected response without count and value fields.');
  }
  return {
    count: Number(payload.count),
    value: payload.value
  };
}
