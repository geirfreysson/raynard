/**
 * Provenance for an exported chart.
 *
 * A chart pasted into a document leaves the app behind, so the image has to say
 * where its numbers came from. Every generated plugin returns SDK references
 * (`referenceLabel` + `referenceMeta.sourceUrl`) alongside its data, which is
 * enough to name the dataset: the OECD plugin labels an observation fetch with
 * its dataflow and key, the World Bank plugin with its indicator id.
 *
 * One entry is one tool call, not one reference, because what matters on the
 * image is whether the chart mixes several API calls.
 */

/** One reference a tool cited, kept small enough to persist on a message. */
export type StoredCitation = {
  /** Turn-scoped number the model cites inline as `[^n]`, assigned by the sidecar. */
  number?: number;
  label: string;
  sourceUrl?: string;
  fetchedAt?: string;
  /** The tool's own one-line account of what this reference covers. */
  quote?: string;
  /** Raw API payload, pretty-printed and truncated. */
  payload?: string;
  /** Set when `payload` was cut, so the reader is never shown a silent slice. */
  payloadTruncated?: boolean;
};

/** One API call that contributed data to a turn. */
export type ChartSource = {
  /** Plugin display name, e.g. `World Bank Data360`. */
  plugin: string;
  /** The dataset the call named, when the call named exactly one. */
  label?: string;
  sourceUrl?: string;
  /** What the call cited, for the in-app citation modal. */
  references?: StoredCitation[];
  /**
   * Index of this call's result card in the message's `cards`. The citation
   * modal shows that card rather than raw JSON, and pointing at the stored card
   * keeps one copy of the rows instead of persisting them twice.
   */
  cardIndex?: number;
};

/**
 * References kept per call. This matches what the sidecar shows the model, so
 * any number the model cites inline can still be resolved to a reference.
 */
const MAX_REFERENCES_PER_CALL = 20;
/** How many of those keep their quote and payload; the rest are label and link. */
const MAX_DETAILED_REFERENCES = 3;
/**
 * Payload budget per reference. These land in the chat history file, so the
 * modal shows a generous excerpt rather than a whole API response.
 */
export const MAX_CITATION_PAYLOAD = 4000;

/**
 * Reads one tool result into a source entry, or null if the tool cited nothing.
 *
 * A call that returned exactly one reference names its dataset. A call that
 * returned many (a catalog search, a codelist) names none: picking the first of
 * twenty would claim the chart came from a row nobody charted.
 */
export function extractToolSource(
  result: unknown,
  toolName: string,
  pluginName?: string
): ChartSource | null {
  if (!result || typeof result !== 'object') return null;
  const raw = (result as { references?: unknown }).references;
  if (!Array.isArray(raw) || !raw.length) return null;

  const plugin = (pluginName || '').trim() || toolName;
  const references = raw
    .slice(0, MAX_REFERENCES_PER_CALL)
    .map((reference, index) => readCitation(reference, index < MAX_DETAILED_REFERENCES))
    .filter((citation): citation is StoredCitation => citation !== null);

  const source: ChartSource = { plugin };
  if (references.length) source.references = references;
  if (raw.length === 1 && references.length === 1) {
    source.label = references[0].label;
    source.sourceUrl = references[0].sourceUrl;
  }
  return source;
}

/**
 * Reads one SDK reference into its persisted form. `detailed` carries the
 * quote and raw payload; a call that cited twenty rows keeps only links for the
 * tail, so one catalog search cannot bloat the chat history file.
 */
function readCitation(value: unknown, detailed: boolean): StoredCitation | null {
  if (!value || typeof value !== 'object') return null;
  const reference = value as {
    citationNumber?: unknown;
    referenceLabel?: unknown;
    referenceMeta?: { sourceUrl?: unknown; fetchedAt?: unknown };
    expandedContent?: unknown;
  };

  const label = text(reference.referenceLabel);
  if (!label) return null;

  const citation: StoredCitation = { label };
  const number = Number(reference.citationNumber);
  if (Number.isInteger(number) && number > 0) citation.number = number;
  const sourceUrl = text(reference.referenceMeta?.sourceUrl);
  if (sourceUrl) citation.sourceUrl = sourceUrl;
  const fetchedAt = text(reference.referenceMeta?.fetchedAt);
  if (fetchedAt) citation.fetchedAt = fetchedAt;

  // `expandedContent` is the SDK's modal payload: a header, the tool's quote,
  // and the raw API response as pretty JSON.
  const blocks =
    detailed && Array.isArray(reference.expandedContent) ? reference.expandedContent : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const { type, text: body } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && !citation.quote) {
      citation.quote = text(body) || undefined;
    } else if (type === 'json' && !citation.payload) {
      const payload = text(body);
      if (payload.length > MAX_CITATION_PAYLOAD) {
        citation.payload = payload.slice(0, MAX_CITATION_PAYLOAD);
        citation.payloadTruncated = true;
      } else if (payload) {
        citation.payload = payload;
      }
    }
  }

  return citation;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One reference, with the call it came from. */
export type DisplayCitation = {
  plugin: string;
  citation: StoredCitation;
  /** The call's result card, for the modal. */
  cardIndex?: number;
};

/** Flattens a turn's calls into the citations shown under a chart or table. */
export function citationsForDisplay(sources: ChartSource[]): DisplayCitation[] {
  const seen = new Set<string>();
  const flattened: DisplayCitation[] = [];

  for (const source of sources) {
    for (const citation of source.references ?? []) {
      const key = `${citation.sourceUrl || ''}|${citation.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push({ plugin: source.plugin, citation, cardIndex: source.cardIndex });
    }
  }

  return flattened;
}

/**
 * Names the sources for the bottom of an exported image, one entry per
 * reference: "D&D 5e monster: Orc", not "[1]" or "3 API calls". A pasted image
 * carries no click target, so the name has to be the citation.
 *
 * `cited` restricts the list to the markers the answer actually used, which is
 * the precise attribution when the model cited inline. Without it the entries
 * cover every reference the turn collected.
 */
export function chartSourceEntries(sources: ChartSource[], cited?: number[]): string[] {
  const wanted = cited?.length ? new Set(cited) : null;
  const entries: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    entries.push(trimmed);
  };

  for (const source of sources) {
    const references = source.references ?? [];

    if (wanted) {
      for (const reference of references) {
        if (reference.number !== undefined && wanted.has(reference.number)) {
          add(reference.label || source.plugin);
        }
      }
      continue;
    }

    // Nothing was cited explicitly, so fall back to the calls that fetched a
    // named thing. A call that returned many references is a catalog search or
    // a codelist — the work of finding the data, not the data. Listing those
    // buries the real sources under labels like "Barrels" and "Total".
    if (references.length === 1) add(references[0].label || source.plugin);
  }

  // Every call was a lookup: name the plugins rather than citing nothing.
  if (!entries.length && !wanted) {
    for (const source of sources) add(source.label || source.plugin);
  }

  return entries;
}
