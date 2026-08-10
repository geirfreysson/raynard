// Pure decisions behind the "this plugin needs an API key" prompt. Kept out of
// main.ts so the rules stay testable without a DOM.

export type CredentialRequirement = {
  key: string;
  label: string;
  description?: string;
  signupUrl?: string;
};

export type CredentialRequest = {
  pluginId: string;
  pluginName: string;
  credentials: CredentialRequirement[];
};

function isHttpUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Decodes a credential request off a stream event. The payload crosses a
 * process boundary as opaque JSON, so anything malformed becomes null rather
 * than a half-rendered card.
 */
export function decodeCredentialRequest(input: unknown): CredentialRequest | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const pluginId = String(source.pluginId || '').trim();
  const rawCredentials = Array.isArray(source.credentials) ? source.credentials : [];

  const credentials: CredentialRequirement[] = [];
  for (const entry of rawCredentials) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = String(record.key || '').trim();
    if (!key || credentials.some((existing) => existing.key === key)) continue;
    const signupUrl = String(record.signupUrl || '').trim();
    credentials.push({
      key,
      label: String(record.label || key).trim() || key,
      description: String(record.description || '').trim(),
      signupUrl: isHttpUrl(signupUrl) ? signupUrl : ''
    });
  }

  if (!pluginId || !credentials.length) return null;
  return {
    pluginId,
    pluginName: String(source.pluginName || pluginId).trim() || pluginId,
    credentials
  };
}

export function credentialPromptCopy(request: CredentialRequest) {
  const labels = request.credentials.map((credential) => credential.label);
  const names =
    labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
  return {
    // Also used as the message text, so it has to read well on its own: it is
    // what remains if the structured field is ever lost.
    title: `${request.pluginName} needs ${names}`,
    description:
      labels.length > 1
        ? 'Add these keys to run that request. They are stored in your operating system keychain.'
        : 'Add the key to run that request. It is stored in your operating system keychain.',
    addLabel: labels.length > 1 ? 'Add keys' : 'Add key',
    dismissLabel: 'Not now',
    continueLabel: 'Continue',
    signupLabel: 'Get an API key'
  };
}

/** True once every credential the request names has a stored value. */
export function allCredentialsConfigured(
  request: CredentialRequest,
  plugin: { credentials?: { key: string; configured: boolean }[] } | null | undefined
): boolean {
  const configured = new Set(
    (plugin?.credentials || []).filter((entry) => entry.configured).map((entry) => entry.key)
  );
  return request.credentials.every((credential) => configured.has(credential.key));
}

export function missingCredentialKeys(
  request: CredentialRequest,
  plugin: { credentials?: { key: string; configured: boolean }[] } | null | undefined
): string[] {
  const configured = new Set(
    (plugin?.credentials || []).filter((entry) => entry.configured).map((entry) => entry.key)
  );
  return request.credentials
    .filter((credential) => !configured.has(credential.key))
    .map((credential) => credential.key);
}

/**
 * The question to re-send once the key is stored.
 *
 * Read back out of history rather than captured in a closure, so the card still
 * works after the chat has been closed and reopened.
 */
export function retryPromptFor(
  messages: { role: string; text: string; modeStatus?: boolean }[],
  recordIndex: number
): string {
  const upperBound = recordIndex >= 0 ? recordIndex : messages.length;
  for (let index = upperBound - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || message.modeStatus) continue;
    const text = String(message.text || '').trim();
    if (text) return text;
  }
  return '';
}
