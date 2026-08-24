import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  buildDataUrl,
  buildTimeFilter,
  fetchCodelist,
  fetchDataflows,
  fetchDataflowWithStructure,
  parseDataMessage,
  parseUrn
} from './client.ts';

// Shapes below are trimmed copies of live IMF SDMX 3.0 responses: every
// artefact list is nested under `data`, and the wrapper is what the previous
// version of this plugin got wrong.

test('fetchDataflows requests the structure endpoint with the SDMX media type', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/structure/dataflow/*/*/+')) {
      return {
        body: {
          data: {
            dataflows: [
              { id: 'BOP', name: 'Balance of Payments (BOP)', version: '15.0.1', agencyID: 'IMF.STA' }
            ]
          }
        }
      };
    }
    return undefined;
  });

  try {
    const dataflows = await fetchDataflows();
    assert.equal(fetchMock.calls.length, 1);
    assert.ok(fetchMock.calls[0].startsWith('https://api.imf.org/external/sdmx/3.0/structure/dataflow/'));
    assert.equal(dataflows[0].agencyID, 'IMF.STA');
  } finally {
    fetchMock.restore();
  }
});

test('fetchDataflowWithStructure asks for children so the DSD comes back', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/structure/dataflow/IMF.STA/BOP/+')) {
      return {
        body: {
          data: {
            dataflows: [{ id: 'BOP', name: 'Balance of Payments (BOP)', version: '15.0.1', agencyID: 'IMF.STA' }],
            dataStructures: [{ id: 'DSD_BOP', name: 'BOP', version: '24.0.0', agencyID: 'IMF.STA' }]
          }
        }
      };
    }
    return undefined;
  });

  try {
    const detail = await fetchDataflowWithStructure('IMF.STA', 'BOP');
    assert.ok(fetchMock.calls[0].includes('references=children'));
    assert.equal(detail.dataStructure?.id, 'DSD_BOP');
  } finally {
    fetchMock.restore();
  }
});

test('fetchCodelist returns the first codelist under data', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      data: {
        codelists: [
          {
            id: 'CL_BOP_COUNTRY',
            name: 'Country',
            version: '1.0.0',
            agencyID: 'IMF.STA',
            codes: [{ id: 'USA', name: 'United States' }]
          }
        ]
      }
    }
  }));

  try {
    const codelist = await fetchCodelist('IMF.STA', 'CL_BOP_COUNTRY');
    assert.equal(codelist?.codes?.[0].id, 'USA');
  } finally {
    fetchMock.restore();
  }
});

test('buildTimeFilter expands bare years, because ge:2020 is ignored by the API', () => {
  assert.equal(buildTimeFilter('2020', '2023'), 'ge:2020-01-01+le:2023-12-31');
  assert.equal(buildTimeFilter('2020-Q2'), 'ge:2020-04-01');
  assert.equal(buildTimeFilter(undefined, undefined), undefined);
});

test('buildDataUrl puts every dimension in c[] and leaves the key as *', () => {
  const url = buildDataUrl({
    agencyID: 'IMF.STA',
    dataflowID: 'BOP',
    filters: { COUNTRY: 'USA,DEU', INDICATOR: 'CAB', FREQUENCY: '' },
    startPeriod: '2020',
    endPeriod: '2023'
  });

  assert.ok(url.includes('/data/dataflow/IMF.STA/BOP/+/*?'));
  assert.ok(url.includes('c%5BCOUNTRY%5D=USA%2CDEU'));
  assert.ok(url.includes('c%5BINDICATOR%5D=CAB'));
  assert.ok(!url.includes('FREQUENCY'), 'empty filters are dropped');
  assert.ok(url.includes('c%5BTIME_PERIOD%5D=ge%3A2020-01-01%2Ble%3A2023-12-31'));
});

test('parseUrn extracts agency, id, and version', () => {
  assert.deepEqual(parseUrn('urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.STA:CL_BOP_COUNTRY(1.0+.0)'), {
    agencyID: 'IMF.STA',
    id: 'CL_BOP_COUNTRY',
    version: '1.0+.0'
  });
  assert.equal(parseUrn(undefined), null);
});

test('parseDataMessage resolves series index keys and TIME_PERIOD values', () => {
  const parsed = parseDataMessage({
    data: {
      dataSets: [
        {
          series: {
            '0:0:0': { observations: { '1': ['-855203000000', 0], '0': ['-589622000000', 0] } },
            '1:0:0': { observations: { '0': [null] } }
          }
        }
      ],
      structures: [
        {
          dimensions: {
            series: [
              { id: 'COUNTRY', values: [{ id: 'USA' }, { id: 'DEU' }] },
              { id: 'INDICATOR', values: [{ id: 'CAB' }] },
              { id: 'FREQUENCY', values: [{ id: 'A' }] }
            ],
            // Time period entries use `value`, not `id`.
            observation: [{ id: 'TIME_PERIOD', values: [{ value: '2020' }, { value: '2021' }] }]
          }
        }
      ]
    }
  });

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].key, 'USA.CAB.A');
  assert.deepEqual(parsed[0].observations, [
    { period: '2020', value: -589622000000 },
    { period: '2021', value: -855203000000 }
  ]);
  assert.deepEqual(parsed[1].observations, [{ period: '2020', value: null }]);
});

test('parseDataMessage returns nothing for the empty dataSet a bad code produces', () => {
  const parsed = parseDataMessage({
    data: {
      dataSets: [{ structure: 0, action: 'Replace' } as never],
      structures: [{ dimensions: { series: [], observation: [] } }]
    }
  });
  assert.deepEqual(parsed, []);
});
