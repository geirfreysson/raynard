// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { appendInlineMarkdownSafe, messageContext } from './inline-markdown';
import { resetCitationModal } from './citation-modal';
import type { ChartSource } from './chart-sources';

const sources: ChartSource[] = [
  {
    plugin: 'Financial Modeling Prep',
    references: [
      {
        label: 'AAPL FMP profile',
        number: 7,
        sourceUrl: 'https://financialmodelingprep.com/stable/profile?symbol=AAPL',
        fetchedAt: '2026-08-30T08:33:06.668Z',
        quote: 'Apple Inc.; market cap $4.70T.'
      },
      {
        label: 'MSFT FMP profile',
        number: 8,
        sourceUrl: 'https://financialmodelingprep.com/stable/profile?symbol=MSFT',
        fetchedAt: '2026-08-30T08:33:07.100Z',
        quote: 'Microsoft Corporation.'
      }
    ]
  }
] as unknown as ChartSource[];

const context = messageContext({ sources });

function render(text: string) {
  const host = document.createElement('p');
  appendInlineMarkdownSafe(host, text, context);
  return host;
}

afterEach(() => {
  resetCitationModal();
});

describe('appendInlineMarkdownSafe', () => {
  it('renders a bare citation marker as a chip', () => {
    const host = render('P/E expanded to 36.5x [^7] over the period.');
    const chips = host.querySelectorAll('button.inline-citation');
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual(['7']);
  });

  it('renders citations inside an italic source line', () => {
    // The shape models actually write for attribution. These used to render as
    // the literal text "[^7]" because <em> was filled with textContent.
    const host = render('*Sources: [^7], [^8]*');
    const emphasis = host.querySelector('em');
    expect(emphasis).not.toBeNull();
    const chips = emphasis!.querySelectorAll('button.inline-citation');
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual(['7', '8']);
    expect(emphasis!.textContent).toBe('Sources: 7, 8');
  });

  it('renders citations inside bold text', () => {
    const host = render('**Apple leads [^7]**');
    const strong = host.querySelector('strong');
    expect(strong?.querySelector('button.inline-citation')?.textContent).toBe('7');
  });

  it('renders a link inside bold text', () => {
    const host = render('**See [the profile](https://example.com/aapl) now**');
    const link = host.querySelector('strong a');
    expect(link?.getAttribute('href')).toBe('https://example.com/aapl');
    expect(link?.textContent).toBe('the profile');
  });

  it('renders inline code and nested emphasis inside bold text', () => {
    const host = render('**Run `npm test` on _every_ change**');
    const strong = host.querySelector('strong');
    expect(strong?.querySelector('code')?.textContent).toBe('npm test');
    expect(strong?.querySelector('em')?.textContent).toBe('every');
    expect(strong?.textContent).toBe('Run npm test on every change');
  });

  it('leaves a marker the turn never issued as literal text', () => {
    const host = render('*Sources: [^99]*');
    expect(host.querySelector('button.inline-citation')).toBeNull();
    expect(host.textContent).toBe('Sources: [^99]');
  });

  it('keeps text around emphasis intact', () => {
    const host = render('before *middle [^7]* after');
    expect(host.textContent).toBe('before middle 7 after');
    expect(host.querySelectorAll('button.inline-citation')).toHaveLength(1);
  });

  it('stops nesting at the depth cap instead of recursing without bound', () => {
    const host = render(`*${'*'.repeat(200)}*`);
    expect(host.textContent).toContain('*');
  });
});
