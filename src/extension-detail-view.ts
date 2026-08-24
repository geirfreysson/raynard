/**
 * Pure wording and ordering rules for the extension detail screen.
 *
 * The screen leads with what the user can act on — an extension that wants an
 * API key is useless until one is stored — and demotes the paths, ids, and
 * source dumps that only matter while debugging. Keeping the rules here means
 * the order and the labels can be tested without a webview.
 */

export type ExtensionCredentialState = {
  key: string;
  configured: boolean;
};

export type ExtensionKeyAction = {
  /** `add` while at least one declared key is missing, `replace` once all are stored. */
  kind: 'add' | 'replace';
  label: string;
  /** Keys the action should collect, in declaration order. */
  keys: string[];
};

export type ExtensionKeyStatus = {
  text: string;
  configured: boolean;
};

export type ExtensionDetailSection = 'setup' | 'tools' | 'cards' | 'readme' | 'manifest' | 'source';

/**
 * The button in the header and the item in the `⋯` menu. Both offer the same
 * action, so they share one label. An extension that is not installed yet has
 * nowhere to store a key, so it gets no action.
 */
export function extensionKeyAction(
  credentials: ExtensionCredentialState[],
  options: { readOnly?: boolean } = {}
): ExtensionKeyAction | null {
  const declared = credentials.filter((credential) => credential.key);
  if (options.readOnly || !declared.length) return null;
  const missing = declared.filter((credential) => !credential.configured);
  const target = missing.length ? missing : declared;
  const plural = target.length > 1 ? 'keys' : 'key';
  return {
    kind: missing.length ? 'add' : 'replace',
    label: `${missing.length ? 'Add' : 'Replace'} API ${plural}`,
    keys: target.map((credential) => credential.key)
  };
}

/** The pill beside the extension name: what its key situation is right now. */
export function extensionKeyStatus(
  credentials: ExtensionCredentialState[],
  options: { readOnly?: boolean; requiresKey?: boolean } = {}
): ExtensionKeyStatus | null {
  const declared = credentials.filter((credential) => credential.key);
  if (options.readOnly) {
    return options.requiresKey || declared.length
      ? { text: 'Requires key', configured: false }
      : null;
  }
  if (!declared.length) return options.requiresKey ? { text: 'Requires key', configured: false } : null;
  const missing = declared.filter((credential) => !credential.configured);
  const plural = declared.length > 1 ? 'keys' : 'key';
  return missing.length
    ? { text: `API ${missing.length > 1 ? 'keys' : 'key'} needed`, configured: false }
    : { text: `API ${plural} added`, configured: true };
}

/** One-line prompt above the credential rows, or null when nothing is missing. */
export function extensionKeyHint(credentials: ExtensionCredentialState[]): string | null {
  const declared = credentials.filter((credential) => credential.key);
  const missing = declared.filter((credential) => !credential.configured);
  if (!missing.length) return null;
  return missing.length > 1
    ? 'Add these keys before this extension can run its tools.'
    : 'Add this key before this extension can run its tools.';
}

/**
 * Section order on the detail screen. The manifest leads because it says what
 * the extension is; setup follows because it is the only section that blocks
 * use. Source comes last, and folds itself away.
 */
export function extensionDetailSectionOrder(options: {
  hasCredentials: boolean;
  hasReadme: boolean;
}): ExtensionDetailSection[] {
  const order: ExtensionDetailSection[] = ['manifest'];
  if (options.hasCredentials) order.push('setup');
  order.push('tools', 'cards');
  if (options.hasReadme) order.push('readme');
  order.push('source');
  return order;
}

export type ExtensionManifestMetadata = {
  category: string;
  author: string;
  homepage: string;
  license: string;
  icon: string;
  sdkVersion: string;
  tags: string[];
  sources: string[];
};

function manifestString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function manifestStrings(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const entries = value
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          return manifestString(record.url, record.href, record.title, record.name);
        }
        return '';
      })
      .filter(Boolean);
    if (entries.length) return entries;
  }
  return [];
}

/**
 * Reads the display-worthy fields out of a `plugin.json`. A generated plugin
 * writes them at the top level and a bundled one nests them under
 * `catalogMetadata`, so both are accepted with the top level winning.
 *
 * `samplePrompts` are deliberately not returned: splash prompts belong to the
 * empty chat, not to this screen.
 */
export function extensionManifestMetadata(manifest: unknown): ExtensionManifestMetadata {
  const root = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, unknown>;
  const nested = (root.catalogMetadata && typeof root.catalogMetadata === 'object'
    ? root.catalogMetadata
    : {}) as Record<string, unknown>;
  return {
    category: manifestString(root.category, nested.category),
    author: manifestString(root.author, nested.author),
    homepage: manifestString(root.homepage, nested.homepage),
    license: manifestString(root.license, nested.license),
    icon: manifestString(root.icon, nested.icon),
    sdkVersion: manifestString(root.sdkVersion, nested.sdkVersion),
    tags: manifestStrings(root.tags, nested.tags),
    sources: manifestStrings(root.sourceUrls, root.sources, nested.sourceUrls, nested.sources)
  };
}

export type ExtensionToolParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

function parameterType(schema: Record<string, unknown>): string {
  const raw = schema.type;
  const type = Array.isArray(raw)
    ? raw.filter((entry) => typeof entry === 'string').join(' | ')
    : typeof raw === 'string'
      ? raw
      : '';
  if (type === 'array') {
    const items = schema.items && typeof schema.items === 'object'
      ? parameterType(schema.items as Record<string, unknown>)
      : '';
    return items ? `${items}[]` : 'array';
  }
  if (type) return type;
  return Array.isArray(schema.enum) ? 'enum' : 'any';
}

/** Flattens one tool's JSON parameter schema into rows a person can read. */
export function extensionToolParameters(schema: unknown): ExtensionToolParameter[] {
  const root = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
  const properties = (root.properties && typeof root.properties === 'object'
    ? root.properties
    : {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((entry): entry is string => typeof entry === 'string') : []
  );
  return Object.entries(properties).map(([name, value]) => {
    const property = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const parts: string[] = [];
    const description = manifestString(property.description);
    if (description) parts.push(description);
    const options = Array.isArray(property.enum)
      ? property.enum.map((option) => (typeof option === 'string' ? option : JSON.stringify(option)))
      : [];
    if (options.length && options.length <= 12) parts.push(`One of: ${options.join(', ')}.`);
    if (property.default !== undefined) parts.push(`Default: ${JSON.stringify(property.default)}.`);
    return {
      name,
      type: parameterType(property),
      required: required.has(name),
      description: parts.join(' ')
    };
  });
}

/**
 * The one line a collapsed tool row shows. Tool descriptions are written for
 * the model and run long, so the row keeps the first sentence and the
 * disclosure holds the rest.
 */
export function extensionToolSummary(description: string): string {
  const text = description.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  const sentence = match ? match[1] : text;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}...` : sentence;
}

/**
 * A documentation URL as a readable label. Manifests cite deep documentation
 * pages, and five wrapped 120-character URLs read as a wall rather than as a
 * list; the full URL stays on the link's title and is what gets opened.
 */
export function extensionSourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments.length) return host;
    const last = segments[segments.length - 1];
    return segments.length > 1 ? `${host}/.../${last}` : `${host}/${last}`;
  } catch {
    return url;
  }
}
