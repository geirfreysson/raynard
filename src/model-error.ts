/**
 * User-facing copy for a turn that ended because the model provider failed.
 *
 * A raw provider string in an assistant bubble is indistinguishable from an
 * answer: one observed turn ended on `429 The engine is currently overloaded`
 * with no indication that Moonshot — not the question, and not the plugin the
 * agent had just called thirteen times — was what gave out. These messages say
 * who failed, whether we already retried, and what the user can do about it.
 */

export type ModelFailureContext = {
  provider?: string;
  model?: string;
  /** Which agent stopped: the chat model or the coding model. */
  role: 'chat' | 'builder';
  /** Transient resumes the sidecar already spent before giving up. */
  resumeAttempts?: number;
};

export type ModelFailure = {
  title: string;
  detail: string;
  /** The provider's own words, kept for the disclosure and the turn log. */
  raw: string;
  /** Whether trying the same request again is worth the user's time. */
  retryable: boolean;
};

/** Display names for the providers `/models` can configure. */
const PROVIDER_LABELS: Record<string, string> = {
  moonshot: 'Moonshot',
  kimi: 'Moonshot',
  claude: 'Claude',
  openai: 'OpenAI'
};

const GENERIC_PROVIDER = 'The model provider';

function providerLabel(provider?: string): string {
  const key = String(provider || '').trim().toLowerCase();
  if (!key) return GENERIC_PROVIDER;
  return PROVIDER_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

/** "Moonshot (kimi-k2.5)", or just the provider when the model is unknown. */
function providerAndModel(context: ModelFailureContext): string {
  const label = providerLabel(context.provider);
  const model = String(context.model || '').trim();
  return model ? `${label} (${model})` : label;
}

function retriedSentence(attempts: number): string {
  if (attempts <= 0) return '';
  return attempts === 1 ? ' Retried once.' : ` Retried ${attempts} times.`;
}

/** What this turn was: the wording differs for an answer and a coding pass. */
function lostWork(role: ModelFailureContext['role']): string {
  return role === 'builder'
    ? 'The coding model stopped mid-pass — this is the provider, not your plugin.'
    : 'Nothing is wrong with your question or the installed plugins.';
}

const OVERLOADED = /overloaded|capacity|\bbusy\b|congest/i;
const RATE_LIMITED = /\brate[\s_-]?limit|too many requests|quota exceeded/i;
const UNAVAILABLE = /\b5\d\d\b|unavailable|bad gateway|server error|timed?[\s_-]?out|timeout/i;
const REJECTED_KEY = /\b(401|403)\b|invalid[\s_-]?api[\s_-]?key|incorrect api key|invalid authentication|unauthorized|forbidden/i;
const CONTEXT_EXHAUSTED = /context[\s_-]?length|maximum context|context window|too many tokens/i;

export function describeModelFailure(raw: string, context: ModelFailureContext): ModelFailure {
  const text = String(raw || '').trim();
  const who = providerLabel(context.provider);
  const attempts = Number(context.resumeAttempts) || 0;
  const failure = { raw: text, retryable: false };

  // Checked before the capacity patterns: a 429 that names a quota is the
  // user's own budget, and waiting is a different answer than trying again.
  if (RATE_LIMITED.test(text)) {
    return {
      ...failure,
      retryable: true,
      title: `${who} is rate limiting this account`,
      detail: `${retriedSentence(attempts).trim()} The request budget for this key is used up rather than the request being wrong. Wait a moment, or switch models in /models.`.trim()
    };
  }

  if (OVERLOADED.test(text) || /\b429\b/.test(text)) {
    return {
      ...failure,
      retryable: true,
      title: attempts > 0 ? `${who} is still overloaded` : `${who} is overloaded`,
      detail: `${who} is at capacity and never produced an answer.${retriedSentence(attempts)} ${lostWork(context.role)} Try again in a moment.`
    };
  }

  if (UNAVAILABLE.test(text)) {
    return {
      ...failure,
      retryable: true,
      title: `${who} could not be reached`,
      detail: `The request to ${who} was dropped before an answer came back.${retriedSentence(attempts)} ${lostWork(context.role)} Try again, and check your connection if it keeps happening.`
    };
  }

  if (REJECTED_KEY.test(text)) {
    return {
      ...failure,
      title: `${who} rejected the API key`,
      detail: `${who} refused the stored credentials, so no request was answered. Open /models to re-enter the key.`
    };
  }

  if (CONTEXT_EXHAUSTED.test(text)) {
    return {
      ...failure,
      title: `The conversation outgrew ${context.model || who}'s context`,
      detail:
        context.role === 'builder'
          ? 'The coding pass ran out of context. Ask for a smaller change, or start a new chat for the next pass.'
          : 'There is no room left for another round. Narrow the query so tools return less data, or start a new chat.'
    };
  }

  return {
    ...failure,
    title: `${providerAndModel(context)} stopped this turn`,
    detail: text || 'The model ended the turn without an answer and without saying why.'
  };
}
