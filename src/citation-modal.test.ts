// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createChartCitationLine,
  createCitationLine,
  createInlineCitation,
  hasInlineCitations,
  resetCitationModal
} from './citation-modal';
import type { ChartSource } from './chart-sources';
import type { StoredResultCard } from './result-card/types';

const observation = {
  label: 'WB_WDI_NY_GDP_PCAP_CD Data360 observations',
  sourceUrl: 'https://data360api.worldbank.org/data360/data?INDICATOR=WB_WDI_NY_GDP_PCAP_CD',
  fetchedAt: '2026-08-15T09:00:00.000Z',
  quote: 'The Data360 data endpoint returned 4 rows.',
  payload: '{"count":4,"value":[{"REF_AREA":"ISL","OBS_VALUE":66944}]}'
};

const sources: ChartSource[] = [{ plugin: 'World Bank Data360', references: [observation] }];

const card: StoredResultCard = {
  toolName: 'wb_fetch_observations',
  template: {
    name: { singular: 'observation', plural: 'observations' },
    title: 'GDP per capita',
    layout: [
      {
        component: 'Table',
        rows: 'rows',
        columns: [
          { header: 'Year', field: 'year' },
          { header: 'Value', field: 'value' }
        ]
      }
    ]
  },
  data: { rows: [{ year: '2022', value: '74,591' }] }
};

function render(list: ChartSource[], cards: StoredResultCard[] = []): HTMLElement | null {
  const line = createCitationLine(list, cards);
  if (line) document.body.appendChild(line);
  return line;
}

function modal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.citation-modal-overlay');
}

afterEach(() => {
  resetCitationModal();
  document.body.textContent = '';
});

describe('createCitationLine', () => {
  it('labels each chip with the plugin and the dataset', () => {
    const line = render(sources)!;
    const chip = line.querySelector<HTMLButtonElement>('.block-source-chip')!;
    expect(line.querySelector('.block-sources-lead')?.textContent).toBe('Source');
    expect(chip.textContent).toBe('World Bank Data360 · WB_WDI_NY_GDP_PCAP_CD Data360 observations');
    expect(chip.title).toBe(observation.sourceUrl);
  });

  it('pluralizes and collapses the tail once there are many references', () => {
    const many: ChartSource[] = [
      {
        plugin: 'OECD',
        references: Array.from({ length: 8 }, (_, i) => ({ label: `Row ${i}`, sourceUrl: `u${i}` }))
      }
    ];
    const line = render(many)!;
    expect(line.querySelector('.block-sources-lead')?.textContent).toBe('Sources');
    expect(line.querySelectorAll('.block-source-chip')).toHaveLength(6);
    expect(line.querySelector('.block-sources-rest')?.textContent).toBe('+2 more');
  });

  it('renders nothing when the turn cited no API call', () => {
    expect(createCitationLine([])).toBeNull();
    expect(createCitationLine([{ plugin: 'OECD' }])).toBeNull();
  });
});

describe('inline citations', () => {
  const numbered: ChartSource[] = [
    {
      plugin: 'World Bank Data360',
      references: [
        { number: 1, label: 'GDP', quote: 'gdp rows' },
        { number: 2, label: 'Population' }
      ]
    }
  ];

  it('resolves a marker to the reference the turn issued', () => {
    const chip = createInlineCitation(2, numbered)!;
    expect(chip.textContent).toBe('2');
    expect(chip.title).toBe('World Bank Data360 · Population');
    expect(chip.getAttribute('aria-label')).toBe('Source 2: World Bank Data360 · Population');
  });

  it('opens the cited observation', () => {
    const chip = createInlineCitation(1, numbered)!;
    document.body.appendChild(chip);
    chip.click();

    expect(modal()!.querySelector('.citation-modal-quote')?.textContent).toBe('gdp rows');
  });

  it('refuses a number the turn never issued', () => {
    // Models invent citation numbers; an invented one must cite nothing.
    expect(createInlineCitation(9, numbered)).toBeNull();
    expect(createInlineCitation(1, [])).toBeNull();
  });

  it('detects only markers that resolve', () => {
    expect(hasInlineCitations('Iceland reached $74,591 [^2].', numbered)).toBe(true);
    expect(hasInlineCitations('Nothing cited here.', numbered)).toBe(false);
    expect(hasInlineCitations('Made up [^9].', numbered)).toBe(false);
    expect(hasInlineCitations('Cited [^1] but no sources stored.', [])).toBe(false);
  });
});

describe('createChartCitationLine', () => {
  const plotted: ChartSource[] = [
    { plugin: 'OECD Data Explorer', references: [{ number: 4, label: 'PPP series' }] },
    { plugin: 'OECD Data Explorer', references: [{ number: 9, label: 'Consumption series' }] },
    { plugin: 'OECD Data Explorer', references: [{ number: 12, label: 'A codelist row' }] }
  ];

  it('shows a numbered marker per plotted call, not the whole turn', () => {
    const line = createChartCitationLine([4, 9], plotted)!;
    const chips = [...line.querySelectorAll('.inline-citation')].map((chip) => chip.textContent);

    expect(line.querySelector('.block-sources-lead')?.textContent).toBe('Sources');
    expect(chips).toEqual(['4', '9']);
    expect(line.textContent).not.toContain('A codelist row');
  });

  it('names the reference behind each marker on hover', () => {
    const line = createChartCitationLine([9], plotted)!;
    const chip = line.querySelector<HTMLButtonElement>('.inline-citation')!;

    expect(line.querySelector('.block-sources-lead')?.textContent).toBe('Source');
    expect(chip.title).toBe('OECD Data Explorer · Consumption series');
  });

  it('renders nothing when the chart declared numbers the turn never issued', () => {
    expect(createChartCitationLine([99], plotted)).toBeNull();
    expect(createChartCitationLine([], plotted)).toBeNull();
  });
});

describe('the citation modal', () => {
  it('shows the result card the cited call rendered', async () => {
    const cited: ChartSource[] = [{ ...sources[0], cardIndex: 0 }];
    render(cited, [card])!.querySelector<HTMLButtonElement>('.block-source-chip')!.click();
    // The card mounts through React, so let its first render commit.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const host = modal()!;
    expect(host.querySelector('.citation-modal-title')?.textContent).toBe(observation.label);
    expect(host.querySelector('.citation-modal-quote')?.textContent).toBe(observation.quote);
    expect(host.querySelector('.citation-modal-card')?.textContent).toContain('74,591');
    // The card replaces the raw response, not the link out to it.
    expect(host.querySelector('.citation-modal-payload')).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>('.citation-modal-link')?.href).toBe(
      observation.sourceUrl
    );
  });

  it('falls back to the raw payload for a call that rendered no card', () => {
    const line = render(sources)!;
    line.querySelector<HTMLButtonElement>('.block-source-chip')!.click();

    const host = modal()!;
    expect(host.classList.contains('is-hidden')).toBe(false);
    expect(host.querySelector('.citation-modal-card')).toBeNull();
    // The payload is re-indented and highlighted rather than dumped verbatim.
    const payload = host.querySelector('.citation-modal-payload')!;
    expect(payload.textContent).toContain('"REF_AREA": "ISL"');
    expect(payload.querySelector('.json-key')?.textContent).toBe('"count"');
    expect(payload.querySelector('.json-number')?.textContent).toBe('4');
    expect(host.querySelector('.citation-modal-note')).toBeNull();
  });

  it('warns when the payload it shows was cut short', () => {
    render([
      { plugin: 'P', references: [{ label: 'L', payload: '{', payloadTruncated: true }] }
    ])!.querySelector<HTMLButtonElement>('.block-source-chip')!.click();

    expect(modal()!.querySelector('.citation-modal-note')?.textContent).toContain('truncated');
  });

  it('closes on the overlay, the close button, and Escape', () => {
    const line = render(sources)!;
    const chip = line.querySelector<HTMLButtonElement>('.block-source-chip')!;

    chip.click();
    modal()!.querySelector<HTMLButtonElement>('.citation-modal-close')!.click();
    expect(modal()!.classList.contains('is-hidden')).toBe(true);

    chip.click();
    modal()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal()!.classList.contains('is-hidden')).toBe(true);

    chip.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal()!.classList.contains('is-hidden')).toBe(true);
  });

  it('replaces the previous reference rather than stacking modals', () => {
    const two: ChartSource[] = [
      {
        plugin: 'P',
        references: [
          { label: 'First', quote: 'one' },
          { label: 'Second', quote: 'two' }
        ]
      }
    ];
    const chips = render(two)!.querySelectorAll<HTMLButtonElement>('.block-source-chip');

    chips[0].click();
    chips[1].click();

    expect(document.querySelectorAll('.citation-modal-overlay')).toHaveLength(1);
    expect(modal()!.querySelector('.citation-modal-title')?.textContent).toBe('Second');
    expect(modal()!.querySelectorAll('.citation-modal-quote')).toHaveLength(1);
  });
});
