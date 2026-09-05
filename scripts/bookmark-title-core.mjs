/**
 * Naming logic for bookmarks, kept apart from the sidecar so it can be tested
 * without a model or a network.
 *
 * A bookmark used to be labelled with the prompt that produced it, which reads
 * badly in a list: prompts are long, often start with the same few words, and
 * describe the question rather than what was found. The model writes a short
 * label instead, and everything here exists to make that label safe to render
 * in a single row.
 */

export const BOOKMARK_TITLE_MAX_LENGTH = 60;

export const BOOKMARK_TITLE_SYSTEM_PROMPT = `You name saved answers so they can be found again in a list.

Write one short title, at most 8 words, describing what the answer establishes — not the shape of the exchange.

Rules:
- Return the title alone. No quotes, no markdown, no trailing period, no "Title:" prefix.
- Prefer the specific subject: name the company, ticker, metric, place, or entity the answer is about.
- Lead with the subject, not a verb ("Apple FY2024 margins", not "Analyzing Apple's margins").
- Never write a generic label such as "Answer", "Summary", "Research", or "Response".
- Write it in the language the question was asked in.`;

/**
 * The answer carries what the bookmark is actually worth finding again, so it
 * leads and gets the larger budget; the prompt is context for what was asked.
 * Both are clipped because a title never needs a full transcript, and a long
 * answer would otherwise dominate the request.
 */
export function buildTitlePrompt({ prompt, answer } = {}) {
  const question = clip(prompt, 500);
  const response = clip(answer, 2000);
  const parts = [];
  if (question) parts.push(`Question:\n${question}`);
  if (response) parts.push(`Answer:\n${response}`);
  return {
    systemPrompt: BOOKMARK_TITLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: parts.join('\n\n') || 'Untitled answer.' }]
  };
}

function clip(value, limit) {
  const text = String(value ?? '').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Concatenates the text blocks of a pi-ai reply. */
export function readTitleFromReply(reply) {
  const blocks = Array.isArray(reply?.content) ? reply.content : [];
  return blocks
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('');
}

/**
 * Reduces whatever the model returned to one plain line that fits a bookmark row.
 *
 * Models reliably decorate titles even when told not to — wrapping them in
 * quotes, bolding them, prefixing "Title:", adding a period — so this strips
 * the decoration rather than rejecting the title over it. Returns '' when
 * nothing usable is left, which the caller treats as "fall back to the prompt".
 */
export function normalizeBookmarkTitle(raw) {
  let title = String(raw ?? '')
    // Only the first line: a model that ignores the instruction and explains
    // itself puts the title first and the commentary after.
    .split(/\r?\n/)[0]
    .trim();
  title = title.replace(/^(?:title|name)\s*[:\-—]\s*/i, '');
  title = title.replace(/[*_`#]+/g, '');
  // Repeat: a model may both quote and bold, leaving nested wrappers.
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = title
      .trim()
      .replace(/^["'“”‘’«»]+/, '')
      .replace(/["'“”‘’«»]+$/, '')
      .trim();
    if (stripped === title.trim()) break;
    title = stripped;
  }
  title = title.replace(/\s+/g, ' ').trim();
  title = title.replace(/[.,;:]+$/, '').trim();
  if (!title) return '';
  if (title.length <= BOOKMARK_TITLE_MAX_LENGTH) return title;
  // Cut on a word boundary so the label does not end mid-word.
  const clipped = title.slice(0, BOOKMARK_TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = (lastSpace > BOOKMARK_TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[.,;:]+$/, '')
    .trim();
  return `${base}…`;
}
