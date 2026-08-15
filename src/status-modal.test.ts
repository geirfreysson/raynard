// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeStatusModal,
  contextFillPercent,
  formatResetAt,
  formatTokens,
  openStatusModal,
  resetStatusModal,
  type ChatUsageSnapshot,
  type ProviderQuota,
  type StatusModalData
} from './status-modal';

afterEach(() => {
  resetStatusModal();
  document.body.textContent = '';
});

const chat: ChatUsageSnapshot = {
  provider: 'claude',
  model: 'claude-3-5-sonnet-latest',
  contextTokens: 48_000,
  contextWindow: 200_000,
  input: 120_000,
  output: 9_000,
  cacheRead: 4_000,
  cacheWrite: 500,
  totalTokens: 133_500,
  turns: 6
};

const data: StatusModalData = {
  chat,
  totals: {
    totals: {
      'claude/claude-3-5-sonnet-latest': {
        input: 500_000,
        output: 40_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 540_000,
        turns: 20
      }
    }
  }
};

const overlay = () => document.querySelector<HTMLElement>('.status-modal-overlay');
const never = () => new Promise<ProviderQuota>(() => {});

describe('openStatusModal', () => {
  it('paints local numbers synchronously without waiting on the provider', () => {
    openStatusModal(data, never);

    const host = overlay();
    expect(host).not.toBeNull();
    expect(host?.classList.contains('is-hidden')).toBe(false);
    // The context meter is present and correct before any quota resolves.
    const meter = host?.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute('aria-valuenow')).toBe('24');
    expect(host?.textContent).toContain('48k / 200k');
    expect(host?.querySelector('.status-quota-loading')).not.toBeNull();
  });

  it('lists all-time totals and says what they exclude', () => {
    openStatusModal(data, never);

    const text = overlay()?.textContent ?? '';
    expect(text).toContain('claude/claude-3-5-sonnet-latest');
    expect(text).toContain('540k');
    expect(text).toContain('20 turns');
    expect(text).toContain('Chat turns only');
  });

  it('renders quota windows with reset times once they arrive', async () => {
    const quota: ProviderQuota = {
      providerId: 'openai-codex',
      providerName: 'ChatGPT',
      kind: 'windows',
      plan: 'plus',
      windows: [
        { label: '5 hours', usedPercent: 42, resetsAt: Date.now() + 3 * 3_600_000 },
        { label: 'Weekly', usedPercent: 7, resetsAt: null }
      ],
      fetchedAt: Date.now()
    };
    openStatusModal(data, () => Promise.resolve(quota));
    await vi.waitFor(() => {
      expect(overlay()?.querySelector('.status-quota-loading')).toBeNull();
    });

    const text = overlay()?.textContent ?? '';
    expect(text).toContain('42% used');
    expect(text).toMatch(/resets in \d+h/);
    expect(text).toContain('Plan: plus');
    // Three meters: one for context, two for the quota windows.
    expect(overlay()?.querySelectorAll('[role="progressbar"]').length).toBe(3);
  });

  it('renders a balance with no meter', async () => {
    openStatusModal(data, () =>
      Promise.resolve({
        providerId: 'moonshot',
        providerName: 'Kimi',
        kind: 'balance',
        balanceUsd: 49.58894,
        cashBalanceUsd: 3.00001,
        windows: [],
        fetchedAt: Date.now()
      } as ProviderQuota)
    );
    await vi.waitFor(() => {
      expect(overlay()?.textContent).toContain('$49.59');
    });

    // Only the context meter — a balance is not a percentage of anything.
    expect(overlay()?.querySelectorAll('[role="progressbar"]').length).toBe(1);
  });

  it('states plainly when a provider publishes no balance, with a console link', async () => {
    openStatusModal(data, () =>
      Promise.resolve({
        providerId: 'claude',
        providerName: 'Claude',
        kind: 'unavailable',
        message: 'Balance is not available through the API.',
        consoleUrl: 'https://console.anthropic.com/settings/billing',
        windows: [],
        fetchedAt: Date.now()
      } as ProviderQuota)
    );
    await vi.waitFor(() => {
      expect(overlay()?.querySelector('.status-quota-note')).not.toBeNull();
    });

    const link = overlay()?.querySelector<HTMLAnchorElement>('.status-quota-link');
    expect(link?.href).toBe('https://console.anthropic.com/settings/billing');
    expect(overlay()?.textContent).toContain('not available through the API');
    expect(overlay()?.querySelectorAll('[role="progressbar"]').length).toBe(1);
  });

  it('says nothing at all when a provider reports no quota, keeping the link', async () => {
    openStatusModal(data, () =>
      Promise.resolve({
        providerId: 'openai-codex',
        providerName: 'ChatGPT',
        kind: 'unavailable',
        consoleUrl: 'https://chatgpt.com/codex/settings/usage',
        windows: [],
        fetchedAt: Date.now()
      } as ProviderQuota)
    );
    await vi.waitFor(() => {
      expect(overlay()?.querySelector('.status-quota-link')).not.toBeNull();
    });

    // No explanatory line, and no fallback text standing in for one.
    expect(overlay()?.querySelector('.status-quota-note')).toBeNull();
    expect(overlay()?.textContent).not.toContain('not available through the API');
    expect(overlay()?.textContent).toContain('ChatGPT account');
  });

  it('keeps the local numbers when the provider lookup fails', async () => {
    openStatusModal(data, () => Promise.reject(new Error('offline')));
    await vi.waitFor(() => {
      expect(overlay()?.querySelector('.status-quota-loading')).toBeNull();
    });

    const text = overlay()?.textContent ?? '';
    expect(text).toContain('Could not read your account');
    // The half of the modal that never needed the network is untouched.
    expect(text).toContain('48k / 200k');
  });

  it('does not write into the modal after it has been closed', async () => {
    let resolve: (quota: ProviderQuota) => void = () => {};
    openStatusModal(data, () => new Promise<ProviderQuota>((done) => (resolve = done)));
    closeStatusModal();

    resolve({
      providerId: 'moonshot',
      providerName: 'Kimi',
      kind: 'balance',
      balanceUsd: 12,
      windows: [],
      fetchedAt: Date.now()
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(overlay()?.textContent).not.toContain('$12.00');
    expect(overlay()?.classList.contains('is-hidden')).toBe(true);
  });

  it('reuses one overlay across reopens', () => {
    openStatusModal(data, never);
    closeStatusModal();
    openStatusModal(data, never);

    expect(document.querySelectorAll('.status-modal-overlay').length).toBe(1);
    expect(overlay()?.classList.contains('is-hidden')).toBe(false);
  });

  it('closes on Escape and on a backdrop click', () => {
    openStatusModal(data, never);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay()?.classList.contains('is-hidden')).toBe(true);

    openStatusModal(data, never);
    overlay()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()?.classList.contains('is-hidden')).toBe(true);
  });

  it('shows an empty conversation without a divide-by-zero meter', () => {
    openStatusModal(
      {
        chat: { ...chat, contextTokens: 0, contextWindow: 0, totalTokens: 0 },
        totals: { totals: {} }
      },
      never
    );

    expect(overlay()?.textContent).toContain('No turns yet');
    expect(overlay()?.textContent).toContain('No turns recorded yet.');
  });
});

describe('formatting helpers', () => {
  it('compacts token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(48_000)).toBe('48k');
    expect(formatTokens(4_800)).toBe('4.8k');
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(Number.NaN)).toBe('0');
  });

  it('clamps context fill and refuses to divide by zero', () => {
    expect(contextFillPercent(50, 200)).toBe(25);
    expect(contextFillPercent(0, 200)).toBe(0);
    // An overflowed window is still full, not 130% wide.
    expect(contextFillPercent(260, 200)).toBe(100);
    expect(contextFillPercent(10, 0)).toBeNull();
    expect(contextFillPercent(10, Number.NaN)).toBeNull();
  });

  it('describes reset times relative to now', () => {
    const now = 1_000_000_000_000;
    expect(formatResetAt(now + 45 * 60_000, now)).toBe('resets in 45m');
    expect(formatResetAt(now + 3 * 3_600_000 + 12 * 60_000, now)).toBe('resets in 3h 12m');
    expect(formatResetAt(now + 26 * 3_600_000, now)).toBe('resets in 1d 2h');
    expect(formatResetAt(now - 1, now)).toBe('resets now');
    expect(formatResetAt(null, now)).toBe('');
    expect(formatResetAt(undefined, now)).toBe('');
  });
});
