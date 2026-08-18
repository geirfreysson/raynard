import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectToolResult, mockFetch } from '@raynard/plugin-sdk/testing';
import { DATA_URL, SEARCH_URL } from './client.ts';
import { tools } from './tools.ts';

function mockPostJson(body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const searchItem = {
  '@search.score': 44.5,
  disaggregation_types: ['SEX', 'AGE', 'URBANISATION'],
  series_description: {
    idno: 'WB_WDI_SP_POP_TOTL',
    name: 'Population, total',
    database_id: 'WB_WDI',
    database_name: 'World Development Indicators',
    measurement_unit: 'Number',
    periodicity: 'Annual',
    time_periods: [{ start: '1960', end: '2024', notes: null }],
    api_link: `${DATA_URL}?DATABASE_ID=WB_WDI&INDICATOR=WB_WDI_SP_POP_TOTL`
  }
};

test('data360_search_indicators returns selectable data endpoint IDs and card rows', async () => {
  const restore = mockPostJson({ '@odata.count': 125, value: [searchItem] });
  try {
    const tool = tools.data360_search_indicators;
    const result = await tool.execute({ query: 'population total', limit: 10 });
    expectToolResult(result);
    assert.match(result.text, /WB_WDI_SP_POP_TOTL/);
    assert.match(result.text, /WB_WDI/);
    assert.match(result.text, /Population, total/);
    assert.match(result.text, /data360_get_data/);
    const data = result.data as { total: number; shown: number; rows: Array<Record<string, unknown>> };
    assert.equal(data.total, 125);
    assert.equal(data.shown, 1);
    assert.equal(data.rows[0].indicatorId, 'WB_WDI_SP_POP_TOTL');
    assert.equal(data.rows[0].databaseId, 'WB_WDI');
    assert.equal(data.rows[0].coverage, '1960–2024');
    assert.equal(data.rows[0].disaggregations, 'SEX, AGE, URBANISATION');
    assert.equal(result.references[0].referenceMeta.sourceUrl, searchItem.series_description.api_link);
    assert.ok(tool.card.layout.length > 0);
  } finally {
    restore();
  }
});

test('data360_search_indicators returns useful empty-state data and a search reference', async () => {
  const restore = mockPostJson({ '@odata.count': 0, value: [] });
  try {
    const result = await tools.data360_search_indicators.execute({ query: 'no matching series' });
    expectToolResult(result);
    assert.match(result.text, /No Data360 indicators/i);
    assert.equal((result.data as { shown: number }).shown, 0);
    assert.deepEqual((result.data as { rows: unknown[] }).rows, []);
    assert.equal(result.references[0].referenceMeta.sourceUrl, SEARCH_URL);
  } finally {
    restore();
  }
});

test('data360_get_data returns sorted observations, exact filters, bounded text, and all fetched card rows', async () => {
  const payload = {
    count: 3,
    value: [
      {
        DATABASE_ID: 'WB_WDI', INDICATOR: 'WB_WDI_SP_POP_TOTL', REF_AREA: 'KEN',
        TIME_PERIOD: '2022', OBS_VALUE: '54.0', FREQ: 'A', UNIT_MEASURE: 'MILLION',
        SEX: '_T', AGE: '_T', URBANISATION: '_T', LATEST_DATA: false
      },
      {
        DATABASE_ID: 'WB_WDI', INDICATOR: 'WB_WDI_SP_POP_TOTL', REF_AREA: 'KEN',
        TIME_PERIOD: '2020', OBS_VALUE: '52.0', FREQ: 'A', UNIT_MEASURE: 'MILLION',
        SEX: '_T', AGE: '_T', URBANISATION: '_T', LATEST_DATA: false
      },
      {
        DATABASE_ID: 'WB_WDI', INDICATOR: 'WB_WDI_SP_POP_TOTL', REF_AREA: 'KEN',
        TIME_PERIOD: '2021', OBS_VALUE: '53.0', FREQ: 'A', UNIT_MEASURE: 'MILLION',
        SEX: '_T', AGE: '_T', URBANISATION: '_T', LATEST_DATA: true
      }
    ]
  };
  const mocked = mockFetch(() => ({ body: payload }));
  try {
    const result = await tools.data360_get_data.execute({
      databaseId: 'WB_WDI',
      indicatorId: 'WB_WDI_SP_POP_TOTL',
      refArea: 'KEN',
      timePeriodFrom: '2020',
      timePeriodTo: '2022',
      displayLimit: 2
    });
    expectToolResult(result);
    assert.match(result.text, /2020.*52\.0/);
    assert.match(result.text, /2021.*53\.0/);
    assert.doesNotMatch(result.text, /2022.*54\.0/);
    const data = result.data as {
      total: number;
      returned: number;
      shown: number;
      stored: number;
      rows: Array<Record<string, unknown>>;
    };
    assert.equal(data.total, 3);
    assert.equal(data.returned, 3);
    assert.equal(data.shown, 2);
    assert.equal(data.stored, 3);
    assert.deepEqual(data.rows.map((row) => row.period), ['2020', '2021', '2022']);
    assert.equal(data.rows[1].latest, 'Yes');
    assert.equal(result.references.length, 1);
    const source = new URL(result.references[0].referenceMeta.sourceUrl);
    assert.equal(source.origin + source.pathname, DATA_URL);
    assert.equal(source.searchParams.get('DATABASE_ID'), 'WB_WDI');
    assert.equal(source.searchParams.get('INDICATOR'), 'WB_WDI_SP_POP_TOTL');
    assert.equal(source.searchParams.get('REF_AREA'), 'KEN');
    assert.equal(source.searchParams.get('timePeriodFrom'), '2020');
    assert.equal(source.searchParams.get('timePeriodTo'), '2022');
    assert.ok(tools.data360_get_data.card.layout.length > 0);
  } finally {
    mocked.restore();
  }
});

test('data360_get_data handles an empty data response', async () => {
  const mocked = mockFetch(() => ({ body: { count: 0, value: [] } }));
  try {
    const result = await tools.data360_get_data.execute({
      databaseId: 'WB_WDI',
      indicatorId: 'WB_WDI_NOT_REAL'
    });
    expectToolResult(result);
    assert.match(result.text, /No observations/i);
    assert.equal((result.data as { shown: number }).shown, 0);
    assert.deepEqual((result.data as { rows: unknown[] }).rows, []);
  } finally {
    mocked.restore();
  }
});

test('data360_get_data rejects invalid display limits before calling the API', async () => {
  await assert.rejects(
    () => tools.data360_get_data.execute({
      databaseId: 'WB_WDI', indicatorId: 'WB_WDI_SP_POP_TOTL', displayLimit: 101
    }),
    /displayLimit must be between 1 and 100/i
  );
});

test('every exported tool has a routing description, strict object schema, card, and execute function', () => {
  assert.deepEqual(Object.keys(tools).sort(), ['data360_get_data', 'data360_search_indicators']);
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.description.length > 80, `${name} should have a specific routing description`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.card.name.singular);
    assert.ok(tool.card.name.plural);
    assert.ok(tool.card.layout.length > 0);
    assert.equal(typeof tool.execute, 'function');
  }
});
