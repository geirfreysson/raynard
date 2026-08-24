import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

const NAMAIN10_DIMENSIONS = [
  { id: 'FREQ', position: 0, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=SDMX:CL_FREQ(2.1)' } },
  { id: 'REF_AREA', position: 1, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD:CL_AREA(1.1)' } },
  { id: 'SECTOR', position: 2, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD:CL_SECTOR(1.1)' } },
  { id: 'COUNTERPART_SECTOR', position: 3, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD:CL_SECTOR(1.1)' } },
  { id: 'TRANSACTION', position: 4, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD.SDD.NAD:CL_TRANSACTION(1.0)' } },
  { id: 'TABLE_IDENTIFIER', position: 5, localRepresentation: { enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD.SDD.NAD:CL_TABLEID(1.0)' } }
];
const NAMAIN10_CODELISTS = [
  { agencyID: 'SDMX', id: 'CL_FREQ', version: '2.1', codes: [{ id: 'A', name: 'Annual' }] },
  { agencyID: 'OECD', id: 'CL_AREA', version: '1.1', codes: [{ id: 'ISL', name: 'Iceland' }, { id: 'SWE', name: 'Sweden' }] },
  { agencyID: 'OECD', id: 'CL_SECTOR', version: '1.1', codes: [{ id: 'S1', name: 'Total economy' }] },
  { agencyID: 'OECD.SDD.NAD', id: 'CL_TRANSACTION', version: '1.0', codes: [{ id: 'PPP_B1GQ', name: 'Purchasing power parities for GDP' }] },
  { agencyID: 'OECD.SDD.NAD', id: 'CL_TABLEID', version: '1.0', codes: [{ id: 'T4', name: 'Table 4' }] }
];
const structurePayload = () => ({
  data: {
    dataflows: [{ id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', version: '1.0', structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAMAIN10(1.0)' }],
    dataStructures: [{ id: 'DSD_NAMAIN10', version: '1.0', name: 'National accounts', dataStructureComponents: { dimensionList: { dimensions: NAMAIN10_DIMENSIONS } } }],
    codelists: NAMAIN10_CODELISTS
  }
});
// The gateway serves several versions of a dataflow at once; a version-less
// data request uses the newest, so structure resolution must too.
const versionedStructurePayload = () => ({
  data: {
    dataflows: [
      { id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', version: '1.0', structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAMAIN10(1.0)' },
      { id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', version: '2.0', structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAMAIN10(2.0)' }
    ],
    dataStructures: [
      { id: 'DSD_NAMAIN10', version: '1.0', dataStructureComponents: { dimensionList: { dimensions: NAMAIN10_DIMENSIONS.slice(0, 3) } } },
      { id: 'DSD_NAMAIN10', version: '2.0', dataStructureComponents: { dimensionList: { dimensions: NAMAIN10_DIMENSIONS } } }
    ],
    codelists: NAMAIN10_CODELISTS
  }
});
const observationPayload = () => ({
  data: {
    structures: [{
      dimensions: {
        observation: [
          { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
          { id: 'REF_AREA', values: [{ id: 'SWE', name: 'Sweden' }, { id: 'ISL', name: 'Iceland' }] },
          { id: 'TIME_PERIOD', values: [{ id: '2015' }, { id: '2016' }] }
        ]
      }
    }],
    dataSets: [{ observations: { '0:1:0': [1.44], '0:1:1': [1.51], '0:0:0': [8.9] } }]
  },
  meta: { schema: 'mock' }
});

test('oecd_search_dataflows keeps whole dataflow ids and reports a usable flowRef', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/dataflow\/all\/all\/all/);
    return { body: { data: { dataflows: [
      { id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', version: '1.0', name: 'Annual Purchasing Power Parities and exchange rates' },
      { id: 'DSD_NAMAIN10@DF_TABLE4_PPP_P41', agencyID: 'OECD.SDD.NAD', version: '1.0', names: { en: 'Annual Purchasing Power Parities for actual individual consumption' } }
    ] } } };
  });
  try {
    const result = await tools.oecd_search_dataflows.execute({ q: 'purchasing power parities', limit: 10 });
    expectToolResult(result);
    assert.match(result.text, /OECD\.SDD\.NAD,DSD_NAMAIN10@DF_TABLE4/);
    const rows = result.data.flows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'DSD_NAMAIN10@DF_TABLE4');
    assert.equal(rows[0].flowRef, 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4');
    // The `names` object form must resolve too, or the row looks unnamed.
    assert.match(String(rows[1].name), /actual individual consumption/);
  } finally {
    fetchMock.restore();
  }
});

test('oecd_parse_data_explorer_url keeps df[id] whole in the flowRef', async () => {
  const url = 'https://data-explorer.oecd.org/vis?df[ds]=DisseminateFinalDMZ&df[id]=DSD_NAMAIN10%40DF_TABLE4&df[ag]=OECD.SDD.NAD&dq=A.ISL%2BSWE...PPP_B1GQ.......&lom=LASTNPERIODS&lo=10&to[TIME_PERIOD]=false';
  const result = await tools.oecd_parse_data_explorer_url.execute({ url });
  expectToolResult(result);
  assert.equal(result.data.agencyID, 'OECD.SDD.NAD');
  assert.equal(result.data.structureID, 'DSD_NAMAIN10');
  assert.equal(result.data.dataflowID, 'DSD_NAMAIN10@DF_TABLE4');
  // Dropping the DSD_NAMAIN10@ prefix here is what made every data call 404.
  assert.equal(result.data.flowRef, 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4');
  assert.equal(result.data.dq, 'A.ISL+SWE...PPP_B1GQ.......');
  assert.equal(result.data.key, 'A.ISL+SWE...PPP_B1GQ.......');
  assert.equal(result.data.lastNObservations, 10);
});

test('oecd_inspect_dataflow_structure resolves codelist URNs and accepts a dataflow id', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/datastructure\/OECD\.SDD\.NAD\/DSD_NAMAIN10\/all/);
    assert.doesNotMatch(url, /references=/);
    return { body: structurePayload() };
  });
  try {
    const result = await tools.oecd_inspect_dataflow_structure.execute({ agencyID: 'OECD.SDD.NAD', structureID: 'DSD_NAMAIN10@DF_TABLE4' });
    expectToolResult(result);
    const dimensions = result.data.dimensions as any[];
    assert.equal(dimensions[0].id, 'FREQ');
    assert.equal(dimensions[0].codelistID, 'CL_FREQ');
    assert.equal(dimensions[0].codelistAgencyID, 'SDMX');
    assert.equal(dimensions[0].codelistVersion, '2.1');
    assert.equal(dimensions[1].codelistAgencyID, 'OECD');
    assert.equal(result.data.keyOrder, 'FREQ.REF_AREA.SECTOR.COUNTERPART_SECTOR.TRANSACTION.TABLE_IDENTIFIER');
  } finally { fetchMock.restore(); }
});

test('oecd_get_codelist_values reads SDMX 1.0 codes and picks the requested codelist', async () => {
  const fetchMock = mockFetch((url) => {
    assert.match(url, /\/codelist\/OECD\/CL_AREA\/1\.1/);
    return { body: { data: { codelists: [
      { id: 'CL_TRANSACTION', codes: [{ id: 'PPP_B1GQ', name: 'PPP for GDP' }] },
      { id: 'CL_AREA', names: { en: 'Area' }, codes: [{ id: 'ISL', names: { en: 'Iceland' } }, { id: 'SWE', name: 'Sweden' }] }
    ] } } };
  });
  try {
    const result = await tools.oecd_get_codelist_values.execute({ agencyID: 'OECD', codelistID: 'CL_AREA', version: '1.1', q: 'iceland' });
    expectToolResult(result);
    assert.match(result.text, /ISL: Iceland/);
    assert.equal((result.data.codes as any[])[0].id, 'ISL');
  } finally { fetchMock.restore(); }
});

test('oecd_fetch_observations expands a short key against the live structure', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/dataflow/')) {
      // referencepartial is answered with HTTP 501 unless the version is
      // concrete, so an unversioned flowRef resolves the version first.
      if (!url.includes('references=')) {
        assert.match(url, /\/DSD_NAMAIN10@DF_TABLE4\/all$/);
        return { body: structurePayload() };
      }
      assert.match(url, /\/DSD_NAMAIN10@DF_TABLE4\/1\.0\?/);
      assert.match(url, /references=all/);
      assert.match(url, /detail=referencepartial/);
      return { body: structurePayload() };
    }
    if (url.includes('/codelist/')) throw new Error(`key resolution should not fetch codelists: ${url}`);
    assert.match(url, /\/data\/OECD\.SDD\.NAD,DSD_NAMAIN10@DF_TABLE4\//);
    // FREQ.REF_AREA.SECTOR.COUNTERPART_SECTOR.TRANSACTION.TABLE_IDENTIFIER
    assert.ok(url.includes('/A.ISL+SWE...PPP_B1GQ.?'), `unexpected key in ${url}`);
    assert.match(url, /startPeriod=2015/);
    return { body: observationPayload() };
  });
  try {
    const result = await tools.oecd_fetch_observations.execute({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', key: 'A.ISL+SWE.PPP_B1GQ', startPeriod: '2015' });
    expectToolResult(result);
    assert.equal(result.data.key, 'A.ISL+SWE...PPP_B1GQ.');
    assert.equal(result.data.originalKey, 'A.ISL+SWE.PPP_B1GQ');
    assert.match(result.text, /3 observations/);
    const rows = result.data.observations as any[];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].country, 'Iceland');
    assert.equal(rows[0].countryCode, 'ISL');
    assert.equal(rows[0].timePeriod, '2015');
    assert.equal(rows[0].value, 1.44);
    assert.equal(rows[1].timePeriod, '2016');
    assert.equal(rows[2].country, 'Sweden');
  } finally { fetchMock.restore(); }
});

test('oecd_fetch_observations builds a key from a dimensions object', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/dataflow/')) return { body: structurePayload() };
    assert.ok(url.includes('/A.ISL+SWE...PPP_B1GQ.?'), `unexpected key in ${url}`);
    return { body: observationPayload() };
  });
  try {
    const result = await tools.oecd_fetch_observations.execute({
      flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4',
      dimensions: { FREQ: 'A', REF_AREA: ['ISL', 'SWE'], TRANSACTION: 'PPP_B1GQ' }
    });
    expectToolResult(result);
    assert.equal(result.data.key, 'A.ISL+SWE...PPP_B1GQ.');
  } finally { fetchMock.restore(); }
});

test('oecd_fetch_observations resolves the newest dataflow version, matching a version-less data request', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/dataflow/')) return { body: versionedStructurePayload() };
    // Six dimensions is the v2.0 structure; picking v1.0 would send three.
    assert.ok(url.includes('/A.ISL+SWE...PPP_B1GQ.?'), `unexpected key in ${url}`);
    return { body: observationPayload() };
  });
  try {
    const result = await tools.oecd_fetch_observations.execute({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', key: 'A.ISL+SWE.PPP_B1GQ' });
    expectToolResult(result);
    assert.equal(result.data.keyOrder, 'FREQ.REF_AREA.SECTOR.COUNTERPART_SECTOR.TRANSACTION.TABLE_IDENTIFIER');
  } finally { fetchMock.restore(); }
});

test('oecd_fetch_observations reports the real dimension order for an unresolvable key', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/dataflow/')) return { body: structurePayload() };
    throw new Error(`observations should not be requested for an invalid key: ${url}`);
  });
  try {
    await assert.rejects(
      tools.oecd_fetch_observations.execute({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', key: 'A.NOPE.NOPE2' }),
      /FREQ\.REF_AREA\.SECTOR\.COUNTERPART_SECTOR\.TRANSACTION\.TABLE_IDENTIFIER/
    );
    await assert.rejects(
      tools.oecd_fetch_observations.execute({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', dimensions: { COUNTRY: 'ISL' } }),
      /Unknown dimension\(s\) COUNTRY/
    );
  } finally { fetchMock.restore(); }
});

test('oecd_search_dataflows matches natural-language queries term by term', async () => {
  const fetchMock = mockFetch(() => ({ body: { data: { dataflows: [
    { id: 'DSD_NAMAIN10@DF_TABLE4', agencyID: 'OECD.SDD.NAD', version: '1.0', name: 'Annual Purchasing Power Parities and exchange rates' },
    { id: 'DSD_NAMAIN10@DF_TABLE1', agencyID: 'OECD.SDD.NAD', version: '1.0', name: 'GDP per capita in PPP US dollars' },
    { id: 'DSD_HEALTH@DF_BEDS', agencyID: 'OECD.ELS.HD', version: '1.0', name: 'Hospital beds' }
  ] } } }));
  try {
    // A whole-phrase `includes` match found nothing here and the tool then threw
    // "Tool result must include at least one API reference".
    const result = await tools.oecd_search_dataflows.execute({ q: 'GDP per capita PPP US dollars', limit: 10 });
    expectToolResult(result);
    const rows = result.data.flows as any[];
    assert.equal(rows[0].id, 'DSD_NAMAIN10@DF_TABLE1');
    assert.ok(rows.every((row) => row.id !== 'DSD_HEALTH@DF_BEDS'));
  } finally { fetchMock.restore(); }
});

test('oecd_search_dataflows returns an empty result instead of failing the turn', async () => {
  const fetchMock = mockFetch(() => ({ body: { data: { dataflows: [{ id: 'DSD_HEALTH@DF_BEDS', agencyID: 'OECD.ELS.HD', version: '1.0', name: 'Hospital beds' }] } } }));
  try {
    const result = await tools.oecd_search_dataflows.execute({ q: 'zzz nonexistent topic' });
    expectToolResult(result);
    assert.equal((result.data.flows as any[]).length, 0);
    assert.match(result.text, /No OECD dataflow matched/);
    // assertToolResult rejects an empty references array, so the registry itself
    // has to be cited when nothing matched.
    assert.equal(result.references.length, 1);
  } finally { fetchMock.restore(); }
});

test('oecd_get_codelist_values cites the codelist when no code matches', async () => {
  const fetchMock = mockFetch(() => ({ body: { data: { codelists: [{ id: 'CL_AREA', codes: [{ id: 'ISL', name: 'Iceland' }] }] } } }));
  try {
    const result = await tools.oecd_get_codelist_values.execute({ agencyID: 'OECD', codelistID: 'CL_AREA', q: 'atlantis' });
    expectToolResult(result);
    assert.equal((result.data.codes as any[]).length, 0);
    assert.equal(result.references.length, 1);
  } finally { fetchMock.restore(); }
});

test('oecd_fetch_observations names an invalid code instead of forwarding it', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/dataflow/')) return { body: structurePayload() };
    throw new Error(`should not request data for an invalid code: ${url}`);
  });
  try {
    await assert.rejects(
      tools.oecd_fetch_observations.execute({ flowRef: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4', dimensions: { FREQ: 'A', REF_AREA: 'ATLANTIS' } }),
      /REF_AREA does not serve ATLANTIS.*Available codes include: ISL, SWE/s
    );
  } finally { fetchMock.restore(); }
});
