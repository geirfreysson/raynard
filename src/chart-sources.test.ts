import { describe, expect, it } from 'vitest';
import {
  chartSourceEntries,
  citationsForDisplay,
  extractToolSource,
  MAX_CITATION_PAYLOAD,
  type ChartSource
} from './chart-sources';

const oecdResult = {
  text: '...',
  references: [
    {
      referenceLabel: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4 A.ISL+SWE...',
      referenceMeta: {
        sourceUrl: 'https://sdmx.oecd.org/public/rest/data/x',
        fetchedAt: '2026-08-15T09:00:00.000Z'
      },
      expandedContent: [
        { type: 'header', title: 'ignored' },
        { type: 'text', text: '4 observations' },
        { type: 'json', title: 'Raw API payload', text: '{"value":[1,2]}' }
      ]
    }
  ]
};

describe('extractToolSource', () => {
  it('names the dataset a single-reference call cited', () => {
    const source = extractToolSource(oecdResult, 'oecd_fetch_observations', 'OECD Data Explorer');
    expect(source).toMatchObject({
      plugin: 'OECD Data Explorer',
      label: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4 A.ISL+SWE...',
      sourceUrl: 'https://sdmx.oecd.org/public/rest/data/x'
    });
  });

  it('keeps the quote and raw payload for the citation modal', () => {
    const [citation] = extractToolSource(oecdResult, 'oecd_fetch_observations', 'OECD')!.references!;
    expect(citation).toEqual({
      label: 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4 A.ISL+SWE...',
      sourceUrl: 'https://sdmx.oecd.org/public/rest/data/x',
      fetchedAt: '2026-08-15T09:00:00.000Z',
      quote: '4 observations',
      payload: '{"value":[1,2]}'
    });
  });

  it('truncates an oversized payload and says so', () => {
    const huge = {
      references: [
        {
          referenceLabel: 'Big',
          expandedContent: [{ type: 'json', text: 'x'.repeat(MAX_CITATION_PAYLOAD + 500) }]
        }
      ]
    };
    const [citation] = extractToolSource(huge, 'tool', 'Plugin')!.references!;
    expect(citation.payload).toHaveLength(MAX_CITATION_PAYLOAD);
    expect(citation.payloadTruncated).toBe(true);
  });

  it('names only the plugin when a call cited many references', () => {
    const search = {
      references: [
        { referenceLabel: 'Dataflow A', referenceMeta: { sourceUrl: 'https://a' } },
        { referenceLabel: 'Dataflow B', referenceMeta: { sourceUrl: 'https://b' } }
      ]
    };
    // A catalog search cites every row it found; none of them is the chart's source.
    const source = extractToolSource(search, 'oecd_search_dataflows', 'OECD Data Explorer')!;
    expect(source.plugin).toBe('OECD Data Explorer');
    expect(source.label).toBeUndefined();
    expect(source.references).toHaveLength(2);
  });

  it('keeps every reference the model could cite, with payloads for the first few', () => {
    const many = {
      references: Array.from({ length: 25 }, (_, i) => ({
        referenceLabel: `Row ${i}`,
        citationNumber: i + 1,
        expandedContent: [{ type: 'json', text: `{"row":${i}}` }]
      }))
    };
    const references = extractToolSource(many, 'oecd_search_dataflows', 'OECD')!.references!;

    // Capped at what the sidecar shows the model, so any marker still resolves.
    expect(references).toHaveLength(20);
    expect(references[0].payload).toBe('{"row":0}');
    // The tail carries its label and number only; twenty payloads would bloat
    // the chat history file for a search nobody charted.
    expect(references[3].payload).toBeUndefined();
    expect(references[19].number).toBe(20);
  });

  it('falls back to the tool name when the plugin is unknown', () => {
    expect(extractToolSource(oecdResult, 'oecd_fetch_observations')?.plugin).toBe(
      'oecd_fetch_observations'
    );
  });

  it('ignores results that cited nothing', () => {
    expect(extractToolSource({ text: 'no refs' }, 'x', 'P')).toBeNull();
    expect(extractToolSource({ references: [] }, 'x', 'P')).toBeNull();
    expect(extractToolSource(null, 'x', 'P')).toBeNull();
    expect(extractToolSource('a string', 'x', 'P')).toBeNull();
  });
});

describe('citationsForDisplay', () => {
  it('flattens every call and keeps which plugin served each reference', () => {
    const flattened = citationsForDisplay([
      { plugin: 'OECD', references: [{ label: 'PPP', sourceUrl: 'https://a' }] },
      { plugin: 'World Bank', references: [{ label: 'GDP', sourceUrl: 'https://b' }] }
    ]);
    expect(flattened.map((entry) => `${entry.plugin}:${entry.citation.label}`)).toEqual([
      'OECD:PPP',
      'World Bank:GDP'
    ]);
  });

  it('drops a reference two calls both cited', () => {
    const flattened = citationsForDisplay([
      { plugin: 'OECD', references: [{ label: 'PPP', sourceUrl: 'https://a' }] },
      { plugin: 'OECD', references: [{ label: 'PPP', sourceUrl: 'https://a' }] }
    ]);
    expect(flattened).toHaveLength(1);
  });

  it('is empty when the calls cited nothing storable', () => {
    expect(citationsForDisplay([{ plugin: 'OECD' }])).toEqual([]);
  });
});

describe('chartSourceEntries', () => {
  const wb: ChartSource = {
    plugin: 'World Bank Data360',
    references: [{ number: 1, label: 'WB_WDI_NY_GDP_PCAP_CD Data360 observations' }]
  };
  const orc: ChartSource = {
    plugin: 'Dnd 5e Api',
    references: [{ number: 2, label: 'D&D 5e monster: Orc' }]
  };
  const goblin: ChartSource = {
    plugin: 'Dnd 5e Api',
    references: [{ number: 3, label: 'D&D 5e monster: Goblin' }]
  };
  // What a catalog search cites: every row it found, none of them charted.
  const lookup: ChartSource = {
    plugin: 'Dnd 5e Api',
    references: [
      { number: 4, label: 'Barrels' },
      { number: 5, label: 'Total' },
      { number: 6, label: 'Households' }
    ]
  };

  it('names each fetched reference rather than counting calls', () => {
    expect(chartSourceEntries([wb, orc, goblin])).toEqual([
      'WB_WDI_NY_GDP_PCAP_CD Data360 observations',
      'D&D 5e monster: Orc',
      'D&D 5e monster: Goblin'
    ]);
  });

  it('leaves lookup calls out of the uncited fallback', () => {
    expect(chartSourceEntries([lookup, orc])).toEqual(['D&D 5e monster: Orc']);
  });

  it('still cites a lookup reference when the answer named it', () => {
    expect(chartSourceEntries([lookup, orc], [5])).toEqual(['Total']);
  });

  it('narrows to the references the answer actually cited', () => {
    expect(chartSourceEntries([wb, orc, goblin], [3])).toEqual(['D&D 5e monster: Goblin']);
  });

  it('drops a call whose references were not cited', () => {
    expect(chartSourceEntries([wb, orc], [1])).toEqual([
      'WB_WDI_NY_GDP_PCAP_CD Data360 observations'
    ]);
  });

  it('falls back to the plugin when a call named nothing', () => {
    expect(chartSourceEntries([{ plugin: 'Hacker News' }])).toEqual(['Hacker News']);
  });

  it('names the plugins when every call was a lookup', () => {
    expect(chartSourceEntries([lookup])).toEqual(['Dnd 5e Api']);
  });

  it('does not repeat a reference two calls share', () => {
    expect(chartSourceEntries([wb, { ...wb }])).toEqual([
      'WB_WDI_NY_GDP_PCAP_CD Data360 observations'
    ]);
  });

  it('is empty when nothing was collected', () => {
    expect(chartSourceEntries([])).toEqual([]);
  });
});
