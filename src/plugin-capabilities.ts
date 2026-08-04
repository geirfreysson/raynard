export type CapabilityRequest = {
  requested: boolean;
  name: string;
  description: string;
  sourceUrls: string[];
};

const CAPABILITY_PATTERNS = [
  /\badd\s+(?:a\s+)?(?:new\s+)?capability\b/i,
  /\bbuild\s+(?:a\s+)?(?:new\s+)?plugin\b/i,
  /\bbuild\s+(?:an?\s+)?(?:api\s+)?explorer\s+for\b/i,
  /\bcreate\s+(?:a\s+)?(?:new\s+)?plugin\b/i,
  /\badd\s+(?:support|integration)\s+for\b/i,
  /\bconnect\s+(?:this|the)?\s*(?:agent|app)?\s*(?:to|with)\s+(?:an?\s+)?api\b/i,
  /\buse\s+(?:an?\s+)?api\s+(?:for|to)\b/i
];

const URL_PATTERN = /https?:\/\/[^\s)]+/gi;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'api',
  'app',
  'agent',
  'build',
  'can',
  'capability',
  'create',
  'for',
  'integration',
  'new',
  'plugin',
  'so',
  'support',
  'the',
  'this',
  'to',
  'with'
]);

export function detectCapabilityRequest(message: string): CapabilityRequest {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized || !CAPABILITY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      requested: false,
      name: '',
      description: '',
      sourceUrls: []
    };
  }

  return {
    requested: true,
    name: deriveCapabilityName(normalized),
    description: normalized,
    sourceUrls: extractSourceUrls(normalized)
  };
}

export function deriveCapabilityName(message: string) {
  const apiSubjectMatch =
    message.match(/\b(?:explorer|support|integration|capability|plugin)\s+for\s+(?:the\s+)?(.+?)\s+api\b/i) ||
    message.match(/\b(?:connect|use)\s+(?:.+?\s+)?(.+?)\s+api\b/i);
  const source = apiSubjectMatch?.[1] || message;
  const withoutLeadIn = source
    .replace(URL_PATTERN, ' ')
    .replace(/^.*?\b(?:capability|plugin|support|integration)\s+(?:for|to|with)?\s*/i, '')
    .replace(/[^\w\s.-]+/g, ' ')
    .trim();
  const words = (withoutLeadIn || message)
    .toLowerCase()
    .split(/[\s_.-]+/)
    .map((word) => word.replace(/[^a-z0-9]+/g, ''))
    .filter((word) => word && !STOPWORDS.has(word))
    .slice(0, 5);

  return words.length ? words.join('-') : 'generated-capability';
}

export function extractSourceUrls(message: string) {
  return Array.from(message.matchAll(URL_PATTERN), (match) => match[0].replace(/[.,;]+$/, ''));
}
