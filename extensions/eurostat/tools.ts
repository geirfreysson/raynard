import {
  createApiReference,
  defineCard,
  defineTools,
  requireNonEmpty,
  type ToolResult
} from '@raynard/plugin-sdk';
import {
  DATAFLOW_BASE_URL,
  DATAFLOW_CATALOGUE_URL,
  fetchDatasetCatalogue,
  fetchDatasetMetadata,
  fetchStatisticsData,
  buildStatisticsUrl,
  normalizeDatasetCode,
  type EurostatAnnotation,
  type EurostatDataflow,
  type JsonStatDataset,
  type StatisticsOptions
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

function normalizeWords(value: unknown): string[] {
  return requireNonEmpty(value, 'query')
    .toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function datasetScore(item: EurostatDataflow, words: string[], query: string): number {
  const code = String(item.extension.id || '').toLocaleLowerCase('en');
  const label = String(item.label || '').toLocaleLowerCase('en');
  const haystack = `${code} ${label}`;
  if (!words.every((word) => haystack.includes(word))) return -1;
  let score = words.length * 100;
  if (code === query) score += 1000;
  else if (code.startsWith(query)) score += 500;
  else if (code.includes(query)) score += 300;
  if (label === query) score += 800;
  else if (label.startsWith(query)) score += 400;
  else if (label.includes(query)) score += 200;
  return score;
}

function annotation(
  annotations: EurostatAnnotation[],
  type: string
): EurostatAnnotation | undefined {
  return annotations.find((entry) => entry.type === type);
}

function annotationValue(entry: EurostatAnnotation | undefined): string {
  return String(entry?.title ?? entry?.text ?? entry?.date ?? '').trim();
}

function orderedCategoryCodes(dataset: JsonStatDataset, dimensionId: string): string[] {
  const category = dataset.dimension[dimensionId]?.category;
  const index = category?.index;
  if (Array.isArray(index)) return index.map(String);
  if (index && typeof index === 'object') {
    return Object.entries(index)
      .sort((left, right) => Number(left[1]) - Number(right[1]))
      .map(([code]) => code);
  }
  return [];
}

function cubeValue(
  values: JsonStatDataset['value'] | JsonStatDataset['status'],
  index: number
): number | string | null | undefined {
  if (values == null) return undefined;
  return Array.isArray(values) ? values[index] : values[String(index)];
}

function displayValue(value: number | string): string {
  return typeof value === 'number' ? value.toLocaleString('en-GB') : String(value);
}

type ObservationRow = Record<string, string | number> & {
  value: string;
  rawValue: string | number;
  status: string;
  time: string;
  timeLabel: string;
  geo: string;
  geoLabel: string;
  unit: string;
  unitLabel: string;
  sex: string;
  sexLabel: string;
  age: string;
  ageLabel: string;
  frequency: string;
  frequencyLabel: string;
  dimensions: string;
};

function decodeJsonStat(dataset: JsonStatDataset, maxCells: number) {
  if (dataset.id.length !== dataset.size.length) {
    throw new Error('Eurostat JSON-stat response has mismatched id and size arrays.');
  }
  const totalCells = dataset.size.reduce((product, size) => product * size, 1);
  if (!Number.isSafeInteger(totalCells) || totalCells > maxCells) {
    throw new Error(
      `Eurostat returned ${totalCells.toLocaleString('en-GB')} cells, above maxCells ${maxCells}. Add narrower dimension/time filters or raise maxCells (up to 10,000).`
    );
  }
  const codes = dataset.id.map((id) => orderedCategoryCodes(dataset, id));
  const rows: ObservationRow[] = [];
  for (let flatIndex = 0; flatIndex < totalCells; flatIndex += 1) {
    const rawValue = cubeValue(dataset.value, flatIndex);
    if (rawValue == null) continue;
    const row: ObservationRow = {
      value: displayValue(rawValue),
      rawValue,
      status: String(cubeValue(dataset.status, flatIndex) ?? ''),
      time: '—',
      timeLabel: '—',
      geo: '—',
      geoLabel: '—',
      unit: '—',
      unitLabel: '—',
      sex: '—',
      sexLabel: '—',
      age: '—',
      ageLabel: '—',
      frequency: '—',
      frequencyLabel: '—',
      dimensions: ''
    };
    const labels: string[] = [];
    let remainder = flatIndex;
    for (let dimensionIndex = 0; dimensionIndex < dataset.id.length; dimensionIndex += 1) {
      const id = dataset.id[dimensionIndex];
      const stride = dataset.size
        .slice(dimensionIndex + 1)
        .reduce((product, size) => product * size, 1);
      const categoryIndex = Math.floor(remainder / stride) % dataset.size[dimensionIndex];
      remainder %= stride;
      const code = codes[dimensionIndex]?.[categoryIndex] ?? String(categoryIndex);
      const label = dataset.dimension[id]?.category?.label?.[code] ?? code;
      const key = id.toLocaleLowerCase('en').replace(/[^a-z0-9_]/g, '_');
      row[key] = code;
      row[`${key}Label`] = label;
      labels.push(`${dataset.dimension[id]?.label ?? id}: ${label} (${code})`);
    }
    row.time = String(row.time ?? row.time_period ?? '—');
    row.timeLabel = String(row.timeLabel ?? row.time_periodLabel ?? row.time);
    row.geo = String(row.geo ?? '—');
    row.geoLabel = String(row.geoLabel ?? row.geo);
    row.unit = String(row.unit ?? '—');
    row.unitLabel = String(row.unitLabel ?? row.unit);
    row.sex = String(row.sex ?? '—');
    row.sexLabel = String(row.sexLabel ?? row.sex);
    row.age = String(row.age ?? '—');
    row.ageLabel = String(row.ageLabel ?? row.age);
    row.frequency = String(row.freq ?? '—');
    row.frequencyLabel = String(row.freqLabel ?? row.frequency);
    row.dimensions = labels.join('; ');
    rows.push(row);
  }
  return { totalCells, rows };
}

const datasetSearchCard = defineCard({
  name: { singular: 'dataset', plural: 'datasets' },
  title: 'Eurostat datasets — {{query}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Matches', field: 'matches' },
        { label: 'Shown', field: 'shown' },
        { label: 'Catalogue updated', field: 'catalogueUpdated' }
      ]
    },
    {
      component: 'Table',
      columns: [
        { header: 'Dataset', field: 'label' },
        { header: 'Code', field: 'datasetCode' },
        { header: 'Agency', field: 'agency' },
        { header: 'Version', field: 'version' }
      ],
      rows: 'rows'
    }
  ]
});

const metadataCard = defineCard({
  name: { singular: 'dataset', plural: 'datasets' },
  title: '{{datasetCode}} — {{label}}',
  layout: [
    {
      component: 'KeyValue',
      pairs: [
        { label: 'Coverage', field: 'coverage' },
        { label: 'Observations', field: 'observationCount' },
        { label: 'Last data update', field: 'updated' },
        { label: 'Source', field: 'sourceInstitution' },
        { label: 'Data structure', field: 'dataStructure' },
        { label: 'Metadata', field: 'metadataUrl' }
      ]
    }
  ]
});

const dataCard = defineCard({
  name: { singular: 'observation', plural: 'observations' },
  title: '{{datasetCode}} — {{label}}',
  layout: [
    {
      component: 'MetricRow',
      items: [
        { label: 'Cube cells', field: 'totalCells' },
        { label: 'Observations', field: 'observations' },
        { label: 'Shown in text', field: 'shown' },
        { label: 'Updated', field: 'updated' }
      ]
    },
    {
      component: 'Table',
      columns: [
        { header: 'Geography', field: 'geoLabel' },
        { header: 'Time', field: 'timeLabel' },
        { header: 'Value', field: 'value' },
        { header: 'Unit', field: 'unitLabel' },
        { header: 'Sex', field: 'sexLabel' },
        { header: 'Age', field: 'ageLabel' },
        { header: 'Frequency', field: 'frequencyLabel' },
        { header: 'Status', field: 'status' },
        { header: 'All dimensions', field: 'dimensions' }
      ],
      rows: 'rows'
    }
  ]
});

export const tools = defineTools({
  eurostat_search_datasets: {
    description:
      'Search the complete official Eurostat SDMX dataflow catalogue by words in a dataset title or by online dataset code. Use this first for topic questions when the exact code is unknown; all query words must occur in the title/code. Returns exact datasetCode values for eurostat_get_dataset_metadata and eurostat_query_data. Results are relevance-ranked, then alphabetical; use offset and limit to page. The catalogue is cached by the host (24 hours by default).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words from the desired statistical topic or an exact Eurostat online dataset code.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum matching datasets to return (1-25, default 10).',
          minimum: 1,
          maximum: 25,
          default: 10
        },
        offset: {
          type: 'integer',
          description: 'Number of ranked matches to skip for pagination (0-10000, default 0).',
          minimum: 0,
          maximum: 10000,
          default: 0
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    card: datasetSearchCard,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = requireNonEmpty(args.query, 'query').toLocaleLowerCase('en');
      const words = normalizeWords(query);
      const limit = boundedInt(args.limit, 10, 'limit', 1, 25);
      const offset = boundedInt(args.offset, 0, 'offset', 0, 10000);
      const payload = await fetchDatasetCatalogue();
      const matches = payload.link.item
        .map((item) => ({ item, score: datasetScore(item, words, query) }))
        .filter(({ score }) => score >= 0)
        .sort((left, right) =>
          right.score - left.score ||
          String(left.item.label ?? '').localeCompare(String(right.item.label ?? ''))
        );
      const selected = matches.slice(offset, offset + limit).map(({ item }) => ({
        datasetCode: item.extension.id,
        label: item.label ?? 'Untitled dataset',
        agency: item.extension.agencyId ?? 'ESTAT',
        version: item.extension.version ?? 'Not stated'
      }));
      const text = selected.length
        ? [
            `Found ${matches.length.toLocaleString('en-GB')} Eurostat dataset${matches.length === 1 ? '' : 's'} matching "${query}"; showing ${selected.length} from offset ${offset}. Use an exact code with eurostat_get_dataset_metadata, then eurostat_query_data:`,
            ...selected.map(
              (item, index) => `${offset + index + 1}. ${item.datasetCode} — ${item.label}`
            )
          ].join('\n')
        : `No Eurostat datasets matched all words in "${query}".`;
      return {
        text,
        references: [
          createApiReference({
            id: `eurostat-catalogue:${query}:${offset}`,
            label: `Eurostat dataset catalogue search: ${query}`,
            sourceUrl: DATAFLOW_CATALOGUE_URL,
            quote: selected.length
              ? `The Eurostat SDMX catalogue contained ${matches.length} matches; this result preserves ${selected.length} ranked dataset records.`
              : 'The Eurostat SDMX catalogue contained no dataset matching all query words.',
            payload: {
              catalogueUpdated: payload.updated ?? null,
              query,
              totalMatches: matches.length,
              offset,
              matches: selected
            }
          })
        ],
        data: {
          query,
          matches: matches.length,
          shown: selected.length,
          offset,
          catalogueUpdated: payload.updated ?? 'Not stated',
          rows: selected
        }
      };
    }
  },

  eurostat_get_dataset_metadata: {
    description:
      'Get official Eurostat metadata for one exact online dataset code returned by eurostat_search_datasets. Use this before querying data to confirm the title, total observation count, overall oldest/latest periods, latest update, source institution, data-structure version, and explanatory-metadata link. This does not return dimension positions or observations; call eurostat_query_data next with narrow dimension and time filters.',
    parameters: {
      type: 'object',
      properties: {
        datasetCode: {
          type: 'string',
          description: 'Exact Eurostat online dataset code, such as DEMO_PJAN or NAMA_10_GDP.'
        }
      },
      required: ['datasetCode'],
      additionalProperties: false
    },
    card: metadataCard,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const datasetCode = normalizeDatasetCode(args.datasetCode);
      const payload = await fetchDatasetMetadata(datasetCode);
      const annotations = payload.extension.annotation ?? [];
      const observationCountRaw = annotationValue(annotation(annotations, 'OBS_COUNT'));
      const observationCount = Number(observationCountRaw);
      const oldestPeriod = annotationValue(annotation(annotations, 'OBS_PERIOD_OVERALL_OLDEST')) || 'Not stated';
      const latestPeriod = annotationValue(annotation(annotations, 'OBS_PERIOD_OVERALL_LATEST')) || 'Not stated';
      const updated = annotationValue(annotation(annotations, 'UPDATE_DATA')) || 'Not stated';
      const sourceInstitution = annotationValue(annotation(annotations, 'SOURCE_INSTITUTIONS')) || 'Eurostat';
      const metadataUrl = annotation(annotations, 'ESMS_HTML')?.href ?? 'Not stated';
      const dataStructure = [
        payload.extension.datastructure?.agencyId,
        payload.extension.datastructure?.id,
        payload.extension.datastructure?.version
      ].filter(Boolean).join('/') || 'Not stated';
      const coverage = `${oldestPeriod}–${latestPeriod}`;
      const sourceUrl = `${DATAFLOW_BASE_URL}/${datasetCode}/latest?format=JSON`;
      return {
        text: [
          `${datasetCode} — ${payload.label ?? 'Untitled Eurostat dataset'}`,
          `Coverage: ${coverage}. Observations: ${Number.isFinite(observationCount) ? observationCount.toLocaleString('en-GB') : observationCountRaw || 'not stated'}.`,
          `Last data update: ${updated}. Source: ${sourceInstitution}.`,
          metadataUrl !== 'Not stated' ? `Explanatory metadata: ${metadataUrl}` : ''
        ].filter(Boolean).join('\n'),
        references: [
          createApiReference({
            id: `eurostat-metadata:${datasetCode}`,
            label: `${datasetCode} Eurostat dataset metadata`,
            sourceUrl,
            quote: `Eurostat metadata identifies ${datasetCode} as ${payload.label ?? 'an untitled dataset'}, covering ${coverage}.`,
            payload
          })
        ],
        data: {
          datasetCode,
          label: payload.label ?? 'Untitled Eurostat dataset',
          coverage,
          oldestPeriod,
          latestPeriod,
          observationCount: Number.isFinite(observationCount)
            ? observationCount.toLocaleString('en-GB')
            : observationCountRaw || 'Not stated',
          updated,
          sourceInstitution,
          dataStructure,
          metadataUrl
        }
      };
    }
  },

  eurostat_query_data: {
    description:
      'Query observations from one exact Eurostat online dataset code through the Statistics API and decode its JSON-stat 2.0 cube into labelled rows. Use eurostat_search_datasets first when the code is unknown and eurostat_get_dataset_metadata to inspect coverage. Dimension filters are exact code/value pairs; repeat a dimension to request several values. With no explicit time selection the tool sends lastTimePeriod=1. A time/time_period filter, lastTimePeriod, or since/until range are mutually exclusive except since+until may be combined. Every non-empty cell is retained in the filterable card; text is bounded by displayLimit. Queries above maxCells fail with instructions to narrow filters, preventing oversized model results.',
    parameters: {
      type: 'object',
      properties: {
        datasetCode: {
          type: 'string',
          description: 'Exact Eurostat online dataset code returned by eurostat_search_datasets.'
        },
        filters: {
          type: 'array',
          description: 'Exact dataset-specific dimension code/value filters. Repeat a dimension for multiple values; examples: geo=DE, sex=T, age=TOTAL, unit=NR.',
          maxItems: 24,
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', description: 'Dimension code present in the dataset, such as geo, sex, age, unit, or na_item.' },
              value: { type: 'string', description: 'Exact position code for that dimension, such as DE, T, TOTAL, or B1GQ.' }
            },
            required: ['dimension', 'value'],
            additionalProperties: false
          }
        },
        geoLevel: {
          type: 'string',
          enum: ['aggregate', 'country', 'nuts1', 'nuts2', 'nuts3', 'city'],
          description: 'Optional special GEO grouping filter. Use exact geo filters for named places; geoLevel selects all positions at one territorial level.'
        },
        lastTimePeriod: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Return the N latest time positions (1-100). Defaults to 1 only when no other time selection is supplied.'
        },
        sinceTimePeriod: {
          type: 'string',
          description: 'Inclusive earliest time-period code. May be combined only with untilTimePeriod, not lastTimePeriod or a time filter.'
        },
        untilTimePeriod: {
          type: 'string',
          description: 'Inclusive latest time-period code. May be combined only with sinceTimePeriod, not lastTimePeriod or a time filter.'
        },
        language: {
          type: 'string',
          enum: ['en', 'de', 'fr'],
          default: 'en',
          description: 'Language for dataset and category labels (default en).'
        },
        displayLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 25,
          description: 'Maximum observations copied into model-visible text (1-100, default 25); all fetched non-empty cells remain in card data.'
        },
        maxCells: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 2500,
          description: 'Safety ceiling for the returned JSON-stat cube (1-10000, default 2500). Narrow filters if Eurostat returns more cells.'
        }
      },
      required: ['datasetCode'],
      additionalProperties: false
    },
    card: dataCard,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const datasetCode = normalizeDatasetCode(args.datasetCode);
      const displayLimit = boundedInt(args.displayLimit, 25, 'displayLimit', 1, 100);
      const maxCells = boundedInt(args.maxCells, 2500, 'maxCells', 1, 10000);
      const options: StatisticsOptions = {
        datasetCode,
        language: args.language as StatisticsOptions['language'],
        filters: args.filters as StatisticsOptions['filters'],
        geoLevel: args.geoLevel as StatisticsOptions['geoLevel'],
        lastTimePeriod: args.lastTimePeriod as number | undefined,
        sinceTimePeriod: args.sinceTimePeriod as string | undefined,
        untilTimePeriod: args.untilTimePeriod as string | undefined
      };
      const sourceUrl = buildStatisticsUrl(options);
      const payload = await fetchStatisticsData(options);
      const decoded = decodeJsonStat(payload, maxCells);
      const shown = decoded.rows.slice(0, displayLimit);
      const lines = shown.map((row, index) =>
        `${index + 1}. ${row.geoLabel} | ${row.timeLabel} | ${row.value}` +
        (row.unitLabel !== '—' ? ` | ${row.unitLabel}` : '') +
        (row.status ? ` | status ${row.status}` : '')
      );
      const text = decoded.rows.length
        ? [
            `${payload.label ?? datasetCode}: ${decoded.rows.length.toLocaleString('en-GB')} non-empty observation${decoded.rows.length === 1 ? '' : 's'} in ${decoded.totalCells.toLocaleString('en-GB')} cube cells; showing ${shown.length}:`,
            ...lines,
            decoded.rows.length > shown.length
              ? `${decoded.rows.length - shown.length} more observations remain in the result card.`
              : ''
          ].filter(Boolean).join('\n')
        : `${payload.label ?? datasetCode}: No non-empty observations were returned for the selected filters.`;
      return {
        text,
        references: [
          createApiReference({
            id: `eurostat-data:${datasetCode}`,
            label: `${datasetCode} Eurostat observations`,
            sourceUrl,
            quote: decoded.rows.length
              ? `The Eurostat Statistics API returned ${decoded.rows.length} non-empty observations in a ${decoded.totalCells}-cell JSON-stat cube.`
              : 'The Eurostat Statistics API returned no non-empty observations for these filters.',
            payload
          })
        ],
        data: {
          datasetCode,
          label: payload.label ?? datasetCode,
          source: payload.source ?? 'ESTAT',
          updated: payload.updated ?? 'Not stated',
          totalCells: decoded.totalCells,
          observations: decoded.rows.length,
          shown: shown.length,
          rows: decoded.rows
        }
      };
    }
  }
});
