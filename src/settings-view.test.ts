// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAppUpdateState,
  applyTelegramChannelState,
  closeSettingsView,
  manualDownloadUrl,
  renderSettingsView,
  updateNeedsAttention,
  updateStatusLine,
  type AppUpdateState,
  type SettingsViewDeps
} from './settings-view';
import type { TelegramChannelState } from './telegram-channel';

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'idle',
    currentVersion: '0.4.0',
    progressPercent: 0,
    ...overrides
  };
}

function deps(overrides: Partial<SettingsViewDeps> = {}): SettingsViewDeps {
  const telegram = telegramState();
  return {
    check: vi.fn(async () => state({ status: 'upToDate' })),
    download: vi.fn(async () => state({ status: 'downloaded', availableVersion: '0.5.0' })),
    install: vi.fn(async () => state({ status: 'installing' })),
    openExternal: vi.fn(async () => undefined),
    connectTelegram: vi.fn(async (): Promise<TelegramChannelState> => ({
      ...telegram,
      configured: true,
      status: 'awaitingPairing'
    })),
    approveTelegram: vi.fn(async (): Promise<TelegramChannelState> => ({
      ...telegram,
      status: 'connected'
    })),
    rejectTelegram: vi.fn(async () => telegram),
    forgetTelegramOwner: vi.fn(async () => telegram),
    disconnectTelegram: vi.fn(async () => telegram),
    ...overrides
  };
}

function telegramState(overrides: Partial<TelegramChannelState> = {}): TelegramChannelState {
  return {
    status: 'disconnected',
    configured: false,
    enabled: false,
    bot: null,
    owner: null,
    pairingRequests: [],
    pendingCount: 0,
    ...overrides
  };
}

/** Mirrors main.ts: the page is a child of the shared detail section. */
function mount(
  initial: AppUpdateState,
  api: SettingsViewDeps = deps(),
  telegram: TelegramChannelState = telegramState()
) {
  const detail = document.createElement('section');
  detail.id = 'pluginDetailView';
  document.body.appendChild(detail);
  const host = document.createElement('div');
  detail.appendChild(host);
  renderSettingsView(host, api, initial, telegram);
  return host;
}

function button(host: HTMLElement) {
  return host.querySelector<HTMLButtonElement>('.settings-updates .settings-update-action');
}

function statusText(host: HTMLElement) {
  return host.querySelector('.settings-updates .settings-status-line')?.textContent || '';
}

beforeEach(() => {
  document.body.replaceChildren();
  closeSettingsView();
});

describe('updateStatusLine', () => {
  it('names both versions when an update is available', () => {
    expect(updateStatusLine(state({ status: 'available', availableVersion: '0.5.0' }))).toBe(
      'Raynard 0.5.0 is available. You have 0.4.0.'
    );
  });

  it('reports the installed version when up to date', () => {
    expect(updateStatusLine(state({ status: 'upToDate' }))).toBe('Raynard 0.4.0 is up to date.');
  });

  it('prefers the message Rust supplied for errors', () => {
    const line = updateStatusLine(
      state({ status: 'error', message: 'Could not reach GitHub to check for updates.' })
    );
    expect(line).toBe('Could not reach GitHub to check for updates.');
  });

  it('falls back to generic wording when an error carries no message', () => {
    expect(updateStatusLine(state({ status: 'error' }))).toMatch(/went wrong/);
  });
});

describe('updateNeedsAttention', () => {
  it('flags states that are waiting on the user', () => {
    expect(updateNeedsAttention(state({ status: 'available' }))).toBe(true);
    expect(updateNeedsAttention(state({ status: 'downloaded' }))).toBe(true);
  });

  it('stays quiet while working or when there is nothing to do', () => {
    for (const status of ['idle', 'checking', 'upToDate', 'downloading', 'installing'] as const) {
      expect(updateNeedsAttention(state({ status }))).toBe(false);
    }
  });
});

describe('manualDownloadUrl', () => {
  it('resolves the platform key Rust chose against share.config.json', () => {
    const url = manualDownloadUrl(state({ status: 'manualDownload', downloadTarget: 'debian' }));
    expect(url).toContain('.deb');
  });

  it('is null for any status that is not manualDownload', () => {
    expect(manualDownloadUrl(state({ status: 'available', downloadTarget: 'macos' }))).toBeNull();
  });

  it('is null for a platform key with no configured download', () => {
    expect(manualDownloadUrl(state({ status: 'manualDownload', downloadTarget: 'bsd' }))).toBeNull();
  });
});

describe('the settings page', () => {
  it('always shows the installed version', () => {
    const host = mount(state());
    expect(host.querySelector('.settings-row-value')?.textContent).toBe('0.4.0');
  });

  it('connects a BotFather token without rendering it back', async () => {
    const api = deps();
    const host = mount(state(), api);
    const input = host.querySelector<HTMLInputElement>('.settings-telegram-token')!;
    input.value = '123:secret';
    host.querySelector<HTMLFormElement>('.settings-telegram-form')?.requestSubmit();
    await vi.waitFor(() => expect(api.connectTelegram).toHaveBeenCalledWith('123:secret'));
    expect(host.textContent).not.toContain('123:secret');
  });

  it('shows and approves a numeric Telegram pairing request', () => {
    const api = deps();
    const host = mount(
      state(),
      api,
      telegramState({
        status: 'awaitingPairing',
        configured: true,
        enabled: true,
        pairingRequests: [
          {
            id: 'pair-1',
            userId: 42,
            chatId: 42,
            username: 'ada',
            name: 'Ada',
            createdAt: 1,
            expiresAt: 2
          }
        ]
      })
    );
    expect(host.textContent).toContain('Ada · @ada · 42');
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((entry) => entry.textContent === 'Approve')
      ?.click();
    expect(api.approveTelegram).toHaveBeenCalledWith('pair-1');
  });

  it('repaints Telegram state pushed by the host', () => {
    const host = mount(state());
    applyTelegramChannelState(
      telegramState({
        status: 'connected',
        configured: true,
        enabled: true,
        bot: { id: 1, username: 'raynard_bot', name: 'Raynard' },
        owner: { userId: 42, username: 'ada', name: 'Ada', approvedAt: 1 }
      })
    );
    expect(host.textContent).toContain('@raynard_bot is connected');
    expect(host.textContent).toContain('Ada · @ada · 42');
  });

  it('offers a check when idle and paints what the check returns', async () => {
    const api = deps();
    const host = mount(state(), api);
    expect(button(host)?.textContent).toBe('Check for updates');

    button(host)?.click();
    await vi.waitFor(() => expect(statusText(host)).toBe('Raynard 0.4.0 is up to date.'));
    expect(api.check).toHaveBeenCalledOnce();
  });

  it('offers Download for an available update, not an install', () => {
    const host = mount(state({ status: 'available', availableVersion: '0.5.0' }));
    expect(button(host)?.textContent).toBe('Download');
  });

  it('shows release notes only once there is something to decide about', () => {
    const available = mount(
      state({ status: 'available', availableVersion: '0.5.0', notes: 'Adds in-app updates.' })
    );
    expect(available.querySelector('.settings-release-notes')?.textContent).toBe(
      'Adds in-app updates.'
    );

    document.body.replaceChildren();
    const upToDate = mount(state({ status: 'upToDate', notes: 'Adds in-app updates.' }));
    expect(upToDate.querySelector('.settings-release-notes')).toBeNull();
  });

  it('renders a progress meter while downloading and disables the button', () => {
    const host = mount(
      state({ status: 'downloading', availableVersion: '0.5.0', progressPercent: 62 })
    );
    const meter = host.querySelector('.status-meter');
    expect(meter?.getAttribute('aria-valuenow')).toBe('62');
    expect(host.querySelector<HTMLElement>('.status-meter-fill')?.style.width).toBe('62%');
    expect(host.querySelector('.settings-updates .settings-status-detail')?.textContent).toBe('62%');
    expect(button(host)?.disabled).toBe(true);
  });

  it('clamps a progress percent outside 0-100', () => {
    const host = mount(state({ status: 'downloading', progressPercent: 140 }));
    expect(host.querySelector('.status-meter')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('offers Restart and install once the bytes are down', () => {
    const api = deps();
    const host = mount(state({ status: 'downloaded', availableVersion: '0.5.0' }), api);
    expect(button(host)?.textContent).toBe('Restart and install');
    button(host)?.click();
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('disables the button while installing, since the process is about to go', () => {
    const host = mount(state({ status: 'installing' }));
    expect(button(host)?.disabled).toBe(true);
    expect(statusText(host)).toMatch(/Installing/);
  });

  it('opens the browser for a build that cannot update itself', () => {
    const api = deps();
    const host = mount(
      state({
        status: 'manualDownload',
        downloadTarget: 'debian',
        message: 'This copy was installed from a package.'
      }),
      api
    );
    expect(statusText(host)).toBe('This copy was installed from a package.');
    expect(button(host)?.textContent).toBe('Download in browser');
    button(host)?.click();
    expect(api.openExternal).toHaveBeenCalledWith(expect.stringContaining('.deb'));
  });

  it('retries after an error', () => {
    const api = deps();
    const host = mount(state({ status: 'error', message: 'Could not reach GitHub.' }), api);
    expect(button(host)?.textContent).toBe('Try again');
    button(host)?.click();
    expect(api.check).toHaveBeenCalledOnce();
  });

  it('turns a rejected action into an error state rather than an unhandled failure', async () => {
    const api = deps({
      check: vi.fn(async () => {
        throw new Error('network down');
      })
    });
    const host = mount(state(), api);
    button(host)?.click();
    await vi.waitFor(() => expect(statusText(host)).toBe('network down'));
  });

  it('links to the releases page', () => {
    const host = mount(state());
    const link = host.querySelector<HTMLAnchorElement>('.settings-secondary-link');
    expect(link?.href).toContain('geirfreysson/raynard/releases');
  });

  it('re-paints when a background check pushes a new state', () => {
    const host = mount(state({ status: 'upToDate' }));
    applyAppUpdateState(state({ status: 'available', availableVersion: '0.6.0' }));
    expect(statusText(host)).toBe('Raynard 0.6.0 is available. You have 0.4.0.');
  });

  it('ignores a push once the page is closed', () => {
    const host = mount(state({ status: 'upToDate' }));
    closeSettingsView();
    applyAppUpdateState(state({ status: 'available', availableVersion: '0.6.0' }));
    expect(statusText(host)).toBe('Raynard 0.4.0 is up to date.');
  });

  it('stops painting once another screen has taken over the detail section', () => {
    const host = mount(state({ status: 'upToDate' }));
    // Opening a plugin or a scheduled task calls replaceChildren() on the
    // shared section, which detaches this page.
    document.querySelector('#pluginDetailView')?.replaceChildren();
    applyAppUpdateState(state({ status: 'available', availableVersion: '0.6.0' }));
    // The detached subtree keeps whatever it last painted; what matters is
    // that the push did not write into it.
    expect(statusText(host)).toBe('Raynard 0.4.0 is up to date.');
  });

  it('drops a slow response that lost its race with a newer action', async () => {
    // Typed through a holder: assigning inside the executor otherwise narrows
    // `release` to never at the call site below.
    const holder: { release?: (value: AppUpdateState) => void } = {};
    const api = deps({
      check: vi.fn(
        () =>
          new Promise<AppUpdateState>((resolve) => {
            holder.release = resolve;
          })
      )
    });
    const host = mount(state(), api);
    button(host)?.click();

    // A push lands while the check is still in flight; the stale resolution
    // that follows must not overwrite it.
    applyAppUpdateState(state({ status: 'available', availableVersion: '0.7.0' }));
    holder.release?.(state({ status: 'upToDate' }));
    await Promise.resolve();

    expect(statusText(host)).toBe('Raynard 0.7.0 is available. You have 0.4.0.');
  });
});
