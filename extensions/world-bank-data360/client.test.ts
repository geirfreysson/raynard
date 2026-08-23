import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  DATA_URL,
  SEARCH_URL,
  fetchData360Data,
  searchData360Indicators
} from './client.ts';

type CapturedRequest = {
  url: string;
  init?: RequestInit;
};

function mockFetchWithInit(body: unknown, status = 200) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response;
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

test('the client targets the documented Data360 host', () => {
  // Assertions below compare against DATA_URL/SEARCH_URL, so they would follow
  // a base-URL rewrite. Pinning the literal origins once is what makes it fail.
  assert.equal(SEARCH_URL, 'https://data360api.worldbank.org/data360/searchv2');
  assert.equal(DATA_URL, 'https://data360api.worldbank.org/data360/data');
});

test('searchData360Indicators posts an indicator-only search and keeps endpoint metadata', async () => {
  const response = {
    '@odata.count': 42,
    value: [
      {
        '@search.score': 51.2,
        disaggregation_types: ['SEX', 'AGE'],
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
      }
    ]
  };
  const mocked = mockFetchWithInit(response);
  try {
    const result = await searchData360Indicators({
      query: 'population total',
      databaseId: 'WB_WDI',
      limit: 5,
      skip: 10
    });

    assert.equal(result.value[0].series_description.idno, 'WB_WDI_SP_POP_TOTL');
    assert.deepEqual(result.value[0].disaggregation_types, ['SEX', 'AGE']);
    assert.equal(mocked.requests.length, 1);
    assert.equal(mocked.requests[0].url, SEARCH_URL);
    assert.equal(mocked.requests[0].init?.method, 'POST');
    assert.equal(
      (mocked.requests[0].init?.headers as Record<string, string>)['content-type'],
      'application/json'
    );
    const requestBody = JSON.parse(String(mocked.requests[0].init?.body));
    assert.equal(requestBody.search, 'population total');
    assert.equal(requestBody.top, 5);
    assert.equal(requestBody.skip, 10);
    assert.equal(requestBody.count, true);
    assert.equal(
      requestBody.filter,
      "type eq 'indicator' and series_description/database_id eq 'WB_WDI'"
    );
    assert.match(requestBody.select, /series_description\/api_link/);
    assert.match(requestBody.select, /disaggregation_types/);
  } finally {
    mocked.restore();
  }
});

test('searchData360Indicators validates query, database ID, limit, and skip', async () => {
  await assert.rejects(() => searchData360Indicators({ query: '  ' }), /query must be a non-empty/i);
  await assert.rejects(
    () => searchData360Indicators({ query: 'poverty', databaseId: "WB_WDI' or true" }),
    /databaseId may contain only/i
  );
  await assert.rejects(
    () => searchData360Indicators({ query: 'poverty', limit: 26 }),
    /limit must be between 1 and 25/i
  );
  await assert.rejects(
    () => searchData360Indicators({ query: 'poverty', skip: -1 }),
    /skip must be a non-negative integer/i
  );
});

test('searchData360Indicators surfaces HTTP failures with the endpoint label', async () => {
  const mocked = mockFetchWithInit({ message: 'bad request' }, 400);
  try {
    await assert.rejects(
      () => searchData360Indicators({ query: 'poverty' }),
      /Data360 search request failed with HTTP 400.*bad request/i
    );
  } finally {
    mocked.restore();
  }
});

test('fetchData360Data sends the selected search result IDs and supported data filters', async () => {
  const response = {
    count: 1,
    value: [
      {
        DATABASE_ID: 'WB_WDI',
        INDICATOR: 'WB_WDI_SP_POP_TOTL',
        REF_AREA: 'KEN',
        TIME_PERIOD: '2023',
        OBS_VALUE: '55,339,003',
        FREQ: 'A',
        UNIT_MEASURE: 'NUMBER'
      }
    ]
  };
  const mocked = mockFetch(() => ({ body: response }));
  try {
    const result = await fetchData360Data({
      databaseId: 'WB_WDI',
      indicatorId: 'WB_WDI_SP_POP_TOTL',
      refArea: 'KEN',
      sex: '_T',
      age: '_T',
      urbanisation: '_T',
      compBreakdown1: '_Z',
      compBreakdown2: '_Z',
      compBreakdown3: '_Z',
      timePeriodFrom: '2020',
      timePeriodTo: '2024',
      frequency: 'A',
      unitMeasure: 'NUMBER',
      unitType: 'count',
      unitMultiplier: '0',
      skip: 1000
    });

    assert.equal(result.count, 1);
    assert.equal(result.value[0].REF_AREA, 'KEN');
    const called = new URL(mocked.calls[0]);
    assert.equal(called.origin + called.pathname, DATA_URL);
    assert.equal(called.searchParams.get('DATABASE_ID'), 'WB_WDI');
    assert.equal(called.searchParams.get('INDICATOR'), 'WB_WDI_SP_POP_TOTL');
    assert.equal(called.searchParams.get('REF_AREA'), 'KEN');
    assert.equal(called.searchParams.get('SEX'), '_T');
    assert.equal(called.searchParams.get('AGE'), '_T');
    assert.equal(called.searchParams.get('URBANISATION'), '_T');
    assert.equal(called.searchParams.get('COMP_BREAKDOWN_1'), '_Z');
    assert.equal(called.searchParams.get('COMP_BREAKDOWN_2'), '_Z');
    assert.equal(called.searchParams.get('COMP_BREAKDOWN_3'), '_Z');
    assert.equal(called.searchParams.get('timePeriodFrom'), '2020');
    assert.equal(called.searchParams.get('timePeriodTo'), '2024');
    assert.equal(called.searchParams.get('FREQ'), 'A');
    assert.equal(called.searchParams.get('UNIT_MEASURE'), 'NUMBER');
    assert.equal(called.searchParams.get('UNIT_TYPE'), 'count');
    assert.equal(called.searchParams.get('UNIT_MULT'), '0');
    assert.equal(called.searchParams.get('skip'), '1000');
  } finally {
    mocked.restore();
  }
});

test('fetchData360Data validates required IDs and pagination', async () => {
  await assert.rejects(
    () => fetchData360Data({ databaseId: '', indicatorId: 'WB_WDI_SP_POP_TOTL' }),
    /databaseId must be a non-empty/i
  );
  await assert.rejects(
    () => fetchData360Data({ databaseId: 'WB_WDI', indicatorId: '' }),
    /indicatorId must be a non-empty/i
  );
  await assert.rejects(
    () => fetchData360Data({ databaseId: 'WB_WDI', indicatorId: 'X', skip: 1.5 }),
    /skip must be a non-negative integer/i
  );
});

test('fetchData360Data surfaces API errors', async () => {
  const mocked = mockFetch(() => ({ status: 500, body: { message: 'temporary outage' } }));
  try {
    await assert.rejects(
      () => fetchData360Data({ databaseId: 'WB_WDI', indicatorId: 'X' }),
      /HTTP 500.*temporary outage/i
    );
  } finally {
    mocked.restore();
  }
});

test('fetchData360Data always sends a two-sided time range', async () => {
  // Data360 honours the range only when BOTH bounds are present. Sending
  // timePeriodFrom alone is silently ignored and the whole history comes back,
  // so a one-sided request must be widened rather than passed through.
  const cases: Array<{
    label: string;
    options: { timePeriodFrom?: string; timePeriodTo?: string };
    from: string | null;
    to: string | null;
  }> = [
    { label: 'from only', options: { timePeriodFrom: '2010' }, from: '2010', to: '2100' },
    { label: 'to only', options: { timePeriodTo: '2015' }, from: '1800', to: '2015' },
    {
      label: 'both',
      options: { timePeriodFrom: '2010', timePeriodTo: '2015' },
      from: '2010',
      to: '2015'
    },
    { label: 'neither', options: {}, from: null, to: null }
  ];

  for (const testCase of cases) {
    const mocked = mockFetch(() => ({ body: { count: 0, value: [] } }));
    try {
      await fetchData360Data({
        databaseId: 'WB_WDI',
        indicatorId: 'WB_WDI_SP_POP_TOTL',
        ...testCase.options
      });
      const called = new URL(mocked.calls[0]);
      assert.equal(
        called.searchParams.get('timePeriodFrom'),
        testCase.from,
        `${testCase.label}: timePeriodFrom`
      );
      assert.equal(
        called.searchParams.get('timePeriodTo'),
        testCase.to,
        `${testCase.label}: timePeriodTo`
      );
      // The camelCase spelling is the one the API honours.
      assert.equal(called.searchParams.get('time-period-from'), null);
    } finally {
      mocked.restore();
    }
  }
});
