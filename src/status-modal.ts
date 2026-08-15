// The /status modal: how full the current conversation's context window is,
// what this chat and the app as a whole have spent in tokens, and whatever the
// active provider is willing to say about quota or balance.
//
// Provider data is injected as a `loadQuota` thunk rather than invoked here, so
// the modal's loading, resolved, and failed states are all drivable from a test
// without mocking Tauri.

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type ChatUsageSnapshot = TokenCounts & {
  provider: string;
  model: string;
  /** The last turn's prompt plus completion — the window's high-water mark. */
  contextTokens: number;
  contextWindow: number;
  turns: number;
};

export type UsageTotalsRow = TokenCounts & { turns: number };

/** Mirrors the Rust `UsageTotals`, keyed by "provider/model". */
export type UsageTotals = {
  schemaVersion?: number;
  updatedAt?: number;
  totals: Record<string, UsageTotalsRow>;
};

export type QuotaWindow = {
  label: string;
  usedPercent: number;
  /** Epoch milliseconds; Rust converts from the provider's units. */
  resetsAt?: number | null;
};

export type ProviderQuota = {
  providerId: string;
  providerName: string;
  kind: 'windows' | 'balance' | 'unavailable';
  message?: string | null;
  consoleUrl?: string | null;
  plan?: string | null;
  balanceUsd?: number | null;
  voucherBalanceUsd?: number | null;
  cashBalanceUsd?: number | null;
  windows: QuotaWindow[];
  fetchedAt: number;
};

export type StatusModalData = {
  chat: ChatUsageSnapshot;
  totals: UsageTotals;
};

let modal: HTMLElement | null = null;
// Bumped on every open and close. A quota request that resolves after the user
// has closed or reopened the modal must not write into a torn-down section.
let generation = 0;

/** Compact token counts: the all-time column is otherwise unreadable. */
export function formatTokens(value: number): string {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * Context fill as a whole percent, or null when there is nothing to divide by.
 * Clamped to 100: a model that overflowed its window is still "full", and a
 * meter wider than its track just looks broken.
 */
export function contextFillPercent(used: number, window: number): number | null {
  const usedCount = Number(used);
  const windowCount = Number(window);
  if (!Number.isFinite(windowCount) || windowCount <= 0) return null;
  if (!Number.isFinite(usedCount) || usedCount < 0) return null;
  return Math.min(100, Math.round((usedCount / windowCount) * 100));
}

/** "resets in 3h 12m", or an empty string when the reset time is unknown. */
export function formatResetAt(resetsAt: number | null | undefined, now = Date.now()): string {
  const target = Number(resetsAt);
  if (!Number.isFinite(target) || target <= 0) return '';
  const remaining = target - now;
  if (remaining <= 0) return 'resets now';
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `resets in ${days}d ${hours % 24}h`;
  if (hours >= 1) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function meter(label: string, percent: number | null, detail: string): HTMLElement {
  const row = el('div', 'status-meter-row');
  const head = el('div', 'status-meter-head');
  head.append(el('span', 'status-meter-label', label), el('span', 'status-meter-detail', detail));
  row.appendChild(head);

  const track = el('div', 'status-meter');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  if (percent !== null) track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-label', label);
  const fill = el('div', 'status-meter-fill');
  fill.style.width = `${percent ?? 0}%`;
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

function metricRow(label: string, value: string): HTMLElement {
  const row = el('div', 'status-row');
  row.append(el('span', 'status-row-label', label), el('span', 'status-metric', value));
  return row;
}

function renderChatSection(chat: ChatUsageSnapshot): HTMLElement {
  const section = el('section', 'status-section');
  section.appendChild(el('h3', 'status-section-title', 'This conversation'));

  const percent = contextFillPercent(chat.contextTokens, chat.contextWindow);
  const detail =
    percent === null
      ? 'No turns yet'
      : `${formatTokens(chat.contextTokens)} / ${formatTokens(chat.contextWindow)} · ${percent}%`;
  section.appendChild(meter('Context window', percent, detail));

  if (chat.model) {
    section.appendChild(
      el('p', 'status-section-note', `${chat.provider}/${chat.model}`.replace(/^\//, ''))
    );
  }

  section.appendChild(metricRow('Input', formatTokens(chat.input)));
  section.appendChild(metricRow('Output', formatTokens(chat.output)));
  section.appendChild(metricRow('Cache read', formatTokens(chat.cacheRead)));
  section.appendChild(metricRow('Cache write', formatTokens(chat.cacheWrite)));
  section.appendChild(metricRow('Total this chat', formatTokens(chat.totalTokens)));
  return section;
}

function renderTotalsSection(totals: UsageTotals): HTMLElement {
  const section = el('section', 'status-section');
  section.appendChild(el('h3', 'status-section-title', 'All time'));

  const rows = Object.entries(totals?.totals ?? {}).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens
  );
  if (!rows.length) {
    section.appendChild(el('p', 'status-empty', 'No turns recorded yet.'));
    return section;
  }

  for (const [key, row] of rows) {
    section.appendChild(
      metricRow(key, `${formatTokens(row.totalTokens)} · ${row.turns} turn${row.turns === 1 ? '' : 's'}`)
    );
  }
  // The builder runs the coding model through a separate path that this does not
  // count, and a build pass can outspend many chat turns. Say so rather than
  // presenting a partial number as a total.
  section.appendChild(
    el('p', 'status-section-note', 'Chat turns only, since token counting was added.')
  );
  return section;
}

function renderQuota(section: HTMLElement, quota: ProviderQuota) {
  section.textContent = '';
  section.appendChild(
    el('h3', 'status-section-title', `${quota.providerName || 'Provider'} account`)
  );

  if (quota.kind === 'windows') {
    for (const window of quota.windows ?? []) {
      const percent = contextFillPercent(window.usedPercent, 100);
      const reset = formatResetAt(window.resetsAt);
      const detail = [`${Math.round(window.usedPercent)}% used`, reset].filter(Boolean).join(' · ');
      section.appendChild(meter(window.label, percent, detail));
    }
    if (quota.plan) section.appendChild(el('p', 'status-section-note', `Plan: ${quota.plan}`));
    section.appendChild(
      el('p', 'status-section-note', 'Reported by ChatGPT; not an official API.')
    );
  } else if (quota.kind === 'balance') {
    const available = Number(quota.balanceUsd ?? 0);
    section.appendChild(metricRow('Available', `$${available.toFixed(2)}`));
    if (typeof quota.cashBalanceUsd === 'number') {
      section.appendChild(metricRow('Cash', `$${quota.cashBalanceUsd.toFixed(2)}`));
    }
    if (typeof quota.voucherBalanceUsd === 'number') {
      section.appendChild(metricRow('Voucher', `$${quota.voucherBalanceUsd.toFixed(2)}`));
    }
  } else if (quota.message) {
    // No message is deliberate silence, not a missing string: the console link
    // below says more than a line explaining that nothing was reported.
    section.appendChild(el('p', 'status-quota-note', quota.message));
  }

  if (quota.consoleUrl) {
    const link = document.createElement('a');
    link.className = 'status-quota-link';
    link.href = quota.consoleUrl;
    link.rel = 'noreferrer noopener';
    link.textContent = 'Open provider console';
    section.appendChild(link);
  }
}

/**
 * Opens the modal on local numbers immediately, then swaps in provider quota
 * when it arrives. Nothing is awaited before the first paint.
 */
export function openStatusModal(data: StatusModalData, loadQuota: () => Promise<ProviderQuota>) {
  const host = ensureModal();
  const body = host.querySelector<HTMLElement>('.status-modal-body');
  if (!body) return;

  generation += 1;
  const opened = generation;

  body.textContent = '';
  body.appendChild(renderChatSection(data.chat));
  body.appendChild(renderTotalsSection(data.totals));

  const quotaSection = el('section', 'status-section');
  quotaSection.appendChild(el('h3', 'status-section-title', 'Provider account'));
  quotaSection.appendChild(el('p', 'status-quota-loading', 'Checking your account...'));
  body.appendChild(quotaSection);

  host.classList.remove('is-hidden');
  host.setAttribute('aria-hidden', 'false');
  host.querySelector<HTMLButtonElement>('.status-modal-close')?.focus();

  void loadQuota()
    .then((quota) => {
      if (generation !== opened) return;
      renderQuota(quotaSection, quota);
    })
    .catch(() => {
      if (generation !== opened) return;
      renderQuota(quotaSection, {
        providerId: '',
        providerName: 'Provider',
        kind: 'unavailable',
        message: 'Could not read your account right now.',
        windows: [],
        fetchedAt: Date.now()
      });
    });
}

export function closeStatusModal() {
  if (!modal) return;
  // Invalidates any quota request still in flight for the closed view.
  generation += 1;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function ensureModal(): HTMLElement {
  if (modal) return modal;

  const host = document.createElement('section');
  host.className = 'status-modal-overlay is-hidden';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = `
    <div class="status-modal" role="dialog" aria-modal="true" aria-labelledby="statusModalTitle">
      <header class="status-modal-header">
        <div>
          <h2 id="statusModalTitle" class="status-modal-title">Usage</h2>
          <p class="status-modal-hint">Tokens used and what your provider reports.</p>
        </div>
        <button class="status-modal-close" type="button" aria-label="Close usage">x</button>
      </header>
      <div class="status-modal-body"></div>
    </div>
  `;

  host.addEventListener('click', (event) => {
    if (event.target === host) closeStatusModal();
  });
  host.querySelector('.status-modal-close')?.addEventListener('click', () => closeStatusModal());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeStatusModal();
  });

  document.body.appendChild(host);
  modal = host;
  return host;
}

/** Test seam: drops the cached node so each test starts from nothing. */
export function resetStatusModal() {
  modal?.remove();
  modal = null;
  generation = 0;
}
