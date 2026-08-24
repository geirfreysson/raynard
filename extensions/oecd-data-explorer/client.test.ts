import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import { BASE, DATA_ACCEPT, STRUCTURE_ACCEPT, fetchCodelist, fetchDataflowReferences, fetchDataflowStructure, fetchDataflows, fetchObservations } from './client.ts';

test('every request goes to the public OECD SDMX gateway', () => {
  // Written out rather than derived from BASE: a mock that matches on a path
  // fragment stays green through a total rewrite of the host, so this literal
  // is the only thing that fails when the origin changes.
  assert.equal(BASE, 'https://sdmx.oecd.org/public/rest');
});

test('structure and data endpoints negotiate the versions the gateway actually serves', () => {
  // Structure endpoints answer structure+json 1.0 only; asking for 2.0 there
  // returns HTTP 406. The data endpoint is the opposite and serves 2.0.
  // Exact spellings from "OECD Data API documentation" (22 July 2024).
  assert.equal(STRUCTURE_ACCEPT, 'application/vnd.sdmx.structure+json; charset=utf-8; version=1.0');
  assert.equal(DATA_ACCEPT, 'application/vnd.sdmx.data+json; charset=utf-8; version=2');
});

test('fetchDataflows sends SDMX dataflow request with query parameters', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /^https:\/\/sdmx\.oecd\.org\/public\/rest\/dataflow\/all\/all\/all/);
    assert.match(url, /detail=allstubs/);
    return { body: { data: { dataflows: [{ id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', name: 'Annual Purchasing Power Parities' }] } } };
  });
  try {
    const flows = await fetchDataflows();
    assert.equal(flows.data.dataflows[0].id, 'DSD_NAMAIN10@DF_TABLE4');
  } finally {
    fetchMock.restore();
  }
});

test('fetchDataflowReferences uses the documented references=all&detail=referencepartial query', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/dataflow\/OECD\.SDD\.NAD\/DSD_NAMAIN10@DF_TABLE4\/all/);
    // referencepartial returns only the codes the dataflow serves: 40 KB gzipped
    // instead of the 1.2 MB references=all returns for this structure.
    assert.match(url, /references=all/);
    assert.match(url, /detail=referencepartial/);
    return { body: { data: { dataStructures: [{ id: 'DSD_NAMAIN10' }] } } };
  });
  try {
    const payload = await fetchDataflowReferences({ agencyID: 'OECD.SDD.NAD', dataflowID: 'DSD_NAMAIN10@DF_TABLE4' });
    assert.equal(((payload.data as any).dataStructures[0].id), 'DSD_NAMAIN10');
  } finally {
    fetchMock.restore();
  }
});

test('fetchDataflowStructure asks for no references, which the dimension list does not need', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/datastructure\/OECD\.SDD\.NAD\/DSD_NAMAIN10\/1\.0/);
    // references=all costs 276 KB here for identical dimension output, and
    // detail=referencepartial is answered with HTTP 501 on this endpoint.
    assert.doesNotMatch(url, /references=/);
    assert.doesNotMatch(url, /detail=/);
    return { body: { data: { dataStructures: [{ id: 'DSD_NAMAIN10' }] } } };
  });
  try {
    const structure = await fetchDataflowStructure({ agencyID: 'OECD.SDD.NAD', structureID: 'DSD_NAMAIN10', version: '1.0' });
    assert.equal(((structure.data as any).dataStructures[0].id), 'DSD_NAMAIN10');
  } finally {
    fetchMock.restore();
  }
});

test('fetchCodelist omits detail=allstubs so the codes come back', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/codelist\/SDMX\/CL_FREQ\/2\.1/);
    assert.doesNotMatch(url, /allstubs/);
    return { body: { data: { codelists: [{ id: 'CL_FREQ', codes: [{ id: 'A', name: 'Annual' }] }] } } };
  });
  try {
    const codelist = await fetchCodelist({ agencyID: 'SDMX', codelistID: 'CL_FREQ', version: '2.1' });
    assert.equal(((codelist.data as any).codelists[0].codes[0].id), 'A');
  } finally {
    fetchMock.restore();
  }
});

test('fetchObservations uses the camelCase dimensionAtObservation parameter', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/data\/OECD\.SDD\.NAD,DSD_NAMAIN10@DF_TABLE4\/A\.ISL\+SWE/);
    assert.match(url, /startPeriod=2015/);
    assert.match(url, /endPeriod=2023/);
    assert.match(url, /lastNObservations=5/);
    assert.match(url, /dimensionAtObservation=AllDimensions/);
    // The snake_case spelling is rejected by the gateway with HTTP 422.
    assert.doesNotMatch(url, /dimension_at_observation/);
    return { body: { data: { dataSets: [{ observations: { '0:0:0': [1.5] } }] } } };
  });
  try {
    const data = await fetchObservations({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', key: 'A.ISL+SWE...PPP_B1GQ.......', startPeriod: '2015', endPeriod: '2023', lastNObservations: 5 });
    assert.ok(data.data);
  } finally {
    fetchMock.restore();
  }
});
