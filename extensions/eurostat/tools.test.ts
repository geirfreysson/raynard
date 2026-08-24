import test from 'node:test';
import assert from 'node:assert/strict';
import { expectToolResult, mockFetch } from '@raynard/plugin-sdk/testing';
import { DATAFLOW_CATALOGUE_URL, STATISTICS_BASE_URL } from './client.ts';
import { tools } from './tools.ts';

const cataloguePayload = {
  version: '2.0',
  class: 'collection',
  updated: '2026-08-16T11:00:00+0200',
  link: {
    item: [
      {
        class: 'dataset',
        label: 'Population on 1 January by age and sex',
        extension: { lang: 'EN', id: 'DEMO_PJAN', agencyId: 'ESTAT', version: '1.0' }
      },
      {
        class: 'dataset',
        label: 'Population density by NUTS 3 region',
        extension: { lang: 'EN', id: 'DEMO_R_D3DENS', agencyId: 'ESTAT', version: '1.0' }
      },
      {
        class: 'dataset',
        label: 'Gross domestic product (GDP) and main components',
        extension: { lang: 'EN', id: 'NAMA_10_GDP', agencyId: 'ESTAT', version: '1.0' }
      }
    ]
  }
};

const metadataPayload = {
  version: '2.0',
  class: 'dataset',
  label: 'Population on 1 January by age and sex',
  extension: {
    lang: 'EN',
    id: 'DEMO_PJAN',
    agencyId: 'ESTAT',
    version: '1.0',
    datastructure: { id: 'DEMO_PJAN', agencyId: 'ESTAT', version: '42.0' },
    annotation: [
      { type: 'OBS_COUNT', title: '250000' },
      { type: 'OBS_PERIOD_OVERALL_OLDEST', title: '1960' },
      { type: 'OBS_PERIOD_OVERALL_LATEST', title: '2025' },
      { type: 'UPDATE_DATA', date: '2026-08-15T11:00:00+0200' },
      { type: 'ESMS_HTML', title: 'Explanatory texts', href: 'https://ec.europa.eu/eurostat/cache/metadata/en/demo_pjan_esms.htm' },
      { type: 'SOURCE_INSTITUTIONS', text: 'Eurostat' }
    ]
  }
};

const dataPayload = {
  version: '2.0',
  class: 'dataset',
  label: 'Population on 1 January by age and sex',
  source: 'ESTAT',
  updated: '2026-08-15T11:00:00+0200',
  id: ['freq', 'sex', 'age', 'geo', 'time'],
  size: [1, 1, 1, 2, 2],
  dimension: {
    freq: { label: 'Time frequency', category: { index: { A: 0 }, label: { A: 'Annual' } } },
    sex: { label: 'Sex', category: { index: { T: 0 }, label: { T: 'Total' } } },
    age: { label: 'Age class', category: { index: { TOTAL: 0 }, label: { TOTAL: 'Total' } } },
    geo: { label: 'Geopolitical entity', category: { index: { DE: 0, FR: 1 }, label: { DE: 'Germany', FR: 'France' } } },
    time: { label: 'Time', category: { index: { '2023': 0, '2024': 1 }, label: { '2023': '2023', '2024': '2024' } } }
  },
  value: { '0': 84482267, '1': 84708010, '2': 68143367, '3': 68373433 },
  status: { '3': 'p' }
};

test('eurostat_search_datasets ranks matching datasets and returns card rows and a bounded reference', async () => {
  const mocked = mockFetch(() => ({ body: cataloguePayload }));
  try {
    const result = await tools.eurostat_search_datasets.execute({ query: 'population', limit: 2 });
    expectToolResult(result);
    assert.match(result.text, /DEMO_PJAN/);
    assert.match(result.text, /DEMO_R_D3DENS/);
    assert.doesNotMatch(result.text, /NAMA_10_GDP/);
    const data = result.data as { matches: number; shown: number; rows: Array<Record<string, unknown>> };
    assert.equal(data.matches, 2);
    assert.equal(data.shown, 2);
    assert.deepEqual(
      data.rows.map((row) => row.datasetCode),
      ['DEMO_R_D3DENS', 'DEMO_PJAN']
    );
    assert.equal(result.references[0].referenceMeta.sourceUrl, DATAFLOW_CATALOGUE_URL);
    const expanded = JSON.stringify(result.references[0].expandedContent);
    assert.match(expanded, /DEMO_PJAN/);
    assert.match(expanded, /DEMO_R_D3DENS/);
    assert.doesNotMatch(expanded, /NAMA_10_GDP/);
  } finally {
    mocked.restore();
  }
});

test('eurostat_search_datasets returns a useful empty state', async () => {
  const mocked = mockFetch(() => ({ body: cataloguePayload }));
  try {
    const result = await tools.eurostat_search_datasets.execute({ query: 'definitely absent topic' });
    expectToolResult(result);
    assert.match(result.text, /No Eurostat datasets matched/i);
    assert.deepEqual((result.data as { rows: unknown[] }).rows, []);
    assert.equal((result.data as { shown: number }).shown, 0);
  } finally {
    mocked.restore();
  }
});

test('eurostat_get_dataset_metadata returns coverage, update facts, links, references, and card data', async () => {
  const mocked = mockFetch(() => ({ body: metadataPayload }));
  try {
    const result = await tools.eurostat_get_dataset_metadata.execute({ datasetCode: 'demo_pjan' });
    expectToolResult(result);
    assert.match(result.text, /DEMO_PJAN/);
    assert.match(result.text, /1960.*2025/);
    assert.match(result.text, /250,000/);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.datasetCode, 'DEMO_PJAN');
    assert.equal(data.latestPeriod, '2025');
    assert.equal(data.metadataUrl, 'https://ec.europa.eu/eurostat/cache/metadata/en/demo_pjan_esms.htm');
    assert.ok(result.references.length >= 1);
    assert.ok(tools.eurostat_get_dataset_metadata.card.layout.length > 0);
  } finally {
    mocked.restore();
  }
});

test('eurostat_query_data decodes a JSON-stat cube into labelled rows with status', async () => {
  const mocked = mockFetch(() => ({ body: dataPayload }));
  try {
    const result = await tools.eurostat_query_data.execute({
      datasetCode: 'DEMO_PJAN',
      filters: [
        { dimension: 'sex', value: 'T' },
        { dimension: 'age', value: 'TOTAL' },
        { dimension: 'geo', value: 'DE' },
        { dimension: 'geo', value: 'FR' }
      ],
      sinceTimePeriod: '2023',
      untilTimePeriod: '2024',
      displayLimit: 3,
      maxCells: 10
    });
    expectToolResult(result);
    assert.match(result.text, /Germany.*2023.*84,482,267/);
    assert.match(result.text, /Germany.*2024.*84,708,010/);
    assert.match(result.text, /France.*2023.*68,143,367/);
    assert.doesNotMatch(result.text, /68,373,433/);
    const data = result.data as {
      totalCells: number;
      observations: number;
      shown: number;
      rows: Array<Record<string, unknown>>;
    };
    assert.equal(data.totalCells, 4);
    assert.equal(data.observations, 4);
    assert.equal(data.shown, 3);
    assert.equal(data.rows.length, 4);
    assert.equal(data.rows[0].geo, 'DE');
    assert.equal(data.rows[0].geoLabel, 'Germany');
    assert.equal(data.rows[3].status, 'p');
    const source = new URL(result.references[0].referenceMeta.sourceUrl);
    assert.equal(source.origin + source.pathname, `${STATISTICS_BASE_URL}/DEMO_PJAN`);
    assert.deepEqual(source.searchParams.getAll('geo'), ['DE', 'FR']);
  } finally {
    mocked.restore();
  }
});

test('eurostat_query_data handles sparse empty results and rejects oversized cubes', async () => {
  const empty = { ...dataPayload, size: [1, 1, 1, 1, 1], value: {} };
  let mocked = mockFetch(() => ({ body: empty }));
  try {
    const result = await tools.eurostat_query_data.execute({ datasetCode: 'DEMO_PJAN' });
    expectToolResult(result);
    assert.match(result.text, /No non-empty observations/i);
    assert.deepEqual((result.data as { rows: unknown[] }).rows, []);
  } finally {
    mocked.restore();
  }

  mocked = mockFetch(() => ({ body: dataPayload }));
  try {
    await assert.rejects(
      () => tools.eurostat_query_data.execute({ datasetCode: 'DEMO_PJAN', maxCells: 3 }),
      /4 cells.*maxCells.*3/i
    );
  } finally {
    mocked.restore();
  }
});

test('every exported tool has a routing description, strict object schema, card, and execute function', () => {
  assert.deepEqual(Object.keys(tools).sort(), [
    'eurostat_get_dataset_metadata',
    'eurostat_query_data',
    'eurostat_search_datasets'
  ]);
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.description.length > 100, `${name} needs a routing-quality description`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.card.name.singular);
    assert.ok(tool.card.name.plural);
    assert.ok(tool.card.layout.length > 0);
    assert.equal(typeof tool.execute, 'function');
  }
});
