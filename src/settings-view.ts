// The Settings page: what version this is, and everything about updating it.
//
// Reached from the gear pinned to the bottom of the sidebar rail, or `/settings`.
// Like `status-modal.ts`, every Tauri call arrives as an injected thunk rather
// than being invoked here, so all nine states below are drivable from a test
// without mocking Tauri.
//
// The page is a pure function of the `AppUpdateState` Rust hands over. It never
// decides for itself what happens next — a background check six hours from now
// pushes a new state through `applyAppUpdateState` and the page re-paints.

import { DOWNLOADS } from './share/config';

/** Mirrors the Rust `AppUpdateStatus`. */
export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'manualDownload'
  | 'error';

/** Mirrors the Rust `AppUpdateState`. */
export type AppUpdateState = {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string | null;
  notes?: string | null;
  pubDate?: string | null;
  progressPercent: number;
  message?: string | null;
  checkedAt?: number | null;
  /** A key into `share.config.json`'s downloads; `manualDownload` only. */
  downloadTarget?: string | null;
};

export type SettingsViewDeps = {
  check: () => Promise<AppUpdateState>;
  download: () => Promise<AppUpdateState>;
  install: () => Promise<AppUpdateState>;
  openExternal: (url: string) => Promise<void>;
};

/** Where "Release notes" goes. Rendered as an ordinary link. */
export const RELEASES_URL = 'https://github.com/geirfreysson/raynard/releases';

type Action = { label: string; run: () => void } | null;

let host: HTMLElement | null = null;
let deps: SettingsViewDeps | null = null;
let current: AppUpdateState | null = null;
// Bumped on every action. A slow check that resolves after the user has already
// pressed something else must not overwrite the newer state.
let generation = 0;

/**
 * The sentence shown above the button.
 *
 * Kept separate from the DOM so the wording is testable on its own, and so the
 * rail badge and the page cannot describe the same state differently.
 */
export function updateStatusLine(state: AppUpdateState): string {
  const available = state.availableVersion || '';
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'upToDate':
      return `Raynard ${state.currentVersion} is up to date.`;
    case 'available':
      return `Raynard ${available} is available. You have ${state.currentVersion}.`;
    case 'downloading':
      return `Downloading Raynard ${available}…`;
    case 'downloaded':
      return `Raynard ${available} is ready to install.`;
    case 'installing':
      return 'Installing the update and restarting…';
    case 'manualDownload':
      return state.message || 'This copy cannot update itself.';
    case 'error':
      return state.message || 'Something went wrong checking for updates.';
    default:
      return `Raynard ${state.currentVersion}.`;
  }
}

/** Whether the rail should show a dot: an update is waiting on the user. */
export function updateNeedsAttention(state: AppUpdateState): boolean {
  return state.status === 'available' || state.status === 'downloaded';
}

/** The manual download URL for this platform, when one applies. */
export function manualDownloadUrl(state: AppUpdateState): string | null {
  if (state.status !== 'manualDownload') return null;
  const target = state.downloadTarget || '';
  return DOWNLOADS[target] || null;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Runs `action`, painting whatever state it resolves to. */
function drive(action: () => Promise<AppUpdateState>) {
  generation += 1;
  const started = generation;
  void action()
    .then((state) => {
      if (generation !== started) return;
      applyAppUpdateState(state);
    })
    .catch((error) => {
      if (generation !== started) return;
      applyAppUpdateState({
        ...(current as AppUpdateState),
        status: 'error',
        progressPercent: 0,
        message: error instanceof Error ? error.message : String(error)
      });
    });
}

/**
 * The primary button, or null where there is nothing useful to press.
 *
 * `installing` deliberately has no button: the process is about to be replaced.
 */
function primaryAction(state: AppUpdateState, api: SettingsViewDeps): Action {
  switch (state.status) {
    case 'checking':
    case 'downloading':
    case 'installing':
      return null;
    case 'available':
      return { label: 'Download', run: () => drive(api.download) };
    case 'downloaded':
      return { label: 'Restart and install', run: () => drive(api.install) };
    case 'error':
      return { label: 'Try again', run: () => drive(api.check) };
    case 'manualDownload': {
      const url = manualDownloadUrl(state);
      if (!url) return null;
      return { label: 'Download in browser', run: () => void api.openExternal(url) };
    }
    default:
      return { label: 'Check for updates', run: () => drive(api.check) };
  }
}

function renderUpdateSection(state: AppUpdateState, api: SettingsViewDeps): HTMLElement {
  const section = el('section', 'settings-section');
  section.appendChild(el('h3', 'settings-section-title', 'App updates'));

  const line = el('p', 'settings-status-line', updateStatusLine(state));
  line.setAttribute('aria-live', 'polite');
  section.appendChild(line);

  if (state.status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(state.progressPercent || 0)));
    const track = el('div', 'status-meter');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(percent));
    track.setAttribute('aria-label', 'Update download progress');
    const fill = el('div', 'status-meter-fill');
    fill.style.width = `${percent}%`;
    track.appendChild(fill);
    section.appendChild(track);
    section.appendChild(el('p', 'settings-status-detail', `${percent}%`));
  }

  // Release notes are worth showing when there is something to decide about.
  if (state.notes && (state.status === 'available' || state.status === 'downloaded')) {
    section.appendChild(el('p', 'settings-release-notes', state.notes));
  }

  const actions = el('div', 'settings-actions');
  const action = primaryAction(state, api);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-update-action';
  button.textContent = action ? action.label : 'Check for updates';
  if (action) {
    button.addEventListener('click', action.run);
  } else {
    button.disabled = true;
  }
  actions.appendChild(button);

  const notes = document.createElement('a');
  notes.className = 'settings-secondary-link';
  notes.href = RELEASES_URL;
  notes.textContent = 'Release notes';
  actions.appendChild(notes);

  section.appendChild(actions);
  return section;
}

function renderAboutSection(state: AppUpdateState): HTMLElement {
  const section = el('section', 'settings-section');
  section.appendChild(el('h3', 'settings-section-title', 'About'));
  const row = el('div', 'settings-row');
  row.append(
    el('span', 'settings-row-label', 'Version'),
    el('span', 'settings-row-value', state.currentVersion)
  );
  section.appendChild(row);
  return section;
}

/**
 * Paints `state` into the page, if the page is open.
 *
 * Bumping the generation here is what makes a background push authoritative: a
 * manual check that started earlier and is still in flight would otherwise
 * resolve afterwards and quietly replace a newer `available` with a stale
 * `upToDate`.
 */
export function applyAppUpdateState(state: AppUpdateState): void {
  current = state;
  generation += 1;
  // The page lives inside the shared detail section, so opening a plugin or a
  // scheduled task replaces it wholesale. Losing the document is the signal
  // that this page is gone — no teardown call to keep in sync.
  if (host && !host.isConnected) host = null;
  if (!host || !deps) return;
  host.replaceChildren();

  const header = el('header', 'settings-header');
  header.appendChild(el('h2', 'settings-title', 'Settings'));
  host.appendChild(header);

  const body = el('div', 'settings-body');
  body.append(renderAboutSection(state), renderUpdateSection(state, deps));
  host.appendChild(body);
}

/**
 * Mounts the page into `element` and paints `state`.
 *
 * Call again to re-mount; the module keeps one page at a time, matching the
 * single `#settingsView` section in the shell.
 */
export function renderSettingsView(
  element: HTMLElement,
  api: SettingsViewDeps,
  state: AppUpdateState
): void {
  host = element;
  deps = api;
  applyAppUpdateState(state);
}

/** Detaches the page so a late push cannot write into a hidden section. */
export function closeSettingsView(): void {
  generation += 1;
  host = null;
}
