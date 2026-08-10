export type ApiReferenceInput = {
  id: string;
  label: string;
  sourceUrl: string;
  quote: string;
  fetchedAt?: string;
  payloadPath?: string;
  payload?: unknown;
};

export type ApiReference = {
  referenceId: string;
  referenceLabel: string;
  referenceMeta: {
    sourceUrl: string;
    fetchedAt: string;
    payloadPath: string;
  };
  modalTitle: string;
  modalHint: string;
  compactContent: unknown[];
  expandedContent: unknown[];
};

export function createApiReference(input: ApiReferenceInput): ApiReference;

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
  name: { singular: string; plural: string };
  title?: string;
  layout: CardBlock[];
};

export type ToolResult = {
  text: string;
  references: ApiReference[];
  data: Record<string, unknown>;
};

export type ApiTool = {
  description: string;
  parameters: Record<string, unknown>;
  card: CardTemplate;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export type ToolRegistry = Record<string, ApiTool>;

export function defineCard(template: CardTemplate): CardTemplate;
export function defineTools<const T extends ToolRegistry>(tools: T): T;
export function assertCardTemplate(template: unknown): CardTemplate;
export function assertToolRegistry(tools: unknown): ToolRegistry;
export function assertToolResult(result: unknown): ToolResult;

export type QueryValue = string | number | boolean | undefined | null;
export type ApiGetOptions = {
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  label?: string;
};

export type ApiCacheOptions = {
  enabled: boolean;
  ttlHours?: number;
  directory?: string;
};

export function buildQuery(params?: Record<string, QueryValue>): string;
export function configureApiCache(options: ApiCacheOptions): void;
export function apiGet<T>(url: string, options?: ApiGetOptions): Promise<T>;
export function requireNonEmpty(value: unknown, label: string): string;
export function requirePositiveInt(value: unknown, label: string): number;

/**
 * Thrown by requireCredential when the host has not configured a value. The
 * runner turns it into a prompt for the user rather than a plain tool failure.
 */
export class MissingCredentialError extends Error {
  name: 'MissingCredentialError';
  credentialKey: string;
  credentialLabel: string;
}

/** Host-only. Plugins never call this. */
export function configureCredentials(values: Record<string, string>): void;

/** Returns '' when the credential is not configured. */
export function getCredential(key: string): string;

/**
 * Reads a credential the plugin declared under auth.credentials in
 * plugin.json, throwing MissingCredentialError when the user has not added it
 * yet. Call it inside execute(), never at module load, so tool discovery keeps
 * working before a key is configured.
 *
 *   const key = requireCredential('OPENWEATHER_API_KEY');
 *   const data = await apiGet(url, { query: { appid: key } });
 */
export function requireCredential(key: string, label?: string): string;

/** Replaces every configured credential value in the text with '***'. */
export function redactSecrets(text: unknown): string;
