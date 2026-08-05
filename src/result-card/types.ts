// Card template shape — mirrors scripts/plugin-runtime/runtime.ts (CardTemplate).
// Kept as an app-local copy so the frontend has no build dependency on the
// vendored plugin runtime. The builder authors these; the app renders them.

export type CardBlock =
  | { component: 'MetricRow'; items: { label: string; field: string; tone?: 'delta' | 'muted' }[] }
  | { component: 'Table'; columns: { header: string; field: string }[]; rows: string }
  | { component: 'KeyValue'; pairs: { label: string; field: string }[] }
  | { component: 'Text'; text: string }
  | { component: 'Section'; title?: string; layout: CardBlock[] }
  | { component: 'Badge'; field: string; tone?: 'success' | 'warn' | 'muted' }
  | { component: 'Image'; field: string; alt?: string }
  | { component: 'Json'; field?: string };

export type CardTemplate = {
  /** Count label authored by the plugin; optional here for legacy persisted cards. */
  name?: {
    singular: string;
    plural: string;
  };
  title?: string;
  layout: CardBlock[];
};

/** One card captured from a storable tool call and persisted on a message. */
export type StoredResultCard = {
  toolName: string;
  template: CardTemplate;
  data: unknown;
};
