import {
  createApiReference,
  defineCard,
  defineTools,
  requireNonEmpty,
  type ToolResult
} from '@raynard/plugin-sdk';
import {
  SEARCH_URL,
  buildData360DataUrl,
  fetchData360Data,
  searchData360Indicators,
  type Data360DataOptions,
  type Data360Record,
  type Data360SearchItem
} from './client.ts';

function boundedInt(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return numeric;
}

function nonNegativeInt(value: unknown, fallback: number, label: string): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return numeric;
}

function optionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

function coverage(item: Data360SearchItem): string {
  const periods = item.series_description.time_periods ?? [];
  return periods
    .map((period) => {
      const start = period.start ?? '?';
      const end = period.end ?? start;
      return start === end ? start : `${start}–${end}`;
    })
    .join(', ') || 'Not stated';
}

function searchResultLine(item: Data360SearchItem, index: number): string {
  const series = item.series_description;
  const unit = series.measurement_unit || 'unit not stated';
  const periodicity = series.periodicity || 'frequency not stated';
  return (
    `${index + 1}. ${series.name} — databaseId=${series.database_id}, ` +
    `indicatorId=${series.idno}; ${unit}; ${periodicity}; coverage ${coverage(item)}`
  );
}

function observationSort(a: Data360Record, b: Data360Record): number {
  const byPeriod = String(a.TIME_PERIOD ?? '').localeCompare(
    String(b.TIME_PERIOD ?? ''),
    undefined,
    { numeric: true }
  );
  if (byPeriod !== 0) return byPeriod;
  return String(a.REF_AREA ?? '').localeCompare(String(b.REF_AREA ?? ''));
}

function observationRow(record: Data360Record) {
  return {
    period: String(record.TIME_PERIOD ?? '—'),
    area: String(record.REF_AREA ?? '—'),
    value: String(record.OBS_VALUE ?? '—'),
    unit: String(record.UNIT_MEASURE ?? record.UNIT_TYPE ?? '—'),
    frequency: String(record.FREQ ?? '—'),
    sex: String(record.SEX ?? '—'),
    age: String(record.AGE ?? '—'),
    urbanisation: String(record.URBANISATION ?? '—'),
    latest: record.LATEST_DATA === true ? 'Yes' : 'No'
  };
}

function observationLine(record: Data360Record, index: number): string {
  const unit = record.UNIT_MEASURE ?? record.UNIT_TYPE ?? 'unit not stated';
  const dimensions = [
    record.SEX && record.SEX !== '_T' ? `sex ${record.SEX}` : '',
    record.AGE && record.AGE !== '_T' ? `age ${record.AGE}` : '',
    record.URBANISATION && record.URBANISATION !== '_T'
      ? `urbanisation ${record.URBANISATION}`
      : ''
  ].filter(Boolean);
  return (
    `${index + 1}. ${record.TIME_PERIOD ?? 'unknown period'} | ` +
    `${record.REF_AREA ?? 'all areas'} | ${record.OBS_VALUE ?? 'null'} ${unit}` +
    (dimensions.length ? ` | ${dimensions.join(', ')}` : '')
  );
}

const searchCard = defineCard({
  name: { singular: 'indicator', plural: 'indicators' },
  title: 'Data360 indicator search — {{query}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Total matches', field: 'total' },
        { label: 'Shown', field: 'shown' },
        { label: 'Offset', field: 'skip' }
      ]
    },
    {
      component: 'Table',
      columns: [
        { header: 'Indicator', field: 'name' },
        { header: 'Database ID', field: 'databaseId' },
        { header: 'Indicator ID', field: 'indicatorId' },
        { header: 'Unit', field: 'unit' },
        { header: 'Coverage', field: 'coverage' },
        { header: 'Breakdowns', field: 'disaggregations' }
      ],
      rows: 'rows'
    }
  ]
});

const dataCard = defineCard({
  name: { singular: 'observation', plural: 'observations' },
  title: 'Data360 observations — {{indicatorId}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Total matches', field: 'total' },
        { label: 'API page rows', field: 'returned' },
        { label: 'Filterable', field: 'stored' }
      ]
    },
    {
      component: 'Table',
      columns: [
        { header: 'Period', field: 'period' },
        { header: 'Area', field: 'area' },
        { header: 'Value', field: 'value' },
        { header: 'Unit', field: 'unit' },
        { header: 'Frequency', field: 'frequency' },
        { header: 'Sex', field: 'sex' },
        { header: 'Age', field: 'age' },
        { header: 'Latest', field: 'latest' }
      ],
      rows: 'rows'
    }
  ]
});

export const tools = defineTools({
  data360_search_indicators: {
    description:
      'Search the World Bank Data360 catalog for indicator data series and discover the exact databaseId and indicatorId required by data360_get_data. Use this first for topic, metric, or dataset questions; do not guess IDs. Returns indicator names, units, coverage, database names, available disaggregation dimensions, relevance, and each series data endpoint. Optionally restrict results to one known database ID and page with skip.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language indicator search, such as "population total" or "female labor force participation".'
        },
        databaseId: {
          type: 'string',
          description: 'Optional exact Data360 database ID, such as WB_WDI, to restrict the indicator search.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum indicator matches to return (1-25, default 10).',
          minimum: 1,
          maximum: 25,
          default: 10
        },
        skip: {
          type: 'integer',
          description: 'Number of search matches to skip for pagination (default 0).',
          minimum: 0,
          default: 0
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    card: searchCard,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = requireNonEmpty(args.query, 'query');
      const databaseId = optionalString(args.databaseId);
      const limit = boundedInt(args.limit, 10, 'limit', 1, 25);
      const skip = nonNegativeInt(args.skip, 0, 'skip');
      const payload = await searchData360Indicators({ query, databaseId, limit, skip });
      const items = payload.value;
      const total = Number(payload['@odata.count'] ?? items.length);
      const rows = items.map((item) => ({
        name: item.series_description.name,
        databaseId: item.series_description.database_id,
        indicatorId: item.series_description.idno,
        database: item.series_description.database_name ?? 'Not stated',
        unit: item.series_description.measurement_unit ?? 'Not stated',
        frequency: item.series_description.periodicity ?? 'Not stated',
        coverage: coverage(item),
        disaggregations: item.disaggregation_types?.join(', ') || 'None stated',
        score: item['@search.score'] ?? null,
        apiUrl: item.series_description.api_link ?? ''
      }));

      const references = items.length
        ? items.map((item) => {
            const series = item.series_description;
            const sourceUrl = series.api_link || buildData360DataUrl({
              databaseId: series.database_id,
              indicatorId: series.idno
            });
            return createApiReference({
              id: `${series.database_id}:${series.idno}`,
              label: `${series.name} (${series.idno})`,
              sourceUrl,
              quote: `Data360 search identified ${series.idno} in ${series.database_id}; ${series.measurement_unit ?? 'unit not stated'}, coverage ${coverage(item)}.`,
              payload: item
            });
          })
        : [
            createApiReference({
              id: `search:${query}`,
              label: `Data360 search: ${query}`,
              sourceUrl: SEARCH_URL,
              quote: `The Data360 indicator search returned no matches at offset ${skip}.`,
              payload: { query, databaseId, skip, count: total, value: [] }
            })
          ];

      return {
        text: items.length
          ? [
              `Found ${items.length} Data360 indicator${items.length === 1 ? '' : 's'} (${total} total matches). Use the databaseId and indicatorId with data360_get_data:`,
              ...items.map(searchResultLine)
            ].join('\n')
          : `No Data360 indicators matched "${query}" at offset ${skip}${databaseId ? ` in ${databaseId}` : ''}.`,
        references,
        data: {
          query,
          databaseId: databaseId ?? 'All databases',
          total,
          shown: rows.length,
          skip,
          rows
        }
      };
    }
  },

  data360_get_data: {
    description:
      'Fetch actual World Bank Data360 observations from GET /data360/data using an exact databaseId and indicatorId returned by data360_search_indicators. Use after search for values, time series, country/economy comparisons, or dimension-specific observations. Supports area, time, sex, age, urbanisation, frequency, unit, and three indicator-specific breakdown filters. Observations are sorted by period, then by area. The API returns at most 1,000 rows per call; use skip for later pages and displayLimit to bound the model-visible text only — every fetched row stays in the result card.',
    parameters: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'Exact DATABASE_ID from data360_search_indicators, for example WB_WDI.'
        },
        indicatorId: {
          type: 'string',
          description: 'Exact INDICATOR/idno from data360_search_indicators, for example WB_WDI_SP_POP_TOTL.'
        },
        refArea: {
          type: 'string',
          description: 'Optional REF_AREA code such as KEN, USA, or a World Bank aggregate code.'
        },
        sex: { type: 'string', description: 'Optional SEX code supported by the selected indicator, such as F or M.' },
        age: { type: 'string', description: 'Optional AGE code supported by the selected indicator.' },
        urbanisation: { type: 'string', description: 'Optional URBANISATION code supported by the indicator, such as URB or RUR.' },
        compBreakdown1: { type: 'string', description: 'Optional indicator-specific COMP_BREAKDOWN_1 code.' },
        compBreakdown2: { type: 'string', description: 'Optional indicator-specific COMP_BREAKDOWN_2 code.' },
        compBreakdown3: { type: 'string', description: 'Optional indicator-specific COMP_BREAKDOWN_3 code.' },
        timePeriod: { type: 'string', description: 'Optional exact TIME_PERIOD value.' },
        timePeriodFrom: { type: 'string', description: 'Optional inclusive start period, commonly a year such as 2010. Supplying only one end of the range is fine: the API ignores a one-sided range, so this tool fills the missing bound for you.' },
        timePeriodTo: { type: 'string', description: 'Optional inclusive end period, commonly a year such as 2024. Supplying only one end of the range is fine: the API ignores a one-sided range, so this tool fills the missing bound for you.' },
        frequency: { type: 'string', description: 'Optional FREQ code, such as A for annual.' },
        unitMeasure: { type: 'string', description: 'Optional UNIT_MEASURE code supported by the indicator.' },
        unitType: { type: 'string', description: 'Optional UNIT_TYPE code supported by the indicator.' },
        unitMultiplier: { type: 'string', description: 'Optional UNIT_MULT value.' },
        skip: {
          type: 'integer',
          description: 'Rows to skip for API pagination. Each API call returns at most 1,000 observations (default 0).',
          minimum: 0,
          default: 0
        },
        displayLimit: {
          type: 'integer',
          description: 'Maximum observations to include in model-visible text from this API page (1-100, default 50). All fetched page rows remain available in the filterable card table.',
          minimum: 1,
          maximum: 100,
          default: 50
        }
      },
      required: ['databaseId', 'indicatorId'],
      additionalProperties: false
    },
    card: dataCard,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const options: Data360DataOptions = {
        databaseId: requireNonEmpty(args.databaseId, 'databaseId'),
        indicatorId: requireNonEmpty(args.indicatorId, 'indicatorId'),
        refArea: optionalString(args.refArea),
        sex: optionalString(args.sex),
        age: optionalString(args.age),
        urbanisation: optionalString(args.urbanisation),
        compBreakdown1: optionalString(args.compBreakdown1),
        compBreakdown2: optionalString(args.compBreakdown2),
        compBreakdown3: optionalString(args.compBreakdown3),
        timePeriod: optionalString(args.timePeriod),
        timePeriodFrom: optionalString(args.timePeriodFrom),
        timePeriodTo: optionalString(args.timePeriodTo),
        frequency: optionalString(args.frequency),
        unitMeasure: optionalString(args.unitMeasure),
        unitType: optionalString(args.unitType),
        unitMultiplier: optionalString(args.unitMultiplier),
        skip: nonNegativeInt(args.skip, 0, 'skip')
      };
      const displayLimit = boundedInt(args.displayLimit, 50, 'displayLimit', 1, 100);
      const payload = await fetchData360Data(options);
      const sorted = [...payload.value].sort(observationSort);
      const shownRecords = sorted.slice(0, displayLimit);
      const rows = sorted.map(observationRow);
      const sourceUrl = buildData360DataUrl(options);

      return {
        text: shownRecords.length
          ? [
              `Data360 returned ${payload.value.length} observation${payload.value.length === 1 ? '' : 's'} on this API page (${payload.count} total matches); showing ${shownRecords.length} for ${options.indicatorId}:`,
              ...shownRecords.map(observationLine),
              ...(payload.value.length > shownRecords.length
                ? [`${payload.value.length - shownRecords.length} additional row(s) from this page were omitted; raise displayLimit to show more.`]
                : []),
              ...(payload.count > payload.value.length + Number(options.skip ?? 0)
                ? [`More API pages are available; call again with skip=${Number(options.skip ?? 0) + payload.value.length}.`]
                : [])
            ].join('\n')
          : `No observations matched databaseId=${options.databaseId}, indicatorId=${options.indicatorId}, and the supplied filters.`,
        references: [
          createApiReference({
            id: `${options.databaseId}:${options.indicatorId}:${options.skip ?? 0}`,
            label: `${options.indicatorId} Data360 observations`,
            sourceUrl,
            quote: `The Data360 data endpoint returned ${payload.value.length} rows on this page from ${payload.count} total matching observations.`,
            payload: {
              count: payload.count,
              skip: options.skip ?? 0,
              value: shownRecords
            }
          })
        ],
        data: {
          databaseId: options.databaseId,
          indicatorId: options.indicatorId,
          total: payload.count,
          returned: payload.value.length,
          shown: shownRecords.length,
          stored: rows.length,
          skip: options.skip ?? 0,
          rows
        }
      };
    }
  }
});
