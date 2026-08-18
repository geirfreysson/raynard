// Card template shape — mirrors scripts/plugin-sdk/index.d.ts (CardTemplate).
// Kept as an app-local copy so the frontend has no build dependency on the
// vendored plugin runtime. The builder authors these; the app renders them.

export type CardGap = 'sm' | 'md' | 'lg';

export type CardBlock =
  | { component: 'MetricRow'; items: { label: string; field: string; tone?: 'delta' | 'muted' }[] }
  | { component: 'Table'; columns: { header: string; field: string }[]; rows: string }
  | { component: 'KeyValue'; pairs: { label: string; field: string }[] }
  | { component: 'Text'; text: string }
  | { component: 'Section'; title?: string; layout: CardBlock[] }
  | { component: 'Stack'; gap?: CardGap; layout: CardBlock[] }
  | { component: 'Grid'; columns?: 1 | 2 | 3 | 4; gap?: CardGap; layout: CardBlock[] }
  | {
      component: 'Columns';
      gap?: CardGap;
      collapseBelow?: 'sm' | 'md' | 'never';
      columns: { width?: number; layout: CardBlock[] }[];
    }
  | { component: 'Badge'; field: string; tone?: 'success' | 'warn' | 'muted' }
  | {
      component: 'Image';
      field: string;
      alt?: string;
      variant?: 'avatar' | 'media';
      fit?: 'cover' | 'contain';
      aspectRatio?: '1/1' | '3/4' | '4/3' | '16/9' | 'auto';
    }
  | { component: 'Json'; field?: string };

export type CardTemplate = {
  /** Count label authored by the plugin. */
  name: {
    singular: string;
    plural: string;
  };
  title?: string;
  layout: CardBlock[];
};

/** App-local payload written outside chat history when card data is large. */
export type ResultArtifactRef = {
  chatId: string;
  artifactId: string;
  byteCount: number;
};

/** One card captured from a storable tool call and persisted on a message. */
export type StoredResultCard = {
  toolName: string;
  template: CardTemplate;
  data: unknown;
  /** True when at least one API request used to produce this card hit the cache. */
  cached?: boolean;
  artifact?: ResultArtifactRef;
};
