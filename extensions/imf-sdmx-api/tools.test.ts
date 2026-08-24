import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectToolResult, mockFetch } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

const DATAFLOW_LIST = {
  data: {
    dataflows: [
      {
        id: 'BOP',
        name: 'Balance of Payments (BOP)',
        description: 'Transactions between residents and nonresidents.',
        version: '15.0.1',
        agencyID: 'IMF.STA'
      },
      {
        id: 'GFSMAB',
        name: 'Government Finance Statistics (GFS), Main Aggregates and Balances',
        version: '3.0.0',
        agencyID: 'IMF.STA'
      },
      { id: 'WEO', name: 'World Economic Outlook (WEO)', version: '1.0.0', agencyID: 'IMF.RES' }
    ]
  }
};

const DATAFLOW_DETAIL = {
  data: {
    dataflows: [{ id: 'BOP', name: 'Balance of Payments (BOP)', version: '15.0.1', agencyID: 'IMF.STA' }],
    dataStructures: [
      {
        id: 'DSD_BOP',
        name: 'BOP',
        version: '24.0.0',
        agencyID: 'IMF.STA',
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'COUNTRY',
                position: 0,
                // Live IMF dimensions carry no localRepresentation; the codelist
                // is only reachable through the concept scheme.
                conceptIdentity: 'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_BOP(17.0+.0).COUNTRY'
              },
              {
                id: 'FREQUENCY',
                position: 1,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF:CS_MASTER_SYSTEM(1.0+.0).FREQ'
              }
            ]
          }
        }
      }
    ]
  }
};

const DSD_CONCEPTS = {
  data: {
    conceptSchemes: [
      {
        id: 'CS_BOP',
        agencyID: 'IMF.STA',
        version: '17.0.0',
        concepts: [
          {
            id: 'COUNTRY',
            coreRepresentation: {
              enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.STA:CL_BOP_COUNTRY(1.0+.0)'
            }
          }
        ]
      },
      {
        id: 'CS_MASTER_SYSTEM',
        agencyID: 'IMF',
        version: '1.0.0',
        concepts: [
          {
            id: 'FREQ',
            coreRepresentation: {
              enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF:CL_FREQ(1.0+.0)'
            }
          }
        ]
      }
    ]
  }
};

function routeStructure(url: string) {
  if (url.includes('/structure/dataflow/*/*/+')) return { body: DATAFLOW_LIST };
  if (url.includes('/structure/dataflow/IMF.STA/BOP/')) return { body: DATAFLOW_DETAIL };
  if (url.includes('/structure/datastructure/IMF.STA/DSD_BOP/')) return { body: DSD_CONCEPTS };
  return undefined;
}

test('imf_list_dataflows filters, bounds, and reports the match count', async () => {
  const fetchMock = mockFetch(routeStructure);
  try {
    const result = expectToolResult(await tools.imf_list_dataflows.execute({ query: 'government finance' }));
    assert.equal(result.data.matched, 1);
    assert.equal((result.data.dataflows as Array<{ id: string }>)[0].id, 'GFSMAB');
    assert.ok(result.text.includes('IMF.STA:GFSMAB'));
    assert.equal(result.references.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test('imf_list_dataflows keeps an empty result useful', async () => {
  const fetchMock = mockFetch(routeStructure);
  try {
    const result = expectToolResult(await tools.imf_list_dataflows.execute({ query: 'no such dataset' }));
    assert.equal(result.data.matched, 0);
    assert.deepEqual(result.data.dataflows, []);
    assert.ok(result.text.includes('No IMF dataflow matches'));
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_dataflow resolves the agency and maps dimensions to codelists', async () => {
  const fetchMock = mockFetch(routeStructure);
  try {
    const result = expectToolResult(await tools.imf_get_dataflow.execute({ dataflow_id: 'BOP' }));
    const dimensions = result.data.dimensions as Array<{ id: string; codelistId: string; codelistAgency: string }>;
    assert.equal(result.data.agencyID, 'IMF.STA');
    assert.equal(result.data.dataStructureId, 'IMF.STA:DSD_BOP');
    assert.deepEqual(
      dimensions.map((dimension) => `${dimension.id}:${dimension.codelistAgency}:${dimension.codelistId}`),
      ['COUNTRY:IMF.STA:CL_BOP_COUNTRY', 'FREQUENCY:IMF:CL_FREQ']
    );
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_dataflow rejects an unknown dataflow with a routing hint', async () => {
  const fetchMock = mockFetch(routeStructure);
  try {
    await assert.rejects(
      () => tools.imf_get_dataflow.execute({ dataflow_id: 'NOPE' }),
      /No IMF dataflow with ID "NOPE"/
    );
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_codelist falls back from IMF.STA to IMF and filters codes', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/structure/codelist/IMF.STA/CL_FREQ/')) return { body: {} };
    if (url.includes('/structure/codelist/IMF/CL_FREQ/')) {
      return {
        body: {
          data: {
            codelists: [
              {
                id: 'CL_FREQ',
                name: 'Frequency',
                version: '1.0.0',
                agencyID: 'IMF',
                codes: [
                  { id: 'A', name: 'Annual' },
                  { id: 'Q', name: 'Quarterly' },
                  { id: 'M', name: 'Monthly' }
                ]
              }
            ]
          }
        }
      };
    }
    return undefined;
  });

  try {
    const result = expectToolResult(
      await tools.imf_get_codelist.execute({ codelist_id: 'CL_FREQ', query: 'quarter' })
    );
    assert.equal(result.data.agencyID, 'IMF');
    assert.equal(result.data.totalCodes, 3);
    assert.deepEqual(result.data.codes, [{ id: 'Q', name: 'Quarterly' }]);
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_data sends c[] filters and flattens the series message', async () => {
  const fetchMock = mockFetch((url) => {
    const structure = routeStructure(url);
    if (structure) return structure;
    if (url.includes('/data/dataflow/IMF.STA/BOP/+/*')) {
      return {
        body: {
          data: {
            dataSets: [{ series: { '0:0:0': { observations: { '0': ['-589622000000'], '1': ['-855203000000'] } } } }],
            structures: [
              {
                dimensions: {
                  series: [
                    { id: 'COUNTRY', values: [{ id: 'USA' }] },
                    { id: 'INDICATOR', values: [{ id: 'CAB' }] },
                    { id: 'FREQUENCY', values: [{ id: 'A' }] }
                  ],
                  observation: [{ id: 'TIME_PERIOD', values: [{ value: '2020' }, { value: '2021' }] }]
                }
              }
            ]
          }
        }
      };
    }
    return undefined;
  });

  try {
    const result = expectToolResult(
      await tools.imf_get_data.execute({
        dataflow_id: 'BOP',
        filters: [
          { dimension: 'COUNTRY', values: 'USA' },
          { dimension: 'INDICATOR', values: 'CAB' }
        ],
        start_period: '2020',
        end_period: '2021'
      })
    );

    const dataCall = fetchMock.calls.find((call) => call.includes('/data/dataflow/')) ?? '';
    assert.ok(dataCall.includes('/BOP/+/*?'), 'key stays * so the c[] filters apply');
    assert.ok(dataCall.includes('c%5BCOUNTRY%5D=USA'));
    assert.ok(dataCall.includes('c%5BTIME_PERIOD%5D=ge%3A2020-01-01%2Ble%3A2021-12-31'));
    assert.equal(result.data.seriesCount, 1);
    assert.equal(result.data.observationCount, 2);
    assert.deepEqual(result.data.observations, [
      { series: 'USA.CAB.A', period: '2020', value: -589622000000 },
      { series: 'USA.CAB.A', period: '2021', value: -855203000000 }
    ]);
    assert.ok(result.text.includes('2021: -855203000000'));
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_data explains the silent empty dataset a wrong code produces', async () => {
  const fetchMock = mockFetch((url) => {
    const structure = routeStructure(url);
    if (structure) return structure;
    if (url.includes('/data/dataflow/')) {
      return { body: { data: { dataSets: [{ structure: 0, action: 'Replace' }], structures: [{ dimensions: {} }] } } };
    }
    return undefined;
  });

  try {
    const result = expectToolResult(
      await tools.imf_get_data.execute({
        dataflow_id: 'BOP',
        filters: [{ dimension: 'COUNTRY', values: 'US' }]
      })
    );
    assert.equal(result.data.seriesCount, 0);
    assert.deepEqual(result.data.observations, []);
    assert.ok(result.text.includes('returned no observations'));
    assert.ok(result.text.includes('imf_get_codelist'));
  } finally {
    fetchMock.restore();
  }
});

test('imf_get_availability reports coverage metrics from constraint annotations', async () => {
  const fetchMock = mockFetch((url) => {
    const structure = routeStructure(url);
    if (structure) return structure;
    if (url.includes('/availability/dataflow/IMF.STA/BOP/')) {
      return {
        body: {
          data: {
            dataConstraints: [
              {
                id: 'BOP',
                agencyID: 'IMF.STA',
                version: '21.0.0',
                annotations: [
                  { id: 'series_count', title: '405103', type: 'sdmx_metrics' },
                  { id: 'time_period_start', title: '1948-01-01', type: 'sdmx_metrics' },
                  { id: 'time_period_end', title: '2026-07-01', type: 'sdmx_metrics' }
                ],
                cubeRegions: [{ components: [{ id: 'COUNTRY' }, { id: 'INDICATOR' }], keyValues: [] }]
              }
            ]
          }
        }
      };
    }
    return undefined;
  });

  try {
    const result = expectToolResult(await tools.imf_get_availability.execute({ dataflow_id: 'BOP' }));
    assert.equal(result.data.seriesCount, '405103');
    assert.equal(result.data.timePeriodStart, '1948-01-01');
    assert.deepEqual(result.data.dimensions, [{ id: 'COUNTRY' }, { id: 'INDICATOR' }]);
    assert.ok(result.text.includes('imf_get_codelist'));
  } finally {
    fetchMock.restore();
  }
});

test('every tool exposes a fixed declarative card', () => {
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.card, `${name} must define a card`);
    assert.ok(tool.card.name.singular && tool.card.name.plural, `${name} card needs singular/plural names`);
    assert.ok(Array.isArray(tool.card.layout) && tool.card.layout.length, `${name} card needs a layout`);
    assert.equal(tool.parameters.type, 'object');
  }
});
