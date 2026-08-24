import test from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  DATAFLOW_BASE_URL,
  DATAFLOW_CATALOGUE_URL,
  STATISTICS_BASE_URL,
  fetchDatasetCatalogue,
  fetchDatasetMetadata,
  fetchStatisticsData
} from './client.ts';

test('fetchDatasetCatalogue requests the compact English SDMX dataflow catalogue', async () => {
  const mocked = mockFetch(() => ({
    body: {
      version: '2.0',
      class: 'collection',
      updated: '2026-08-16T11:00:00+0200',
      link: {
        item: [
          {
            class: 'dataset',
            label: 'Population on 1 January by age and sex',
            extension: { lang: 'EN', id: 'DEMO_PJAN', agencyId: 'ESTAT', version: '1.0' }
          }
        ]
      }
    }
  }));

  try {
    const result = await fetchDatasetCatalogue();
    assert.equal(result.link.item[0].extension.id, 'DEMO_PJAN');
    assert.equal(mocked.calls.length, 1);
    const called = new URL(mocked.calls[0]);
    assert.equal(called.origin + called.pathname, DATAFLOW_CATALOGUE_URL.split('?')[0]);
    assert.equal(called.searchParams.get('format'), 'JSON');
    assert.equal(called.searchParams.get('detail'), 'allstubs');
  } finally {
    mocked.restore();
  }
});

test('fetchDatasetMetadata requests one exact dataflow and keeps annotations', async () => {
  const payload = {
    version: '2.0',
    class: 'dataset',
    label: 'Population on 1 January by age and sex',
    extension: {
      lang: 'EN',
      id: 'DEMO_PJAN',
      agencyId: 'ESTAT',
      version: '1.0',
      annotation: [{ type: 'OBS_COUNT', title: '12345' }]
    }
  };
  const mocked = mockFetch(() => ({ body: payload }));

  try {
    const result = await fetchDatasetMetadata('demo_pjan');
    assert.equal(result.extension.annotation?.[0].title, '12345');
    const called = new URL(mocked.calls[0]);
    assert.equal(
      called.origin + called.pathname,
      `${DATAFLOW_BASE_URL}/DEMO_PJAN/latest`
    );
    assert.equal(called.searchParams.get('format'), 'JSON');
  } finally {
    mocked.restore();
  }
});

test('fetchStatisticsData sends documented time, geography, language, and repeated dimension filters', async () => {
  const mocked = mockFetch(() => ({
    body: {
      version: '2.0',
      class: 'dataset',
      label: 'Population',
      id: ['freq', 'sex', 'age', 'geo', 'time'],
      size: [1, 1, 1, 1, 2],
      dimension: {},
      value: [1, 2]
    }
  }));

  try {
    await fetchStatisticsData({
      datasetCode: 'demo_pjan',
      language: 'de',
      geoLevel: 'country',
      sinceTimePeriod: '2020',
      untilTimePeriod: '2024',
      filters: [
        { dimension: 'geo', value: 'DE' },
        { dimension: 'sex', value: 'T' },
        { dimension: 'age', value: 'TOTAL' },
        { dimension: 'geo', value: 'FR' }
      ]
    });

    const called = new URL(mocked.calls[0]);
    assert.equal(called.origin + called.pathname, `${STATISTICS_BASE_URL}/DEMO_PJAN`);
    assert.equal(called.searchParams.get('lang'), 'DE');
    assert.equal(called.searchParams.get('format'), 'JSON');
    assert.equal(called.searchParams.get('geoLevel'), 'country');
    assert.equal(called.searchParams.get('sinceTimePeriod'), '2020');
    assert.equal(called.searchParams.get('untilTimePeriod'), '2024');
    assert.equal(called.searchParams.get('lastTimePeriod'), null);
    assert.deepEqual(called.searchParams.getAll('geo'), ['DE', 'FR']);
    assert.equal(called.searchParams.get('sex'), 'T');
    assert.equal(called.searchParams.get('age'), 'TOTAL');
  } finally {
    mocked.restore();
  }
});

test('fetchStatisticsData defaults to the latest time position and validates conflicting inputs', async () => {
  const mocked = mockFetch(() => ({ body: { version: '2.0', class: 'dataset', id: [], size: [], dimension: {}, value: [] } }));
  try {
    await fetchStatisticsData({ datasetCode: 'demo_pjan', filters: [{ dimension: 'geo', value: 'DE' }] });
    const called = new URL(mocked.calls[0]);
    assert.equal(called.searchParams.get('lastTimePeriod'), '1');
  } finally {
    mocked.restore();
  }

  await assert.rejects(
    () => fetchStatisticsData({ datasetCode: '../secret' }),
    /datasetCode may contain only/i
  );
  await assert.rejects(
    () => fetchStatisticsData({ datasetCode: 'demo_pjan', language: 'es' as 'en' }),
    /language must be EN, DE, or FR/i
  );
  await assert.rejects(
    () => fetchStatisticsData({ datasetCode: 'demo_pjan', lastTimePeriod: 2, sinceTimePeriod: '2020' }),
    /lastTimePeriod cannot be combined/i
  );
  await assert.rejects(
    () => fetchStatisticsData({
      datasetCode: 'demo_pjan',
      filters: [{ dimension: 'bad dimension', value: 'DE' }]
    }),
    /dimension may contain only/i
  );
});

test('API helpers surface HTTP errors', async () => {
  const mocked = mockFetch(() => ({ status: 503, body: { error: 'maintenance' } }));
  try {
    await assert.rejects(() => fetchDatasetCatalogue(), /HTTP 503.*maintenance/i);
  } finally {
    mocked.restore();
  }
});
