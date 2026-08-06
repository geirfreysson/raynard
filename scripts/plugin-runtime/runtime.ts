// Raynard generated-plugin runtime — shared, pre-tested plumbing that every
// plugin imports. This file is vendored UNCHANGED into each generated plugin;
// do not edit it inside a plugin. Write only the API specifics (endpoints,
// parameter schemas, and how a payload becomes readable text + citations).

export type ApiReference = {
  /** Stable id for the cited record (a resource id, slug, or query key). */
  id: string;
  /** Short human label shown on the citation card. */
  label: string;
  /** URL a reader can open to verify the claim. */
  sourceUrl: string;
  /** One-line quote/summary of what this reference supports. */
  quote: string;
  /** ISO timestamp; defaults to now when omitted. */
  fetchedAt?: string;
  /** Optional dotted path into the payload the quote came from. */
  payloadPath?: string;
  /** Raw API payload, shown in the expanded citation view. */
  payload?: unknown;
};

/** Build a Raynard citation card from an API result. */
export function createApiReference(input: ApiReference) {
  return {
    referenceId: input.id,
    referenceLabel: input.label,
    referenceMeta: {
      sourceUrl: input.sourceUrl,
      fetchedAt: input.fetchedAt || new Date().toISOString(),
      payloadPath: input.payloadPath || ''
    },
    modalTitle: input.label,
    modalHint: input.sourceUrl,
    compactContent: [
      { type: 'header', state: 'complete', icon: 'check', title: input.label },
      { type: 'text', text: input.quote }
    ],
    expandedContent: [
      { type: 'header', state: 'complete', icon: 'check', title: input.label },
      { type: 'text', text: input.quote },
      { type: 'json', title: 'Raw API payload', text: JSON.stringify(input.payload ?? {}, null, 2) }
    ]
  };
}

// ---------------------------------------------------------------------------
// Result cards
//
// A card is a FIXED, declarative layout authored once at plugin-build time and
// stored on a tool. Each tool call only feeds fresh `data` into it — the layout
// never varies per call. The host app owns the actual rendering components; this
// file only declares the shape the builder fills in. String fields support
// `{{path}}` interpolation and `field`/`rows` are dotted paths into the tool's
// returned `data` object (e.g. 'quote.price', 'holdings').
// ---------------------------------------------------------------------------

export type CardGap = 'sm' | 'md' | 'lg';

/** A single visual block in a card. `component` picks an app-owned renderer. */
export type CardBlock =
  | { component: 'MetricRow'; items: { label: string; field: string; tone?: 'delta' | 'muted' }[] }
  | { component: 'Table'; columns: { header: string; field: string }[]; rows: string }
  | { component: 'KeyValue'; pairs: { label: string; field: string }[] }
  | { component: 'Text'; text: string }
  | { component: 'Section'; title?: string; layout: CardBlock[] }
  /** Vertical composition with controlled spacing. */
  | { component: 'Stack'; gap?: CardGap; layout: CardBlock[] }
  /** Equal-width responsive cells. */
  | { component: 'Grid'; columns?: 1 | 2 | 3 | 4; gap?: CardGap; layout: CardBlock[] }
  /** Weighted responsive columns; widths are relative, so 3 + 1 means 75% + 25%. */
  | {
      component: 'Columns';
      gap?: CardGap;
      collapseBelow?: 'sm' | 'md' | 'never';
      columns: { width?: number; layout: CardBlock[] }[];
    }
  | { component: 'Badge'; field: string; tone?: 'success' | 'warn' | 'muted' }
  /** An image URL. Defaults to a header avatar; media renders inline at container width. */
  | {
      component: 'Image';
      field: string;
      alt?: string;
      variant?: 'avatar' | 'media';
      fit?: 'cover' | 'contain';
      aspectRatio?: '1/1' | '3/4' | '4/3' | '16/9' | 'auto';
    }
  | { component: 'Json'; field?: string };

/** A fixed card layout stored on a storable (final-data) tool. */
export type CardTemplate = {
  /** Lower-case count labels used by the host, e.g. "1 monster", "2 monsters". */
  name: {
    singular: string;
    plural: string;
  };
  /** Heading text; supports {{path}} interpolation from the call's data. */
  title?: string;
  /** Ordered blocks rendered top-to-bottom. */
  layout: CardBlock[];
};

/** Identity helper that type-checks a card template at authoring time. */
export function defineCard(template: CardTemplate): CardTemplate {
  return template;
}

export type QueryValue = string | number | boolean | undefined | null;

/** Serialize a query object, skipping undefined/null/empty. Returns '' or '?a=1&b=2'. */
export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export type ApiGetOptions = {
  /** Query parameters appended to the URL. */
  query?: Record<string, QueryValue>;
  /** Extra request headers (e.g. an API key). */
  headers?: Record<string, string>;
  /** Label used in error messages (defaults to the request host). */
  label?: string;
};

/**
 * GET a JSON endpoint with consistent error handling. Throws a descriptive
 * Error on a non-2xx response, surfacing an { "error" } / { "message" } field
 * from the body when present. For anything unusual — auth handshakes, non-JSON
 * responses, POST/PUT bodies — call the global `fetch()` directly instead.
 */
export async function apiGet<T>(url: string, options: ApiGetOptions = {}): Promise<T> {
  const target = url + buildQuery(options.query);
  const label = options.label || safeHost(target);
  const response = await fetch(target, { headers: options.headers });
  if (!response.ok) {
    throw new Error(
      `${label} request failed with HTTP ${response.status} for ${target}${await errorDetail(response)}`
    );
  }
  return (await response.json()) as T;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message =
      body && typeof body === 'object'
        ? ((body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message)
        : undefined;
    return typeof message === 'string' && message.trim() ? ` — ${message.trim()}` : '';
  } catch {
    // Some APIs return an HTML error page instead of JSON; ignore the body then.
    return '';
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'API';
  }
}

/** Require a non-empty string argument, returned trimmed. */
export function requireNonEmpty(value: unknown, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty string.`);
  return trimmed;
}

/** Require a positive integer argument. */
export function requirePositiveInt(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} must be a positive integer, received: ${String(value)}`);
  }
  return numeric;
}
